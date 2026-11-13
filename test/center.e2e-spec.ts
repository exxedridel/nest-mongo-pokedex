import { PlayerActivityService } from '../src/messages/player-activity.service';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ShopService } from '../src/shop/shop.service';
import { Actor } from '../src/pvp/pvp.types';
import { CenterPreview } from '../src/shop/shop.types';

describe('Poké Center durable free recovery', () => {
  let service: ShopService;
  let repo: MemoryShopRepository;
  let activity: PlayerActivityService;
  let clients: Record<number, Actor>;
  let auth: any;
  const hash = 'a'.repeat(64),
    planHash = 'b'.repeat(64);
  const request = (overrides: Record<string, any> = {}) => ({
    requestId: 'center-1',
    playerUserId: 2,
    clientId: 'client-2',
    partyHash: hash,
    partyRevision: 7,
    captureIds: ['capture-1', 'capture-2'],
    ...overrides,
  });
  const cancellation = (overrides: Record<string, any> = {}) => ({
    ...request(),
    adminUserId: 1,
    planHash,
    centerRevision: 1,
    ...overrides,
  });
  const preview = (): CenterPreview => ({
    userId: 2,
    clientId: 'client-2',
    partyHash: hash,
    partyRevision: 7,
    pokemons: [1, 2].map((id) => ({
      captureId: `capture-${id}`,
      pokemonId: id,
      name: `Pokemon ${id}`,
      image: null,
      level: 5,
      currentHp: 0,
      maxHp: 22,
      statuses: ['poisoned'],
      needsHealing: true,
      moves: [{ id: 33, name: 'Tackle', currentPp: 0, maxPp: 35 }],
    })),
  });
  beforeEach(async () => {
    const users = [1, 2, 3, 4].map((id) => ({
      id,
      email: `center${id}@example.test`,
      first_name: 'Center',
      last_name: String(id),
      role: id === 1 || id === 4 ? 'admin' : 'player',
    }));
    auth = {
      users,
      authenticate: jest.fn(async (token: string) => ({
        user: users.find((user) => `token-${user.id}` === token),
        expiresAt: Date.now() + 3600000,
      })),
      contacts: jest.fn(async () => users),
    };
    clients = Object.fromEntries(
      users.map((user) => [
        user.id,
        {
          user: { ...user },
          token: `token-${user.id}`,
          clientId: `client-${user.id}`,
          socketId: `socket-${user.id}`,
        },
      ]),
    ) as any;
    repo = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(repo, auth, activity);
    await service.onModuleInit();
    Object.values(clients).forEach((client) => service.connect(client));
    await service.presence(clients[2], {
      ready: true,
      localBattle: false,
      supportsCenterHealing: true,
      supportsBalanceAdjustments: true,
    });
    await service.presence(clients[3], { ready: true, localBattle: false });
    service.setCenterSnapshotHandler(async () => ({
      ok: true,
      preview: preview(),
    }));
    service.setCenterPrepareHandler(async (_owner, incoming) => ({
      ok: true,
      operation: 'center-heal',
      planHash,
      partyHash: incoming.partyHash,
      partyRevision: incoming.partyRevision,
    }));
  });
  it('reads an all-fainted team without requiring a battle-eligible snapshot and keeps it ephemeral', async () => {
    const result = await service.centerPreview(clients[1], {
      playerUserId: 2,
      clientId: 'client-2',
    });
    expect(result.centerPreview).toEqual(preview());
    expect((await service.sync(clients[3])).centerPreview).toBeUndefined();
    expect((await repo.get(2)).centerHeals).toBeUndefined();
  });
  it('projects only the validated display fields of the player snapshot', async () => {
    service.setCenterSnapshotHandler(async () => ({
      ok: true,
      preview: {
        ...preview(),
        privateParty: 'secret',
        pokemons: preview().pokemons.map((pokemon) => ({
          ...pokemon,
          bag: 100,
        })),
      } as any,
    }));
    const result = await service.centerPreview(clients[1], {
      playerUserId: 2,
      clientId: 'client-2',
    });
    expect(result.centerPreview).toEqual(preview());
  });
  it.each([
    [[]],
    [['one', 'two', 'three']],
    [['one', 'one']],
    [['invalid id']],
  ])('refuses an invalid selection %p before PREPARE', async (captureIds) => {
    const handler = jest.fn();
    service.setCenterPrepareHandler(handler);
    await expect(
      service.centerHeal(clients[1], request({ captureIds })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(handler).not.toHaveBeenCalled();
  });
  it('requires admin, advertised capability, ready player and matching current browser', async () => {
    await expect(
      service.centerHeal(clients[2], request()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(
      service.centerHeal(clients[1], request({ clientId: 'another' })),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    await service.presence(clients[2], { ready: true, localBattle: false });
    await expect(
      service.centerHeal(clients[1], request()),
    ).rejects.toMatchObject({ code: 'PLAYER_UPDATE_REQUIRED' });
    await service.presence(clients[2], {
      ready: false,
      localBattle: false,
      supportsCenterHealing: true,
    });
    await expect(
      service.centerHeal(clients[1], request()),
    ).rejects.toMatchObject({ code: 'PLAYER_NOT_READY' });
  });
  it('excludes local and network battles, pending purchases and pending item/reset/adjustment operations', async () => {
    await service.presence(clients[2], {
      ready: true,
      localBattle: true,
      supportsCenterHealing: true,
    });
    await expect(
      service.centerHeal(clients[1], request()),
    ).rejects.toMatchObject({ code: 'PLAYER_IN_BATTLE' });
    await service.presence(clients[2], {
      ready: true,
      localBattle: false,
      supportsCenterHealing: true,
    });
    activity.register('battle', async () => [2]);
    await expect(
      service.centerHeal(clients[1], request()),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    activity.register('battle', async () => []);
    for (const field of ['purchases', 'uses', 'resets', 'adjustments']) {
      const row = await repo.get(2);
      (row as any)[field] = [{ status: 'pending' }];
      await repo.compareAndSwap(row, row.storageRevision);
      await expect(
        service.centerHeal(clients[1], request()),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      (row as any)[field] = [];
      await repo.compareAndSwap(row, row.storageRevision);
    }
  });
  it('demands operation and original snapshot hash in the PREPARE acknowledgement', async () => {
    for (const response of [
      { ok: true },
      {
        ok: true,
        operation: 'center-heal',
        planHash,
        partyHash: 'c'.repeat(64),
        partyRevision: 7,
      },
    ]) {
      service.setCenterPrepareHandler(async () => response as any);
      await expect(
        service.centerHeal(clients[1], request()),
      ).rejects.toMatchObject({ code: 'PLAYER_NOT_READY' });
      expect((await repo.get(2)).centerHeals).toBeUndefined();
    }
  });
  it('stores metadata only, preserves cash/stock/revision and keeps the player busy until checked-write ACK', async () => {
    const before = await repo.get(2);
    const created = await service.centerHeal(clients[1], request());
    expect(created.centerHeal).toMatchObject({
      status: 'pending',
      centerRevision: 1,
      captureIds: ['capture-1', 'capture-2'],
    });
    const after = await repo.get(2);
    expect(after.balance).toBe(before.balance);
    expect(after.items).toEqual(before.items);
    expect(after.revision).toBe(before.revision);
    expect(after.storageRevision).toBe(1);
    expect((after.centerHeals[0] as any).pokemons).toBeUndefined();
    await expect(activity.assertAvailable([2])).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    const admin = await service.sync(clients[1]);
    expect(admin.players.find((player) => player.user.id === 2)).toMatchObject({
      pending: true,
      pendingCenter: true,
      supportsCenterHealing: true,
    });
    await expect(
      service.centerApplied(clients[3], {
        requestId: 'center-1',
        centerRevision: 1,
        planHash,
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(
      service.centerApplied(clients[2], {
        requestId: 'center-1',
        centerRevision: 1,
        planHash: hash,
      }),
    ).rejects.toMatchObject({ code: 'CENTER_CONFLICT' });
    expect(
      (
        await service.centerApplied(clients[2], {
          requestId: 'center-1',
          centerRevision: 1,
          planHash,
        })
      ).centerHeal.status,
    ).toBe('applied');
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
  });
  it('keeps pending busy after service restart and excludes every new operation', async () => {
    await service.centerHeal(clients[1], request());
    const secondActivity = new PlayerActivityService();
    const restarted = new ShopService(repo, auth, secondActivity);
    await restarted.onModuleInit();
    await expect(secondActivity.assertAvailable([2])).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    await expect(
      service.reset(clients[2], {
        requestId: 'reset',
        expectedWalletRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.balanceAdjust(clients[1], {
        requestId: 'adjust',
        playerUserId: 2,
        clientId: 'client-2',
        expectedWalletRevision: 0,
        delta: 1,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.purchase(clients[1], {
        requestId: 'buy',
        playerUserId: 2,
        clientId: 'client-2',
        itemId: 'poke-ball',
        quantity: 1,
        expectedWalletRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
  });
  it('deduplicates requests, fences changed selections and allows immediate free repeat with a new ID', async () => {
    const handler = jest.fn(async (_owner, incoming) => ({
      ok: true,
      operation: 'center-heal' as const,
      planHash,
      partyHash: incoming.partyHash,
      partyRevision: incoming.partyRevision,
    }));
    service.setCenterPrepareHandler(handler);
    await service.centerHeal(clients[1], request());
    await service.centerHeal(clients[1], request());
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      service.centerHeal(clients[1], request({ captureIds: ['capture-2'] })),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await service.centerApplied(clients[2], {
      requestId: 'center-1',
      centerRevision: 1,
      planHash,
    });
    await service.centerApplied(clients[2], {
      requestId: 'center-1',
      centerRevision: 1,
      planHash,
    });
    const second = await service.centerHeal(
      clients[1],
      request({ requestId: 'center-2', captureIds: ['capture-1'] }),
    );
    expect(second.centerHeal.centerRevision).toBe(2);
    expect((await repo.get(2)).balance).toBe(500);
  });
  it('cancels pending once without rollback, never revives via late ACK/replay and never reverses APPLIED', async () => {
    await service.centerHeal(clients[1], request());
    await expect(
      service.centerCancel(clients[4], {
        requestId: 'center-1',
        playerUserId: 2,
        clientId: 'client-2',
      }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    const cancelled = await service.centerCancel(clients[1], {
      requestId: 'center-1',
      playerUserId: 2,
      clientId: 'client-2',
    });
    expect(cancelled.centerHeal.status).toBe('cancelled');
    await service.centerCancel(clients[2], {
      requestId: 'center-1',
      playerUserId: 2,
      clientId: 'client-2',
    });
    expect(
      (
        await service.centerApplied(clients[2], {
          requestId: 'center-1',
          centerRevision: 1,
          planHash,
        })
      ).centerHeal.status,
    ).toBe('cancelled');
    expect(
      (await service.centerHeal(clients[1], request())).centerHeal.status,
    ).toBe('cancelled');
    await service.centerHeal(clients[1], request({ requestId: 'second' }));
    await service.centerApplied(clients[2], {
      requestId: 'second',
      centerRevision: 2,
      planHash,
    });
    expect(
      (
        await service.centerCancel(clients[1], {
          requestId: 'second',
          playerUserId: 2,
          clientId: 'client-2',
        })
      ).centerHeal.status,
    ).toBe('applied');
    expect((await repo.get(2)).revision).toBe(0);
  });
  it('closes an uncommitted exact PREPARE with an original-client tombstone before releasing its lock', async () => {
    await expect(
      service.centerCancel(clients[1], {
        requestId: 'center-1',
        playerUserId: 2,
        clientId: 'client-2',
      }),
    ).rejects.toMatchObject({ code: 'CENTER_NOT_FOUND' });
    const cancelled = await service.centerCancel(clients[2], cancellation());
    expect(cancelled.centerHeal.status).toBe('cancelled');
    const handler = jest.fn();
    service.setCenterPrepareHandler(handler);
    expect(
      (await service.centerHeal(clients[1], request())).centerHeal.status,
    ).toBe('cancelled');
    expect(handler).not.toHaveBeenCalled();
    expect((await repo.get(2)).centerHeals).toHaveLength(1);
    await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
  });
  it('rejects a duplicate request ID reused by another admin in the same player ledger', async () => {
    await service.centerHeal(clients[1], request());
    await service.centerApplied(clients[2], {
      requestId: 'center-1',
      centerRevision: 1,
      planHash,
    });
    await expect(
      service.centerHeal(clients[4], request()),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect((await repo.get(2)).centerHeals).toHaveLength(1);
  });
  it('refuses unknown cancellation from another browser or with a stale sequence', async () => {
    const otherBrowser = {
      ...clients[2],
      socketId: 'new-socket',
      clientId: 'new-client',
    };
    service.connect(otherBrowser);
    await expect(
      service.centerCancel(otherBrowser, cancellation()),
    ).rejects.toMatchObject({ code: 'CENTER_NOT_FOUND' });
    service.disconnect('new-socket');
    service.connect(clients[2]);
    await expect(
      service.centerCancel(clients[2], cancellation({ centerRevision: 2 })),
    ).rejects.toMatchObject({ code: 'CENTER_CONFLICT' });
  });
  it('closes a historical failed PREPARE after another browser completed the same sequence', async () => {
    // Original browser saved seq1 PREPARE but its server commit never arrived.
    const alternate = {
      ...clients[2],
      socketId: 'alternate-socket',
      clientId: 'alternate-client',
    };
    service.connect(alternate);
    await service.presence(alternate, {
      ready: true,
      localBattle: false,
      supportsCenterHealing: true,
    });
    const completed = await service.centerHeal(
      clients[1],
      request({ requestId: 'alternate-heal', clientId: alternate.clientId }),
    );
    expect(completed.centerHeal.centerRevision).toBe(1);
    await service.centerApplied(alternate, {
      requestId: 'alternate-heal',
      centerRevision: 1,
      planHash,
    });
    service.disconnect(alternate.socketId);
    service.connect(clients[2]);
    const cancelled = await service.centerCancel(clients[2], cancellation());
    expect(cancelled.centerHeal).toMatchObject({
      status: 'cancelled',
      requestId: 'center-1',
      centerRevision: 1,
    });
    expect((await repo.get(2)).centerRevision).toBe(1);
    expect(
      (await repo.get(2)).centerHeals.map((entry) => entry.status),
    ).toEqual(['applied', 'cancelled']);
    expect(
      (await service.centerHeal(clients[1], request())).centerHeal.status,
    ).toBe('cancelled');
    await service.presence(clients[2], {
      ready: true,
      localBattle: false,
      supportsCenterHealing: true,
    });
    expect(
      (
        await service.centerHeal(
          clients[1],
          request({ requestId: 'next-heal' }),
        )
      ).centerHeal.centerRevision,
    ).toBe(2);
  });
  it.each(['applied', 'cancelled'])(
    'keeps a historical tombstone from hiding a different pending at the same sequence until %s',
    async (terminal) => {
      const alternate = {
        ...clients[2],
        socketId: 'alternate-socket',
        clientId: 'alternate-client',
      };
      service.connect(alternate);
      await service.presence(alternate, {
        ready: true,
        localBattle: false,
        supportsCenterHealing: true,
      });
      await service.centerHeal(
        clients[1],
        request({
          requestId: 'alternate-pending',
          clientId: alternate.clientId,
        }),
      );
      // The original browser reconnects with its failed PREPARE seq1. Cancelling
      // it must not manufacture terminal seq1 while a different seq1 is pending.
      service.disconnect(alternate.socketId);
      service.connect(clients[2]);
      const before = await repo.get(2);
      await expect(
        service.centerCancel(clients[2], cancellation()),
      ).rejects.toMatchObject({ code: 'CENTER_CONFLICT' });
      expect(await repo.get(2)).toEqual(before);
      expect((await service.sync(clients[2])).centerHeals).toEqual([
        expect.objectContaining({
          requestId: 'alternate-pending',
          centerRevision: 1,
          status: 'pending',
        }),
      ]);
      await expect(activity.assertAvailable([2])).rejects.toMatchObject({
        code: 'PLAYER_BUSY',
      });
      if (terminal === 'applied') {
        service.disconnect(clients[2].socketId);
        service.connect(alternate);
        await service.centerApplied(alternate, {
          requestId: 'alternate-pending',
          centerRevision: 1,
          planHash,
        });
        service.disconnect(alternate.socketId);
        service.connect(clients[2]);
      } else {
        await service.centerCancel(clients[1], {
          requestId: 'alternate-pending',
          playerUserId: 2,
          clientId: alternate.clientId,
        });
      }
      expect(
        (await service.centerCancel(clients[2], cancellation())).centerHeal
          .status,
      ).toBe('cancelled');
      const row = await repo.get(2);
      expect(row.centerRevision).toBe(1);
      expect(row.centerHeals.map((entry) => entry.status)).toEqual([
        terminal,
        'cancelled',
      ]);
      await expect(activity.assertAvailable([2])).resolves.toBeUndefined();
    },
  );
  it('detects browser, role and local-battle changes after asynchronous PREPARE without committing', async () => {
    for (const change of ['browser', 'role', 'battle']) {
      service.connect(clients[2]);
      await service.presence(clients[2], {
        ready: true,
        localBattle: false,
        supportsCenterHealing: true,
      });
      auth.users[0].role = 'admin';
      service.setCenterPrepareHandler(async (_owner, incoming) => {
        if (change === 'browser') {
          service.connect({ ...clients[2], socketId: 'new-socket' });
          service.actors.get('new-socket').supportsCenterHealing = true;
        }
        if (change === 'role') auth.users[0].role = 'player';
        if (change === 'battle')
          service.actors.get(clients[2].socketId).localBattle = true;
        return {
          ok: true,
          operation: 'center-heal',
          planHash,
          partyHash: incoming.partyHash,
          partyRevision: incoming.partyRevision,
        };
      });
      await expect(
        service.centerHeal(clients[1], request()),
      ).rejects.toMatchObject({
        code:
          change === 'role'
            ? 'ADMIN_REQUIRED'
            : change === 'battle'
              ? 'PLAYER_IN_BATTLE'
              : 'SESSION_CHANGED',
      });
      expect((await repo.get(2)).centerHeals).toBeUndefined();
      service.disconnect('new-socket');
    }
  });
  it('does not hide a CAS storage failure behind successful healing and lets exact cancellation recover it', async () => {
    const original = repo.compareAndSwap.bind(repo);
    jest
      .spyOn(repo, 'compareAndSwap')
      .mockRejectedValueOnce(new Error('storage failed'));
    await expect(service.centerHeal(clients[1], request())).rejects.toThrow(
      'storage failed',
    );
    expect((await repo.get(2)).centerHeals).toBeUndefined();
    repo.compareAndSwap = original;
    expect(
      (await service.centerCancel(clients[2], cancellation())).centerHeal
        .status,
    ).toBe('cancelled');
  });
  it('returns exact old terminal receipts beyond the display window and all pending to the owner/admin only', async () => {
    const row = await repo.get(2);
    row.centerRevision = 60;
    row.centerHeals = Array.from({ length: 60 }, (_, index) => ({
      requestId: `history-${index}`,
      adminUserId: 1,
      userId: 2,
      clientId: 'client-2',
      captureIds: ['capture-1'],
      partyHash: hash,
      partyRevision: index,
      planHash,
      centerRevision: index + 1,
      status: index === 0 ? ('pending' as const) : ('applied' as const),
      requestHash: `hash-${index}`,
    }));
    await repo.compareAndSwap(row, 0);
    const state = await service.sync(clients[2], {
      centerRequestId: 'history-1',
    });
    expect(state.centerHeal.requestId).toBe('history-1');
    expect(state.centerHeals).toHaveLength(51);
    expect(
      state.centerHeals.some((entry) => entry.requestId === 'history-0'),
    ).toBe(true);
    expect((await service.sync(clients[1])).centerHeals).toHaveLength(51);
    expect((await service.sync(clients[3])).centerHeals).toEqual([]);
    expect((await service.sync(clients[4])).centerHeals).toEqual([]);
  });
});
