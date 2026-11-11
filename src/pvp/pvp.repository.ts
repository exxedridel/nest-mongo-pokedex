import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { Battle, clone, fail } from './pvp.types';

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
  { collection: 'pvp_battles', versionKey: false, strict: 'throw' },
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

@Injectable()
export class MongoPvpRepository implements PvpRepository {
  constructor(@InjectModel(PVP_MODEL) private readonly model: Model<any>) {}
  async ready() {
    await this.model.createIndexes();
  }
  async get(battleId: string): Promise<Battle | null> {
    return this.model.findById(battleId).select('-_id').lean<Battle>().exec();
  }
  async byCreationKey(creationKey: string): Promise<Battle | null> {
    return this.model
      .findOne({ creationKey })
      .select('-_id')
      .lean<Battle>()
      .exec();
  }
  async locked(): Promise<Battle[]> {
    return this.model
      .find({ lockHeld: true })
      .select('-_id')
      .lean<Battle[]>()
      .exec();
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
