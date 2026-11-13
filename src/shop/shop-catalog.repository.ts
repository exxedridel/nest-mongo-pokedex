import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { clone, ShopCatalog, ShopItemId } from './shop.types';

export const SHOP_CATALOG_REPOSITORY = Symbol('SHOP_CATALOG_REPOSITORY');
export const SHOP_CATALOG_MODEL = 'ShopCatalog';
export type ShopCatalogRecord = ShopCatalog & {
  changes: {
    adminUserId: number;
    requestId: string;
    itemId: ShopItemId;
    price: number;
    requestHash: string;
    createdAt: number;
  }[];
};
export interface ShopCatalogRepository {
  ready(): Promise<void>;
  get(): Promise<ShopCatalogRecord | null>;
  insert(record: ShopCatalogRecord): Promise<boolean>;
  compareAndSwap(record: ShopCatalogRecord, revision: number): Promise<boolean>;
}
export const ShopCatalogSchema = new Schema(
  {
    _id: { type: String, required: true },
    revision: { type: Number, required: true },
    prices: { type: Schema.Types.Mixed, required: true },
    changes: { type: [Schema.Types.Mixed], required: true },
  },
  {
    collection: 'shop_catalog',
    versionKey: false,
    strict: 'throw',
    minimize: false,
  },
);

@Injectable()
export class MongoShopCatalogRepository implements ShopCatalogRepository {
  constructor(
    @InjectModel(SHOP_CATALOG_MODEL) private readonly model: Model<any>,
  ) {}
  async ready() {
    await this.model.createIndexes();
  }
  async get() {
    return this.model
      .findById('global')
      .select('-_id')
      .lean<ShopCatalogRecord>()
      .exec();
  }
  async insert(record: ShopCatalogRecord) {
    try {
      await this.model.create([{ ...record, _id: 'global' }], {
        writeConcern: { w: 1, j: true },
      });
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }
  async compareAndSwap(record: ShopCatalogRecord, revision: number) {
    const result = await this.model
      .replaceOne(
        { _id: 'global', revision },
        { ...record, _id: 'global' },
        { writeConcern: { w: 1, j: true } },
      )
      .exec();
    return result.matchedCount === 1;
  }
}
export class MemoryShopCatalogRepository implements ShopCatalogRepository {
  private row: ShopCatalogRecord | null = null;
  async ready() {}
  async get() {
    return clone(this.row);
  }
  async insert(record: ShopCatalogRecord) {
    if (this.row) return false;
    this.row = clone(record);
    return true;
  }
  async compareAndSwap(record: ShopCatalogRecord, revision: number) {
    if (this.row?.revision !== revision) return false;
    this.row = clone(record);
    return true;
  }
}
