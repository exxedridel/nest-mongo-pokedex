import mongoose from 'mongoose';
import { MongoPvpRepository, PvpBattleSchema } from '../src/pvp/pvp.repository';
import { digest } from '../src/pvp/pvp.validation';
import { Battle } from '../src/pvp/pvp.types';
import { trainerPreset } from '../src/pvp/pvp.trainers';
const {
  createMongoosePvpFixture,
} = require('./support/mongoose-pvp-model.cjs');

function battle(): Battle {
  const pokemons: any[] = [
    {
      captureId: 'first',
      pokemon: { stats: [{ name: 'hp', value: 17 }] },
      statusTurns: {},
    },
    { captureId: 'second', pokemon: { stats: [{ name: 'hp', value: 29 }] } },
  ];
  return {
    battleId: 'persisted-battle',
    creationKey: 'create-one',
    creationHash: 'hash',
    phase: 'active',
    revision: 4,
    checkpointRevision: 1,
    lockHeld: true,
    lockedUserIds: [2, 3],
    adminId: 1,
    host: { userId: 1, clientId: 'admin-client', epoch: 2 },
    players: Object.fromEntries(
      ['a', 'b'].map((side, index) => [
        side,
        {
          user: {
            id: index + 2,
            role: 'player',
            email: `${side}@example.test`,
            first_name: side,
            last_name: 'QA',
          },
          clientId: `player-${side}`,
          snapshot: {
            version: 1,
            battleId: 'persisted-battle',
            snapshotId: `snapshot-${side}`,
            userId: index + 2,
            clientId: `player-${side}`,
            dataVersion: 'test',
            pokemons: structuredClone(pokemons),
            baseHash: digest(pokemons),
            activeCaptureId: 'first',
            hpMultiplier: 1.3,
          },
        },
      ]),
    ) as Battle['players'],
    session: {
      teams: Object.fromEntries(
        ['a', 'b'].map((side) => [
          side,
          { pokemons: structuredClone(pokemons) },
        ]),
      ),
      runtime: {
        engine: '{"opaque":"unchanged"}',
        turn: 1,
        serial: 0,
        pending: {},
        requests: { a: { moves: [] }, b: { moves: [] } },
        ended: false,
        winner: null,
      },
    },
    commands: [],
    commandHashes: {},
    applied: { a: false, b: false },
  };
}

