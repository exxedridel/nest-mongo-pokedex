import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import {
  AuthIdentityService,
  MessageAuthError,
} from '../src/messages/auth-identity.service';
import { PvpModule } from '../src/pvp/pvp.module';
import {
  MemoryPvpRepository,
  PvpBattleSchema,
} from '../src/pvp/pvp.repository';
import { PvpService } from '../src/pvp/pvp.service';
import { Actor, Battle, clone, Snapshot } from '../src/pvp/pvp.types';
import {
  digest,
  requestKey,
  stableJson,
  validateSnapshot,
} from '../src/pvp/pvp.validation';

function fakeAuth() {
  const users = new Map(
    [1, 2, 3, 4, 5, 6].map((id) => [
      id,
      {
        id,
        email: `user${id}@example.test`,
        first_name: `User${id}`,
        last_name: 'QA',
        role: id === 1 || id === 5 ? 'admin' : 'player',
      },
    ]),
  );
  return {
    users,
    async authenticate(token: any) {
      const user = users.get(Number(String(token).replace('test-user-', '')));
      if (!user)
        throw new MessageAuthError('SESSION_REVOKED', 'Test session revoked');
      return { user: clone(user), expiresAt: Date.now() + 3600000 };
    },
    async contacts(token: string, selfId: number) {
      await this.authenticate(token);
      return clone([...users.values()].filter((user) => user.id !== selfId));
    },
  };
}
function capture(name = 'test-mon', large = false): any {
  const names = [
    'hp',
    'attack',
    'defense',
    'special-attack',
    'special-defense',
    'speed',
  ];
  const move = {
    id: 1,
    name: 'pound',
    displayName: 'Pound',
    type: 'normal',
    damageClass: 'physical',
    power: 40,
    accuracy: 100,
    pp: 35,
    priority: 0,
    description: large ? 'x'.repeat(9000) : 'Test',
    source: 'wild',
  };
  return {
    captureId: 'same-id-across-players',
    pokemon: {
      id: 35,
      name,
      image: null,
      types: ['fairy'],
      progressionVersion: 1,
      level: 20,
      hpMultiplier: 1.3,
      baseStats: names.map((name) => ({ name, value: 100 })),
      stats: names.map((name) => ({ name, value: name === 'hp' ? 70 : 45 })),
      battleStages: Object.fromEntries(
        [...names.slice(1), 'accuracy', 'evasiveness'].map((name) => [name, 0]),
      ),
    },
    moves: large ? [move, { ...move, id: 2 }, { ...move, id: 3 }] : [move],
    statuses: ['burned', 'confused'],
    statusTurns: { confused: 2 },
  };
}
function snapshot(
  battle: Battle | any,
  userId: number,
  clientId: string,
  large = false,
): Snapshot {
  const pokemons = [capture(`private-pokemon-${userId}`, large)];
  return {
    version: 1,
    battleId: battle.battleId,
    snapshotId: `snapshot-${userId}`,
    userId,
    clientId,
    dataVersion: '1.6.0',
    baseHash: digest(pokemons),
    pokemons,
    activeCaptureId: pokemons[0].captureId,
    hpMultiplier: 1.3,
  };
}
function session(battle: Battle): any {
  const request = {
    moves: [{ id: 1, name: 'pound', pp: 35, maxpp: 35, disabled: false }],
    forceSwitch: false,
    waiting: false,
    locked: false,
    trapped: false,
    gender: '',
  };
  return {
    version: 1,
    id: battle.battleId,
    networkBattleId: battle.battleId,
    phase: 'battle',
    hpMultiplier: 1.3,
    teams: Object.fromEntries(
      ['a', 'b'].map((side) => [
        side,
        {
          name: side,
          pokemons: clone(battle.players[side].snapshot.pokemons),
          activeCaptureId: battle.players[side].snapshot.activeCaptureId,
        },
      ]),
    ),
    weather: { kind: 'none' },
    history: [],
    runtime: {
      engine: JSON.stringify({ testEngine: true, padding: 'x'.repeat(20000) }),
      serial: 0,
      turn: 1,
      pending: {},
      requests: { a: clone(request), b: clone(request) },
      ended: false,
      winner: null,
    },
  };
}

