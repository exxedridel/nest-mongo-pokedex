import mongoose from 'mongoose';
import {
  MongoShopRepository,
  ShopWalletSchema,
} from '../src/shop/shop.repository';
import { WalletRecord, walletView } from '../src/shop/shop.types';
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
  it('preserves reward generation and terminal receipts atomically without backfilling legacy documents', async () => {
    const row = wallet();
    await repository.insert(row);
    const legacy = await repository.get(2);
    expect(legacy).not.toHaveProperty('rewardEpoch');
    expect(walletView(legacy).rewardEpoch).toBe(0);
    const next = {
      ...legacy,
      rewardEpoch: 1,
      balance: 700,
      revision: 1,
      storageRevision: 1,
      rewards: [
        {
          rewardId: 'local:win',
          userId: 2,
          source: 'local-trainer' as const,
          encounterId: 'win',
          epoch: 1,
          color: 'pink' as const,
          amount: 200,
          walletRevision: 1,
          status: 'credited' as const,
          requestHash: 'original-reward-hash',
        },
      ],
    };
    expect(await repository.compareAndSwap(next, 0)).toBe(true);
    expect(await repository.get(2)).toMatchObject(next);
    expect(await repository.compareAndSwap({ ...next, balance: 900 }, 0)).toBe(
      false,
    );
    expect((await repository.get(2)).balance).toBe(700);
  });
  it('roundtrips independent background streams, hashes and terminal rejections without adding fields to legacy wallets', async () => {
    const row = wallet();
    await repository.insert(row);
    expect(await repository.get(2)).not.toHaveProperty('consumptionClients');
    const operation = {
      operationId: 'same-id',
      sequence: 1,
      itemId: 'full-restore' as const,
      quantity: 1 as const,
      captureId: 'target',
      context: 'party' as const,
      userId: 2,
      walletRevision: 1,
    };
    const updated = await repository.get(2);
    updated.items['full-restore'] = 0;
    updated.revision = 1;
    updated.storageRevision++;
    updated.consumptionClients = [
      { clientId: 'first', throughSequence: 1 },
      { clientId: '__proto__', throughSequence: 1 },
    ];
    updated.consumptions = [
      {
        ...operation,
        clientId: 'first',
        status: 'accepted',
        requestHash: 'hash-first',
      },
      {
        ...operation,
        clientId: '__proto__',
        status: 'rejected',
        reason: 'INSUFFICIENT_ITEMS',
        requestHash: 'hash-second',
      },
    ];
    expect(await repository.compareAndSwap(updated, 0)).toBe(true);
    const restored = await repository.get(2);
    expect(restored.consumptions).toEqual(updated.consumptions);
    expect(walletView(restored, 'first').consumptionAck).toEqual({
      clientId: 'first',
      throughSequence: 1,
    });
    expect(walletView(restored, '__proto__').consumptionAck).toEqual({
      clientId: '__proto__',
      throughSequence: 1,
      rejected: [
        {
          operationId: 'same-id',
          sequence: 1,
          itemId: 'full-restore',
          reason: 'INSUFFICIENT_ITEMS',
        },
      ],
    });
    expect(walletView(restored, 'unregistered')).not.toHaveProperty(
      'consumptionAck',
    );
    expect(restored.balance).toBe(500);
  });
  it('roundtrips item gift receipts and precommit tombstones without rewriting a legacy purchase', async () => {
    const row = wallet();
    const legacy = {
      purchaseId: 'old-purchase',
      requestId: 'old-request',
      adminUserId: 1,
      userId: 2,
      clientId: 'client',
      itemId: 'poke-ball' as const,
      quantity: 1,
      unitPrice: 150,
      total: 150,
      balanceBefore: 650,
      balanceAfter: 500,
      walletRevision: 0,
      status: 'applied' as const,
      requestHash: 'old-hash',
    };
    row.purchases = [
      legacy,
      {
        ...legacy,
        kind: 'gift',
        purchaseId: 'gift',
        requestId: 'gift-request',
        itemId: 'tm',
        quantity: 3,
        unitPrice: 0,
        total: 0,
        balanceBefore: 500,
        walletRevision: 1,
        status: 'pending',
        requestHash: 'gift-hash',
      },
    ];
    row.items.tm = 3;
    row.revision = 1;
    row.storageRevision = 1;
    await repository.insert(row);
    const restored = await repository.get(2);
    expect(restored.purchases[0]).toEqual(legacy);
    expect(restored.purchases[0]).not.toHaveProperty('kind');
    restored.purchases[1].status = 'applied';
    restored.purchases.push({
      ...restored.purchases[1],
      purchaseId: 'cancelled-gift',
      requestId: 'cancelled-request',
      status: 'cancelled',
      requestHash: 'cancel-hash',
    });
    restored.storageRevision++;
    expect(await repository.compareAndSwap(restored, 1)).toBe(true);
    const final = await repository.get(2);
    expect(final.items).toEqual({ tm: 3 });
    expect(final.balance).toBe(500);
    expect(final.revision).toBe(1);
    expect(final.purchases.map((entry) => entry.status)).toEqual([
      'applied',
      'applied',
      'cancelled',
    ]);
    expect((await repository.forAdmin(1))[0].purchases).toEqual(
      final.purchases,
    );
  });
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
  it('roundtrips optional capture difficulty and its journal while preserving a legacy catalogue', async () => {
    const catalogFixture = createMongooseShopFixture({
      mongoose,
      schema: ShopCatalogSchema,
    });
    try {
      const repository = new MongoShopCatalogRepository(catalogFixture.model);
      const legacy = { revision: 0, prices: { ...SHOP_CATALOG }, changes: [] };
      await repository.insert(legacy);
      expect(await repository.get()).toEqual(legacy);
      const updated = {
        ...legacy,
        revision: 1,
        captureDifficulty: 2,
        changes: [
          {
            kind: 'capture-difficulty' as const,
            adminUserId: 1,
            requestId: 'difficulty',
            modifier: 2,
            requestHash: 'hash',
            createdAt: 123,
          },
        ],
      };
      expect(await repository.compareAndSwap(updated, 0)).toBe(true);
      expect(await repository.get()).toEqual(updated);
      expect(await repository.compareAndSwap(legacy, 0)).toBe(false);
    } finally {
      await catalogFixture.dispose();
    }
  });
  it('roundtrips an optional opponent-automation flag and journal without rewriting legacy catalogues', async () => {
    const catalogFixture = createMongooseShopFixture({
      mongoose,
      schema: ShopCatalogSchema,
    });
    try {
      const repository = new MongoShopCatalogRepository(catalogFixture.model);
      const legacy = { revision: 0, prices: { ...SHOP_CATALOG }, changes: [] };
      await repository.insert(legacy);
      expect(await repository.get()).toEqual(legacy);
      const enabled = {
        ...legacy,
        revision: 1,
        automaticOpponents: true,
        changes: [
          {
            kind: 'opponent-automation' as const,
            adminUserId: 1,
            requestId: 'auto-on',
            enabled: true,
            requestHash: 'hash',
            createdAt: 123,
          },
        ],
      };
      expect(await repository.compareAndSwap(enabled, 0)).toBe(true);
      expect(await repository.get()).toEqual(enabled);
      const disabled = { ...enabled, revision: 2, automaticOpponents: false };
      expect(await repository.compareAndSwap(disabled, 1)).toBe(true);
      expect((await repository.get()).automaticOpponents).toBe(false);
      expect(await repository.compareAndSwap(enabled, 1)).toBe(false);
    } finally {
      await catalogFixture.dispose();
    }
  });
  it('persists Center pending/applied/cancelled metadata without changing wallet revision, stock or cash', async () => {
    const row = wallet();
    row.centerRevision = 1;
    row.centerHeals = [
      {
        requestId: 'center-first',
        adminUserId: 1,
        userId: 2,
        clientId: 'center-browser',
        captureIds: ['one', 'two'],
        partyHash: 'a'.repeat(64),
        partyRevision: 12,
        planHash: 'b'.repeat(64),
        centerRevision: 1,
        status: 'pending',
        requestHash: 'immutable-request',
      },
    ];
    row.storageRevision = 1;
    await repository.insert(row);
    expect(await repository.get(2)).toEqual(row);
    expect((await repository.forAdmin(1))[0].centerHeals).toEqual(
      row.centerHeals,
    );
    const pending = await repository.get(2);
    pending.centerHeals[0].status = 'applied';
    pending.storageRevision++;
    expect(await repository.compareAndSwap(pending, 1)).toBe(true);
    pending.centerRevision = 2;
    pending.centerHeals.push({
      ...pending.centerHeals[0],
      requestId: 'center-second',
      centerRevision: 2,
      status: 'cancelled',
    });
    pending.storageRevision++;
    expect(await repository.compareAndSwap(pending, 2)).toBe(true);
    const stored = await repository.get(2);
    expect(stored.centerHeals.map((receipt) => receipt.status)).toEqual([
      'applied',
      'cancelled',
    ]);
    expect(stored.balance).toBe(500);
    expect(stored.items).toEqual({});
    expect(stored.revision).toBe(0);
  });
  it('round-trips cancelled adjustment compensation metadata without rewriting the original receipt', async () => {
    const row = wallet();
    row.revision = 2;
    row.storageRevision = 2;
    row.adjustments = [
      {
        adjustmentId: 'abort-id',
        requestId: 'abort-request',
        adminUserId: 1,
        userId: 2,
        clientId: 'client',
        delta: 10000,
        balanceBefore: 500,
        balanceAfter: 10500,
        walletRevision: 1,
        status: 'cancelled',
        cancelledWalletRevision: 2,
        cancelledBalance: 500,
        requestHash: 'original-hash',
      },
    ];
    await repository.insert(row);
    expect(await repository.get(2)).toEqual(row);
    expect((await repository.forAdmin(1))[0].adjustments[0]).toMatchObject({
      walletRevision: 1,
      cancelledWalletRevision: 2,
      status: 'cancelled',
      requestHash: 'original-hash',
    });
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
