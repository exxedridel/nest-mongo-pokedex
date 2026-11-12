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
import { ShopModule } from '../src/shop/shop.module';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ShopService } from '../src/shop/shop.service';
import { clone, ShopError } from '../src/shop/shop.types';

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
    }));
    for (const userId of [2, 3])
      await service.presence(clients[userId], {
        ready: true,
        localBattle: false,
      });
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
