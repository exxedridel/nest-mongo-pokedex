import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { clone, WalletRecord } from './shop.types';

export const SHOP_REPOSITORY = Symbol('SHOP_REPOSITORY');
export const SHOP_MODEL = 'ShopWallet';
export interface ShopRepository {
  ready(): Promise<void>;
  get(userId: number): Promise<WalletRecord | null>;
  forAdmin(adminUserId: number): Promise<WalletRecord[]>;
  insert(wallet: WalletRecord): Promise<boolean>;
  compareAndSwap(
    wallet: WalletRecord,
    expectedStorageRevision: number,
  ): Promise<boolean>;
}
export const ShopWalletSchema = new Schema(
  {
    _id: { type: Number, required: true },
    userId: { type: Number, required: true },
    balance: { type: Number, required: true },
    revision: { type: Number, required: true },
    storageRevision: { type: Number, required: true },
    currencyVersion: { type: Number, required: true, enum: [1] },
    items: { type: Schema.Types.Mixed, required: true },
    purchases: { type: [Schema.Types.Mixed], required: true },
    resets: { type: [Schema.Types.Mixed], default: [] },
    uses: { type: [Schema.Types.Mixed], default: [] },
    battleUses: { type: [Schema.Types.Mixed], default: [] },
  },
  {
    collection: 'shop_wallets',
    versionKey: false,
    strict: 'throw',
    minimize: false,
  },
);
ShopWalletSchema.index({ userId: 1 }, { unique: true });
ShopWalletSchema.index({ 'purchases.adminUserId': 1 });

@Injectable()
export class MongoShopRepository implements ShopRepository {
  constructor(@InjectModel(SHOP_MODEL) private readonly model: Model<any>) {}
  async ready() {
    await this.model.createIndexes();
  }
  async get(userId: number) {
    return this.model
      .findById(userId)
      .select('-_id')
      .lean<WalletRecord>()
      .exec();
  }
  async forAdmin(adminUserId: number) {
    return this.model
      .find({ 'purchases.adminUserId': adminUserId })
      .select('-_id')
      .lean<WalletRecord[]>()
      .exec();
  }
  async insert(wallet: WalletRecord) {
    try {
      await this.model.create([{ ...wallet, _id: wallet.userId }], {
        writeConcern: { w: 1, j: true },
      });
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
  async compareAndSwap(wallet: WalletRecord, expectedStorageRevision: number) {
    const result = await this.model
      .replaceOne(
        { _id: wallet.userId, storageRevision: expectedStorageRevision },
        { ...wallet, _id: wallet.userId },
        { writeConcern: { w: 1, j: true } },
      )
      .exec();
    return result.matchedCount === 1;
  }
}

export class MemoryShopRepository implements ShopRepository {
  readonly rows = new Map<number, WalletRecord>();
  constructor(initial: WalletRecord[] = []) {
    for (const row of initial) this.rows.set(row.userId, clone(row));
  }
  async ready() {}
  async get(userId: number) {
    return clone(this.rows.get(userId) ?? null);
  }
  async forAdmin(adminUserId: number) {
    return clone(
      [...this.rows.values()].filter((row) =>
        row.purchases.some((purchase) => purchase.adminUserId === adminUserId),
      ),
    );
  }
  async insert(wallet: WalletRecord) {
    if (this.rows.has(wallet.userId)) return false;
    this.rows.set(wallet.userId, clone(wallet));
    return true;
  }
  async compareAndSwap(wallet: WalletRecord, expectedStorageRevision: number) {
    if (
      this.rows.get(wallet.userId)?.storageRevision !== expectedStorageRevision
    )
      return false;
    this.rows.set(wallet.userId, clone(wallet));
    return true;
  }
}
