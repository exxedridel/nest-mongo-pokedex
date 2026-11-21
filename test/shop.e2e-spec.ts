import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import {
  AuthIdentityService,
  MessageAuthError,
} from '../src/messages/auth-identity.service';
import { PlayerActivityService } from '../src/messages/player-activity.service';
import { PvpModule } from '../src/pvp/pvp.module';
import { MemoryPvpRepository } from '../src/pvp/pvp.repository';
import { PvpService } from '../src/pvp/pvp.service';
import { Actor } from '../src/pvp/pvp.types';
import { digest, validateChoice } from '../src/pvp/pvp.validation';
import { ShopModule } from '../src/shop/shop.module';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ShopService } from '../src/shop/shop.service';
import { ShopCatalogService } from '../src/shop/shop-catalog.service';
import {
  BALL_ITEM_IDS,
  clone,
  ShopError,
  SHOP_CATALOG,
} from '../src/shop/shop.types';

function fakeAuth() {
  const users = new Map(
    [1, 2, 3, 4].map((id) => [
      id,
      {
        id,
        email: `shop${id}@example.test`,
        first_name: `Shop${id}`,
        last_name: 'QA',
        role: id === 1 || id === 4 ? 'admin' : 'player',
      },
    ]),
  );
  return {
    users,
    async authenticate(token: string) {
      const user = users.get(Number(String(token).replace('shop-user-', '')));
      if (!user)
        throw new MessageAuthError(
          'SESSION_REVOKED',
          'Fixture session revoked',
        );
      return { user: clone(user), expiresAt: Date.now() + 3600000 };
    },
    async contacts(token: string, selfId: number) {
      await this.authenticate(token);
      return clone([...users.values()].filter((user) => user.id !== selfId));
    },
  };
}
function actors(auth: ReturnType<typeof fakeAuth>): Record<number, Actor> {
  return Object.fromEntries(
    [...auth.users.values()].map((user) => [
      user.id,
      {
        user: clone(user),
        clientId: `shop-client-${user.id}`,
        socketId: `shop-socket-${user.id}`,
        token: `shop-user-${user.id}`,
      },
    ]),
  ) as any;
}
const input = (overrides: Record<string, any> = {}) => ({
  requestId: 'purchase-1',
  playerUserId: 2,
  clientId: 'shop-client-2',
  itemId: 'poke-ball',
  quantity: 1,
  expectedWalletRevision: 0,
  ...overrides,
});
const resetInput = (overrides: Record<string, any> = {}) => ({
  requestId: 'reset-1',
  expectedWalletRevision: 0,
  ...overrides,
});
const starterResetInput = (overrides: Record<string, any> = {}) =>
  resetInput({ starterItemsVersion: 1, ...overrides });

