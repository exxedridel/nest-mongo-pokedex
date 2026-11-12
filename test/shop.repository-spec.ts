import mongoose from 'mongoose';
import {
  MongoShopRepository,
  ShopWalletSchema,
} from '../src/shop/shop.repository';
import { WalletRecord } from '../src/shop/shop.types';
const {
  createMongooseShopFixture,
} = require('./support/mongoose-shop-model.cjs');

describe('Mongo wallet atomic replacement (real Mongoose, fake driver)', () => {
  let fixture: ReturnType<typeof createMongooseShopFixture>,
    repository: MongoShopRepository;
  const wallet = (userId = 2): WalletRecord => ({
    userId,
    balance: 500,
    revision: 0,
    storageRevision: 0,
    currencyVersion: 1,
    items: {},
    purchases: [],
    resets: [],
    uses: [],
    battleUses: [],
  });
  beforeEach(() => {
    fixture = createMongooseShopFixture({ mongoose, schema: ShopWalletSchema });
    repository = new MongoShopRepository(fixture.model);
  });
  afterEach(() => fixture.dispose());
  it('initializes once with empty dictionaries preserved and isolates account IDs', async () => {
    expect(await repository.insert(wallet())).toBe(true);
    expect(await repository.insert(wallet())).toBe(false);
    expect(await repository.insert(wallet(3))).toBe(true);
    expect(fixture.rows.get(2).items).toEqual({});
    expect(await repository.get(2)).toEqual(wallet());
    expect(await repository.get(3)).toEqual(wallet(3));
  });
  it('persists debit, items and pending receipt as one fenced replacement', async () => {
    await repository.insert(wallet());
    const row = wallet();
    row.balance = 200;
    row.revision = 1;
    row.storageRevision = 1;
    row.items['great-ball'] = 1;
    row.purchases.push({
      purchaseId: 'purchase',
      requestId: 'request',
      requestHash: 'hash',
      adminUserId: 1,
      userId: 2,
      clientId: 'client',
      itemId: 'great-ball',
      quantity: 1,
      unitPrice: 300,
      total: 300,
      balanceBefore: 500,
      balanceAfter: 200,
      walletRevision: 1,
      status: 'pending',
    });
    expect(await repository.compareAndSwap(row, 0)).toBe(true);
    expect(await repository.compareAndSwap(wallet(), 0)).toBe(false);
    expect(await repository.get(2)).toEqual(row);
    expect(await repository.forAdmin(1)).toEqual([row]);
    expect(await repository.forAdmin(4)).toEqual([]);
  });
  it('adds a reset to a legacy wallet atomically without losing purchase history, and preserves empty items', async () => {
    const legacy = wallet();
    delete legacy.resets;
    legacy.balance = 200;
    legacy.items = { 'great-ball': 1 };
    legacy.revision = 1;
    legacy.storageRevision = 2;
    fixture.rows.set(2, { ...legacy, _id: 2 });
    const row = await repository.get(2);
    expect(row.resets).toBeUndefined();
    row.balance = 500;
    row.items = {};
    row.revision = 2;
    row.storageRevision = 3;
    row.resets = [
      {
        requestId: 'new-game',
        userId: 2,
        clientId: 'client-2',
        requestHash: 'hash',
        walletRevision: 2,
        status: 'pending',
      },
    ];
    expect(await repository.compareAndSwap(row, 2)).toBe(true);
    expect(fixture.rows.get(2).items).toEqual({});
    expect((await repository.get(2)).resets).toEqual(row.resets);
    expect(await repository.compareAndSwap(legacy, 2)).toBe(false);
    row.resets[0].status = 'applied';
    row.storageRevision++;
    expect(await repository.compareAndSwap(row, 3)).toBe(true);
    expect((await repository.get(2)).revision).toBe(2);
  });
  it('persists a cancellation tombstone without changing wallet revision or amount', async () => {
    await repository.insert(wallet());
    const row = await repository.get(2);
    row.resets = [
      {
        requestId: 'aborted',
        userId: 2,
        clientId: 'client-2',
        requestHash: 'hash',
        walletRevision: 0,
        status: 'cancelled',
      },
    ];
    row.storageRevision++;
    expect(await repository.compareAndSwap(row, 0)).toBe(true);
    const saved = await repository.get(2);
    expect(saved).toMatchObject({
      balance: 500,
      revision: 0,
      storageRevision: 1,
    });
    expect(saved.resets[0].status).toBe('cancelled');
  });
});