describe('Mongo PvP serialization and recovery (real Mongoose, fake driver)', () => {
  let fixture: ReturnType<typeof createMongoosePvpFixture>;
  let repository: MongoPvpRepository;
  beforeEach(() => {
    fixture = createMongoosePvpFixture({ mongoose, schema: PvpBattleSchema });
    repository = new MongoPvpRepository(fixture.model);
  });
  afterEach(() => fixture.dispose());

  it('round-trips zero PP, per-item budgets and the item-bound recovery outbox', async () => {
    const input = battle();
    input.session.teams.a.pokemons[0].moves = [{ id: 1, pp: 35, currentPp: 0 }];
    input.inventory = { a: 1, b: 0 };
    input.itemInventory = {
      a: { 'full-restore': 1, 'max-ether': 2, 'max-elixir': 0 },
      b: {},
    };
    input.itemCommands = {
      key: {
        commandId: 'ether',
        side: 'a',
        captureId: 'first',
        requestKey: 'request',
        itemId: 'max-ether',
        moveId: 1,
      },
    };
    input.pendingInventoryCheckpoint = {
      session: input.session,
      processedCommandIds: ['ether'],
      expectedRevision: 1,
      epoch: 2,
      fingerprint: 'hash',
      charges: [
        {
          commandId: 'ether',
          side: 'a',
          userId: 2,
          itemId: 'max-ether',
          moveId: 1,
        },
      ],
    };
    await repository.insert(input);
    input.revision++;
    expect(await repository.compareAndSwap(input, 4)).toBe(true);
    const read = await repository.get(input.battleId);
    expect(read.itemInventory).toEqual(input.itemInventory);
    expect(read.itemCommands).toEqual(input.itemCommands);
    expect(read.pendingInventoryCheckpoint).toEqual(
      input.pendingInventoryCheckpoint,
    );
    expect(read.session.teams.a.pokemons[0].moves[0].currentPp).toBe(0);
  });

  it('reproduces the previous loss with minimize:true and preserves maps on insert and replacement', async () => {
    const oldSchema = PvpBattleSchema.clone().set('minimize', true);
    const old = createMongoosePvpFixture({ mongoose, schema: oldSchema });
    try {
      const broken = new MongoPvpRepository(old.model);
      await broken.insert(battle());
      expect(old.rows.get('persisted-battle').commandHashes).toBeUndefined();
      await broken.compareAndSwap(battle(), 4);
      expect(
        old.rows.get('persisted-battle').session.runtime.pending,
      ).toBeUndefined();
    } finally {
      old.dispose();
    }
    await repository.insert(battle());
    expect(fixture.rows.get('persisted-battle').commandHashes).toEqual({});
    expect(
      fixture.rows.get('persisted-battle').session.runtime.pending,
    ).toEqual({});
    const next = battle();
    next.revision++;
    expect(await repository.compareAndSwap(next, 4)).toBe(true);
    expect(fixture.rows.get(next.battleId).session.runtime.pending).toEqual({});
    expect(
      fixture.rows.get(next.battleId).players.a.snapshot.pokemons[0]
        .statusTurns,
    ).toEqual({});
    expect(await repository.compareAndSwap(battle(), 4)).toBe(false);
  });
  it('persists Trainer metadata and its single real owner across Mongo replacement', async () => {
    const input = battle();
    input.mode = 'trainer';
    input.trainer = trainerPreset('kanto-brock');
    delete input.players.b;
    input.lockedUserIds = [2];
    input.applied.b = true;
    await repository.insert(input);
    input.revision++;
    expect(await repository.compareAndSwap(input, 4)).toBe(true);
    const read = await repository.get(input.battleId);
    expect(read.mode).toBe('trainer');
    expect(read.trainer).toEqual(input.trainer);
    expect(read.players.b).toBeUndefined();
    expect(read.lockedUserIds).toEqual([2]);
    expect(read.trainer.team.pokemons[0].statusTurns).toEqual({});
  });

  it.each(['get', 'byCreationKey', 'locked'] as const)(
    'recovers legacy maps through %s without changing battle state',
    async (method) => {
      const input = battle();
      const legacy = new fixture.model(input).toObject({ minimize: true });
      legacy._id = input.battleId;
      fixture.rows.set(input.battleId, legacy);
      const read =
        method === 'locked'
          ? (await repository.locked())[0]
          : await repository[method](
              method === 'get' ? input.battleId : input.creationKey,
            );
      expect(read.commandHashes).toEqual({});
      expect(read.session.runtime.pending).toEqual({});
      expect(read.session.runtime.engine).toEqual(input.session.runtime.engine);
      expect(read.session.teams.a.pokemons[0].statusTurns).toEqual({});
      expect(read.players.a.snapshot).toEqual(input.players.a.snapshot);
      expect(read.players.a.snapshot.pokemons[1].statusTurns).toBeUndefined();
      expect(read.lockHeld).toBe(true);
      expect(read.lockedUserIds).toEqual([2, 3]);
      expect(read.host).toEqual(input.host);
      expect(read.revision).toBe(4);
      expect(read.checkpointRevision).toBe(1);
      expect(legacy.session.runtime.pending).toBeUndefined();
    },
  );

  it('keeps choices, command deduplication and invalid snapshot hashes untouched', async () => {
    const input = battle();
    input.session.runtime.pending = { a: { kind: 'move', moveId: 150 } };
    input.commandHashes = { existing: 'original-hash' };
    input.players.a.snapshot.baseHash = '0'.repeat(64);
    await repository.insert(input);
    const read = await repository.get(input.battleId);
    expect(read.session.runtime.pending).toEqual(input.session.runtime.pending);
    expect(read.commandHashes).toEqual(input.commandHashes);
    expect(read.players.a.snapshot.baseHash).toBe('0'.repeat(64));
    expect(await repository.get('missing')).toBeNull();
  });

  it('recovers mandatory result maps but does not reconstruct missing requests or explicit null corruption', async () => {
    const input = battle() as any;
    input.session.runtime.pending = null;
    delete input.session.runtime.requests;
    input.results = {
      a: { patches: [{ captureId: 'first', hp: 17, statuses: [] }] },
    };
    await repository.insert(input);
    const read = await repository.get(input.battleId);
    expect(read.session.runtime.pending).toBeNull();
    expect(read.session.runtime.requests).toBeUndefined();
    expect(read.results.a.patches[0].statusTurns).toEqual({});
  });
});