describe('Authoritative Pokedollars and purchases', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    activity: PlayerActivityService,
    service: ShopService,
    pvp: PvpService;
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth as any, activity);
    pvp = new PvpService(new MemoryPvpRepository(), auth as any, activity);
    await pvp.onModuleInit();
    await service.onModuleInit();
    for (const client of Object.values(clients)) {
      service.connect(client);
      pvp.connect(client);
    }
    service.setPrepareHandler(async (_actor, request) => ({
      ok: true,
      revision: request.expectedWalletRevision,
      operation: request.operation,
    }));
    for (const userId of [2, 3])
      await service.presence(clients[userId], {
        ready: true,
        localBattle: false,
        supportsBalanceAdjustments: true,
      });
  });
  const priceInput = (overrides: Record<string, any> = {}) => ({
    requestId: 'price-change',
    itemId: 'poke-ball',
    price: 0,
    expectedCatalogRevision: 0,
    ...overrides,
  });
  const adjustmentInput = (overrides: Record<string, any> = {}) => ({
    requestId: 'balance-change',
    playerUserId: 2,
    clientId: 'shop-client-2',
    delta: 250,
    expectedWalletRevision: 0,
    ...overrides,
  });
  it('requires advertised balance support and an operation-aware PREPARE acknowledgement before changing cash', async () => {
    await service.presence(clients[2], { ready: true, localBattle: false });
    const prepare = jest.fn(async () => ({ ok: true, revision: 0 }));
    service.setPrepareHandler(prepare);
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput()),
    ).rejects.toMatchObject({ code: 'PLAYER_UPDATE_REQUIRED' });
    expect(prepare).not.toHaveBeenCalled();
    await service.presence(clients[2], {
      ready: true,
      localBattle: false,
      supportsBalanceAdjustments: true,
    });
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput()),
    ).rejects.toMatchObject({ code: 'PLAYER_NOT_READY' });
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).adjustments ?? []).toEqual([]);
  });
  it('aborts a pending 10000 PD gift once, preserves history and never revives it through a delayed ACK or replay', async () => {
    const request = adjustmentInput({ delta: 10000 });
    const created = await service.balanceAdjust(clients[1], request);
    const adjustmentId = created.adjustment.adjustmentId;
    expect((await repo.get(2)).balance).toBe(10500);
    await expect(activity.assertAvailable([2])).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    const aborted = await service.balanceAbort(clients[1], { adjustmentId });
    expect(aborted.adjustment).toMatchObject({
      status: 'cancelled',
      walletRevision: 1,
      cancelledWalletRevision: 2,
      cancelledBalance: 500,
      delta: 10000,
    });
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).adjustments).toHaveLength(1);
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
    await service.balanceAbort(clients[1], { adjustmentId });
    expect(
      (await service.balanceApplied(clients[2], { adjustmentId, revision: 1 }))
        .adjustment.status,
    ).toBe('cancelled');
    expect(
      (await service.balanceAdjust(clients[1], request)).adjustment.status,
    ).toBe('cancelled');
    expect((await repo.get(2)).revision).toBe(2);
    expect((await repo.get(2)).balance).toBe(500);
  });
  it('does not undo an already applied adjustment when abort is requested', async () => {
    const created = await service.balanceAdjust(
      clients[1],
      adjustmentInput({ delta: 10000 }),
    );
    const adjustmentId = created.adjustment.adjustmentId;
    await service.balanceApplied(clients[2], { adjustmentId, revision: 1 });
    expect(
      (await service.balanceAbort(clients[1], { adjustmentId })).adjustment
        .status,
    ).toBe('applied');
    expect((await repo.get(2)).balance).toBe(10500);
    expect((await repo.get(2)).revision).toBe(1);
  });
  it('allows the affected account to abort from another browser while rejecting other users and administrators', async () => {
    const created = await service.balanceAdjust(clients[1], adjustmentInput());
    const adjustmentId = created.adjustment.adjustmentId;
    await expect(
      service.balanceAbort(clients[3], { adjustmentId }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(
      service.balanceAbort(clients[4], { adjustmentId }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const alternate = {
      ...clients[2],
      clientId: 'alternate-client',
      socketId: 'alternate-socket',
    };
    service.connect(alternate);
    const result = await service.balanceAbort(alternate, { adjustmentId });
    expect(result.adjustment.status).toBe('cancelled');
    expect(result.wallet.balance).toBe(500);
    expect((await repo.get(2)).items).toEqual({});
  });
  it('retries abort CAS without double compensation and rejects a changed canonical balance', async () => {
    const created = await service.balanceAdjust(
      clients[1],
      adjustmentInput({ delta: -250 }),
    );
    const adjustmentId = created.adjustment.adjustmentId;
    jest.spyOn(repo, 'compareAndSwap').mockResolvedValueOnce(false);
    await service.balanceAbort(clients[1], { adjustmentId });
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).revision).toBe(2);
    const next = await service.balanceAdjust(
      clients[1],
      adjustmentInput({ requestId: 'another', expectedWalletRevision: 2 }),
    );
    repo.rows.get(2).balance++;
    await expect(
      service.balanceAbort(clients[1], {
        adjustmentId: next.adjustment.adjustmentId,
      }),
    ).rejects.toMatchObject({ code: 'BALANCE_CONFLICT' });
    expect((await repo.get(2)).adjustments[1].status).toBe('pending');
  });
  it('serializes abort against an in-flight applied ACK so only one terminal outcome wins', async () => {
    const created = await service.balanceAdjust(
      clients[1],
      adjustmentInput({ delta: 10000 }),
    );
    const adjustmentId = created.adjustment.adjustmentId;
    const authenticate = auth.authenticate.bind(auth);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    auth.authenticate = async (token) => {
      if (token === clients[1].token) {
        entered();
        await barrier;
      }
      return authenticate(token);
    };
    const abort = service.balanceAbort(clients[1], { adjustmentId });
    await reached;
    const ack = service.balanceApplied(clients[2], {
      adjustmentId,
      revision: 1,
    });
    release();
    const results = await Promise.all([abort, ack]);
    expect(results.map((result) => result.adjustment.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).revision).toBe(2);
  });
  it('can abort a persisted pending adjustment after a server restart without requiring its original browser online', async () => {
    const created = await service.balanceAdjust(clients[1], adjustmentInput());
    const afterRestart = new ShopService(
      repo,
      auth as any,
      new PlayerActivityService(),
      new ShopCatalogService(service.catalog.repository),
    );
    await afterRestart.onModuleInit();
    afterRestart.connect(clients[1]);
    const aborted = await afterRestart.balanceAbort(clients[1], {
      adjustmentId: created.adjustment.adjustmentId,
    });
    expect(aborted.adjustment.status).toBe('cancelled');
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).adjustments[0].cancelledWalletRevision).toBe(2);
  });
  it('persists zero prices across service recreation and fences stale or conflicting updates', async () => {
    await expect(
      service.priceSet(clients[2], priceInput()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    for (const price of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      await expect(
        service.priceSet(clients[1], priceInput({ price })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await service.priceSet(clients[1], priceInput());
    expect((await service.sync(clients[1])).catalog.prices['poke-ball']).toBe(
      0,
    );
    await service.priceSet(clients[1], priceInput());
    expect((await service.catalog.snapshot()).revision).toBe(1);
    await expect(
      service.priceSet(clients[1], priceInput({ price: 25 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    const restarted = new ShopCatalogService(service.catalog.repository);
    await restarted.onModuleInit();
    expect((await restarted.snapshot()).prices['poke-ball']).toBe(0);
    await expect(
      service.priceSet(clients[1], priceInput({ requestId: 'stale' })),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
  });
  it('free purchases preserve cash, retain the quantity cap and replay at their original price', async () => {
    await service.priceSet(clients[1], priceInput());
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
    });
    const payload = input({ quantity: 99, expectedCatalogRevision: 1 });
    await service.purchase(clients[1], payload);
    const row = await repo.get(2);
    expect(row.balance).toBe(500);
    expect(row.items['poke-ball']).toBe(99);
    expect(row.purchases[0].total).toBe(0);
    await service.priceSet(
      clients[1],
      priceInput({
        requestId: 'price-2',
        price: 75,
        expectedCatalogRevision: 1,
      }),
    );
    await service.purchase(clients[1], payload);
    expect((await repo.get(2)).purchases).toHaveLength(1);
    await expect(
      service.purchase(
        clients[1],
        input({
          requestId: 'too-many',
          quantity: 100,
          expectedCatalogRevision: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('adds the two 300 PD items to old catalogues without resetting custom prices and persists later administrator edits', async () => {
    const legacy: any = await service.catalog.repository.get();
    delete legacy.prices['max-revive'];
    delete legacy.prices['rare-candy'];
    legacy.prices['full-restore'] = 123;
    legacy.prices['poke-ball'] = 0;
    await service.catalog.repository.compareAndSwap(legacy, legacy.revision);
    const visible = await service.catalog.snapshot();
    expect(visible.prices).toMatchObject({
      'max-revive': 300,
      'rare-candy': 300,
      'full-restore': 123,
      'poke-ball': 0,
    });
    expect(await service.catalog.repository.get()).toEqual(legacy);
    for (const [index, itemId] of ['max-revive', 'rare-candy'].entries()) {
      const response = await service.priceSet(
        clients[1],
        priceInput({
          requestId: `new-item-price-${itemId}`,
          itemId,
          price: index === 0 ? 0 : 444,
          expectedCatalogRevision: index,
        }),
      );
      expect(response.catalog.prices[itemId]).toBe(index === 0 ? 0 : 444);
    }
    const restarted = new ShopCatalogService(service.catalog.repository);
    await restarted.onModuleInit();
    expect((await restarted.snapshot()).prices).toMatchObject({
      'max-revive': 0,
      'rare-candy': 444,
      'full-restore': 123,
      'poke-ball': 0,
    });
    const bought = await service.purchase(
      clients[1],
      input({
        itemId: 'rare-candy',
        expectedCatalogRevision: 2,
      }),
    );
    expect(bought.purchases[0]).toMatchObject({
      itemId: 'rare-candy',
      unitPrice: 444,
      total: 444,
    });
    expect(
      bought.players.find((entry) => entry.user.id === 2).wallet.balance,
    ).toBe(56);
  });
  it('rejects a price changed during player preparation without charging', async () => {
    service.setPrepareHandler(async (_owner, request) => {
      await service.catalog.setPrice(1, priceInput({ price: 200 }));
      return { ok: true, revision: request.expectedWalletRevision };
    });
    await expect(
      service.purchase(clients[1], input({ expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).purchases).toEqual([]);
  });
  it('adjusts cash exactly once, fences other operations until saved and preserves inventory', async () => {
    const adjusted = await service.balanceAdjust(clients[1], adjustmentInput());
    expect(adjusted.adjustment).toMatchObject({
      delta: 250,
      balanceBefore: 500,
      balanceAfter: 750,
      status: 'pending',
    });
    await service.balanceAdjust(clients[1], adjustmentInput());
    expect((await repo.get(2)).adjustments).toHaveLength(1);
    expect((await repo.get(2)).items).toEqual({});
    await expect(
      service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.reset(clients[2], resetInput({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput({ delta: 300 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.balanceApplied(clients[3], {
        adjustmentId: adjusted.adjustment.adjustmentId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await service.balanceApplied(clients[2], {
      adjustmentId: adjusted.adjustment.adjustmentId,
      revision: 1,
    });
    const subtracted = await service.balanceAdjust(
      clients[1],
      adjustmentInput({
        requestId: 'subtract',
        delta: -750,
        expectedWalletRevision: 1,
      }),
    );
    expect(subtracted.adjustment.balanceAfter).toBe(0);
    await service.balanceApplied(clients[2], {
      adjustmentId: subtracted.adjustment.adjustmentId,
      revision: 2,
    });
    await service.balanceApplied(clients[2], {
      adjustmentId: subtracted.adjustment.adjustmentId,
      revision: 2,
    });
    expect((await repo.get(2)).revision).toBe(2);
  });
  it('rejects negative balances, overflow, player requests, disconnected or battling owners', async () => {
    await expect(
      service.balanceAdjust(clients[2], adjustmentInput()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    for (const delta of [0, 1.5, NaN])
      await expect(
        service.balanceAdjust(clients[1], adjustmentInput({ delta })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput({ delta: -501 })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      service.balanceAdjust(
        clients[1],
        adjustmentInput({ delta: Number.MAX_SAFE_INTEGER }),
      ),
    ).rejects.toMatchObject({ code: 'BALANCE_LIMIT' });
    await service.presence(clients[2], { ready: true, localBattle: true });
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput()),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    service.disconnect(clients[2].socketId);
    await expect(
      service.balanceAdjust(clients[1], adjustmentInput()),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    expect((await repo.get(2)).balance).toBe(500);
  });
  it('pending balance adjustments survive restart and are visible to alternate browsers', async () => {
    const adjusted = await service.balanceAdjust(clients[1], adjustmentInput());
    const restarted = new ShopService(
      repo,
      auth as any,
      new PlayerActivityService(),
      new ShopCatalogService(service.catalog.repository),
    );
    await restarted.onModuleInit();
    const other = {
      ...clients[2],
      socketId: 'alternate',
      clientId: 'alternate-browser',
    };
    restarted.connect(other);
    expect((await restarted.sync(other)).adjustments[0].status).toBe('pending');
    restarted.connect(clients[1]);
    await expect(
      restarted.balanceAdjust(
        clients[1],
        adjustmentInput({
          clientId: other.clientId,
          requestId: 'new-adjustment',
          expectedWalletRevision: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    restarted.connect(clients[2]);
    await restarted.balanceApplied(clients[2], {
      adjustmentId: adjusted.adjustment.adjustmentId,
      revision: 1,
    });
    expect((await repo.get(2)).balance).toBe(750);
  });
  it('initializes 500 only once and rejects client-supplied balances or prices', async () => {
    expect((await service.sync(clients[2])).wallet).toMatchObject({
      userId: 2,
      balance: 500,
      revision: 0,
      currencyVersion: 1,
      items: {},
    });
    await expect(
      service.presence(clients[2], {
        ready: true,
        localBattle: false,
        balance: 5000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.purchase(clients[1], input({ unitPrice: 1 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await service.purchase(clients[1], input());
    service.disconnect(clients[2].socketId);
    service.connect(clients[2]);
    expect((await service.sync(clients[2])).wallet.balance).toBe(350);
    expect(await repo.get(1)).toBeNull();
  });
  it('charges catalog prices, increments item counts and exposes only the recipient wallet', async () => {
    repo.rows.get(2).balance = 600;
    const result = await service.purchase(
      clients[1],
      input({ itemId: 'great-ball', quantity: 2 }),
    );
    const purchase = result.purchases[0];
    expect(purchase).toMatchObject({
      quantity: 2,
      unitPrice: 300,
      total: 600,
      balanceBefore: 600,
      balanceAfter: 0,
      walletRevision: 1,
      status: 'pending',
    });
    expect(result.players.find((player) => player.user.id === 2)).toMatchObject(
      { pending: true, wallet: { balance: 0, items: { 'great-ball': 2 } } },
    );
    const own = await service.sync(clients[2]);
    expect(own.wallet.balance).toBe(0);
    expect(own.purchases).toHaveLength(1);
    const unrelated = await service.sync(clients[3]);
    expect(unrelated.wallet.balance).toBe(500);
    expect(unrelated.purchases).toEqual([]);
    expect((await service.sync(clients[4])).purchases).toEqual([]);
  });
  it.each([0, -1, 1.5, 100, Number.MAX_SAFE_INTEGER, '2'])(
    'rejects invalid quantity %s',
    async (quantity) => {
      await expect(
        service.purchase(clients[1], input({ quantity })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await repo.get(2)).balance).toBe(500);
    },
  );
  it.each([
    ['max-ether', 350],
    ['max-elixir', 700],
    ['max-revive', 300],
    ['rare-candy', 300],
  ] as const)(
    'sells %s at its authoritative catalog price %i',
    async (itemId, unitPrice) => {
      repo.rows.get(2).balance = 1400;
      const result = await service.purchase(
        clients[1],
        input({ itemId, quantity: 2 }),
      );
      expect(result.purchases[0]).toMatchObject({
        itemId,
        unitPrice,
        total: unitPrice * 2,
      });
      expect((await repo.get(2)).items[itemId]).toBe(2);
      expect((await repo.get(2)).balance).toBe(1400 - unitPrice * 2);
    },
  );
  it('rejects player authority, unavailable items, insufficient funds and stale revisions', async () => {
    await expect(service.purchase(clients[2], input())).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    await expect(
      service.purchase(clients[1], input({ itemId: '__proto__' })),
    ).rejects.toMatchObject({ code: 'INVALID_ITEM' });
    await expect(
      service.purchase(
        clients[1],
        input({ itemId: 'great-ball', quantity: 2 }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
  });
  it('rejects disconnected, unready and locally battling players before preflight', async () => {
    await service.presence(clients[2], { ready: true, localBattle: true });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_IN_BATTLE',
    });
    await service.presence(clients[2], { ready: false, localBattle: false });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_NOT_READY',
    });
    service.disconnect(clients[2].socketId);
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_OFFLINE',
    });
    expect(
      (await service.sync(clients[1])).players.map((player) => player.user.id),
    ).toEqual([3]);
  });
  it('aborted, mismatched and failed preflights never charge or create receipts', async () => {
    for (const response of [
      { ok: false, error: { message: 'Batalla local activa' } },
      { ok: true, revision: 42 },
    ]) {
      service.setPrepareHandler(async () => response);
      await expect(service.purchase(clients[1], input())).rejects.toMatchObject(
        { code: 'PLAYER_NOT_READY' },
      );
    }
    service.setPrepareHandler(async () => {
      throw new ShopError('PLAYER_NOT_READY', 'Timeout fixture');
    });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_NOT_READY',
    });
    const row = await repo.get(2);
    expect(row.balance).toBe(500);
    expect(row.items).toEqual({});
    expect(row.purchases).toEqual([]);
  });
  it('revalidates ownership after prepare and refuses a disconnect during preflight', async () => {
    service.setPrepareHandler(async (_actor, request) => {
      service.disconnect(clients[2].socketId);
      return { ok: true, revision: request.expectedWalletRevision };
    });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_NOT_READY',
    });
    expect((await repo.get(2)).balance).toBe(500);
  });
  it('rechecks administrator authority after preflight before any debit', async () => {
    service.setPrepareHandler(async (_actor, request) => {
      auth.users.get(1).role = 'player';
      return { ok: true, revision: request.expectedWalletRevision };
    });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).purchases).toEqual([]);
  });
  it('refuses a disconnect during delayed post-preflight authentication before CAS', async () => {
    const original = auth.authenticate.bind(auth);
    let prepared = false;
    let entered: () => void;
    let release: () => void;
    const authenticating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finishAuthentication = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.setPrepareHandler(async (_actor, request) => {
      prepared = true;
      return { ok: true, revision: request.expectedWalletRevision };
    });
    auth.authenticate = async (token) => {
      const identity = await original(token);
      if (token === clients[2].token && prepared) {
        entered();
        await finishAuthentication;
      }
      return identity;
    };
    const buying = service.purchase(clients[1], input());
    await authenticating;
    service.disconnect(clients[2].socketId);
    release();
    await expect(buying).rejects.toMatchObject({ code: 'PLAYER_NOT_READY' });
    const wallet = await repo.get(2);
    expect(wallet.balance).toBe(500);
    expect(wallet.items).toEqual({});
    expect(wallet.purchases).toEqual([]);
  });
  it('does not report a debit when persistent storage fails', async () => {
    const original = repo.compareAndSwap.bind(repo);
    repo.compareAndSwap = async () => {
      throw new Error('Fixture DB unavailable');
    };
    await expect(service.purchase(clients[1], input())).rejects.toThrow(
      'Fixture DB unavailable',
    );
    repo.compareAndSwap = original;
    const state = await service.sync(clients[2]);
    expect(state.wallet.balance).toBe(500);
    expect(state.purchases).toEqual([]);
  });
  it('a repeated request survives lost acknowledgements/restarts and cannot change target or quantity', async () => {
    await service.purchase(clients[1], input());
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    service.connect(clients[1]);
    const replay = await service.purchase(clients[1], input());
    expect(replay.purchases).toHaveLength(1);
    expect((await repo.get(2)).balance).toBe(350);
    await expect(
      service.purchase(clients[1], input({ quantity: 2 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.purchase(
        clients[1],
        input({ playerUserId: 3, clientId: 'shop-client-3' }),
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('requires the original owner and exact purchase revision, and ACK retries do not reset funds', async () => {
    const purchase = (await service.purchase(clients[1], input())).purchases[0];
    await expect(
      service.applied(clients[3], {
        purchaseId: purchase.purchaseId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const otherClient = {
      ...clients[2],
      clientId: 'different-browser',
      socketId: 'different-socket',
    };
    service.connect(otherClient);
    await expect(
      service.applied(otherClient, {
        purchaseId: purchase.purchaseId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    service.disconnect(otherClient.socketId);
    await expect(
      service.applied(clients[2], {
        purchaseId: purchase.purchaseId,
        revision: 2,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    const applied = await service.applied(clients[2], {
      purchaseId: purchase.purchaseId,
      revision: 1,
    });
    expect(applied.purchases[0].status).toBe('applied');
    expect(applied.wallet.balance).toBe(350);
    expect(
      (
        await service.applied(clients[2], {
          purchaseId: purchase.purchaseId,
          revision: 1,
        })
      ).wallet.revision,
    ).toBe(1);
    expect(await activity.busyUsers([2])).toEqual([]);
    await service.purchase(
      clients[1],
      input({ requestId: 'purchase-2', expectedWalletRevision: 1 }),
    );
    expect((await repo.get(2)).items['poke-ball']).toBe(2);
  });
  it.each(['pvp', 'trainer'])(
    'blocks purchases while %s reserves a player and blocks starting battles until a purchase is saved',
    async (kind) => {
      const payload =
        kind === 'trainer'
          ? {
              commandId: 'battle-1',
              playerAId: 2,
              trainerPresetId: 'kanto-brock',
            }
          : { commandId: 'battle-1', playerAId: 2, playerBId: 3 };
      const battle = await pvp.create(clients[1], payload);
      expect(
        (await service.sync(clients[1])).players.find(
          (player) => player.user.id === 2,
        ).inBattle,
      ).toBe(true);
      await expect(service.purchase(clients[1], input())).rejects.toMatchObject(
        { code: 'PLAYER_BUSY' },
      );
      await pvp.cancel(clients[1], {
        battleId: battle.battleId,
        hostEpoch: battle.host.epoch,
      });
      const purchase = (await service.purchase(clients[1], input()))
        .purchases[0];
      await expect(
        pvp.create(clients[1], { ...payload, commandId: 'battle-2' }),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      await service.applied(clients[2], {
        purchaseId: purchase.purchaseId,
        revision: purchase.walletRevision,
      });
      expect(
        (await pvp.create(clients[1], { ...payload, commandId: 'battle-2' }))
          .phase,
      ).toBe('collecting');
    },
  );
  it('serializes sync and battle creation behind a held preflight; no stale empty state can release the local lock', async () => {
    let release: (value: { ok: boolean; revision: number }) => void;
    let entered: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    service.setPrepareHandler(async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const buying = service.purchase(clients[1], input());
    await started;
    let synced = false;
    const sync = service.sync(clients[2]).then((state) => {
      synced = true;
      return state;
    });
    const battle = pvp
      .create(clients[1], {
        commandId: 'battle-race',
        playerAId: 2,
        trainerPresetId: 'kanto-brock',
      })
      .then(
        () => null,
        (error) => error,
      );
    await Promise.resolve();
    expect(synced).toBe(false);
    release({ ok: true, revision: 0 });
    await buying;
    expect((await sync).purchases[0].status).toBe('pending');
    expect((await battle).code).toBe('PLAYER_BUSY');
    expect((await repo.get(2)).balance).toBe(350);
  });
  it('concurrent clicks debit once, reject a competing request and preserve pending delivery after disconnect', async () => {
    const outcomes = await Promise.allSettled([
      service.purchase(clients[1], input()),
      service.purchase(clients[1], input()),
      service.purchase(clients[4], input({ requestId: 'competing' })),
    ]);
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2);
    expect((await repo.get(2)).purchases).toHaveLength(1);
    expect((await repo.get(2)).balance).toBe(350);
    service.disconnect(clients[2].socketId);
    expect(await activity.busyUsers([2])).toEqual([2]);
    service.connect({ ...clients[2], socketId: 'reconnected-original' });
    const restored = await service.sync({
      ...clients[2],
      socketId: 'reconnected-original',
    });
    expect(restored.purchases[0].status).toBe('pending');
    expect(restored.wallet.items['poke-ball']).toBe(1);
  });
  it('grants exactly six normal balls and 500 PD on the new reset contract, clears other stock, and never replenishes a consumed ball on replay or sync', async () => {
    const purchase = (await service.purchase(clients[1], input())).purchases[0];
    await service.applied(clients[2], {
      purchaseId: purchase.purchaseId,
      revision: 1,
    });
    repo.rows.get(2).items = Object.fromEntries(
      Object.keys(SHOP_CATALOG).map((itemId) => [itemId, 4]),
    );
    repo.rows.get(2).badges = ['boulder'];
    const payload = starterResetInput({ expectedWalletRevision: 1 });
    const result = await service.reset(clients[2], payload);
    expect(result.wallet).toMatchObject({
      balance: 500,
      revision: 2,
      rewardEpoch: 1,
      badges: [],
    });
    expect(result.wallet.items).toEqual({ 'poke-ball': 6 });
    expect(result.reset).toEqual({
      requestId: 'reset-1',
      userId: 2,
      clientId: clients[2].clientId,
      walletRevision: 2,
      starterItemsVersion: 1,
      status: 'pending',
    });
    expect(result.purchases).toEqual([{ ...purchase, status: 'applied' }]);
    expect(await activity.busyUsers([2])).toEqual([2]);
    const stored = await repo.get(2);
    expect(stored.resets[0].requestHash).toBe(
      digest([2, clients[2].clientId, 1, 'starter-items-v1']),
    );
    expect((await service.reset(clients[2], payload)).wallet.items).toEqual({
      'poke-ball': 6,
    });
    expect(await repo.get(2)).toEqual(stored);
    await service.resetApplied(clients[2], {
      requestId: 'reset-1',
      revision: 2,
    });
    await service.presence(clients[2], {
      ready: false,
      localBattle: true,
      supportsBackgroundItemUses: true,
    });
    await service.consumeBatch(clients[2], {
      clientId: clients[2].clientId,
      operations: [
        {
          operationId: 'spent-starter-ball',
          sequence: 1,
          itemId: 'poke-ball',
          quantity: 1,
          captureId: 'local-pokemon',
          context: 'local-battle',
        },
      ],
    });
    const spent = await repo.get(2);
    expect(spent.items).toEqual({ 'poke-ball': 5 });
    expect((await service.reset(clients[2], payload)).wallet.items).toEqual({
      'poke-ball': 5,
    });
    await service.resetApplied(clients[2], {
      requestId: 'reset-1',
      revision: 2,
    });
    await service.sync(clients[2]);
    await service.sync(clients[1]);
    service.disconnect(clients[2].socketId);
    service.connect(clients[2]);
    await service.presence(clients[2], { ready: true, localBattle: false });
    expect(await repo.get(2)).toEqual(spent);
  });
  it('keeps initial and existing wallets untouched when clients connect, sync or open the shop without a reset', async () => {
    const initial = await service.sync(clients[3]);
    expect(initial.wallet.items).toEqual({});
    expect(initial.resetStarterItemsVersion).toBe(1);
    repo.rows.get(2).balance = 321;
    repo.rows.get(2).items = { 'poke-ball': 2, tm: 3 };
    const original = await repo.get(2);
    const catalogue = await service.catalog.repository.get();
    expect((await service.sync(clients[1])).resetStarterItemsVersion).toBe(1);
    await service.sync(clients[2]);
    service.disconnect(clients[2].socketId);
    service.connect(clients[2]);
    await service.presence(clients[2], { ready: true, localBattle: false });
    expect(await repo.get(2)).toEqual(original);
    expect((await repo.get(3)).items).toEqual({});
    expect(await service.catalog.repository.get()).toEqual(catalogue);
  });
  it('recovers one new starter reset after concurrent requests and process restart, and retries a failed ACK without another grant', async () => {
    const payload = starterResetInput();
    const results = await Promise.all([
      service.reset(clients[2], payload),
      service.reset(clients[2], payload),
    ]);
    expect(results[0].reset).toEqual(results[1].reset);
    expect((await repo.get(2)).resets).toHaveLength(1);
    const pending = await repo.get(2);
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    service.connect(clients[2]);
    expect((await service.sync(clients[2])).resets[0]).toEqual(
      results[0].reset,
    );
    expect((await service.reset(clients[2], payload)).wallet.items).toEqual({
      'poke-ball': 6,
    });
    expect(await repo.get(2)).toEqual(pending);
    const cas = repo.compareAndSwap.bind(repo);
    repo.compareAndSwap = async () => {
      throw new Error('Starter reset ACK write unavailable');
    };
    await expect(
      service.resetApplied(clients[2], { requestId: 'reset-1', revision: 1 }),
    ).rejects.toThrow('Starter reset ACK');
    expect(await repo.get(2)).toEqual(pending);
    repo.compareAndSwap = cas;
    await service.resetApplied(clients[2], {
      requestId: 'reset-1',
      revision: 1,
    });
    const applied = await repo.get(2);
    expect(applied.items).toEqual({ 'poke-ball': 6 });
    expect(applied.resets[0]).toMatchObject({
      starterItemsVersion: 1,
      status: 'applied',
    });
    await service.resetApplied(clients[2], {
      requestId: 'reset-1',
      revision: 1,
    });
    expect(await repo.get(2)).toEqual(applied);
  });
  it.each(['pending', 'applied'] as const)(
    'preserves a saved legacy %s reset, its original hash and empty inventory without retroactively granting balls',
    async (status) => {
      await service.reset(clients[2], resetInput());
      if (status === 'applied')
        await service.resetApplied(clients[2], {
          requestId: 'reset-1',
          revision: 1,
        });
      const original = await repo.get(2);
      expect(original.resets[0].requestHash).toBe(
        digest([2, clients[2].clientId, 0]),
      );
      expect(original.resets[0]).not.toHaveProperty('starterItemsVersion');
      service = new ShopService(repo, auth as any, activity);
      await service.onModuleInit();
      service.connect(clients[2]);
      expect(
        (await service.reset(clients[2], resetInput())).wallet.items,
      ).toEqual({});
      await service.sync(clients[2]);
      await expect(
        service.reset(clients[2], starterResetInput()),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      await expect(
        service.resetCancel(clients[2], starterResetInput()),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      expect(await repo.get(2)).toEqual(original);
    },
  );
  it('binds the starter version to cancellation tombstones and never grants items for a cancelled or changed request', async () => {
    const payload = starterResetInput();
    const cancelled = await service.resetCancel(clients[2], payload);
    expect(cancelled.reset).toMatchObject({
      starterItemsVersion: 1,
      status: 'cancelled',
      walletRevision: 0,
    });
    expect(cancelled.wallet.items).toEqual({});
    const original = await repo.get(2);
    expect((await service.reset(clients[2], payload)).reset).toEqual(
      cancelled.reset,
    );
    for (const execute of [
      () => service.reset(clients[2], resetInput()),
      () => service.resetCancel(clients[2], resetInput()),
    ])
      await expect(execute()).rejects.toMatchObject({
        code: 'REQUEST_CONFLICT',
      });
    expect(await repo.get(2)).toEqual(original);
    const next = starterResetInput({ requestId: 'starter-reset-2' });
    const committed = await service.reset(clients[2], next);
    expect((await service.resetCancel(clients[2], next)).reset).toEqual(
      committed.reset,
    );
    expect((await repo.get(2)).items).toEqual({ 'poke-ball': 6 });
    expect(await activity.busyUsers([2])).toEqual([2]);
  });
  it('rejects invalid starter versions before mutation and retries the new reset CAS with exactly one initial inventory', async () => {
    const original = await repo.get(2);
    for (const starterItemsVersion of [0, 2, -1, 1.5, null, '1', true, {}])
      for (const execute of [
        () => service.reset(clients[2], resetInput({ starterItemsVersion })),
        () =>
          service.resetCancel(clients[2], resetInput({ starterItemsVersion })),
      ])
        await expect(execute()).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
    expect(await repo.get(2)).toEqual(original);
    const cas = repo.compareAndSwap.bind(repo);
    let attempts = 0;
    repo.compareAndSwap = async (...args) =>
      ++attempts === 1 ? false : cas(...args);
    const result = await service.reset(clients[2], starterResetInput());
    expect(attempts).toBe(2);
    expect(result.wallet.items).toEqual({ 'poke-ball': 6 });
    expect((await repo.get(2)).resets).toHaveLength(1);
    expect((await repo.get(2)).rewardEpoch).toBe(1);
  });
  it('resets spent money and purchased items atomically, keeps purchase history and never replenishes on replay', async () => {
    const purchase = (await service.purchase(clients[1], input())).purchases[0];
    await service.applied(clients[2], {
      purchaseId: purchase.purchaseId,
      revision: 1,
    });
    await service.presence(clients[2], { ready: false, localBattle: false });
    const reset = await service.reset(
      clients[2],
      resetInput({ expectedWalletRevision: 1 }),
    );
    expect(reset.wallet).toMatchObject({
      balance: 500,
      items: {},
      revision: 2,
    });
    expect(reset.reset).toEqual({
      requestId: 'reset-1',
      userId: 2,
      clientId: 'shop-client-2',
      walletRevision: 2,
      status: 'pending',
    });
    expect(reset.purchases).toHaveLength(1);
    expect(reset.purchases[0].status).toBe('applied');
    expect(await activity.busyUsers([2])).toEqual([2]);
    const duplicate = await service.reset(
      clients[2],
      resetInput({ expectedWalletRevision: 1 }),
    );
    expect(duplicate.wallet.revision).toBe(2);
    expect((await repo.get(2)).resets).toHaveLength(1);
    const applied = await service.resetApplied(clients[2], {
      requestId: 'reset-1',
      revision: 2,
    });
    expect(applied.resets[0].status).toBe('applied');
    expect(applied.wallet.revision).toBe(2);
    expect(await activity.busyUsers([2])).toEqual([]);
    await service.presence(clients[2], { ready: true, localBattle: false });
    await service.purchase(
      clients[1],
      input({ requestId: 'purchase-after-reset', expectedWalletRevision: 2 }),
    );
    expect(
      (
        await service.reset(
          clients[2],
          resetInput({ expectedWalletRevision: 1 }),
        )
      ).wallet.balance,
    ).toBe(350);
    expect(
      (
        await service.resetApplied(clients[2], {
          requestId: 'reset-1',
          revision: 2,
        })
      ).wallet.balance,
    ).toBe(350);
    expect((await repo.get(2)).purchases).toHaveLength(2);
  });
  it('accepts only own authenticated reset intent, exact revision and valid idempotency payload', async () => {
    await expect(service.reset(clients[1], resetInput())).rejects.toMatchObject(
      { code: 'PLAYER_REQUIRED' },
    );
    for (const extra of [{ userId: 3 }, { balance: 5000 }, { items: {} }])
      await expect(
        service.reset(clients[2], resetInput(extra)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.reset(clients[2], resetInput({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    await service.presence(clients[2], { ready: true, localBattle: true });
    await expect(service.reset(clients[2], resetInput())).rejects.toMatchObject(
      { code: 'PLAYER_IN_BATTLE' },
    );
    await service.presence(clients[2], { ready: false, localBattle: false });
    await service.reset(clients[2], resetInput());
    await expect(
      service.reset(clients[2], resetInput({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.reset(clients[2], resetInput({ requestId: 'different-reset' })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    expect((await repo.get(2)).resets).toHaveLength(1);
  });
  it('recovers pending reset after process restart, exposes it to alternate devices and requires original client ACK', async () => {
    await service.reset(clients[2], resetInput());
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    const alternate = {
      ...clients[2],
      socketId: 'alternate-socket',
      clientId: 'alternate-client',
    };
    service.connect(alternate);
    expect((await service.sync(alternate)).resets[0]).toMatchObject({
      requestId: 'reset-1',
      clientId: 'shop-client-2',
      status: 'pending',
    });
    await expect(
      service.resetApplied(alternate, { requestId: 'reset-1', revision: 1 }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    service.connect(clients[2]);
    service.connect(clients[3]);
    expect((await service.sync(clients[3])).resets).toEqual([]);
    await expect(
      service.resetApplied(clients[2], { requestId: 'reset-1', revision: 99 }),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    expect(
      (await service.reset(clients[2], resetInput())).wallet.revision,
    ).toBe(1);
    expect(
      (
        await service.resetApplied(clients[2], {
          requestId: 'reset-1',
          revision: 1,
        })
      ).resets[0].status,
    ).toBe('applied');
    expect((await repo.get(2)).storageRevision).toBe(2);
  });
  it.each(['pvp', 'trainer'])(
    'excludes reset and %s reservation until durable reset ACK',
    async (kind) => {
      const payload =
        kind === 'trainer'
          ? {
              commandId: 'reset-battle',
              playerAId: 2,
              trainerPresetId: 'kanto-brock',
            }
          : { commandId: 'reset-battle', playerAId: 2, playerBId: 3 };
      const battle = await pvp.create(clients[1], payload);
      await expect(
        service.reset(clients[2], resetInput()),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      await pvp.cancel(clients[1], {
        battleId: battle.battleId,
        hostEpoch: battle.host.epoch,
      });
      await service.reset(clients[2], resetInput());
      const admin = await service.sync(clients[1]);
      expect(
        admin.players.find((player) => player.user.id === 2),
      ).toMatchObject({ pending: true, pendingReset: true });
      await expect(
        pvp.create(clients[1], { ...payload, commandId: 'after-reset-battle' }),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      await expect(
        service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      await service.resetApplied(clients[2], {
        requestId: 'reset-1',
        revision: 1,
      });
      expect(
        (
          await pvp.create(clients[1], {
            ...payload,
            commandId: 'after-reset-battle',
          })
        ).phase,
      ).toBe('collecting');
    },
  );
  it.each(['reset-first', 'purchase-first'])(
    'serializes a concurrent purchase/reset with exactly one commit: %s',
    async (order) => {
      const operations =
        order === 'reset-first'
          ? [
              () => service.reset(clients[2], resetInput()),
              () => service.purchase(clients[1], input()),
            ]
          : [
              () => service.purchase(clients[1], input()),
              () => service.reset(clients[2], resetInput()),
            ];
      const outcomes = await Promise.allSettled(
        operations.map((operation) => operation()),
      );
      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
      expect((outcomes[1] as PromiseRejectedResult).reason.code).toBe(
        'PLAYER_BUSY',
      );
      const row = await repo.get(2);
      expect(row.revision).toBe(1);
      expect(row.purchases.length + row.resets.length).toBe(1);
    },
  );
  it('fences reset against disconnect or session changes during asynchronous authentication', async () => {
    const original = auth.authenticate.bind(auth);
    auth.authenticate = async (token) => {
      const identity = await original(token);
      service.disconnect(clients[2].socketId);
      return identity;
    };
    await expect(service.reset(clients[2], resetInput())).rejects.toMatchObject(
      { code: 'SESSION_CHANGED' },
    );
    expect((await repo.get(2)).resets).toEqual([]);
    auth.authenticate = original;
    service.connect(clients[2]);
    auth.users.get(2).role = 'admin';
    await expect(service.reset(clients[2], resetInput())).rejects.toMatchObject(
      { code: 'INVALID_PLAYER' },
    );
    expect((await repo.get(2)).revision).toBe(0);
  });
  it('CAS retries preserve history and failed reset writes never report a reset', async () => {
    const original = repo.compareAndSwap.bind(repo);
    repo.compareAndSwap = async () => {
      throw new Error('Reset DB unavailable');
    };
    await expect(service.reset(clients[2], resetInput())).rejects.toThrow(
      'Reset DB unavailable',
    );
    expect((await repo.get(2)).resets).toEqual([]);
    let calls = 0;
    repo.compareAndSwap = async (...args) =>
      ++calls === 1 ? false : original(...args);
    expect(
      (await service.reset(clients[2], resetInput())).wallet,
    ).toMatchObject({ revision: 1, balance: 500, items: {} });
    expect(calls).toBe(2);
    expect((await repo.get(2)).resets).toHaveLength(1);
  });
  it('cancellation persists a terminal tombstone that fences a late reset, without releasing a committed reset', async () => {
    const cancelled = await service.resetCancel(clients[2], resetInput());
    expect(cancelled.reset).toMatchObject({
      status: 'cancelled',
      walletRevision: 0,
    });
    expect(cancelled.wallet).toMatchObject({
      balance: 500,
      revision: 0,
      items: {},
    });
    expect(await activity.busyUsers([2])).toEqual([]);
    const late = await service.reset(clients[2], resetInput());
    expect(late.reset.status).toBe('cancelled');
    expect(late.wallet.revision).toBe(0);
    expect((await repo.get(2)).resets).toHaveLength(1);
    const live = resetInput({ requestId: 'committed-reset' });
    await service.reset(clients[2], live);
    expect((await service.resetCancel(clients[2], live)).reset.status).toBe(
      'pending',
    );
    expect(await activity.busyUsers([2])).toEqual([2]);
    await service.resetApplied(clients[2], {
      requestId: 'committed-reset',
      revision: 1,
    });
    expect((await service.resetCancel(clients[2], live)).reset.status).toBe(
      'applied',
    );
  });
  it('cancelled reset requests cannot be retargeted, cannot be acknowledged, and survive process restarts', async () => {
    await service.resetCancel(clients[2], resetInput());
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    service.connect(clients[2]);
    await expect(
      service.resetCancel(
        clients[2],
        resetInput({ expectedWalletRevision: 10 }),
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.resetApplied(clients[2], { requestId: 'reset-1', revision: 1 }),
    ).rejects.toMatchObject({ code: 'RESET_CANCELLED' });
    expect((await service.reset(clients[2], resetInput())).reset.status).toBe(
      'cancelled',
    );
    expect((await repo.get(2)).revision).toBe(0);
  });
});

describe('Full Restore local inventory use', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    activity: PlayerActivityService,
    service: ShopService,
    pvp: PvpService;
  const useInput = (overrides: Record<string, any> = {}) => ({
    requestId: 'use-1',
    captureId: 'capture-own',
    context: 'party',
    planHash: 'a'.repeat(64),
    expectedWalletRevision: 0,
    ...overrides,
  });
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth as any, activity);
    pvp = new PvpService(new MemoryPvpRepository(), auth as any, activity);
    await pvp.onModuleInit();
    await service.onModuleInit();
    for (const actor of Object.values(clients)) {
      service.connect(actor);
      pvp.connect(actor);
    }
    await service.presence(clients[2], { ready: true, localBattle: false });
    repo.rows.get(2).items = { 'full-restore': 2 };
  });
  it('decrements exactly one unit without changing money and replays one pending receipt before/after ACK', async () => {
    const used = await service.use(clients[2], useInput());
    expect(used.wallet).toMatchObject({
      balance: 500,
      revision: 1,
      items: { 'full-restore': 1 },
    });
    expect(used.use).toMatchObject({
      requestId: 'use-1',
      itemId: 'full-restore',
      captureId: 'capture-own',
      context: 'party',
      status: 'pending',
      walletRevision: 1,
    });
    expect(await activity.busyUsers([2])).toEqual([2]);
    expect((await service.use(clients[2], useInput())).wallet.revision).toBe(1);
    const done = await service.useApplied(clients[2], {
      requestId: 'use-1',
      revision: 1,
    });
    expect(done.uses[0].status).toBe('applied');
    expect(await activity.busyUsers([2])).toEqual([]);
    expect(
      (await service.use(clients[2], useInput())).wallet.items['full-restore'],
    ).toBe(1);
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('requires stock, exact revision, a player and a plan bound to one capture/context', async () => {
    repo.rows.get(2).items = {};
    await expect(service.use(clients[2], useInput())).rejects.toMatchObject({
      code: 'ITEM_UNAVAILABLE',
    });
    repo.rows.get(2).items = { 'full-restore': 1 };
    await expect(
      service.use(clients[2], useInput({ expectedWalletRevision: 5 })),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    await expect(service.use(clients[1], useInput())).rejects.toMatchObject({
      code: 'PLAYER_REQUIRED',
    });
    await expect(
      service.use(clients[2], useInput({ planHash: 'bad' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.use(clients[2], useInput({ quantity: 2 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await service.use(clients[2], useInput());
    await expect(
      service.use(clients[2], useInput({ captureId: 'other' })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('validates local battle context and excludes every reserved network battle', async () => {
    await expect(
      service.use(clients[2], useInput({ context: 'local-battle' })),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    await service.presence(clients[2], { ready: false, localBattle: true });
    await expect(service.use(clients[2], useInput())).rejects.toMatchObject({
      code: 'PLAYER_IN_BATTLE',
    });
    await service.use(clients[2], useInput({ context: 'local-battle' }));
    await service.useApplied(clients[2], { requestId: 'use-1', revision: 1 });
    await service.presence(clients[2], { ready: true, localBattle: false });
    await pvp.create(clients[1], {
      commandId: 'create-1',
      playerAId: 2,
      trainerPresetId: 'kanto-brock',
    });
    await expect(
      service.use(
        clients[2],
        useInput({ requestId: 'use-2', expectedWalletRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
  });
  it('pending usage blocks purchases, resets and battle reservation until original owner ACKs', async () => {
    await service.use(clients[2], useInput());
    await expect(
      service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.reset(clients[2], {
        requestId: 'reset-1',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      pvp.create(clients[1], {
        commandId: 'create-1',
        playerAId: 2,
        trainerPresetId: 'kanto-brock',
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    const foreign = {
      ...clients[2],
      socketId: 'other-socket',
      clientId: 'other-client',
    };
    service.connect(foreign);
    expect((await service.sync(foreign)).uses[0].status).toBe('pending');
    await expect(
      service.useApplied(foreign, { requestId: 'use-1', revision: 1 }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    service.disconnect(foreign.socketId);
    await expect(
      service.useApplied(clients[2], { requestId: 'use-1', revision: 99 }),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    await service.useApplied(clients[2], { requestId: 'use-1', revision: 1 });
  });
  it('persists cancellation before a late use and cannot undo committed consumption', async () => {
    const cancelled = await service.useCancel(clients[2], useInput());
    expect(cancelled.use.status).toBe('cancelled');
    expect(
      (await service.use(clients[2], useInput())).wallet.items['full-restore'],
    ).toBe(2);
    expect((await service.sync(clients[2])).wallet.revision).toBe(0);
    await expect(
      service.useApplied(clients[2], { requestId: 'use-1', revision: 1 }),
    ).rejects.toMatchObject({ code: 'ITEM_USE_CANCELLED' });
    const second = useInput({ requestId: 'use-2' });
    await service.use(clients[2], second);
    expect((await service.useCancel(clients[2], second)).use.status).toBe(
      'pending',
    );
    expect((await service.sync(clients[2])).wallet.items['full-restore']).toBe(
      1,
    );
  });
  it('keeps the pending use after restart and never consumes again after a lost reply', async () => {
    await service.use(clients[2], useInput());
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    service.connect(clients[2]);
    const result = await service.use(clients[2], useInput());
    expect(result.wallet.items['full-restore']).toBe(1);
    expect(result.use.status).toBe('pending');
    await service.useApplied(clients[2], { requestId: 'use-1', revision: 1 });
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('fences a disconnect or local battle change during authentication before debit', async () => {
    const original = auth.authenticate.bind(auth);
    auth.authenticate = async (token) => {
      const value = await original(token);
      service.disconnect(clients[2].socketId);
      return value;
    };
    await expect(service.use(clients[2], useInput())).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    expect((await repo.get(2)).items['full-restore']).toBe(2);
    expect((await repo.get(2)).uses ?? []).toEqual([]);
  });
  it.each(['max-ether', 'max-elixir', 'max-revive', 'rare-candy'] as const)(
    'consumes only %s and binds its receipt to its exact item and move selector',
    async (itemId) => {
      repo.rows.get(2).items = {
        'full-restore': 2,
        'max-ether': 2,
        'max-elixir': 2,
        'max-revive': 2,
        'rare-candy': 2,
      };
      const payload = useInput({
        itemId,
        ...(itemId === 'max-ether' ? { moveId: 1 } : {}),
      });
      const result = await service.use(clients[2], payload);
      expect(result.wallet.items[itemId]).toBe(1);
      expect(result.wallet.items['full-restore']).toBe(2);
      expect(result.wallet.balance).toBe(500);
      expect(result.use).toMatchObject({
        itemId,
        status: 'pending',
        ...(itemId === 'max-ether' ? { moveId: 1 } : {}),
      });
      await service.use(clients[2], payload);
      expect((await repo.get(2)).items[itemId]).toBe(1);
      await expect(
        service.use(clients[2], {
          ...payload,
          itemId: 'full-restore',
          moveId: undefined,
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      if (itemId === 'max-ether')
        await expect(
          service.use(clients[2], { ...payload, moveId: 2 }),
        ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      await service.useApplied(clients[2], {
        requestId: payload.requestId,
        revision: 1,
      });
      expect((await service.sync(clients[2])).uses[0].status).toBe('applied');
    },
  );
  it.each([
    { itemId: null },
    { itemId: 'max-ether' },
    { itemId: 'max-ether', moveId: 0 },
    { itemId: 'max-ether', moveId: 355 },
    { itemId: 'max-ether', moveId: 1.5 },
    { itemId: 'max-elixir', moveId: 1 },
    { itemId: 'full-restore', moveId: 1 },
    { itemId: 'max-revive', moveId: 1 },
    { itemId: 'rare-candy', moveId: 1 },
  ])(
    'rejects invalid consumable or selector %j without debit',
    async (selection) => {
      await expect(
        service.use(clients[2], useInput(selection)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await repo.get(2)).revision).toBe(0);
    },
  );
  it('preserves legacy Full Restore fingerprints when itemId becomes explicit', async () => {
    await service.use(clients[2], useInput());
    expect(
      (await service.use(clients[2], useInput({ itemId: 'full-restore' })))
        .wallet.items['full-restore'],
    ).toBe(1);
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('allows a battle Max Revive but never consumes Rare Candy in a battle context', async () => {
    repo.rows.get(2).items['max-revive'] = 2;
    repo.rows.get(2).items['rare-candy'] = 2;
    await service.presence(clients[2], { ready: false, localBattle: true });
    const payload = useInput({ itemId: 'max-revive', context: 'local-battle' });
    const used = await service.use(clients[2], payload);
    expect(used.wallet.items['max-revive']).toBe(1);
    expect((await service.use(clients[2], payload)).use).toEqual(used.use);
    expect((await repo.get(2)).uses).toHaveLength(1);
    await expect(
      service.use(
        clients[2],
        useInput({
          requestId: 'candy-in-battle',
          itemId: 'rare-candy',
          context: 'local-battle',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    expect((await repo.get(2)).items['rare-candy']).toBe(2);
  });
  it('persists a Max Ether cancellation bound to its move and prevents late consumption', async () => {
    repo.rows.get(2).items['max-ether'] = 1;
    const payload = useInput({ itemId: 'max-ether', moveId: 1 });
    const cancelled = await service.useCancel(clients[2], payload);
    expect(cancelled.use).toMatchObject({
      itemId: 'max-ether',
      moveId: 1,
      status: 'cancelled',
    });
    expect(
      (await service.use(clients[2], payload)).wallet.items['max-ether'],
    ).toBe(1);
    await expect(
      service.useCancel(clients[2], { ...payload, moveId: 2 }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it('consumes one TM outside battle, binds its learned move and cannot replay or charge another item', async () => {
    const payload = useInput({ itemId: 'tm', moveId: 33 });
    await expect(service.use(clients[2], payload)).rejects.toMatchObject({
      code: 'ITEM_UNAVAILABLE',
    });
    repo.rows.get(2).items.tm = 1;
    const result = await service.use(clients[2], payload);
    expect(result.wallet).toMatchObject({
      balance: 500,
      revision: 1,
      items: { tm: 0, 'full-restore': 2 },
    });
    expect(result.use).toMatchObject({
      itemId: 'tm',
      moveId: 33,
      context: 'party',
      status: 'pending',
    });
    await expect(
      service.use(clients[2], { ...payload, moveId: 45 }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.use(clients[2], { ...payload, itemId: 'max-ether' }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.use(clients[2], { ...payload, planHash: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await service.use(clients[2], payload);
    await service.useApplied(clients[2], {
      requestId: payload.requestId,
      revision: 1,
    });
    const replay = await service.use(clients[2], payload);
    expect(replay.use.status).toBe('applied');
    expect(replay.wallet.items.tm).toBe(0);
    expect((await repo.get(2)).uses).toHaveLength(1);
    await expect(
      service.use(clients[2], {
        ...payload,
        requestId: 'tm-next',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
  });
  it.each([undefined, 0, 355, 1.5])(
    'rejects invalid TM learned move %j before debit or cancellation',
    async (moveId) => {
      repo.rows.get(2).items.tm = 1;
      const payload = useInput({ itemId: 'tm', moveId });
      await expect(service.use(clients[2], payload)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(
        service.useCancel(clients[2], payload),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await repo.get(2)).items.tm).toBe(1);
      expect((await repo.get(2)).uses ?? []).toEqual([]);
    },
  );
  it('forbids TM local-battle requests, local encounter presence and reserved Trainer battles', async () => {
    repo.rows.get(2).items.tm = 1;
    const payload = useInput({ itemId: 'tm', moveId: 33 });
    await expect(
      service.use(clients[2], { ...payload, context: 'local-battle' }),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    await expect(
      service.useCancel(clients[2], { ...payload, context: 'local-battle' }),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    await service.presence(clients[2], { ready: false, localBattle: true });
    await expect(service.use(clients[2], payload)).rejects.toMatchObject({
      code: 'PLAYER_IN_BATTLE',
    });
    await service.presence(clients[2], { ready: true, localBattle: false });
    await pvp.create(clients[1], {
      commandId: 'create-tm',
      playerAId: 2,
      trainerPresetId: 'kanto-brock',
    });
    await expect(service.use(clients[2], payload)).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    expect((await repo.get(2)).revision).toBe(0);
    expect((await repo.get(2)).items.tm).toBe(1);
  });
  it('recovers a pending TM after service restart and keeps battle/reset exclusions until ACK', async () => {
    repo.rows.get(2).items.tm = 1;
    const payload = useInput({ itemId: 'tm', moveId: 33 });
    await service.use(clients[2], payload);
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    service.connect(clients[2]);
    expect((await service.sync(clients[2])).uses[0]).toMatchObject({
      itemId: 'tm',
      moveId: 33,
      status: 'pending',
    });
    expect(await activity.busyUsers([2])).toEqual([2]);
    await expect(
      pvp.create(clients[1], {
        commandId: 'create-tm',
        playerAId: 2,
        trainerPresetId: 'kanto-brock',
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.reset(clients[2], {
        requestId: 'tm-reset',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    const replay = await service.use(clients[2], payload);
    expect(replay.wallet.items.tm).toBe(0);
    await service.useApplied(clients[2], {
      requestId: payload.requestId,
      revision: 1,
    });
    expect(await activity.busyUsers([2])).toEqual([]);
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('persists a TM cancellation with its learned move and never rolls back a committed TM', async () => {
    repo.rows.get(2).items.tm = 1;
    const payload = useInput({ itemId: 'tm', moveId: 33 });
    const cancelled = await service.useCancel(clients[2], payload);
    expect(cancelled.use).toMatchObject({
      itemId: 'tm',
      moveId: 33,
      status: 'cancelled',
    });
    expect((await service.use(clients[2], payload)).wallet.items.tm).toBe(1);
    await expect(
      service.useCancel(clients[2], { ...payload, moveId: 45 }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    const committed = { ...payload, requestId: 'tm-committed' };
    await service.use(clients[2], committed);
    expect((await service.useCancel(clients[2], committed)).use.status).toBe(
      'pending',
    );
    expect((await repo.get(2)).items.tm).toBe(0);
    expect((await repo.get(2)).revision).toBe(1);
  });
  it('revalidates TM battle presence after authentication and before its atomic debit', async () => {
    repo.rows.get(2).items.tm = 1;
    const original = auth.authenticate.bind(auth);
    auth.authenticate = async (token) => {
      const identity = await original(token);
      service.actors.get(clients[2].socketId).localBattle = true;
      return identity;
    };
    await expect(
      service.use(clients[2], useInput({ itemId: 'tm', moveId: 33 })),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    expect((await repo.get(2)).items.tm).toBe(1);
    expect((await repo.get(2)).uses ?? []).toEqual([]);
  });
  it('excludes TM from authorized battle stock, choices and checkpoint consumption', async () => {
    repo.rows.get(2).items.tm = 2;
    expect(await service.battleItemStock(2)).not.toHaveProperty('tm');
    expect(() =>
      validateChoice({
        kind: 'item',
        item: 'tm',
        captureId: 'capture-own',
        moveId: 33,
      }),
    ).toThrow('Objeto no disponible.');
    await expect(
      service.consumeBattleItem(2, 'battle', 'command', 'tm' as any, 33),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repo.get(2)).items.tm).toBe(2);
    expect((await repo.get(2)).battleUses ?? []).toEqual([]);
  });
  it.each(BALL_ITEM_IDS)(
    'spends one %s at confirmed throw, keeps cash/other stock and never charges again before or after ACK',
    async (itemId) => {
      await service.presence(clients[2], { ready: false, localBattle: true });
      Object.assign(repo.rows.get(2).items, {
        'poke-ball': 1,
        'great-ball': 1,
        'ultra-ball': 1,
      });
      const before = await repo.get(2);
      const payload = useInput({ itemId, context: 'local-battle' });
      const used = await service.use(clients[2], payload);
      const expectedItems = { ...before.items, [itemId]: 0 };
      expect(used.wallet).toEqual({
        userId: 2,
        rewardEpoch: 0,
        badges: [],
        balance: before.balance,
        currencyVersion: 1,
        revision: 1,
        items: expectedItems,
      });
      expect(used.use).toMatchObject({
        itemId,
        context: 'local-battle',
        planHash: payload.planHash,
        status: 'pending',
        walletRevision: 1,
      });
      expect((await service.use(clients[2], payload)).wallet).toEqual(
        used.wallet,
      );
      expect((await service.useCancel(clients[2], payload)).use.status).toBe(
        'pending',
      );
      // The throw is already spent regardless of its externally resolved result.
      // Its receipt can still complete after a successful catch ended the battle.
      await service.presence(clients[2], { ready: false, localBattle: false });
      await service.useApplied(clients[2], {
        requestId: payload.requestId,
        revision: 1,
      });
      const replay = await service.use(clients[2], payload);
      expect(replay.use.status).toBe('applied');
      expect(replay.wallet.items).toEqual(expectedItems);
      expect((await repo.get(2)).uses).toHaveLength(1);
      await service.presence(clients[2], { ready: true, localBattle: true });
      await expect(
        service.use(clients[2], {
          ...payload,
          requestId: 'throw-again',
          expectedWalletRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
      expect((await repo.get(2)).revision).toBe(1);
    },
  );
  it.each(BALL_ITEM_IDS)(
    'rejects %s outside a local battle and rejects move selectors without changing inventory',
    async (itemId) => {
      repo.rows.get(2).items[itemId] = 1;
      const party = useInput({ itemId });
      await expect(service.use(clients[2], party)).rejects.toMatchObject({
        code: 'PLAYER_IN_BATTLE',
      });
      await expect(service.useCancel(clients[2], party)).rejects.toMatchObject({
        code: 'PLAYER_IN_BATTLE',
      });
      const local = { ...party, context: 'local-battle' };
      await expect(service.use(clients[2], local)).rejects.toMatchObject({
        code: 'PLAYER_IN_BATTLE',
      });
      for (const moveId of [null, 1, 33]) {
        await expect(
          service.use(clients[2], { ...local, moveId }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(
          service.useCancel(clients[2], { ...local, moveId }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      expect((await repo.get(2)).items[itemId]).toBe(1);
      expect((await repo.get(2)).uses ?? []).toEqual([]);
    },
  );
  it('binds a spent ball to its original type, plan, encounter actor and browser', async () => {
    await service.presence(clients[2], { ready: false, localBattle: true });
    Object.assign(repo.rows.get(2).items, { 'poke-ball': 2, 'ultra-ball': 2 });
    const payload = useInput({ itemId: 'poke-ball', context: 'local-battle' });
    await service.use(clients[2], payload);
    for (const change of [
      { itemId: 'ultra-ball' },
      { planHash: 'b'.repeat(64) },
      { captureId: 'other-capture' },
    ])
      await expect(
        service.use(clients[2], { ...payload, ...change }),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    const anotherBrowser = {
      ...clients[2],
      clientId: 'another-browser',
      socketId: 'another-socket',
    };
    service.connect(anotherBrowser);
    await expect(service.use(anotherBrowser, payload)).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
    await expect(
      service.useApplied(anotherBrowser, {
        requestId: payload.requestId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    expect((await repo.get(2)).items).toEqual({
      'full-restore': 2,
      'poke-ball': 1,
      'ultra-ball': 2,
    });
  });
  it('cancels an uncommitted throw durably while never refunding a committed ball', async () => {
    repo.rows.get(2).items['poke-ball'] = 2;
    const payload = useInput({ itemId: 'poke-ball', context: 'local-battle' });
    const cancellation = await service.useCancel(clients[2], payload);
    expect(cancellation.use).toMatchObject({
      itemId: 'poke-ball',
      status: 'cancelled',
    });
    await service.presence(clients[2], { ready: true, localBattle: true });
    expect(
      (await service.use(clients[2], payload)).wallet.items['poke-ball'],
    ).toBe(2);
    const paid = { ...payload, requestId: 'paid-throw' };
    await service.use(clients[2], paid);
    expect((await service.useCancel(clients[2], paid)).use.status).toBe(
      'pending',
    );
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
    await service.useApplied(clients[2], {
      requestId: paid.requestId,
      revision: 1,
    });
    expect((await service.useCancel(clients[2], paid)).use.status).toBe(
      'applied',
    );
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
  });
  it('keeps an interrupted paid throw exclusive across server restart until its original browser ACKs', async () => {
    repo.rows.get(2).items['great-ball'] = 1;
    await service.presence(clients[2], { ready: false, localBattle: true });
    const payload = useInput({ itemId: 'great-ball', context: 'local-battle' });
    await service.use(clients[2], payload);
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    for (const actor of Object.values(clients)) service.connect(actor);
    expect((await service.sync(clients[2])).uses[0]).toMatchObject({
      itemId: 'great-ball',
      status: 'pending',
    });
    expect(await activity.busyUsers([2])).toEqual([2]);
    await expect(
      pvp.create(clients[1], {
        commandId: 'ball-trainer',
        playerAId: 2,
        trainerPresetId: 'kanto-brock',
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.reset(clients[2], {
        requestId: 'ball-reset',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.balanceAdjust(clients[1], {
        requestId: 'ball-adjust',
        playerUserId: 2,
        clientId: clients[2].clientId,
        delta: 100,
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.centerPreview(clients[1], {
        playerUserId: 2,
        clientId: clients[2].clientId,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    expect(
      (await service.use(clients[2], payload)).wallet.items['great-ball'],
    ).toBe(0);
    await service.useApplied(clients[2], {
      requestId: payload.requestId,
      revision: 1,
    });
    expect(await activity.busyUsers([2])).toEqual([]);
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('revalidates local battle and account ownership after authentication before charging a ball', async () => {
    repo.rows.get(2).items['ultra-ball'] = 1;
    await service.presence(clients[2], { ready: false, localBattle: true });
    const original = auth.authenticate.bind(auth);
    auth.authenticate = async (token) => {
      const identity = await original(token);
      service.actors.get(clients[2].socketId).localBattle = false;
      return identity;
    };
    await expect(
      service.use(
        clients[2],
        useInput({ itemId: 'ultra-ball', context: 'local-battle' }),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    expect((await repo.get(2)).items['ultra-ball']).toBe(1);
    expect((await repo.get(2)).revision).toBe(0);
  });
  it.each(BALL_ITEM_IDS)(
    'excludes %s from admin battle inventory, actions and checkpoint debits',
    async (itemId) => {
      repo.rows.get(2).items[itemId] = 2;
      expect(await service.battleItemStock(2)).not.toHaveProperty(itemId);
      expect(() =>
        validateChoice({
          kind: 'item',
          item: itemId,
          captureId: 'capture-own',
        }),
      ).toThrow('Objeto no disponible.');
      await expect(
        service.consumeBattleItem(2, 'battle', 'ball-command', itemId as any),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await repo.get(2)).items[itemId]).toBe(2);
      expect((await repo.get(2)).battleUses ?? []).toEqual([]);
    },
  );
  it('battle debit deduplicates the original key while rejecting a different item or Ether target', async () => {
    repo.rows.get(2).items['max-ether'] = 2;
    await service.consumeBattleItem(2, 'battle', 'command', 'max-ether', 1);
    await service.consumeBattleItem(2, 'battle', 'command', 'max-ether', 1);
    expect((await repo.get(2)).items['max-ether']).toBe(1);
    await expect(
      service.consumeBattleItem(2, 'battle', 'command', 'max-ether', 2),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.consumeBattleItem(2, 'battle', 'command', 'max-elixir'),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await service.consumeBattleFullRestore(
      2,
      'legacy-battle',
      'legacy-command',
    );
    delete repo.rows.get(2).battleUses[1].itemId;
    await service.consumeBattleFullRestore(
      2,
      'legacy-battle',
      'legacy-command',
    );
    expect((await repo.get(2)).items['full-restore']).toBe(1);
  });
});

describe('Background local inventory consumption batches', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    activity: PlayerActivityService,
    service: ShopService;
  const presence = {
    ready: true,
    localBattle: false,
    supportsBackgroundItemUses: true,
  };
  const operation = (sequence = 1, overrides: Record<string, any> = {}) => ({
    operationId: `local-${sequence}`,
    sequence,
    itemId: 'full-restore',
    quantity: 1,
    captureId: 'local-pokemon',
    context: 'party',
    ...overrides,
  });
  const batch = (operations = [operation()], clientId = 'shop-client-2') => ({
    clientId,
    operations,
  });
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    Object.values(clients).forEach((actor) => service.connect(actor));
    for (const userId of [2, 3])
      await service.presence(clients[userId], presence);
    repo.rows.get(2).items = {
      'full-restore': 3,
      'max-ether': 2,
      'max-elixir': 2,
      'max-revive': 2,
      'rare-candy': 2,
      tm: 2,
      'poke-ball': 2,
      'great-ball': 2,
      'ultra-ball': 2,
    };
    service.setPrepareHandler(async (_owner, request) => ({
      ok: true,
      revision: request.expectedWalletRevision,
      operation: request.operation,
    }));
  });
  it('advertises a separate stream per browser without changing legacy currency or inventing owner restrictions', async () => {
    expect((await service.sync(clients[2])).wallet).toMatchObject({
      balance: 500,
      revision: 0,
      consumptionAck: { clientId: clients[2].clientId, throughSequence: 0 },
    });
    const alternate = {
      ...clients[2],
      socketId: 'second-browser',
      clientId: '__proto__',
    };
    service.connect(alternate);
    await service.presence(alternate, presence);
    expect((await service.sync(alternate)).wallet.consumptionAck).toEqual({
      clientId: '__proto__',
      throughSequence: 0,
    });
    expect(
      (await service.sync(clients[2])).wallet.consumptionAck.clientId,
    ).toBe(clients[2].clientId);
    expect((await repo.get(2)).consumptionClients).toHaveLength(2);
    expect((await repo.get(2)).balance).toBe(500);
    expect((await repo.get(2)).revision).toBe(0);
    const old = {
      ...clients[3],
      socketId: 'legacy-browser',
      clientId: 'legacy-browser',
    };
    service.connect(old);
    await service.presence(old, { ready: true, localBattle: false });
    expect((await service.sync(old)).wallet).not.toHaveProperty(
      'consumptionAck',
    );
  });
  it('settles all usable items in one CAS revision without effect plans, catalogue checks or application ACKs', async () => {
    const requests = [
      'full-restore',
      'max-ether',
      'max-elixir',
      'max-revive',
      'rare-candy',
      'tm',
      'poke-ball',
      'great-ball',
      'ultra-ball',
    ].map((itemId, index) =>
      operation(index + 1, {
        itemId,
        context: itemId.endsWith('ball') ? 'local-battle' : 'party',
        ...(['max-ether', 'tm'].includes(itemId) ? { moveId: 33 } : {}),
      }),
    );
    const quote = jest.spyOn(service.catalog, 'quote');
    const result = await service.consumeBatch(clients[2], batch(requests));
    expect(result.consumptions).toHaveLength(9);
    expect(
      result.consumptions.every((entry) => entry.status === 'accepted'),
    ).toBe(true);
    expect(result.consumptions.some((entry) => 'requestHash' in entry)).toBe(
      false,
    );
    expect(result.wallet).toMatchObject({
      balance: 500,
      revision: 1,
      consumptionAck: { clientId: clients[2].clientId, throughSequence: 9 },
    });
    expect((await repo.get(2)).uses).toEqual([]);
    expect((await repo.get(2)).consumptions).toHaveLength(9);
    expect((await repo.get(2)).items['full-restore']).toBe(2);
    expect((await repo.get(2)).items.tm).toBe(1);
    expect((await repo.get(2)).items['max-revive']).toBe(1);
    expect((await repo.get(2)).items['rare-candy']).toBe(1);
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
    expect(quote).not.toHaveBeenCalled();
  });
  it('records insufficient stock as terminal rejections in sequence and repeats their metadata in every wallet snapshot', async () => {
    repo.rows.get(2).items['full-restore'] = 1;
    const requests = [
      operation(1),
      operation(2),
      operation(3, { itemId: 'tm', moveId: 33 }),
    ];
    const result = await service.consumeBatch(clients[2], batch(requests));
    expect(result.consumptions.map((entry) => entry.status)).toEqual([
      'accepted',
      'rejected',
      'accepted',
    ]);
    expect(result.wallet.items['full-restore']).toBe(0);
    expect(result.wallet.revision).toBe(1);
    expect(result.wallet.consumptionAck).toEqual({
      clientId: clients[2].clientId,
      throughSequence: 3,
      rejected: [
        {
          operationId: 'local-2',
          sequence: 2,
          itemId: 'full-restore',
          reason: 'INSUFFICIENT_ITEMS',
        },
      ],
    });
    expect((await service.sync(clients[2])).wallet.consumptionAck).toEqual(
      result.wallet.consumptionAck,
    );
    const before = await repo.get(2);
    expect(
      (await service.consumeBatch(clients[2], batch(requests))).consumptions,
    ).toEqual(result.consumptions);
    expect(await repo.get(2)).toEqual(before);
    const rejected = await service.consumeBatch(
      clients[2],
      batch([operation(4)]),
    );
    expect(rejected.consumptions[0].status).toBe('rejected');
    expect(rejected.wallet.revision).toBe(1);
    expect((await repo.get(2)).storageRevision).toBe(
      before.storageRevision + 1,
    );
    expect(rejected.wallet.consumptionAck.throughSequence).toBe(4);
  });
  it('allows two devices to compete for the last unit without negatives, owner takeover or a permanent rejected queue', async () => {
    repo.rows.get(2).items['full-restore'] = 1;
    const alternate = {
      ...clients[2],
      socketId: 'alternate-socket',
      clientId: 'alternate-client',
    };
    service.connect(alternate);
    await service.presence(alternate, presence);
    const [first, second] = await Promise.all([
      service.consumeBatch(clients[2], batch()),
      service.consumeBatch(alternate, batch([operation()], alternate.clientId)),
    ]);
    expect(first.consumptions[0].status).toBe('accepted');
    expect(second.consumptions[0]).toMatchObject({
      status: 'rejected',
      reason: 'INSUFFICIENT_ITEMS',
    });
    expect(first.wallet.consumptionAck.clientId).toBe(clients[2].clientId);
    expect(second.wallet.consumptionAck).toMatchObject({
      clientId: alternate.clientId,
      throughSequence: 1,
    });
    expect((await repo.get(2)).items['full-restore']).toBe(0);
    expect((await repo.get(2)).consumptions).toHaveLength(2);
    const before = await repo.get(2);
    await service.consumeBatch(
      alternate,
      batch([operation()], alternate.clientId),
    );
    expect(await repo.get(2)).toEqual(before);
    expect(
      (await service.sync(clients[2])).wallet.consumptionAck,
    ).not.toHaveProperty('rejected');
    expect(
      (await service.sync(clients[3])).wallet.consumptionAck.throughSequence,
    ).toBe(0);
  });
  it('deduplicates replayed prefixes and rejects altered operation IDs or sequence content without partial writes', async () => {
    await service.consumeBatch(clients[2], batch());
    await service.consumeBatch(clients[2], batch([operation(), operation(2)]));
    const before = await repo.get(2);
    expect(before.items['full-restore']).toBe(1);
    expect(before.revision).toBe(2);
    for (const changed of [
      operation(1, { itemId: 'max-elixir' }),
      operation(3, { operationId: 'local-1' }),
    ])
      await expect(
        service.consumeBatch(clients[2], batch([changed])),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.consumeBatch(clients[2], batch([operation(4)])),
    ).rejects.toMatchObject({ code: 'CONSUMPTION_GAP' });
    expect(await repo.get(2)).toEqual(before);
  });
  it('recovers an ACK lost before reload or restart by replaying the same accepted and rejected records', async () => {
    repo.rows.get(2).items['full-restore'] = 1;
    const requests = [operation(1), operation(2)];
    const result = await service.consumeBatch(clients[2], batch(requests));
    const restarted = new ShopService(
      repo,
      auth as any,
      new PlayerActivityService(),
      service.catalog,
    );
    await restarted.onModuleInit();
    restarted.connect(clients[2]);
    await restarted.presence(clients[2], {
      ...presence,
      ready: false,
      pendingConsumption: true,
    });
    const replay = await restarted.consumeBatch(clients[2], batch(requests));
    expect(replay.consumptions).toEqual(result.consumptions);
    expect(replay.wallet.consumptionAck).toEqual(result.wallet.consumptionAck);
    expect((await repo.get(2)).consumptions).toHaveLength(2);
    expect((await repo.get(2)).revision).toBe(1);
  });
  it('rejects malformed batches, client spoofing, unsupported capabilities and invalid contexts without advancing a watermark', async () => {
    const before = await repo.get(2);
    const invalid = [
      [],
      Array.from({ length: 101 }, (_, index) => operation(index + 1)),
      [operation(0)],
      [operation(1, { quantity: 2 })],
      [operation(1, { itemId: 'bicycle' })],
      [operation(1, { itemId: 'tm', moveId: 33, context: 'local-battle' })],
      [operation(1, { itemId: 'poke-ball' })],
      [operation(1, { moveId: 1 })],
      [operation(1, { itemId: 'max-ether', moveId: 355 })],
      [operation(1, { itemId: 'max-revive', moveId: 33 })],
      [operation(1, { itemId: 'rare-candy', moveId: 33 })],
      [operation(1, { itemId: 'rare-candy', context: 'local-battle' })],
      [operation(1, { planHash: 'anything' })],
      [operation(1), operation(2, { operationId: 'local-1' })],
    ];
    for (const operations of invalid)
      await expect(
        service.consumeBatch(clients[2], batch(operations)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.consumeBatch(clients[2], batch([operation()], 'other-client')),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(
      service.consumeBatch(
        clients[1],
        batch([operation()], clients[1].clientId),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_REQUIRED' });
    await service.presence(clients[2], { ready: true, localBattle: false });
    await expect(
      service.consumeBatch(clients[2], batch()),
    ).rejects.toMatchObject({ code: 'PLAYER_UPDATE_REQUIRED' });
    expect(await repo.get(2)).toEqual(before);
  });
  it('does not make auth failures, revoked sessions or storage failures terminal and retries the same operations safely', async () => {
    const before = await repo.get(2);
    const originalAuth = auth.authenticate.bind(auth);
    auth.authenticate = async () => {
      throw new MessageAuthError('AUTH_UNAVAILABLE', 'temporary auth outage');
    };
    await expect(
      service.consumeBatch(clients[2], batch()),
    ).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(await repo.get(2)).toEqual(before);
    auth.authenticate = originalAuth;
    jest
      .spyOn(repo, 'compareAndSwap')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(service.consumeBatch(clients[2], batch())).rejects.toThrow(
      'storage unavailable',
    );
    expect(await repo.get(2)).toEqual(before);
    jest.spyOn(repo, 'compareAndSwap').mockResolvedValueOnce(false);
    await service.consumeBatch(clients[2], batch());
    expect((await repo.get(2)).items['full-restore']).toBe(2);
    expect((await repo.get(2)).consumptions).toHaveLength(1);
  });
  it('fences a disconnected browser or role change while final authentication is outstanding', async () => {
    const original = auth.authenticate.bind(auth);
    auth.authenticate = async (token) => {
      const result = await original(token);
      service.disconnect(clients[2].socketId);
      return result;
    };
    await expect(
      service.consumeBatch(clients[2], batch()),
    ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect((await repo.get(2)).consumptions ?? []).toEqual([]);
    expect((await repo.get(2)).items['full-restore']).toBe(3);
  });
  it('advertises a pending queue as unavailable for external operations while allowing its background settlement', async () => {
    await service.presence(clients[2], {
      ...presence,
      ready: true,
      localBattle: true,
      pendingConsumption: true,
    });
    const row = (await service.sync(clients[1])).players.find(
      (entry) => entry.user.id === 2,
    );
    expect(row).toMatchObject({
      ready: false,
      pending: true,
      pendingConsumption: true,
    });
    await expect(activity.assertAvailable([2])).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    await expect(service.purchase(clients[1], input())).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    await expect(service.reset(clients[2], resetInput())).rejects.toMatchObject(
      { code: 'PLAYER_BUSY' },
    );
    await service.consumeBatch(clients[2], batch());
    expect((await repo.get(2)).items['full-restore']).toBe(2);
    await service.presence(clients[2], presence);
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
  });
  it('finishes a legacy pending use with its exact old fingerprint before settling background operations', async () => {
    const request = {
      requestId: 'legacy-before-background',
      captureId: 'local-pokemon',
      context: 'party',
      planHash: 'a'.repeat(64),
      expectedWalletRevision: 0,
    };
    const legacy = await service.use(clients[2], request);
    expect((await repo.get(2)).uses[0].requestHash).toBe(
      digest([
        2,
        clients[2].clientId,
        request.captureId,
        request.context,
        request.planHash,
        0,
      ]),
    );
    await expect(
      service.consumeBatch(clients[2], batch()),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await service.useApplied(clients[2], {
      requestId: request.requestId,
      revision: legacy.use.walletRevision,
    });
    await service.consumeBatch(clients[2], batch());
    expect((await repo.get(2)).items['full-restore']).toBe(1);
    expect((await service.use(clients[2], request)).use.status).toBe('applied');
  });
});

describe('Durable administrator item gifts', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    activity: PlayerActivityService,
    service: ShopService;
  const request = (overrides: Record<string, any> = {}) =>
    input({
      requestId: 'item-gift-1',
      itemId: 'tm',
      quantity: 3,
      ...overrides,
    });
  const cancel = (overrides: Record<string, any> = {}) => ({
    adminUserId: 1,
    ...request(),
    ...overrides,
  });
  const presence = { ready: true, localBattle: false, supportsItemGifts: true };
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    Object.values(clients).forEach((actor) => service.connect(actor));
    for (const id of [2, 3]) await service.presence(clients[id], presence);
    service.setPrepareHandler(async (_owner, request) => ({
      ok: true,
      revision: request.expectedWalletRevision,
      operation: request.operation,
    }));
  });
  it('grants every catalogued item without quoting prices, changing cash or modifying the catalogue', async () => {
    const before = await service.catalog.snapshot();
    const quote = jest.spyOn(service.catalog, 'quote');
    const commit = jest.spyOn(service.catalog, 'commit');
    repo.rows.get(2).balance = 0;
    let revision = 0;
    for (const itemId of Object.keys(SHOP_CATALOG)) {
      const result = await service.gift(
        clients[1],
        request({
          requestId: `gift-${itemId}`,
          itemId,
          quantity: 99,
          expectedWalletRevision: revision,
        }),
      );
      const receipt = result.purchases.find(
        (entry) => entry.requestId === `gift-${itemId}`,
      );
      expect(receipt).toMatchObject({
        kind: 'gift',
        itemId,
        quantity: 99,
        unitPrice: 0,
        total: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        walletRevision: ++revision,
        status: 'pending',
      });
      expect(result.players.find((entry) => entry.user.id === 2)).toMatchObject(
        {
          supportsItemGifts: true,
          pending: true,
        },
      );
      await service.applied(clients[2], {
        purchaseId: receipt.purchaseId,
        revision,
      });
    }
    expect((await repo.get(2)).items).toEqual(
      Object.fromEntries(Object.keys(SHOP_CATALOG).map((key) => [key, 99])),
    );
    expect((await repo.get(2)).balance).toBe(0);
    expect(await service.catalog.snapshot()).toEqual(before);
    expect(quote).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
  it('rejects non-admin grants, invalid quantities/items and client prices or catalogue revisions', async () => {
    await expect(service.gift(clients[2], request())).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    for (const quantity of [0, -1, 100, 1.5, '1', null, NaN, Infinity])
      await expect(
        service.gift(clients[1], request({ quantity })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const itemId of ['__proto__', 'unknown', null])
      await expect(
        service.gift(clients[1], request({ itemId })),
      ).rejects.toMatchObject({ code: 'INVALID_ITEM' });
    for (const extra of [
      { unitPrice: 0 },
      { total: 0 },
      { expectedCatalogRevision: 0 },
    ])
      await expect(
        service.gift(clients[1], request(extra)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.presence(clients[2], { ...presence, supportsItemGifts: 'true' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repo.get(2)).purchases).toEqual([]);
  });
  it('requires advertised gift support and an exact operation-aware PREPARE acknowledgement', async () => {
    const prepare = jest.fn(async (_owner: any, _request: any) => ({
      ok: true,
      revision: 0,
    }));
    service.setPrepareHandler(prepare);
    await service.presence(clients[2], { ready: true, localBattle: false });
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'PLAYER_UPDATE_REQUIRED',
    });
    expect(prepare).not.toHaveBeenCalled();
    await service.presence(clients[2], presence);
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'PLAYER_NOT_READY',
    });
    expect(prepare.mock.calls[0][1]).toEqual({
      requestId: 'item-gift-1',
      playerUserId: 2,
      clientId: 'shop-client-2',
      expectedWalletRevision: 0,
      operation: 'gift',
      adminUserId: 1,
      itemId: 'tm',
      quantity: 3,
    });
    expect((await repo.get(2)).revision).toBe(0);
  });
  it.each([
    ['capability', 'PLAYER_UPDATE_REQUIRED'],
    ['battle', 'PLAYER_NOT_READY'],
    ['disconnect', 'PLAYER_NOT_READY'],
    ['player-role', 'INVALID_PLAYER'],
    ['admin-role', 'ADMIN_REQUIRED'],
  ])(
    'revalidates %s after PREPARE before writing an item gift',
    async (change, code) => {
      service.setPrepareHandler(async (_owner, selection) => {
        const player = service.actors.get(clients[2].socketId);
        if (change === 'capability') player.supportsItemGifts = false;
        if (change === 'battle') player.localBattle = true;
        if (change === 'disconnect') service.disconnect(player.socketId);
        if (change === 'player-role') auth.users.get(2).role = 'admin';
        if (change === 'admin-role') auth.users.get(1).role = 'player';
        return {
          ok: true,
          revision: selection.expectedWalletRevision,
          operation: 'gift',
        };
      });
      await expect(service.gift(clients[1], request())).rejects.toMatchObject({
        code,
      });
      expect((await repo.get(2)).items).toEqual({});
      expect((await repo.get(2)).purchases).toEqual([]);
    },
  );
  it('preserves exact legacy purchase hashes and distinguishes gifts from genuine free purchases', async () => {
    const purchase = input();
    await service.purchase(clients[1], purchase);
    const stored = (await repo.get(2)).purchases[0];
    expect(stored).not.toHaveProperty('kind');
    expect(stored.requestHash).toBe(
      digest([1, 2, 'shop-client-2', 'poke-ball', 1, 0]),
    );
    await expect(service.gift(clients[1], purchase)).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
    await service.applied(clients[2], {
      purchaseId: stored.purchaseId,
      revision: 1,
    });
    const giftRequest = request({ expectedWalletRevision: 1 });
    await service.gift(clients[1], giftRequest);
    await expect(
      service.purchase(clients[1], giftRequest),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    const gift = (await repo.get(2)).purchases[1];
    expect(gift.requestHash).toBe(
      digest(['gift', 1, 2, 'shop-client-2', 'tm', 3, 1]),
    );
    await service.applied(clients[2], {
      purchaseId: gift.purchaseId,
      revision: 2,
    });
    await service.priceSet(clients[1], {
      requestId: 'free',
      itemId: 'tm',
      price: 0,
      expectedCatalogRevision: 0,
    });
    await service.purchase(
      clients[1],
      request({
        requestId: 'true-free',
        expectedWalletRevision: 2,
        expectedCatalogRevision: 1,
      }),
    );
    expect((await repo.get(2)).purchases[2]).toMatchObject({
      unitPrice: 0,
      total: 0,
    });
    expect((await repo.get(2)).purchases[2]).not.toHaveProperty('kind');
  });
  it('retries CAS and resumes the same gift after restart, disconnect and price changes without another increment', async () => {
    jest.spyOn(repo, 'compareAndSwap').mockResolvedValueOnce(false);
    const result = await service.gift(clients[1], request());
    const original = clone((await repo.get(2)).purchases[0]);
    const restarted = new ShopService(
      repo,
      auth as any,
      new PlayerActivityService(),
      service.catalog,
    );
    await restarted.onModuleInit();
    restarted.connect(clients[1]);
    await service.priceSet(clients[1], {
      requestId: 'price-after-gift',
      itemId: 'tm',
      price: 1,
      expectedCatalogRevision: 0,
    });
    expect((await restarted.gift(clients[1], request())).purchases).toEqual(
      result.purchases,
    );
    await expect(
      restarted.gift(clients[1], request({ quantity: 4 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect((await repo.get(2)).purchases).toEqual([original]);
    expect((await repo.get(2)).items.tm).toBe(3);
    expect((await repo.get(2)).revision).toBe(1);
  });
  it('blocks competing operations until the original browser confirms and keeps receipts private', async () => {
    const result = await service.gift(clients[1], request());
    const receipt = result.purchases[0];
    await expect(activity.assertAvailable([2])).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    await expect(
      service.purchase(clients[1], input({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.reset(clients[2], resetInput({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.gift(
        clients[1],
        request({ requestId: 'next', expectedWalletRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    expect((await service.sync(clients[3])).purchases).toEqual([]);
    expect((await service.sync(clients[4])).purchases).toEqual([]);
    await expect(
      service.applied(clients[3], {
        purchaseId: receipt.purchaseId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await service.applied(clients[2], {
      purchaseId: receipt.purchaseId,
      revision: 1,
    });
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
    expect(
      (await service.gift(clients[1], request())).purchases[0].status,
    ).toBe('applied');
  });
  it('rejects stale wallets, battles, overflow and full ledgers before reserving the frontend', async () => {
    const prepare = jest.fn();
    service.setPrepareHandler(prepare);
    await expect(
      service.gift(clients[1], request({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    service.actors.get(clients[2].socketId).localBattle = true;
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'PLAYER_IN_BATTLE',
    });
    service.actors.get(clients[2].socketId).localBattle = false;
    repo.rows.get(2).items.tm = Number.MAX_SAFE_INTEGER;
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'ITEM_LIMIT',
    });
    repo.rows.get(2).items.tm = 0;
    repo.rows.get(2).purchases = Array.from(
      { length: 4096 },
      (_, index) =>
        ({
          requestId: `old-${index}`,
          adminUserId: 1,
          status: 'applied',
        }) as any,
    );
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'PURCHASE_LIMIT',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('persists precommit cancellation without money, inventory or wallet revision changes and fences delayed grants', async () => {
    const before = await repo.get(2);
    const cancelled = await service.giftCancel(clients[2], cancel());
    expect(cancelled.purchases[0]).toMatchObject({
      kind: 'gift',
      status: 'cancelled',
      walletRevision: 0,
      balanceBefore: 500,
      balanceAfter: 500,
      unitPrice: 0,
      total: 0,
    });
    const after = await repo.get(2);
    expect(after.balance).toBe(before.balance);
    expect(after.items).toEqual(before.items);
    expect(after.revision).toBe(before.revision);
    expect(after.storageRevision).toBe(before.storageRevision + 1);
    expect(
      (await service.gift(clients[1], request())).purchases[0].status,
    ).toBe('cancelled');
    await service.giftCancel(clients[1], cancel());
    expect((await repo.get(2)).purchases).toHaveLength(1);
    await expect(
      service.gift(clients[1], request({ quantity: 1 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(service.purchase(clients[1], request())).rejects.toMatchObject(
      { code: 'REQUEST_CONFLICT' },
    );
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
  });
  it('restricts cancellation to the original administrator or owning player browser and checks exact selection', async () => {
    for (const actor of [
      clients[3],
      clients[4],
      { ...clients[2], clientId: 'other-browser' },
    ])
      await expect(service.giftCancel(actor, cancel())).rejects.toMatchObject({
        code: 'OWNER_REQUIRED',
      });
    await expect(
      service.giftCancel(clients[1], cancel({ expectedWalletRevision: 1 })),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    await service.giftCancel(clients[1], cancel());
    await expect(
      service.giftCancel(clients[1], cancel({ itemId: 'max-ether' })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect((await repo.get(2)).revision).toBe(0);
  });
  it('cancels an orphan after failed PREPARE and never executes it after a late retry', async () => {
    service.setPrepareHandler(async () => {
      throw new Error('PREPARE timed out');
    });
    await expect(service.gift(clients[1], request())).rejects.toThrow(
      'PREPARE timed out',
    );
    await service.giftCancel(clients[2], cancel());
    const prepare = jest.fn();
    service.setPrepareHandler(prepare);
    expect(
      (await service.gift(clients[1], request())).purchases[0].status,
    ).toBe('cancelled');
    expect(prepare).not.toHaveBeenCalled();
    expect((await repo.get(2)).items).toEqual({});
  });
  it('serializes a cancellation behind an in-flight PREPARE without reverting a committed gift', async () => {
    let release: () => void, entered: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    service.setPrepareHandler(async (_owner, selection) => {
      entered();
      await hold;
      return {
        ok: true,
        revision: selection.expectedWalletRevision,
        operation: 'gift',
      };
    });
    const grant = service.gift(clients[1], request());
    await started;
    const closing = service.giftCancel(clients[2], cancel());
    release();
    await grant;
    expect((await closing).purchases[0].status).toBe('pending');
    expect((await repo.get(2)).items.tm).toBe(3);
    expect((await repo.get(2)).revision).toBe(1);
  });
  it('cannot cancel paid inventory after commit or resurrect a cancelled gift through late APPLIED', async () => {
    const receipt = (await service.gift(clients[1], request())).purchases[0];
    expect(
      (await service.giftCancel(clients[1], cancel())).purchases[0].status,
    ).toBe('pending');
    await service.applied(clients[2], {
      purchaseId: receipt.purchaseId,
      revision: 1,
    });
    expect(
      (await service.giftCancel(clients[2], cancel())).purchases[0].status,
    ).toBe('applied');
    const cancelled = (
      await service.giftCancel(
        clients[2],
        cancel({ requestId: 'orphan-next', expectedWalletRevision: 1 }),
      )
    ).purchases.find((entry) => entry.requestId === 'orphan-next');
    await service.applied(clients[2], {
      purchaseId: cancelled.purchaseId,
      revision: 1,
    });
    expect((await repo.get(2)).purchases[1].status).toBe('cancelled');
    expect((await repo.get(2)).items.tm).toBe(3);
    expect((await repo.get(2)).balance).toBe(500);
  });
  it('returns an exact historical gift outside the recent fifty while preserving client and admin isolation', async () => {
    await service.giftCancel(clients[2], cancel());
    const row = repo.rows.get(2),
      original = clone(row.purchases[0]);
    row.purchases.push(
      ...Array.from({ length: 60 }, (_, index) => ({
        ...clone(original),
        purchaseId: `new-${index}`,
        requestId: `new-${index}`,
        createdAt: Date.now() + index + 1,
      })),
    );
    expect((await service.sync(clients[2])).purchases).toHaveLength(50);
    expect(
      (await service.sync(clients[2], { purchaseRequestId: 'item-gift-1' }))
        .purchases[0].requestId,
    ).toBe('item-gift-1');
    expect(
      (await service.sync(clients[1], { purchaseRequestId: 'item-gift-1' }))
        .purchases[0].requestId,
    ).toBe('item-gift-1');
    expect(
      (await service.sync(clients[3], { purchaseRequestId: 'item-gift-1' }))
        .purchases,
    ).toEqual([]);
    expect(
      (await service.gift(clients[1], request())).purchases[0].status,
    ).toBe('cancelled');
    const alternate = {
      ...clients[2],
      socketId: 'alternate-socket',
      clientId: 'alternate-client',
    };
    service.connect(alternate);
    expect(
      (await service.sync(alternate, { purchaseRequestId: 'item-gift-1' }))
        .purchases,
    ).toEqual([]);
    expect(row.purchases[0]).toEqual(original);
  });
  it('publishes every pending gift even when it falls outside the most recent fifty receipts', async () => {
    await service.gift(clients[1], request());
    const row = repo.rows.get(2),
      pending = clone(row.purchases[0]);
    row.purchases.push(
      ...Array.from({ length: 60 }, (_, index) => ({
        ...clone(pending),
        purchaseId: `later-${index}`,
        requestId: `later-${index}`,
        status: 'applied' as const,
        createdAt: Date.now() + index + 1,
      })),
    );
    const admin = await service.sync(clients[1]);
    const owner = await service.sync(clients[2]);
    expect(admin.purchases).toHaveLength(51);
    expect(owner.purchases).toHaveLength(51);
    expect(admin.purchases[0]).toMatchObject({
      requestId: request().requestId,
      status: 'pending',
      kind: 'gift',
    });
    expect((await service.sync(clients[4])).purchases).toEqual([]);
  });
  it('exposes a pending gift only within its own account across browsers while requiring original-client APPLIED', async () => {
    const receipt = (await service.gift(clients[1], request())).purchases[0];
    const alternate = {
      ...clients[2],
      socketId: 'gift-alternate-socket',
      clientId: 'gift-alternate-client',
    };
    service.connect(alternate);
    await service.presence(alternate, { ...presence, ready: false });
    const alternateState = await service.sync(alternate);
    expect(alternateState.purchases[0]).toMatchObject({
      kind: 'gift',
      status: 'pending',
      clientId: clients[2].clientId,
    });
    expect(
      (await service.sync(clients[1])).players.find(
        (entry) => entry.user.id === 2,
      ),
    ).toMatchObject({ ready: false, pending: true });
    await expect(
      service.applied(alternate, {
        purchaseId: receipt.purchaseId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    expect((await service.sync(clients[3])).purchases).toEqual([]);
    const original = { ...clients[2], socketId: 'gift-original-reconnected' };
    service.connect(original);
    await service.applied(original, {
      purchaseId: receipt.purchaseId,
      revision: 1,
    });
    expect((await service.sync(alternate)).purchases).toEqual([]);
    await service.presence(original, presence);
    await service.purchase(
      clients[1],
      input({ requestId: 'legacy-pending', expectedWalletRevision: 1 }),
    );
    expect((await service.sync(alternate)).purchases).toEqual([]);
    expect((await repo.get(2)).purchases[0].status).toBe('applied');
  });
  it('fences an exact player connection lost during final authentication after its PREPARE succeeded', async () => {
    const original = auth.authenticate.bind(auth);
    let playerAuthentications = 0;
    auth.authenticate = async (token) => {
      const result = await original(token);
      if (token === clients[2].token && ++playerAuthentications === 2)
        service.disconnect(clients[2].socketId);
      return result;
    };
    await expect(service.gift(clients[1], request())).rejects.toMatchObject({
      code: 'PLAYER_NOT_READY',
    });
    expect((await repo.get(2)).purchases).toEqual([]);
    expect((await repo.get(2)).items).toEqual({});
  });
  it('accepts the prepared browser becoming not ready while its own gift lock waits for final authentication', async () => {
    const original = auth.authenticate.bind(auth);
    let playerAuthentications = 0,
      entered: () => void,
      release: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    auth.authenticate = async (token) => {
      const result = await original(token);
      if (token === clients[2].token && ++playerAuthentications === 2) {
        entered();
        await hold;
      }
      return result;
    };
    const granting = service.gift(clients[1], request());
    await started;
    // A PREPARE lock makes the original browser unavailable for another
    // operation. It does not invalidate the transaction it already reserved.
    service.actors.get(clients[2].socketId).ready = false;
    release();
    expect((await granting).purchases[0]).toMatchObject({
      kind: 'gift',
      status: 'pending',
    });
    expect((await repo.get(2)).items.tm).toBe(3);
  });
  it('does not expose a gift or debit when its durable CAS fails, and safely closes the saved PREPARE', async () => {
    const original = repo.compareAndSwap.bind(repo);
    jest
      .spyOn(repo, 'compareAndSwap')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(service.gift(clients[1], request())).rejects.toThrow(
      'storage unavailable',
    );
    expect((await repo.get(2)).purchases).toEqual([]);
    expect((await repo.get(2)).revision).toBe(0);
    expect((await repo.get(2)).items).toEqual({});
    (repo.compareAndSwap as jest.Mock).mockImplementation(original);
    jest.spyOn(repo, 'compareAndSwap').mockResolvedValueOnce(false);
    await service.giftCancel(clients[2], cancel());
    expect((await repo.get(2)).purchases[0].status).toBe('cancelled');
    expect((await repo.get(2)).revision).toBe(0);
  });
});

describe('Shop Socket.IO authenticated namespace', () => {
  let app: INestApplication, auth: ReturnType<typeof fakeAuth>, rootUrl: string;
  const sockets: Socket[] = [];
  beforeEach(async () => {
    auth = fakeAuth();
    const module = await Test.createTestingModule({
      imports: [
        PvpModule.withRepository(new MemoryPvpRepository()),
        ShopModule.withRepository(new MemoryShopRepository()),
      ],
    })
      .overrideProvider(AuthIdentityService)
      .useValue(auth)
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    rootUrl = await app.getUrl();
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await app.close();
  });
  const emit = (socket: Socket, event: string, payload: any): Promise<any> =>
    new Promise((resolve, reject) =>
      socket
        .timeout(10000)
        .emit(event, payload, (error, response) =>
          error ? reject(error) : resolve(response),
        ),
    );
  async function connect(userId: number, token = `shop-user-${userId}`) {
    const socket = io(rootUrl + '/shop', {
      auth: { token, clientId: `shop-client-${userId}` },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }
  it('claims trainer rewards over Socket.IO without PREPARE and broadcasts the central balance once', async () => {
    const player = await connect(2);
    let prepares = 0;
    player.on('shop:prepare', () => {
      prepares++;
    });
    await emit(player, 'shop:presence', { ready: true, localBattle: false });
    const payload = {
      rewards: [
        { encounterId: 'socket-trainer-victory', color: 'red', epoch: 0 },
      ],
    };
    const first = await emit(player, 'shop:reward-claim', payload);
    expect(first.ok).toBe(true);
    expect(first.wallet).toMatchObject({ balance: 1100, rewardEpoch: 0 });
    expect(first.rewards[0]).toMatchObject({ amount: 600, status: 'credited' });
    const replay = await emit(player, 'shop:reward-claim', payload);
    expect(replay.wallet.balance).toBe(1100);
    expect(replay.rewards).toEqual(first.rewards);
    expect(prepares).toBe(0);
    const admin = await connect(1);
    expect((await emit(admin, 'shop:reward-claim', payload)).error.code).toBe(
      'PLAYER_REQUIRED',
    );
  });
  it('settles local consumptions over Socket.IO without PREPARE and broadcasts the client watermark including terminal stock conflicts', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    const operation = (sequence: number) => ({
      operationId: `socket-local-${sequence}`,
      sequence,
      itemId: 'full-restore',
      quantity: 1,
      captureId: 'local-actor',
      context: 'party',
    });
    const request = {
      clientId: 'shop-client-2',
      operations: [operation(1), operation(2)],
    };
    await emit(player, 'shop:sync', {});
    expect((await emit(player, 'shop:consume-batch', request)).error.code).toBe(
      'PLAYER_UPDATE_REQUIRED',
    );
    await emit(player, 'shop:presence', {
      ready: true,
      localBattle: false,
      supportsBackgroundItemUses: true,
      pendingConsumption: true,
    });
    const repo = app.get(ShopService).repository as MemoryShopRepository;
    repo.rows.get(2).items['full-restore'] = 1;
    const prepare = jest.fn();
    player.on('shop:prepare', prepare);
    const result = await emit(player, 'shop:consume-batch', request);
    expect(result.ok).toBe(true);
    expect(result.consumptions.map((entry) => entry.status)).toEqual([
      'accepted',
      'rejected',
    ]);
    expect(result.wallet).toMatchObject({
      balance: 500,
      revision: 1,
      items: { 'full-restore': 0 },
      consumptionAck: {
        clientId: 'shop-client-2',
        throughSequence: 2,
        rejected: [
          {
            operationId: 'socket-local-2',
            sequence: 2,
            itemId: 'full-restore',
            reason: 'INSUFFICIENT_ITEMS',
          },
        ],
      },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect((await emit(player, 'shop:sync', {})).wallet.consumptionAck).toEqual(
      result.wallet.consumptionAck,
    );
    expect(
      (await emit(player, 'shop:consume-batch', request)).consumptions,
    ).toEqual(result.consumptions);
    expect(
      (
        await emit(admin, 'shop:consume-batch', {
          ...request,
          clientId: 'shop-client-1',
        })
      ).error.code,
    ).toBe('PLAYER_REQUIRED');
    expect((await emit(other, 'shop:sync', {})).wallet).not.toHaveProperty(
      'consumptionAck',
    );
    const selected = (await emit(admin, 'shop:sync', {})).players.find(
      (entry) => entry.user.id === 2,
    );
    expect(selected).toMatchObject({
      ready: false,
      pendingConsumption: true,
      pending: true,
    });
    await emit(player, 'shop:presence', {
      ready: true,
      localBattle: false,
      supportsBackgroundItemUses: true,
      pendingConsumption: false,
    });
    expect(
      (await emit(admin, 'shop:sync', {})).players.find(
        (entry) => entry.user.id === 2,
      ).pending,
    ).toBe(false);
  });
  it('gifts items through an operation-aware player PREPARE and publishes private receipts without changing cash or prices', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    await emit(player, 'shop:presence', { ready: true, localBattle: false });
    await emit(other, 'shop:presence', { ready: true, localBattle: false });
    const request = input({
      requestId: 'socket-gift',
      itemId: 'tm',
      quantity: 9,
    });
    expect((await emit(admin, 'shop:gift', request)).error.code).toBe(
      'PLAYER_UPDATE_REQUIRED',
    );
    await emit(player, 'shop:presence', {
      ready: true,
      localBattle: false,
      supportsItemGifts: true,
    });
    let prepared: any;
    player.on('shop:prepare', (selection, ack) => {
      prepared = selection;
      ack({
        ok: true,
        revision: selection.expectedWalletRevision,
        operation: selection.operation,
      });
    });
    const before = (await emit(admin, 'shop:sync', {})).catalog;
    const granted = await emit(admin, 'shop:gift', request);
    expect(granted.ok).toBe(true);
    expect(prepared).toMatchObject({
      operation: 'gift',
      adminUserId: 1,
      itemId: 'tm',
      quantity: 9,
    });
    expect(granted.catalog).toEqual(before);
    expect(granted.purchases[0]).toMatchObject({
      kind: 'gift',
      unitPrice: 0,
      total: 0,
      balanceBefore: 500,
      balanceAfter: 500,
      status: 'pending',
    });
    const own = await emit(player, 'shop:sync', {
      purchaseRequestId: request.requestId,
    });
    expect(own.wallet).toMatchObject({
      balance: 500,
      revision: 1,
      items: { tm: 9 },
    });
    expect((await emit(other, 'shop:sync', {})).purchases).toEqual([]);
    expect((await emit(player, 'shop:gift', request)).error.code).toBe(
      'ADMIN_REQUIRED',
    );
    const receipt = own.purchases[0];
    await emit(player, 'shop:applied', {
      purchaseId: receipt.purchaseId,
      revision: 1,
    });
    expect((await emit(admin, 'shop:gift', request)).purchases[0].status).toBe(
      'applied',
    );
    expect(
      (await emit(admin, 'shop:sync', {})).players.find(
        (entry) => entry.user.id === 2,
      ).pending,
    ).toBe(false);
  });
  it('persists a player gift-cancel tombstone over WebSocket and fences any later admin submission', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    await emit(player, 'shop:sync', {});
    const request = input({
      requestId: 'never-gifted',
      itemId: 'max-ether',
      quantity: 2,
    });
    const closed = await emit(player, 'shop:gift-cancel', {
      ...request,
      adminUserId: 1,
    });
    expect(closed.ok).toBe(true);
    expect(closed.purchases[0]).toMatchObject({
      kind: 'gift',
      status: 'cancelled',
      walletRevision: 0,
    });
    expect(closed.wallet).toMatchObject({
      balance: 500,
      revision: 0,
      items: {},
    });
    expect((await emit(admin, 'shop:gift', request)).purchases[0].status).toBe(
      'cancelled',
    );
    expect(
      (await emit(other, 'shop:gift-cancel', { ...request, adminUserId: 1 }))
        .error.code,
    ).toBe('OWNER_REQUIRED');
    expect((await emit(player, 'shop:sync', {})).wallet.items).toEqual({});
  });
  it('publishes opponent automation to every player through the admin-only event without changing wallets', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    const observed = [player, other].map(
      (socket) =>
        new Promise<any>((resolve) => {
          const listener = (state: any) => {
            if (state.catalog?.automaticOpponents === true) {
              socket.off('shop:state', listener);
              resolve(state.catalog);
            }
          };
          socket.on('shop:state', listener);
        }),
    );
    const payload = {
      requestId: 'socket-automation',
      enabled: true,
      expectedCatalogRevision: 0,
    };
    expect(
      (await emit(player, 'shop:opponent-automation-set', payload)).error.code,
    ).toBe('ADMIN_REQUIRED');
    const result = await emit(admin, 'shop:opponent-automation-set', payload);
    expect(result.ok).toBe(true);
    expect(result.catalog.automaticOpponents).toBe(true);
    for (const catalogue of await Promise.all(observed))
      expect(catalogue).toEqual(result.catalog);
    const own = await emit(player, 'shop:sync', {});
    expect(own.wallet).toMatchObject({ balance: 500, revision: 0, items: {} });
    const disabled = await emit(admin, 'shop:opponent-automation-set', {
      requestId: 'socket-manual',
      enabled: false,
      expectedCatalogRevision: 1,
    });
    expect(disabled.catalog.automaticOpponents).toBe(false);
    expect((await emit(other, 'shop:sync', {})).catalog).toEqual(
      disabled.catalog,
    );
  });
  it('publishes the global difficulty through the authenticated admin event to every player without changing their wallet', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    const published = new Promise<any>((resolve) => {
      const listener = (state: any) => {
        if (state.catalog?.captureDifficulty === 2) {
          player.off('shop:state', listener);
          resolve(state.catalog);
        }
      };
      player.on('shop:state', listener);
    });
    const payload = {
      requestId: 'socket-difficulty',
      modifier: 2,
      expectedCatalogRevision: 0,
    };
    expect(
      (await emit(player, 'shop:capture-difficulty-set', payload)).error.code,
    ).toBe('ADMIN_REQUIRED');
    const changed = await emit(admin, 'shop:capture-difficulty-set', payload);
    expect(changed.ok).toBe(true);
    expect(changed.catalog.captureDifficulty).toBe(2);
    expect(await published).toEqual(changed.catalog);
    expect((await emit(other, 'shop:sync', {})).catalog).toEqual(
      changed.catalog,
    );
    const own = await emit(player, 'shop:sync', {});
    expect(own.wallet.balance).toBe(500);
    expect(own.wallet.revision).toBe(0);
  });
  it('rejects legacy balance clients and exposes an authenticated abort event with durable cancellation', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    const payload = {
      requestId: 'socket-balance',
      playerUserId: 2,
      clientId: 'shop-client-2',
      delta: 10000,
      expectedWalletRevision: 0,
    };
    await emit(player, 'shop:presence', { ready: true, localBattle: false });
    expect((await emit(admin, 'shop:balance-adjust', payload)).error.code).toBe(
      'PLAYER_UPDATE_REQUIRED',
    );
    player.on('shop:prepare', (request, ack) =>
      ack({
        ok: true,
        revision: request.expectedWalletRevision,
        operation: request.operation,
      }),
    );
    await emit(player, 'shop:presence', {
      ready: true,
      localBattle: false,
      supportsBalanceAdjustments: true,
    });
    const created = await emit(admin, 'shop:balance-adjust', payload);
    expect(created.ok).toBe(true);
    const adjustmentId = created.adjustment.adjustmentId;
    expect(
      (await emit(other, 'shop:balance-abort', { adjustmentId })).error.code,
    ).toBe('OWNER_REQUIRED');
    const cancelled = await emit(admin, 'shop:balance-abort', { adjustmentId });
    expect(cancelled.adjustment).toMatchObject({
      status: 'cancelled',
      cancelledWalletRevision: 2,
      cancelledBalance: 500,
    });
    expect(
      (
        await emit(player, 'shop:balance-applied', {
          adjustmentId,
          revision: 1,
        })
      ).adjustment.status,
    ).toBe('cancelled');
    expect((await emit(player, 'shop:sync', {})).wallet.balance).toBe(500);
    const selected = (await emit(admin, 'shop:sync', {})).players.find(
      (entry) => entry.user.id === 2,
    );
    expect(selected.pendingAdjustment).toBe(false);
    expect(selected.supportsBalanceAdjustments).toBe(true);
  });
  it('forwards private Center snapshots and prepared plans, publishes durable status and authenticates ACK/cancel', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    const partyHash = 'a'.repeat(64),
      planHash = 'b'.repeat(64);
    await emit(player, 'shop:presence', { ready: true, localBattle: false });
    expect(
      (
        await emit(admin, 'shop:center-preview', {
          playerUserId: 2,
          clientId: 'shop-client-2',
        })
      ).error.code,
    ).toBe('PLAYER_UPDATE_REQUIRED');
    const preview = {
      userId: 2,
      clientId: 'shop-client-2',
      partyRevision: 5,
      partyHash,
      pokemons: [
        {
          captureId: 'center-capture',
          pokemonId: 1,
          name: 'Bulbasaur',
          image: null,
          level: 5,
          currentHp: 0,
          maxHp: 25,
          statuses: ['poisoned'],
          needsHealing: true,
          moves: [{ id: 33, name: 'Tackle', currentPp: 0, maxPp: 35 }],
        },
      ],
    };
    player.on('shop:center-snapshot', (_request, ack) =>
      ack({ ok: true, preview }),
    );
    player.on('shop:center-prepare', (request, ack) =>
      ack({
        ok: true,
        operation: 'center-heal',
        partyRevision: request.partyRevision,
        partyHash: request.partyHash,
        planHash,
      }),
    );
    await emit(player, 'shop:presence', {
      ready: true,
      localBattle: false,
      supportsCenterHealing: true,
    });
    expect(
      (
        await emit(admin, 'shop:center-preview', {
          playerUserId: 2,
          clientId: 'shop-client-2',
        })
      ).centerPreview,
    ).toEqual(preview);
    const request = {
      requestId: 'socket-center',
      playerUserId: 2,
      clientId: 'shop-client-2',
      partyHash,
      partyRevision: 5,
      captureIds: ['center-capture'],
    };
    const created = await emit(admin, 'shop:center-heal', request);
    expect(created.ok).toBe(true);
    expect(created.centerHeal).toMatchObject({
      status: 'pending',
      centerRevision: 1,
    });
    const own = await emit(player, 'shop:sync', {
      centerRequestId: request.requestId,
    });
    expect(own.wallet.balance).toBe(500);
    expect(own.wallet.revision).toBe(0);
    expect(own.centerHeal.status).toBe('pending');
    expect((await emit(other, 'shop:sync', {})).centerHeals).toEqual([]);
    expect(
      (
        await emit(other, 'shop:center-cancel', {
          requestId: request.requestId,
          playerUserId: 2,
          clientId: 'shop-client-2',
        })
      ).error.code,
    ).toBe('OWNER_REQUIRED');
    const applied = await emit(player, 'shop:center-applied', {
      requestId: request.requestId,
      centerRevision: 1,
      planHash,
    });
    expect(applied.ok).toBe(true);
    expect(applied.centerHeal.status).toBe('applied');
    expect(
      (
        await emit(admin, 'shop:center-cancel', {
          requestId: request.requestId,
          playerUserId: 2,
          clientId: 'shop-client-2',
        })
      ).centerHeal.status,
    ).toBe('applied');
    expect(
      (await emit(admin, 'shop:sync', {})).players.find(
        (entry) => entry.user.id === 2,
      ).pendingCenter,
    ).toBe(false);
  });
  it('authenticates, broadcasts wallets privately and performs owner preflight before a persisted purchase', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    player.on('shop:prepare', (request, ack) =>
      ack({ ok: true, revision: request.expectedWalletRevision }),
    );
    await emit(player, 'shop:presence', { ready: true, localBattle: false });
    await emit(other, 'shop:presence', { ready: true, localBattle: false });
    const result = await emit(admin, 'shop:purchase', input());
    expect(result.ok).toBe(true);
    expect(result.purchases[0].total).toBe(150);
    const own = await emit(player, 'shop:sync', {});
    expect(own.wallet.balance).toBe(350);
    const unrelated = await emit(other, 'shop:sync', {});
    expect(unrelated.wallet.balance).toBe(500);
    expect(unrelated.purchases).toEqual([]);
    expect(
      (
        await emit(player, 'shop:applied', {
          purchaseId: own.purchases[0].purchaseId,
          revision: own.wallet.revision,
        })
      ).purchases[0].status,
    ).toBe('applied');
  });
  it('rejects revoked sessions, unauthorized purchases and extra client price fields', async () => {
    await expect(connect(99)).rejects.toMatchObject({
      data: { code: 'SESSION_REVOKED' },
    });
    const player = await connect(2),
      admin = await connect(1);
    expect((await emit(player, 'shop:purchase', input())).error.code).toBe(
      'ADMIN_REQUIRED',
    );
    expect(
      (await emit(admin, 'shop:purchase', input({ price: 1 }))).error.code,
    ).toBe('INVALID_INPUT');
    auth.users.delete(2);
    expect((await emit(player, 'shop:sync', {})).error.code).toBe(
      'SESSION_REVOKED',
    );
  });
  it('authenticates reset intents and publishes pending/completed resets without exposing another account receipt', async () => {
    const admin = await connect(1),
      player = await connect(2),
      other = await connect(3);
    await emit(player, 'shop:sync', {});
    expect((await emit(admin, 'shop:reset', resetInput())).error.code).toBe(
      'PLAYER_REQUIRED',
    );
    const reset = await emit(player, 'shop:reset', resetInput());
    expect(reset.ok).toBe(true);
    expect(reset.reset).toMatchObject({
      requestId: 'reset-1',
      status: 'pending',
    });
    expect(
      (await emit(admin, 'shop:sync', {})).players.find(
        (entry) => entry.user.id === 2,
      ).pendingReset,
    ).toBe(true);
    expect((await emit(other, 'shop:sync', {})).resets).toEqual([]);
    const applied = await emit(player, 'shop:reset-applied', {
      requestId: 'reset-1',
      revision: 1,
    });
    expect(applied.ok).toBe(true);
    expect(applied.resets[0].status).toBe('applied');
    expect(
      (await emit(admin, 'shop:sync', {})).players.find(
        (entry) => entry.user.id === 2,
      ).pending,
    ).toBe(false);
    auth.users.delete(2);
    expect(
      (
        await emit(
          player,
          'shop:reset',
          resetInput({ requestId: 'second', expectedWalletRevision: 1 }),
        )
      ).error.code,
    ).toBe('SESSION_REVOKED');
  });
  it('advertises the new reset contract and delivers six starter balls over Socket.IO exactly once', async () => {
    const player = await connect(2),
      admin = await connect(1);
    const initial = await emit(player, 'shop:sync', {});
    expect(initial.resetStarterItemsVersion).toBe(1);
    expect(initial.wallet.items).toEqual({});
    expect((await emit(admin, 'shop:sync', {})).resetStarterItemsVersion).toBe(
      1,
    );
    const payload = starterResetInput();
    const first = await emit(player, 'shop:reset', payload);
    expect(first.ok).toBe(true);
    expect(first.wallet.items).toEqual({ 'poke-ball': 6 });
    expect(first.reset).toMatchObject({
      starterItemsVersion: 1,
      walletRevision: 1,
      status: 'pending',
    });
    const replay = await emit(player, 'shop:reset', payload);
    expect(replay.reset).toEqual(first.reset);
    expect(replay.wallet.items).toEqual({ 'poke-ball': 6 });
    const ack = await emit(player, 'shop:reset-applied', {
      requestId: 'reset-1',
      revision: 1,
    });
    expect(ack.ok).toBe(true);
    expect(ack.wallet).toMatchObject({ balance: 500, revision: 1 });
    expect(ack.wallet.items).toEqual({ 'poke-ball': 6 });
    expect(ack.resets[0]).toMatchObject({
      starterItemsVersion: 1,
      status: 'applied',
    });
  });
  it('publishes cancellation receipts and refuses execution of the same request afterwards', async () => {
    const player = await connect(2);
    await emit(player, 'shop:sync', {});
    const cancelled = await emit(player, 'shop:reset-cancel', resetInput());
    expect(cancelled.ok).toBe(true);
    expect(cancelled.reset.status).toBe('cancelled');
    expect((await emit(player, 'shop:reset', resetInput())).reset.status).toBe(
      'cancelled',
    );
    expect((await emit(player, 'shop:sync', {})).wallet.revision).toBe(0);
  });
  it('a cancel fences a reset whose gateway authentication completes later', async () => {
    const player = await connect(2);
    await emit(player, 'shop:sync', {});
    const original = auth.authenticate.bind(auth);
    let entered: () => void;
    let release: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = true;
    auth.authenticate = async (token) => {
      const identity = await original(token);
      if (token === 'shop-user-2' && holdNext) {
        holdNext = false;
        entered();
        await finish;
      }
      return identity;
    };
    const late = emit(player, 'shop:reset', resetInput());
    await started;
    const cancelled = await emit(player, 'shop:reset-cancel', resetInput());
    expect(cancelled.reset.status).toBe('cancelled');
    release();
    expect((await late).reset.status).toBe('cancelled');
    expect((await emit(player, 'shop:sync', {})).wallet.revision).toBe(0);
  });
});

describe('Global opponent automation for new player encounters', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    service: ShopService;
  const setting = (overrides: Record<string, any> = {}) => ({
    requestId: 'auto-on',
    enabled: true,
    expectedCatalogRevision: 0,
    ...overrides,
  });
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    service = new ShopService(repo, auth as any, new PlayerActivityService());
    await service.onModuleInit();
    for (const actor of Object.values(clients)) service.connect(actor);
    await service.presence(clients[2], { ready: true, localBattle: false });
  });
  it('defaults legacy catalogues to manual mode, persists on/off across restarts and preserves wallet/prices/difficulty', async () => {
    const original = await service.catalog.repository.get();
    const wallet = await repo.get(2);
    expect(original).not.toHaveProperty('automaticOpponents');
    expect((await service.sync(clients[2])).catalog.automaticOpponents).toBe(
      false,
    );
    const enabled = await service.opponentAutomationSet(clients[1], setting());
    expect(enabled.catalog.automaticOpponents).toBe(true);
    expect(enabled.catalog.prices).toEqual(original.prices);
    expect(enabled.catalog.captureDifficulty).toBe(0);
    const restarted = new ShopCatalogService(service.catalog.repository);
    await restarted.onModuleInit();
    expect(await restarted.snapshot()).toEqual(enabled.catalog);
    await service.opponentAutomationSet(
      clients[1],
      setting({
        requestId: 'auto-off',
        enabled: false,
        expectedCatalogRevision: 1,
      }),
    );
    expect((await service.sync(clients[3])).catalog.automaticOpponents).toBe(
      false,
    );
    expect((await restarted.snapshot()).automaticOpponents).toBe(false);
    expect(await repo.get(2)).toEqual(wallet);
  });
  it('requires current admin identity, strict booleans and known input fields before any mutation', async () => {
    const original = await service.catalog.repository.get();
    await expect(
      service.opponentAutomationSet(clients[2], setting()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    for (const enabled of [undefined, null, 0, 1, 'true', 'false', [], {}])
      await expect(
        service.opponentAutomationSet(clients[1], setting({ enabled })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const expectedCatalogRevision of [-1, 0.5, null, '0'])
      await expect(
        service.opponentAutomationSet(
          clients[1],
          setting({ expectedCatalogRevision }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.opponentAutomationSet(clients[1], setting({ price: 1 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await service.catalog.repository.get()).toEqual(original);
    auth.users.get(1).role = 'player';
    await expect(
      service.opponentAutomationSet(clients[1], setting()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(await service.catalog.repository.get()).toEqual(original);
  });
  it('deduplicates commands across price/difficulty kinds and rejects stale settings without rewinding newer state', async () => {
    await service.opponentAutomationSet(clients[1], setting());
    await service.opponentAutomationSet(clients[1], setting());
    expect((await service.catalog.repository.get()).changes).toHaveLength(1);
    await expect(
      service.opponentAutomationSet(clients[1], setting({ enabled: false })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.priceSet(clients[1], {
        requestId: 'auto-on',
        itemId: 'tm',
        price: 0,
        expectedCatalogRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.captureDifficultySet(clients[1], {
        requestId: 'auto-on',
        modifier: 2,
        expectedCatalogRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.opponentAutomationSet(
        clients[1],
        setting({ requestId: 'stale' }),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_CONFLICT' });
    await service.captureDifficultySet(clients[1], {
      requestId: 'difficulty',
      modifier: 2,
      expectedCatalogRevision: 1,
    });
    await service.priceSet(clients[1], {
      requestId: 'price',
      itemId: 'tm',
      price: 0,
      expectedCatalogRevision: 2,
    });
    await service.opponentAutomationSet(
      clients[1],
      setting({
        requestId: 'auto-off',
        enabled: false,
        expectedCatalogRevision: 3,
      }),
    );
    const replay = await service.opponentAutomationSet(clients[1], setting());
    expect(replay.catalog).toMatchObject({
      revision: 4,
      automaticOpponents: false,
      captureDifficulty: 2,
      prices: { tm: 0 },
    });
    expect((await service.catalog.repository.get()).changes).toHaveLength(4);
  });
  it('revalidates the exact admin connection before commit and never writes a disconnected actor', async () => {
    const before = await service.catalog.repository.get();
    const authenticate = auth.authenticate.bind(auth);
    auth.authenticate = async (token: string) => {
      const verified = await authenticate(token);
      service.disconnect(clients[1].socketId);
      return verified;
    };
    await expect(
      service.opponentAutomationSet(clients[1], setting()),
    ).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(await service.catalog.repository.get()).toEqual(before);
  });
  it('preserves committed ball receipts and lets an uncommitted old quote close after the global toggle', async () => {
    await service.presence(clients[2], { ready: false, localBattle: true });
    repo.rows.get(2).items['poke-ball'] = 2;
    const input = {
      requestId: 'old-ball',
      captureId: 'own',
      itemId: 'poke-ball',
      context: 'local-battle',
      planHash: 'a'.repeat(64),
      expectedWalletRevision: 0,
      expectedCaptureRevision: 0,
    };
    const paid = await service.use(clients[2], input);
    await service.opponentAutomationSet(clients[1], setting());
    expect((await service.use(clients[2], input)).use).toEqual(paid.use);
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
    await service.useApplied(clients[2], {
      requestId: input.requestId,
      revision: 1,
    });
    const stale = {
      ...input,
      requestId: 'stale-ball',
      expectedWalletRevision: 1,
    };
    await expect(service.use(clients[2], stale)).rejects.toMatchObject({
      code: 'CAPTURE_RULES_CHANGED',
    });
    expect((await service.useCancel(clients[2], stale)).use.status).toBe(
      'cancelled',
    );
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
  });
});

describe('Global capture difficulty and paid-throw quote fencing', () => {
  let auth: ReturnType<typeof fakeAuth>,
    clients: Record<number, Actor>,
    repo: MemoryShopRepository,
    activity: PlayerActivityService,
    service: ShopService;
  const setting = (overrides: Record<string, any> = {}) => ({
    requestId: 'difficulty-1',
    modifier: 2,
    expectedCatalogRevision: 0,
    ...overrides,
  });
  const throwInput = (overrides: Record<string, any> = {}) => ({
    requestId: 'difficulty-ball',
    captureId: 'capture-own',
    context: 'local-battle',
    planHash: 'a'.repeat(64),
    expectedWalletRevision: 0,
    itemId: 'poke-ball',
    expectedCaptureRevision: 0,
    ...overrides,
  });
  beforeEach(async () => {
    auth = fakeAuth();
    clients = actors(auth);
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth as any, activity);
    await service.onModuleInit();
    for (const actor of Object.values(clients)) service.connect(actor);
    await service.presence(clients[2], { ready: false, localBattle: true });
    repo.rows.get(2).items['poke-ball'] = 2;
    repo.rows.get(2).items['full-restore'] = 1;
  });
  it('defaults legacy catalogues to zero without resetting prices and persists a global difficulty across restart', async () => {
    const legacy = await service.catalog.repository.get();
    expect(legacy).not.toHaveProperty('captureDifficulty');
    expect((await service.sync(clients[2])).catalog.captureDifficulty).toBe(0);
    const beforeWallet = await repo.get(2);
    await service.captureDifficultySet(clients[1], setting());
    const changed = await service.catalog.snapshot();
    expect(changed.captureDifficulty).toBe(2);
    expect(changed.prices).toEqual(legacy.prices);
    expect((await service.sync(clients[3])).catalog).toEqual(changed);
    const restarted = new ShopCatalogService(service.catalog.repository);
    await restarted.onModuleInit();
    expect(await restarted.snapshot()).toEqual(changed);
    expect(await repo.get(2)).toEqual(beforeWallet);
    await service.catalog.setPrice(1, {
      requestId: 'price',
      itemId: 'tm',
      price: 0,
      expectedCatalogRevision: 1,
    });
    expect((await service.catalog.snapshot()).captureDifficulty).toBe(2);
  });
  it('requires an admin, integers0..20 and a fresh revision and deduplicates setting commands across operation kinds', async () => {
    await expect(
      service.captureDifficultySet(clients[2], setting()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    for (const modifier of [-1, 21, 0.5, null, '2', NaN, Infinity])
      await expect(
        service.captureDifficultySet(clients[1], setting({ modifier })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await service.captureDifficultySet(clients[1], setting());
    await service.captureDifficultySet(clients[1], setting());
    expect((await service.catalog.repository.get()).changes).toHaveLength(1);
    await expect(
      service.captureDifficultySet(clients[1], setting({ modifier: 3 })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.priceSet(clients[1], {
        requestId: 'difficulty-1',
        itemId: 'tm',
        price: 0,
        expectedCatalogRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.captureDifficultySet(clients[1], setting({ requestId: 'stale' })),
    ).rejects.toMatchObject({ code: 'CAPTURE_RULES_CHANGED' });
    await service.captureDifficultySet(
      clients[1],
      setting({
        requestId: 'maximum',
        modifier: 20,
        expectedCatalogRevision: 1,
      }),
    );
    await service.captureDifficultySet(
      clients[1],
      setting({ requestId: 'normal', modifier: 0, expectedCatalogRevision: 2 }),
    );
    expect((await service.catalog.snapshot()).captureDifficulty).toBe(0);
  });
  it('revalidates the administrator before committing difficulty and leaves the catalogue unchanged after revocation', async () => {
    const before = await service.catalog.snapshot();
    auth.users.get(1).role = 'player';
    await expect(
      service.captureDifficultySet(clients[1], setting()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect(await service.catalog.snapshot()).toEqual(before);
  });
  it('allows legacy throws with normal difficulty after price changes, but rejects fresh legacy throws once difficulty is nonzero', async () => {
    await service.priceSet(clients[1], {
      requestId: 'price',
      itemId: 'tm',
      price: 0,
      expectedCatalogRevision: 0,
    });
    const legacy = throwInput();
    delete legacy.expectedCaptureRevision;
    const used = await service.use(clients[2], legacy);
    expect(used.use).not.toHaveProperty('captureRevision');
    await service.captureDifficultySet(
      clients[1],
      setting({ expectedCatalogRevision: 1 }),
    );
    await expect(
      service.use(clients[2], { ...legacy, expectedCaptureRevision: 2 }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect((await service.use(clients[2], legacy)).use.status).toBe('pending');
    await service.useApplied(clients[2], {
      requestId: legacy.requestId,
      revision: 1,
    });
    expect((await service.use(clients[2], legacy)).use.status).toBe('applied');
    await expect(
      service.use(clients[2], {
        ...legacy,
        requestId: 'old-second',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_UPDATE_REQUIRED' });
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
    expect((await repo.get(2)).uses).toHaveLength(1);
  });
  it('binds a new paid throw to its confirmed capture revision and keeps that receipt after live settings change', async () => {
    await service.captureDifficultySet(clients[1], setting());
    const request = throwInput({ expectedCaptureRevision: 1 });
    const used = await service.use(clients[2], request);
    expect(used.use).toMatchObject({
      captureRevision: 1,
      walletRevision: 1,
      status: 'pending',
    });
    const original = clone((await repo.get(2)).uses[0]);
    await service.captureDifficultySet(
      clients[1],
      setting({ requestId: 'harder', modifier: 3, expectedCatalogRevision: 1 }),
    );
    expect((await service.use(clients[2], request)).use).toEqual(used.use);
    expect((await repo.get(2)).uses[0]).toEqual(original);
    await expect(
      service.use(clients[2], { ...request, expectedCaptureRevision: 2 }),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await service.useApplied(clients[2], {
      requestId: request.requestId,
      revision: 1,
    });
    await expect(
      service.use(clients[2], {
        ...request,
        requestId: 'new-stale',
        expectedWalletRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CAPTURE_RULES_CHANGED' });
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
  });
  it('fences a difficulty update completed during player authentication before the final inventory CAS', async () => {
    const original = auth.authenticate.bind(auth);
    let once = true;
    auth.authenticate = async (token) => {
      const identity = await original(token);
      if (token === 'shop-user-2' && once) {
        once = false;
        await service.catalog.setCaptureDifficulty(1, setting());
      }
      return identity;
    };
    await expect(service.use(clients[2], throwInput())).rejects.toMatchObject({
      code: 'CAPTURE_RULES_CHANGED',
    });
    expect((await repo.get(2)).revision).toBe(0);
    expect((await repo.get(2)).items['poke-ball']).toBe(2);
    expect((await repo.get(2)).uses ?? []).toEqual([]);
  });
  it('holds the catalogue mutex across the final wallet write so settings cannot overtake a committed throw', async () => {
    const original = repo.compareAndSwap.bind(repo);
    let entered: () => void, release: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    repo.compareAndSwap = async (...args) => {
      entered();
      await gate;
      return original(...args);
    };
    const use = service.use(clients[2], throwInput());
    await started;
    let difficultySaved = false;
    const change = service.catalog
      .setCaptureDifficulty(1, setting())
      .then(() => {
        difficultySaved = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(difficultySaved).toBe(false);
    release();
    expect((await use).use.captureRevision).toBe(0);
    await change;
    expect((await service.catalog.snapshot()).captureDifficulty).toBe(2);
    expect((await repo.get(2)).items['poke-ball']).toBe(1);
  });
  it('permits a stale uncommitted quote to be cancelled durably without consulting or reverting live capture settings', async () => {
    await service.captureDifficultySet(clients[1], setting());
    const stale = throwInput();
    const cancelled = await service.useCancel(clients[2], stale);
    expect(cancelled.use).toMatchObject({
      status: 'cancelled',
      captureRevision: 0,
    });
    expect((await service.use(clients[2], stale)).use.status).toBe('cancelled');
    expect((await repo.get(2)).items['poke-ball']).toBe(2);
    expect((await service.catalog.snapshot()).captureDifficulty).toBe(2);
  });
  it('rejects malformed capture revisions and any revision on non-ball items without debiting', async () => {
    for (const expectedCaptureRevision of [-1, 0.5, null, '0', NaN])
      await expect(
        service.use(clients[2], throwInput({ expectedCaptureRevision })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const itemId of ['full-restore', 'max-ether', 'max-elixir', 'tm'])
      await expect(
        service.use(
          clients[2],
          throwInput({
            itemId,
            context: 'party',
            ...(itemId === 'max-ether' || itemId === 'tm'
              ? { moveId: 33 }
              : {}),
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repo.get(2)).revision).toBe(0);
  });
});
