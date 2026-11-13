import mongoose from 'mongoose';
import {
  MongoShopRepository,
  ShopWalletSchema,
} from '../src/shop/shop.repository';
import { WalletRecord } from '../src/shop/shop.types';
import {
  MongoShopCatalogRepository,
  ShopCatalogSchema,
} from '../src/shop/shop-catalog.repository';
import { SHOP_CATALOG } from '../src/shop/shop.types';
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
  it('persists a zero-price catalog and its revision using real Mongoose CAS', async () => {
    const catalogFixture = createMongooseShopFixture({
      mongoose,
      schema: ShopCatalogSchema,
    });
    try {
      const catalog = new MongoShopCatalogRepository(catalogFixture.model);
      await catalog.ready();
      const record = { revision: 0, prices: { ...SHOP_CATALOG }, changes: [] };
      expect(await catalog.insert(record)).toBe(true);
      const updated = {
        ...record,
        revision: 1,
        prices: { ...record.prices, tm: 0 },
      };
      expect(await catalog.compareAndSwap(updated, 0)).toBe(true);
      expect(await catalog.compareAndSwap(record, 0)).toBe(false);
      expect(await catalog.get()).toEqual(updated);
    } finally {
      await catalogFixture.dispose();
    }
  });
  it('persists adjustment receipts and finds an admin ledger without any purchases', async () => {
    const row = wallet();
    row.balance = 750;
    row.revision = 1;
    row.storageRevision = 1;
    row.adjustments = [
      {
        adjustmentId: 'balance-id',
        requestId: 'balance-request',
        adminUserId: 1,
        userId: 2,
        clientId: 'client',
        delta: 250,
        balanceBefore: 500,
        balanceAfter: 750,
        walletRevision: 1,
        status: 'pending',
        requestHash: 'hash',
      },
    ];
    await repository.insert(row);
    expect((await repository.forAdmin(1))[0].adjustments).toEqual(
      row.adjustments,
    );
    const restored = await repository.get(2);
    restored.adjustments[0].status = 'applied';
    restored.storageRevision++;
    expect(await repository.compareAndSwap(restored, 1)).toBe(true);
    expect((await repository.get(2)).adjustments[0].status).toBe('applied');
  });
  it('preserves pending/applied TM receipts, learned move and zero stock through Mongoose replacement', async () => {
    await repository.insert(wallet());
    const row = wallet();
    row.items = { tm: 0, 'full-restore': 2 };
    row.uses.push({
      requestId: 'tm-learn',
      userId: 2,
      clientId: 'client',
      itemId: 'tm',
      moveId: 33,
      captureId: 'capture',
      context: 'party',
      planHash: 'plan',
      expectedWalletRevision: 0,
      walletRevision: 1,
      status: 'pending',
      requestHash: 'hash',
    });
    row.revision = 1;
    row.storageRevision = 1;
    expect(await repository.compareAndSwap(row, 0)).toBe(true);
    expect(await repository.get(2)).toEqual(row);
    const restored = await repository.get(2);
    restored.uses[0].status = 'applied';
    restored.storageRevision++;
    expect(await repository.compareAndSwap(restored, 1)).toBe(true);
    expect((await repository.get(2)).uses[0]).toMatchObject({
      itemId: 'tm',
      moveId: 33,
      status: 'applied',
    });
    expect((await repository.get(2)).items.tm).toBe(0);
    expect((await repository.get(2)).revision).toBe(1);
  });
  it('preserves consumable selectors and zero stock through an atomic wallet replacement', async () => {
    await repository.insert(wallet());
    const row = wallet();
    row.items = { 'max-ether': 0, 'max-elixir': 1 };
    row.uses.push({
      requestId: 'ether',
      userId: 2,
      clientId: 'client',
      itemId: 'max-ether',
      moveId: 1,
      captureId: 'capture',
      context: 'party',
      planHash: 'plan',
      expectedWalletRevision: 0,
      walletRevision: 1,
      status: 'pending',
      requestHash: 'hash',
    });
    row.battleUses.push({
      key: 'battle-ether',
      battleId: 'battle',
      commandId: 'command',
      itemId: 'max-ether',
      moveId: 1,
    });
    row.storageRevision++;
    row.revision++;
    expect(await repository.compareAndSwap(row, 0)).toBe(true);
    expect(await repository.get(2)).toEqual(row);
  });
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
