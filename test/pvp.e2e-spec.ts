import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import {
  AuthIdentityService,
  MessageAuthError,
} from '../src/messages/auth-identity.service';
import { PvpModule } from '../src/pvp/pvp.module';
import { ShopService } from '../src/shop/shop.service';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { PlayerActivityService } from '../src/messages/player-activity.service';
import {
  MemoryPvpRepository,
  PvpBattleSchema,
} from '../src/pvp/pvp.repository';
import { PvpService } from '../src/pvp/pvp.service';
import { trainerPreset } from '../src/pvp/pvp.trainers';
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
      ['a', 'b'].map((side) => {
        const npc = side === 'b' && battle.mode === 'trainer';
        const team = npc ? battle.trainer.team : battle.players[side].snapshot;
        return [
          side,
          {
            name: npc ? battle.trainer.team.name : side,
            pokemons: clone(team.pokemons),
            activeCaptureId: team.activeCaptureId,
          },
        ];
      }),
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
  async function readyTrainer(presetId = 'kanto-brock'): Promise<Battle> {
    const battle = await service.create(actors[1], {
      commandId: 'create-trainer',
      playerAId: 2,
      trainerPresetId: presetId,
    });
    const snap = snapshot(battle, 2, actors[2].clientId);
    snap.hpMultiplier = 2;
    return service.snapshot(actors[2], { snapshot: snap });
  }
  async function activeTrainer(): Promise<Battle> {
    const battle = await readyTrainer();
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
  it('creates a Kanto Trainer battle with only one human owner and an immutable scaled preset', async () => {
    const battle = await readyTrainer();
    expect(battle.mode).toBe('trainer');
    expect(battle.phase).toBe('ready');
    expect(battle.lockedUserIds).toEqual([2]);
    expect(battle.players.b).toBeUndefined();
    expect(battle.applied).toEqual({ a: false, b: true });
    expect(battle.trainer.presetId).toBe('kanto-brock');
    expect(
      battle.trainer.team.pokemons.map((p) => [p.pokemon.id, p.pokemon.level]),
    ).toEqual([
      [74, 12],
      [95, 14],
    ]);
    expect(battle.trainer.team.pokemons[0].pokemon.hpMultiplier).toBe(2);
    expect(
      battle.trainer.team.pokemons[0].pokemon.stats.find((s) => s.name === 'hp')
        .value,
    ).toBe(62);
    expect(
      trainerPreset('kanto-brock').team.pokemons[0].pokemon.hpMultiplier,
    ).toBe(1.3);
    expect(service.view(battle, actors[1]).trainer.team).toEqual(
      battle.trainer.team,
    );
    const own = service.view(battle, actors[2]);
    expect(own.trainer.presetId).toBe('kanto-brock');
    expect(own.trainer.name).toBeTruthy();
    expect(own.trainer.team).toBeUndefined();
    expect(own.players.b).toBeUndefined();
    expect(own.session).toBeUndefined();
    expect(own.snapshot).toEqual(battle.players.a.snapshot);
    expect(() => service.view(battle, actors[3])).toThrow();
  });
  it('validates and deduplicates trainer selection without accepting a forged NPC or second account', async () => {
    const payload = {
      commandId: 'create-trainer',
      playerAId: 2,
      trainerPresetId: 'kanto-brock',
    };
    await expect(
      service.create(actors[1], {
        ...payload,
        trainerPresetId: 'missing-trainer',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRAINER' });
    await expect(
      service.create(actors[1], { ...payload, playerBId: 3 }),
    ).rejects.toMatchObject({ code: 'INVALID_PLAYERS' });
    await expect(
      service.create(actors[1], { ...payload, trainer: { team: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.create(actors[2], payload)).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    const battle = await service.create(actors[1], payload);
    expect((await service.create(actors[1], payload)).battleId).toBe(
      battle.battleId,
    );
    await expect(
      service.create(actors[1], { ...payload, trainerPresetId: 'kanto-misty' }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(
      service.create(actors[5], {
        commandId: 'pvp-overlap',
        playerAId: 2,
        playerBId: 3,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.create(actors[5], { ...payload, commandId: 'trainer-overlap' }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await service.cancel(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(
      (
        await service.create(actors[5], {
          ...payload,
          commandId: 'trainer-after-cancel',
        })
      ).lockedUserIds,
    ).toEqual([2]);
  });
  it('rejects altered NPC levels, moves, HP and initial state before accepting a checkpoint', async () => {
    const battle = await readyTrainer();
    for (const change of [
      (s: any) => s.teams.b.pokemons[0].pokemon.level++,
      (s: any) => s.teams.b.pokemons[0].moves[0].id++,
      (s: any) =>
        s.teams.b.pokemons[0].pokemon.stats.find((stat) => stat.name === 'hp')
          .value--,
      (s: any) => s.teams.b.pokemons[0].statuses.push('burned'),
      (s: any) => s.teams.b.pokemons[0].pokemon.battleStages.attack++,
      (s: any) => (s.teams.b.name = 'Forged Trainer'),
      (s: any) => (s.teams.b.activeCaptureId = s.teams.b.pokemons[1].captureId),
    ]) {
      const changed = session(battle);
      change(changed);
      await expect(
        service.checkpoint(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 0,
          session: changed,
          processedCommandIds: [],
        }),
      ).rejects.toThrow();
    }
    expect((await repo.get(battle.battleId)).checkpointRevision).toBe(0);
    expect((await repo.get(battle.battleId)).lockHeld).toBe(true);
  });
  it('requires only the real player online and original device to resume Trainer battle', async () => {
    const battle = await activeTrainer();
    service.disconnect(actors[3].socketId);
    const command = {
      battleId: battle.battleId,
      commandId: 'npc-choice',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'move', moveId: 1 },
    };
    const queued = await service.command(actors[1], command);
    expect(queued.commands).toHaveLength(1);
    service.disconnect(actors[2].socketId);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['npc-choice'],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    const foreign = {
      ...actors[2],
      clientId: 'foreign-player-device',
      socketId: 'foreign-player-socket',
    };
    service.connect(foreign);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['npc-choice'],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    expect(
      service.view(await repo.get(battle.battleId), actors[1]).players.a.online,
    ).toBe(false);
    service.connect(actors[2]);
    const restarted = new PvpService(repo, auth as any);
    [actors[1], actors[2]].forEach((actor) => restarted.connect(actor));
    const restored = await restarted.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.session).toEqual(battle.session);
    expect(restored.state.trainer.team).toEqual(battle.trainer.team);
    expect(
      (
        await restarted.checkpoint(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 1,
          session: battle.session,
          processedCommandIds: ['npc-choice'],
        })
      ).commands,
    ).toEqual([]);
  });
  it('delivers a Trainer result only to its player and releases after that player saves once', async () => {
    const battle = await activeTrainer();
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'b';
    finished.runtime.serial++;
    finished.teams.a.pokemons[0].pokemon.stats[0].value = 0;
    await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: finished,
      processedCommandIds: [],
    });
    service.disconnect(actors[2].socketId);
    const finalizing = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(finalizing.phase).toBe('finalizing');
    expect(finalizing.lockHeld).toBe(true);
    expect(Object.keys(finalizing.results)).toEqual(['a']);
    expect(finalizing.results.a.outcome).toBe('lose');
    expect(finalizing.results.a.patches[0].hp).toBe(0);
    const result = finalizing.results.a;
    const payload = {
      battleId: battle.battleId,
      resultId: result.resultId,
      snapshotId: result.snapshotId,
      baseHash: result.baseHash,
    };
    const foreign = {
      ...actors[2],
      clientId: 'foreign',
      socketId: 'foreign-socket',
    };
    service.connect(foreign);
    await expect(service.applied(foreign, payload)).rejects.toMatchObject({
      code: 'OWNER_REQUIRED',
    });
    service.connect(actors[2]);
    const completed = await service.applied(actors[2], payload);
    expect(completed.phase).toBe('finalized');
    expect(completed.lockHeld).toBe(false);
    expect((await service.applied(actors[2], payload)).revision).toBe(
      completed.revision,
    );
    expect(
      (
        await service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).results,
    ).toEqual(finalizing.results);
    expect(await repo.locked()).toEqual([]);
  });
  it('accepts native Struggle for either side at zero PP without enabling exhausted ordinary moves', async () => {
    let battle = await activeTrainer();
    const exhausted = clone(battle.session);
    exhausted.runtime.serial++;
    for (const side of ['a', 'b']) {
      exhausted.runtime.requests[side].moves = [
        { id: 33, name: 'Tackle', pp: 0, maxpp: 35, disabled: false },
        { id: 165, name: 'Struggle', pp: 0, maxpp: 0, disabled: false },
      ];
    }
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: exhausted,
      processedCommandIds: [],
    });
    for (const side of ['a', 'b'] as const) {
      const base = {
        battleId: battle.battleId,
        commandId: `struggle-${side}`,
        side,
        requestKey: requestKey(battle.session, side),
      };
      await expect(
        service.command(actors[1], {
          ...base,
          choice: { kind: 'move', moveId: 33 },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
      await service.command(actors[1], {
        ...base,
        choice: { kind: 'move', moveId: 165 },
      });
    }
    expect(
      (await repo.get(battle.battleId)).commands.map((command) => [
        command.side,
        command.choice,
      ]),
    ).toEqual([
      ['a', { kind: 'move', moveId: 165 }],
      ['b', { kind: 'move', moveId: 165 }],
    ]);
  });
  it('supports native locked recharge move zero but rejects it outside its forced request', async () => {
    let battle = await activeTrainer();
    const payload = {
      battleId: battle.battleId,
      commandId: 'recharge',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'move', moveId: 0 },
    };
    await expect(service.command(actors[1], payload)).rejects.toMatchObject({
      code: 'INVALID_CHOICE',
    });
    const forced = clone(battle.session);
    forced.runtime.serial++;
    forced.runtime.requests.b.locked = true;
    forced.runtime.requests.b.moves = [
      { id: 0, name: 'Recharge', pp: 0, maxpp: 0, disabled: false },
    ];
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: forced,
      processedCommandIds: [],
    });
    const queued = await service.command(actors[1], {
      ...payload,
      requestKey: requestKey(battle.session, 'b'),
    });
    expect(queued.commands[0].choice).toEqual({ kind: 'move', moveId: 0 });
    const pending = clone(forced);
    pending.runtime.serial++;
    pending.runtime.pending.b = { kind: 'move', moveId: 0 };
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 2,
      session: pending,
      processedCommandIds: ['recharge'],
    });
    const invalid = clone(pending);
    invalid.runtime.requests.b.locked = false;
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 3,
        session: invalid,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(battle.session.runtime.pending.b.moveId).toBe(0);
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
  it('transports a one-player Trainer battle and final result without an NPC socket or false owner', async () => {
    const [admin, player, outsider] = await Promise.all([
      connect(1),
      connect(2),
      connect(3),
    ]);
    const created = await ack(admin, 'pvp:create', {
      commandId: 'socket-trainer',
      playerAId: 2,
      trainerPresetId: 'kanto-misty',
    });
    expect(created.ok).toBe(true);
    expect(created.state.mode).toBe('trainer');
    expect(created.state.players.b).toBeUndefined();
    expect(
      (
        await ack(player, 'pvp:snapshot', {
          snapshot: snapshot(created.state, 2, 'client-2'),
        })
      ).ok,
    ).toBe(true);
    const own = await ack(player, 'pvp:sync', {});
    expect(own.state.phase).toBe('ready');
    expect(own.state.trainer.name).toBe('Misty');
    expect(own.state.trainer.team).toBeUndefined();
    expect(own.state.session).toBeUndefined();
    expect((await ack(outsider, 'pvp:sync', {})).state).toBeNull();
    let battle = await repo.get(created.state.battleId);
    expect(
      (
        await ack(admin, 'pvp:checkpoint', {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 0,
          session: session(battle),
          processedCommandIds: [],
        })
      ).ok,
    ).toBe(true);
    battle = await repo.get(battle.battleId);
    const forbidden = await ack(player, 'pvp:command', {
      battleId: battle.battleId,
      commandId: 'player-npc-choice',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'forfeit' },
    });
    expect(forbidden.error.code).toBe('HOST_REQUIRED');
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    finished.runtime.serial++;
    expect(
      (
        await ack(admin, 'pvp:checkpoint', {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 1,
          session: finished,
          processedCommandIds: [],
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await ack(admin, 'pvp:finalize', {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).ok,
    ).toBe(true);
    const resultView = (await ack(player, 'pvp:sync', {})).state;
    expect(resultView.phase).toBe('finalizing');
    expect(resultView.result.outcome).toBe('win');
    const result = resultView.result;
    const applied = await ack(player, 'pvp:applied', {
      battleId: battle.battleId,
      resultId: result.resultId,
      snapshotId: result.snapshotId,
      baseHash: result.baseHash,
    });
    expect(applied.ok).toBe(true);
    expect(applied.state.phase).toBe('finalized');
    expect((await repo.get(battle.battleId)).lockHeld).toBe(false);
  });
});
describe('Full Restore battle inventory settlement', () => {
  let repo: MemoryPvpRepository,
    wallets: MemoryShopRepository,
    shop: ShopService,
    pvp: PvpService;
  let actors: Record<number, Actor>, battle: Battle;
  beforeEach(async () => {
    const auth = fakeAuth();
    const activity = new PlayerActivityService();
    repo = new MemoryPvpRepository();
    wallets = new MemoryShopRepository();
    shop = new ShopService(wallets, auth as any, activity);
    pvp = new PvpService(repo, auth as any, activity, shop);
    await shop.onModuleInit();
    await pvp.onModuleInit();
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
    for (const actor of Object.values(actors)) {
      shop.connect(actor);
      pvp.connect(actor);
    }
    for (const userId of [2, 3]) {
      await shop.presence(actors[userId], { ready: true, localBattle: false });
      wallets.rows.get(userId).items['full-restore'] = 2;
    }
    battle = await pvp.create(actors[1], {
      commandId: 'inventory-battle',
      playerAId: 2,
      playerBId: 3,
    });
    for (const userId of [2, 3])
      await pvp.snapshot(actors[userId], {
        snapshot: snapshot(battle, userId, actors[userId].clientId),
      });
    battle = await repo.get(battle.battleId);
    battle = await pvp.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  });
  async function item() {
    return pvp.command(actors[1], {
      battleId: battle.battleId,
      commandId: 'restore-action',
      side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: {
        kind: 'item',
        item: 'full-restore',
        captureId: battle.session.teams.a.activeCaptureId,
      },
    });
  }
  function checkpoint(input: Battle, used: string[], pending = false) {
    const next = clone(input.session);
    next.networkItems = {
      pending: pending
        ? {
            a: {
              commandId: 'restore-action',
              captureId: next.teams.a.activeCaptureId,
            },
          }
        : {},
      used,
    };
    next.runtime.pending = pending
      ? {
          a: {
            kind: 'item',
            item: 'full-restore',
            captureId: next.teams.a.activeCaptureId,
          },
        }
      : {};
    next.runtime.serial++;
    return {
      battleId: input.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: input.checkpointRevision,
      session: next,
      processedCommandIds: input.commands.map((c) => c.commandId),
    };
  }
  it('reserves a legal choice without debit, then charges once on effect checkpoint and survives replay', async () => {
    const queued = await item();
    expect(queued.commands[0].inventoryAuthorized).toBe(true);
    expect(await shop.fullRestoreStock(2)).toBe(2);
    const payload = checkpoint(queued, ['restore-action']);
    const done = await pvp.checkpoint(actors[1], payload);
    expect(done.inventory.a).toBe(1);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    await pvp.checkpoint(actors[1], payload);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(wallets.rows.get(2).battleUses).toHaveLength(1);
    expect(wallets.rows.get(2).balance).toBe(500);
  });
  it('a pending choice cancelled before execution never consumes a unit', async () => {
    const selected = await pvp.checkpoint(
      actors[1],
      checkpoint(await item(), [], true),
    );
    const cancelled = await pvp.command(actors[1], {
      battleId: battle.battleId,
      commandId: 'cancel-item',
      side: 'a',
      requestKey: requestKey(selected.session, 'a'),
      choice: { kind: 'cancel' },
    });
    await pvp.checkpoint(actors[1], checkpoint(cancelled, []));
    expect(await shop.fullRestoreStock(2)).toBe(2);
  });
  it('recovering after wallet debit and a failed checkpoint write does not debit again', async () => {
    const queued = await item(),
      payload = checkpoint(queued, ['restore-action']);
    const cas = repo.compareAndSwap.bind(repo);
    let failCommit = true;
    repo.compareAndSwap = async (next, rev) => {
      if (
        failCommit &&
        next.session?.networkItems?.used?.includes('restore-action') &&
        !next.pendingInventoryCheckpoint
      ) {
        failCommit = false;
        throw new Error('simulated checkpoint write failure');
      }
      return cas(next, rev);
    };
    await expect(pvp.checkpoint(actors[1], payload)).rejects.toThrow(
      'simulated',
    );
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint,
    ).toBeDefined();
    const resumed = await pvp.sync(actors[1], { battleId: battle.battleId });
    expect(resumed.state.session.networkItems.used).toEqual(['restore-action']);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint,
    ).toBeUndefined();
  });
  it('rejects zero stock and invented inventory receipts', async () => {
    await repo.compareAndSwap(
      { ...battle, inventory: { a: 0, b: 2 }, revision: battle.revision + 1 },
      battle.revision,
    );
    await expect(item()).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    await expect(
      pvp.checkpoint(
        actors[1],
        checkpoint(await repo.get(battle.battleId), ['invented']),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(await shop.fullRestoreStock(2)).toBe(2);
  });
  it('keeps unusual command IDs as data across persistence and inventory settlement', async () => {
    const queued = await pvp.command(actors[1], {
      battleId: battle.battleId, commandId: '__proto__', side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: { kind: 'item', item: 'full-restore', captureId: battle.session.teams.a.activeCaptureId },
    });
    await pvp.checkpoint(actors[1], checkpoint(queued, ['__proto__']));
    expect(await shop.fullRestoreStock(2)).toBe(1);
  });
});