describe('Durable PvP service, repository and private projection', () => {
  let repo: MemoryPvpRepository;
  let auth: ReturnType<typeof fakeAuth>;
  let service: PvpService;
  let actors: Record<number, Actor>;
  beforeEach(async () => {
    repo = new MemoryPvpRepository();
    auth = fakeAuth();
    service = new PvpService(repo, auth as any);
    actors = Object.fromEntries(
      [...auth.users.values()].map((user) => [
        user.id,
        {
          user: clone(user),
          clientId: `client-${user.id}`,
          socketId: `socket-${user.id}`,
          token: `test-user-${user.id}`,
        },
      ]),
    ) as any;
    Object.values(actors).forEach((actor) => service.connect(actor));
    await service.onModuleInit();
  });
  const createPayload = (commandId = 'create-1') => ({
    commandId,
    playerAId: 2,
    playerBId: 3,
  });
  async function ready(): Promise<Battle> {
    const battle = await service.create(actors[1], createPayload());
    await Promise.all(
      [2, 3].map((id) =>
        service.snapshot(actors[id], {
          snapshot: snapshot(battle, id, actors[id].clientId),
        }),
      ),
    );
    return repo.get(battle.battleId);
  }
  async function active(): Promise<Battle> {
    const battle = await ready();
    return service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  }
  it('declares unique partial reservation indexes for players and administrator', () => {
    const indexes = PvpBattleSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { lockedUserIds: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { lockHeld: true },
          }),
        ],
        [
          { adminId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { lockHeld: true },
          }),
        ],
      ]),
    );
  });
  it('reserves intersecting players atomically and prevents a second battle for an admin', async () => {
    const results = await Promise.allSettled([
      service.create(actors[1], createPayload()),
      service.create(actors[5], {
        commandId: 'other',
        playerAId: 3,
        playerBId: 4,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await repo.locked()).toHaveLength(1);
    const battle = (await repo.locked())[0];
    await expect(
      service.create(actors[battle.adminId], {
        commandId: 'another',
        playerAId: 4,
        playerBId: 6,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
  });
  it('deduplicates create and rejects identity or selection changes', async () => {
    const battle = await service.create(actors[1], createPayload());
    expect((await service.create(actors[1], createPayload())).battleId).toBe(
      battle.battleId,
    );
    await expect(
      service.create(actors[1], { ...createPayload(), playerBId: 4 }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(
      service.create(actors[2], createPayload()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });
  it('merges simultaneous snapshots with CAS and preserves the player board exactly', async () => {
    const battle = await ready();
    expect(battle.phase).toBe('ready');
    expect(battle.players.a.snapshot.pokemons[0].pokemon.types).toEqual([
      'fairy',
    ]);
    expect(battle.players.a.snapshot.pokemons[0].pokemon.stats[0].value).toBe(
      70,
    );
    expect(battle.players.a.snapshot.pokemons[0].statuses).toEqual([
      'burned',
      'confused',
    ]);
    expect(battle.players.a.snapshot.pokemons[0].captureId).toBe(
      battle.players.b.snapshot.pokemons[0].captureId,
    );
    expect(
      (
        await service.snapshot(actors[2], {
          snapshot: battle.players.a.snapshot,
        })
      ).revision,
    ).toBe(battle.revision);
  });
  it('validates 1..6 unique captures, current HP, hashes, versions and four moves without healing', async () => {
    const battle = await service.create(actors[1], createPayload());
    const base = snapshot(battle, 2, actors[2].clientId);
    for (const change of [
      (s: any) => s.pokemons.splice(0),
      (s: any) => s.pokemons.push(clone(s.pokemons[0])),
      (s: any) => (s.pokemons[0].pokemon.stats[0].value = 92),
      (s: any) => (s.pokemons[0].pokemon.level = 0),
      (s: any) => (s.dataVersion = 'unknown'),
      (s: any) => (s.pokemons[0].moves = []),
    ]) {
      const invalid = clone(base);
      change(invalid);
      invalid.baseHash = digest(invalid.pokemons);
      expect(() => validateSnapshot(invalid)).toThrow();
    }
    const four = clone(base);
    four.pokemons[0].moves = [1, 2, 3, 4].map((id) => ({
      ...four.pokemons[0].moves[0],
      id,
    }));
    four.baseHash = digest(four.pokemons);
    expect(validateSnapshot(four)).toEqual(four);
    await expect(
      service.snapshot(
        { ...actors[2], clientId: 'other-device' },
        { snapshot: base },
      ),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
  });
  it('uses UTF-16 key ordering and JSON undefined semantics for hashes and request keys', () => {
    expect(
      stableJson({ '\ufffd': 1, '😀': 2, a: undefined, Z: [undefined, 4] }),
    ).toBe('{"Z":[null,4],"😀":2,"�":1}');
  });
  it('rejects forfeit outside the acting side request and duplicate queued choices', async () => {
    let battle = await active();
    const waiting = clone(battle.session);
    waiting.runtime.serial++;
    waiting.runtime.requests.a.waiting = true;
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: battle.checkpointRevision,
      session: waiting,
      processedCommandIds: [],
    });
    await expect(
      service.command(actors[1], {
        battleId: battle.battleId,
        commandId: 'invalid-forfeit',
        side: 'a',
        requestKey: requestKey(battle.session, 'a'),
        choice: { kind: 'forfeit' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
    const payload = {
      battleId: battle.battleId,
      commandId: 'forfeit-b',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'forfeit' },
    };
    await service.command(actors[1], payload);
    await expect(
      service.command(actors[1], { ...payload, commandId: 'forfeit-b-again' }),
    ).rejects.toMatchObject({ code: 'COMMAND_PENDING' });
    expect((await repo.get(battle.battleId)).commands).toHaveLength(1);
  });
  it('keeps reservations on disconnection/restart and resumes from the durable checkpoint', async () => {
    const battle = await active();
    service.disconnect(actors[2].socketId);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    expect(await repo.locked()).toHaveLength(1);
    const restarted = new PvpService(repo, auth as any);
    Object.values(actors).forEach((actor) => restarted.connect(actor));
    const restored = await restarted.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.session).toEqual(battle.session);
    expect(restored.state.checkpointRevision).toBe(1);
  });
  it('fences an older admin tab after a new claim', async () => {
    const battle = await ready();
    const newHost = {
      ...actors[1],
      clientId: 'new-admin-tab',
      socketId: 'new-admin-socket',
    };
    service.connect(newHost);
    const claimed = await service.claim(newHost, { battleId: battle.battleId });
    expect(claimed.host.epoch).toBe(2);
    const data = {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    };
    await expect(service.checkpoint(actors[1], data)).rejects.toMatchObject({
      code: 'HOST_REQUIRED',
    });
    await expect(service.checkpoint(newHost, data)).rejects.toMatchObject({
      code: 'HOST_FENCED',
    });
  });
  it('accepts commands only from the host, deduplicates them and keeps checkpoint revision independent of enqueue', async () => {
    const battle = await active();
    const commandA = {
      battleId: battle.battleId,
      commandId: 'cmd-a',
      side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: { kind: 'move', moveId: 1 },
    };
    await expect(service.command(actors[2], commandA)).rejects.toMatchObject({
      code: 'HOST_REQUIRED',
    });
    await service.command(actors[1], commandA);
    await service.command(actors[1], commandA);
    expect((await repo.get(battle.battleId)).commands).toHaveLength(1);
    await expect(
      service.command(actors[1], { ...commandA, choice: { kind: 'forfeit' } }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    const actualCas = repo.compareAndSwap.bind(repo);
    jest
      .spyOn(repo, 'compareAndSwap')
      .mockImplementationOnce(async (next, expected) => {
        await service.command(actors[1], {
          ...commandA,
          commandId: 'cmd-b',
          side: 'b',
          requestKey: requestKey(battle.session, 'b'),
        });
        return actualCas(next, expected);
      });
    const saved = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: battle.session,
      processedCommandIds: ['cmd-a'],
    });
    expect(saved.checkpointRevision).toBe(2);
    expect(saved.commands.map((command) => command.commandId)).toEqual([
      'cmd-b',
    ]);
  });
  it('rejects stale requests, permanent-field edits and unknown processed commands', async () => {
    const battle = await active();
    await expect(
      service.command(actors[1], {
        battleId: battle.battleId,
        commandId: 'stale',
        side: 'a',
        requestKey: 'old',
        choice: { kind: 'wait' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REQUEST' });
    const changed = clone(battle.session);
    changed.teams.a.pokemons[0].pokemon.level++;
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: changed,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['unknown'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
  });
  it('persists immutable private results and unlocks only after both owners apply them', async () => {
    const battle = await active();
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    finished.runtime.serial++;
    finished.teams.b.pokemons[0].pokemon.stats[0].value = 0;
    finished.teams.a.pokemons[0].statuses = ['asleep', 'confused'];
    finished.teams.a.pokemons[0].statusTurns = { asleep: 2, confused: 2 };
    await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: finished,
      processedCommandIds: [],
    });
    const finalized = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(
      (
        await service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).results,
    ).toEqual(finalized.results);
    const own = service.view(finalized, actors[2]);
    expect(own.session).toBeUndefined();
    expect(own.commands).toBeUndefined();
    expect(own.players.b.snapshot).toBeUndefined();
    expect(JSON.stringify(own)).not.toContain('private-pokemon-3');
    expect(own.result.patches[0]).toEqual({
      captureId: 'same-id-across-players',
      hp: 70,
      statuses: ['asleep'],
      statusTurns: { asleep: 2 },
    });
    for (const userId of [2, 3]) {
      const side = userId === 2 ? 'a' : 'b';
      const result = finalized.results[side];
      const applied = await service.applied(actors[userId], {
        battleId: battle.battleId,
        resultId: result.resultId,
        snapshotId: result.snapshotId,
        baseHash: result.baseHash,
      });
      expect(applied.lockHeld).toBe(userId === 2);
      expect(
        (
          await service.applied(actors[userId], {
            battleId: battle.battleId,
            resultId: result.resultId,
            snapshotId: result.snapshotId,
            baseHash: result.baseHash,
          })
        ).revision,
      ).toBe(applied.revision);
    }
    expect((await repo.get(battle.battleId)).phase).toBe('finalized');
    expect(await repo.locked()).toHaveLength(0);
  });
  it('only cancels preparation and reuses released player/admin reservations', async () => {
    const battle = await active();
    await expect(
      service.cancel(actors[1], { battleId: battle.battleId, hostEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    const otherRepo = new MemoryPvpRepository();
    const other = new PvpService(otherRepo, auth as any);
    Object.values(actors).forEach((actor) => other.connect(actor));
    const collecting = await other.create(actors[1], createPayload());
    await other.cancel(
      actors[2],
      { battleId: collecting.battleId, reason: 'Local encounter active' },
      true,
    );
    expect(
      (await other.create(actors[1], createPayload('after-cancel'))).phase,
    ).toBe('collecting');
  });
});

describe('Real PvP Socket.IO gateway with fake authoritative auth and memory durability', () => {
  let app: INestApplication;
  let address: string;
  let repo: MemoryPvpRepository;
  let auth: ReturnType<typeof fakeAuth>;
  let sockets: Socket[];
  beforeEach(async () => {
    repo = new MemoryPvpRepository();
    auth = fakeAuth();
    sockets = [];
    const moduleRef = await Test.createTestingModule({
      imports: [PvpModule.withRepository(repo)],
    })
      .overrideProvider(AuthIdentityService)
      .useValue(auth)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    address = await app.getUrl();
  });
  afterEach(async () => {
    for (const socket of sockets) {
      socket.disconnect();
      socket.removeAllListeners();
    }
    await app.close();
  });
  async function connect(userId: number): Promise<Socket> {
    const socket = io(`${address}/pvp`, {
      auth: { token: `test-user-${userId}`, clientId: `client-${userId}` },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      forceNew: true,
      extraHeaders: { Origin: 'http://localhost:5173' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  function ack(socket: Socket, event: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) =>
      socket
        .timeout(6000)
        .emit(event, payload, (error: Error, result: any) =>
          error ? reject(error) : resolve(result),
        ),
    );
  }
  it('transports snapshots larger than 16KB and projects no rival engine or team to players/third parties', async () => {
    const [admin, a, b, outsider] = await Promise.all(
      [1, 2, 3, 4].map(connect),
    );
    const created = await ack(admin, 'pvp:create', {
      commandId: 'large-snapshot',
      playerAId: 2,
      playerBId: 3,
    });
    expect(created.ok).toBe(true);
    const snapA = snapshot(created.state, 2, 'client-2', true);
    expect(Buffer.byteLength(JSON.stringify(snapA))).toBeGreaterThan(16384);
    expect((await ack(a, 'pvp:snapshot', { snapshot: snapA })).ok).toBe(true);
    expect(
      (
        await ack(b, 'pvp:snapshot', {
          snapshot: snapshot(created.state, 3, 'client-3'),
        })
      ).ok,
    ).toBe(true);
    const playerState = await ack(a, 'pvp:sync', {
      battleId: created.state.battleId,
    });
    expect(playerState.state.snapshot).toEqual(snapA);
    expect(playerState.state.players.b.snapshot).toBeUndefined();
    expect(playerState.state.session).toBeUndefined();
    expect(JSON.stringify(playerState)).not.toContain('private-pokemon-3');
    expect(
      (await ack(outsider, 'pvp:sync', { battleId: created.state.battleId }))
        .error.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await ack(a, 'pvp:command', {
          battleId: created.state.battleId,
          commandId: 'forged-player-command',
          side: 'a',
          requestKey: 'none',
          choice: { kind: 'forfeit' },
        })
      ).error.code,
    ).toBe('HOST_REQUIRED');
  });
  it('rejects revoked identities while preserving battle reservations for recovery', async () => {
    const [admin, a] = await Promise.all([connect(1), connect(2), connect(3)]);
    const created = await ack(admin, 'pvp:create', {
      commandId: 'revocation',
      playerAId: 2,
      playerBId: 3,
    });
    expect(created.ok).toBe(true);
    auth.users.delete(2);
    expect(
      (await ack(a, 'pvp:sync', { battleId: created.state.battleId })).error
        .code,
    ).toBe('SESSION_REVOKED');
    expect((await repo.get(created.state.battleId)).lockHeld).toBe(true);
  });
});
