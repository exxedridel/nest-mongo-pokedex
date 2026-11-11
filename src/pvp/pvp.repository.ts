import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { Battle, clone, fail } from './pvp.types';
import { digest } from './pvp.validation';

export const PVP_REPOSITORY = Symbol('PVP_REPOSITORY');
export const PVP_MODEL = 'PvpBattle';
export interface PvpRepository {
  ready(): Promise<void>;
  get(battleId: string): Promise<Battle | null>;
  byCreationKey(key: string): Promise<Battle | null>;
  locked(): Promise<Battle[]>;
  insert(battle: Battle): Promise<void>;
  compareAndSwap(battle: Battle, expectedRevision: number): Promise<boolean>;
}

export const PvpBattleSchema = new Schema(
  {
    _id: { type: String, required: true },
    battleId: { type: String, required: true },
    mode: { type: String, enum: ['trainer'] },
    trainer: Schema.Types.Mixed,
    creationKey: { type: String, required: true },
    creationHash: { type: String, required: true },
    phase: { type: String, required: true },
    revision: { type: Number, required: true },
    checkpointRevision: { type: Number, required: true },
    lockHeld: { type: Boolean, required: true },
    lockedUserIds: { type: [Number], required: true },
    adminId: { type: Number, required: true },
    host: Schema.Types.Mixed,
    players: Schema.Types.Mixed,
    session: Schema.Types.Mixed,
    commands: [Schema.Types.Mixed],
    commandHashes: Schema.Types.Mixed,
    applied: Schema.Types.Mixed,
    results: Schema.Types.Mixed,
    lastCheckpoint: Schema.Types.Mixed,
  },
  {
    collection: 'pvp_battles',
    versionKey: false,
    strict: 'throw',
    // Empty dictionaries are protocol data, especially runtime.pending. Mongo
    // must preserve them, including inside Mixed fields and replacements.
    minimize: false,
  },
);
PvpBattleSchema.index({ creationKey: 1 }, { unique: true });
PvpBattleSchema.index(
  { lockedUserIds: 1 },
  { unique: true, partialFilterExpression: { lockHeld: true } },
);
PvpBattleSchema.index(
  { adminId: 1 },
  { unique: true, partialFilterExpression: { lockHeld: true } },
);

/** Recover only empty dictionaries removed by the former minimize:true schema.
 * Never rebuild engine/requests or change HP, choices, revisions or reservations.
 */
function restorePersistedBattle(battle: Battle | null): Battle | null {
  if (!battle) return battle;
  if (battle.commandHashes === undefined) battle.commandHashes = {};
  if (battle.session?.runtime?.pending === undefined && battle.session?.runtime)
    battle.session.runtime.pending = {};
  for (const capture of battle.trainer?.team?.pokemons ?? [])
    if (capture.statusTurns === undefined) capture.statusTurns = {};
  for (const side of ['a', 'b'] as const) {
    for (const capture of battle.session?.teams?.[side]?.pokemons ?? [])
      if (capture.statusTurns === undefined) capture.statusTurns = {};
    for (const patch of battle.results?.[side]?.patches ?? [])
      if (patch.statusTurns === undefined) patch.statusTurns = {};

    const snapshot = battle.players?.[side]?.snapshot;
    if (
      !snapshot ||
      !Array.isArray(snapshot.pokemons) ||
      snapshot.pokemons.length > 6
    )
      continue;
    // A snapshot can legitimately omit optional statusTurns. Restore only the
    // exact subset of empty maps authenticated by its ORIGINAL content hash.
    const missing = snapshot.pokemons.flatMap((capture, index) =>
      capture.statusTurns === undefined ? [index] : [],
    );
    if (!missing.length || digest(snapshot.pokemons) === snapshot.baseHash)
      continue;
    for (let mask = 1; mask < 1 << missing.length; mask++) {
      const candidate = clone(snapshot.pokemons);
      missing.forEach((index, bit) => {
        if (mask & (1 << bit)) candidate[index].statusTurns = {};
      });
      if (digest(candidate) === snapshot.baseHash) {
        snapshot.pokemons = candidate;
        break;
      }
    }
  }
  return battle;
}
@Injectable()
export class MongoPvpRepository implements PvpRepository {
  constructor(@InjectModel(PVP_MODEL) private readonly model: Model<any>) {}
  async ready() {
    await this.model.createIndexes();
  }
  async get(battleId: string): Promise<Battle | null> {
    return restorePersistedBattle(
      await this.model.findById(battleId).select('-_id').lean<Battle>().exec(),
    );
  }
  async byCreationKey(creationKey: string): Promise<Battle | null> {
    return restorePersistedBattle(
      await this.model
        .findOne({ creationKey })
        .select('-_id')
        .lean<Battle>()
        .exec(),
    );
  }
  async locked(): Promise<Battle[]> {
    const battles = await this.model
      .find({ lockHeld: true })
      .select('-_id')
      .lean<Battle[]>()
      .exec();
    return battles.map((battle) => restorePersistedBattle(battle)!);
  }
  async insert(battle: Battle) {
    try {
      await this.model.create([{ ...battle, _id: battle.battleId }], {
        writeConcern: { w: 1, j: true },
      });
    } catch (error) {
      if (error?.code === 11000)
        fail('PLAYER_BUSY', 'El administrador o un jugador ya está reservado.');
      throw error;
    }
  }
  async compareAndSwap(battle: Battle, expectedRevision: number) {
    const result = await this.model
      .replaceOne(
        { _id: battle.battleId, revision: expectedRevision },
        { ...battle, _id: battle.battleId },
        { writeConcern: { w: 1, j: true } },
      )
      .exec();
    return result.matchedCount === 1;
  }
}

// Exported in dist for isolated QA; no Mongo connection or application globals.
export class MemoryPvpRepository implements PvpRepository {
  private readonly rows = new Map<string, Battle>();
  constructor(initial: Battle[] = []) {
    for (const battle of initial) this.rows.set(battle.battleId, clone(battle));
  }
  async ready() {}
  async get(id: string) {
    return clone(this.rows.get(id) ?? null);
  }
  async byCreationKey(key: string) {
    return clone(
      [...this.rows.values()].find((row) => row.creationKey === key) ?? null,
    );
  }
  async locked() {
    return clone([...this.rows.values()].filter((row) => row.lockHeld));
  }
  private unique(battle: Battle) {
    for (const other of this.rows.values()) {
      if (other.battleId === battle.battleId) continue;
      if (
        other.creationKey === battle.creationKey ||
        (battle.lockHeld &&
          other.lockHeld &&
          (battle.adminId === other.adminId ||
            battle.lockedUserIds.some((id) =>
              other.lockedUserIds.includes(id),
            )))
      )
        fail('PLAYER_BUSY', 'El administrador o un jugador ya está reservado.');
    }
  }
  async insert(battle: Battle) {
    if (this.rows.has(battle.battleId))
      fail('PLAYER_BUSY', 'La batalla ya existe.');
    this.unique(battle);
    this.rows.set(battle.battleId, clone(battle));
  }
  async compareAndSwap(battle: Battle, expectedRevision: number) {
    if (this.rows.get(battle.battleId)?.revision !== expectedRevision)
      return false;
    this.unique(battle);
    this.rows.set(battle.battleId, clone(battle));
    return true;
  }
}
