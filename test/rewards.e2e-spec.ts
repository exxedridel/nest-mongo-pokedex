import { PlayerActivityService } from '../src/messages/player-activity.service';
import { Actor } from '../src/pvp/pvp.types';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ShopService } from '../src/shop/shop.service';
import {
  LOCAL_TRAINER_REWARDS,
  trainerPresetReward,
} from '../src/shop/combat-rewards';

describe('Automatic combat rewards in the authoritative wallet', () => {
  let repository: MemoryShopRepository;
  let service: ShopService;
  let activity: PlayerActivityService;
  let player: Actor;
  const claim = (encounterId = 'encounter-1', color = 'pink', epoch = 0) => ({
    rewards: [{ encounterId, color, epoch }],
  });
  beforeEach(async () => {
    player = {
      user: {
        id: 2,
        email: 'reward@example.test',
        first_name: 'Player',
        last_name: 'QA',
        role: 'player',
      },
      token: 'token',
      clientId: 'reward-client',
      socketId: 'reward-socket',
    };
    repository = new MemoryShopRepository();
    activity = new PlayerActivityService();
    service = new ShopService(
      repository,
      { authenticate: async () => ({ user: player.user }) } as any,
      activity,
    );
    await service.onModuleInit();
    service.connect(player);
    await service.presence(player, { ready: true, localBattle: false });
  });
  it.each(Object.entries(LOCAL_TRAINER_REWARDS))(
    'derives %s payouts centrally and replays each encounter without another credit',
    async (color, amount) => {
      const first = await service.rewardClaim(player, claim('win', color));
      expect(first.wallet).toMatchObject({
        balance: 500 + amount,
        rewardEpoch: 0,
      });
      expect(first.rewards[0]).toMatchObject({
        rewardId: 'local:win',
        userId: 2,
        color,
        amount,
        status: 'credited',
      });
      const repeated = await service.rewardClaim(player, claim('win', color));
      expect(repeated.rewards).toEqual(first.rewards);
      expect(repeated.wallet.revision).toBe(first.wallet.revision);
      expect((await repository.get(2)).rewards).toHaveLength(1);
    },
  );
  it('deduplicates account encounters across devices and refuses a changed color or client-supplied money', async () => {
    await service.rewardClaim(player, claim());
    const other = {
      ...player,
      socketId: 'other-socket',
      clientId: 'other-client',
    };
    service.connect(other);
    expect((await service.rewardClaim(other, claim())).wallet.balance).toBe(
      700,
    );
    await expect(
      service.rewardClaim(other, claim('encounter-1', 'red')),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(
      service.rewardClaim(other, {
        rewards: [{ ...claim().rewards[0], amount: 99999 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repository.get(2)).balance).toBe(700);
  });
  it('pays repeat victories only for new encounter identities and serializes simultaneous additions', async () => {
    await Promise.all([
      service.rewardClaim(player, claim('win-one', 'pink')),
      service.rewardClaim(player, claim('win-two', 'red')),
    ]);
    const row = await repository.get(2);
    expect(row.balance).toBe(1300);
    expect(row.rewards).toHaveLength(2);
    expect(row.revision).toBe(2);
  });
  it('retries a failed CAS without crediting twice and returns exact old receipts beyond the recent window', async () => {
    const original = repository.compareAndSwap.bind(repository);
    let collide = true;
    jest
      .spyOn(repository, 'compareAndSwap')
      .mockImplementation(async (row, previous) => {
        if (collide) {
          collide = false;
          return false;
        }
        return original(row, previous);
      });
    const batch = {
      rewards: Array.from({ length: 60 }, (_, index) => ({
        encounterId: `win-${index}`,
        color: 'pink',
        epoch: 0,
      })),
    };
    await service.rewardClaim(player, batch);
    expect((await repository.get(2)).balance).toBe(12500);
    expect((await service.sync(player)).rewards).toHaveLength(50);
    expect(
      (await service.rewardClaim(player, claim('win-0'))).rewards[0].rewardId,
    ).toBe('local:win-0');
    expect((await repository.get(2)).balance).toBe(12500);
  });
  it('allows a previous victory to sync during a later local encounter without PREPARE or a player gate', async () => {
    service.setPrepareHandler(async () => {
      throw new Error('must not PREPARE');
    });
    await service.presence(player, { ready: false, localBattle: true });
    expect((await service.rewardClaim(player, claim())).wallet.balance).toBe(
      700,
    );
  });
  it('increments the game epoch only on committed reset and terminally rejects old-device rewards', async () => {
    await service.rewardClaim(player, claim('before-reset'));
    const reset = await service.reset(player, {
      requestId: 'new-game',
      expectedWalletRevision: 1,
    });
    expect(reset.wallet).toMatchObject({ balance: 500, rewardEpoch: 1 });
    const stale = await service.rewardClaim(
      player,
      claim('offline-old-game', 'red', 0),
    );
    expect(stale.rewards[0]).toMatchObject({
      status: 'rejected',
      reason: 'STALE_GAME',
      amount: 0,
    });
    expect(stale.wallet.balance).toBe(500);
    await service.resetApplied(player, {
      requestId: 'new-game',
      revision: reset.reset.walletRevision,
    });
    expect(
      (await service.rewardClaim(player, claim('current-game', 'green', 1)))
        .wallet.balance,
    ).toBe(800);
    expect(
      (await service.rewardClaim(player, claim('offline-old-game', 'red', 0)))
        .wallet.balance,
    ).toBe(800);
    expect(
      (await service.rewardClaim(player, claim('before-reset'))).wallet.balance,
    ).toBe(800);
  });
  it('waits behind pending central operations without consuming a new reward identity', async () => {
    activity.register('shop', async () => [2]);
    await expect(service.rewardClaim(player, claim())).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    expect((await repository.get(2)).rewards).toBeUndefined();
    activity.register('shop', async () => []);
    expect((await service.rewardClaim(player, claim())).wallet.balance).toBe(
      700,
    );
  });
  it('keeps old wallets unchanged when reading the additive epoch and credits administrative presets once', async () => {
    const before = await repository.get(2);
    expect((await service.sync(player)).wallet.rewardEpoch).toBe(0);
    expect(await repository.get(2)).toEqual(before);
    const first = await service.creditBattleReward(
      2,
      'battle-brock',
      'kanto-brock',
      0,
    );
    expect(first.amount).toBe(1200);
    expect(
      await service.creditBattleReward(2, 'battle-brock', 'kanto-brock', 0),
    ).toEqual(first);
    expect((await repository.get(2)).balance).toBe(1700);
  });
  it.each([
    ['kanto-brock', 1200],
    ['kanto-misty', 1400],
    ['kanto-surge', 1600],
    ['kanto-erika', 1800],
    ['kanto-koga', 2000],
    ['kanto-sabrina', 2000],
    ['kanto-blaine', 2300],
    ['kanto-giovanni', 2600],
    ['kanto-lorelei', 3000],
    ['kanto-bruno', 3000],
    ['kanto-agatha', 3000],
    ['kanto-lance', 3000],
    ['kanto-rival-lab-grass', 500],
    ['kanto-rival-lab-fire', 500],
    ['kanto-rival-lab-water', 500],
    ['kanto-rival-champion-grass', 6660],
    ['kanto-rival-champion-fire', 6660],
    ['kanto-rival-champion-water', 6660],
  ])('keeps the exact %s preset amount', (preset, amount) =>
    expect(trainerPresetReward(preset as string)).toBe(amount),
  );
});
