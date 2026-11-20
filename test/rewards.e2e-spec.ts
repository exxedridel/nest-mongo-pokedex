import { PlayerActivityService } from '../src/messages/player-activity.service';
import { Actor } from '../src/pvp/pvp.types';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ShopService } from '../src/shop/shop.service';
import {
  LOCAL_TRAINER_REWARDS,
  LOCAL_TRAINER_PENALTIES,
  GYM_REWARD_BADGES,
  trainerPresetReward,
  trainerPresetPenalty,
} from '../src/shop/combat-rewards';

describe('Automatic combat rewards in the authoritative wallet', () => {
  let repository: MemoryShopRepository;
  let service: ShopService;
  let activity: PlayerActivityService;
  let player: Actor;
  const claim = (encounterId = 'encounter-1', color = 'pink', epoch = 0) => ({
    rewards: [{ encounterId, color, epoch }],
  });
  const penalty = (encounterId = 'loss-1', color = 'red', epoch = 0) => ({
    rewards: [{ encounterId, color, epoch, penaltyVersion: 1 }],
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
  it.each(Object.entries(GYM_REWARD_BADGES))(
    'grants %s cash, one TM and its unique badge atomically on every new victory',
    async (presetId, badgeId) => {
      const first = await service.creditBattleReward(
        2,
        'gym-win-one',
        presetId,
        0,
        1,
      );
      expect(first).toMatchObject({
        rewardBundleVersion: 1,
        badgeId,
        items: { tm: 1 },
        amount: trainerPresetReward(presetId),
      });
      expect(
        await service.creditBattleReward(2, 'gym-win-one', presetId, 0, 1),
      ).toEqual(first);
      expect((await repository.get(2)).items.tm).toBe(1);
      await service.creditBattleReward(2, 'gym-win-two', presetId, 0, 1);
      const row = await repository.get(2);
      expect(row.badges).toEqual([badgeId]);
      expect(row.items.tm).toBe(2);
      expect(row.balance).toBe(500 + trainerPresetReward(presetId) * 2);
      expect(row.rewards).toHaveLength(2);
    },
  );
  it('never upgrades old cash-only receipts and emits no gym extras for the Elite Four or rival', async () => {
    const old = await service.creditBattleReward(
      2,
      'old-win',
      'kanto-brock',
      0,
    );
    expect(old).not.toHaveProperty('items');
    expect(
      await service.creditBattleReward(2, 'old-win', 'kanto-brock', 0),
    ).toEqual(old);
    await expect(
      service.creditBattleReward(2, 'old-win', 'kanto-brock', 0, 1),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    for (const presetId of [
      'kanto-lorelei',
      'kanto-rival-lab-grass',
      'kanto-rival-champion-water',
    ]) {
      const receipt = await service.creditBattleReward(
        2,
        presetId,
        presetId,
        0,
        1,
      );
      expect(receipt.rewardBundleVersion).toBe(1);
      expect(receipt).not.toHaveProperty('badgeId');
      expect(receipt).not.toHaveProperty('items');
    }
    const row = await repository.get(2);
    expect(row.badges).toBeUndefined();
    expect(row.items.tm).toBeUndefined();
  });
  it('clears canonical badges on reset and rejects stale gym bundles without any item or badge grants', async () => {
    await service.creditBattleReward(2, 'gym-win', 'kanto-brock', 0, 1);
    const reset = await service.reset(player, {
      requestId: 'reset-badges',
      expectedWalletRevision: 1,
    });
    expect(reset.wallet).toMatchObject({
      balance: 500,
      badges: [],
      items: {},
      rewardEpoch: 1,
    });
    const rejected = await service.creditBattleReward(
      2,
      'stale-gym-win',
      'kanto-misty',
      0,
      1,
    );
    expect(rejected).toMatchObject({
      rewardBundleVersion: 1,
      status: 'rejected',
      reason: 'STALE_GAME',
      amount: 0,
    });
    expect(rejected).not.toHaveProperty('items');
    expect(rejected).not.toHaveProperty('badgeId');
    expect((await repository.get(2)).badges).toEqual([]);
    expect((await repository.get(2)).items.tm).toBeUndefined();
  });
  it.each(Object.entries(LOCAL_TRAINER_PENALTIES))(
    'settles a %s trainer defeat once with the exact server tariff, including free losses',
    async (color, nominalAmount) => {
      const first = await service.rewardClaim(player, penalty('defeat', color));
      expect(first.rewards[0]).toMatchObject({
        rewardId: 'local:defeat',
        penaltyVersion: 1,
        nominalAmount,
        amount: nominalAmount,
        status: 'debited',
        balanceBefore: 500,
        balanceAfter: 500 - nominalAmount,
      });
      expect(first.rewards[0]).not.toHaveProperty('badgeId');
      expect(first.rewards[0]).not.toHaveProperty('items');
      expect(first.wallet.balance).toBe(500 - nominalAmount);
      expect(
        (await service.rewardClaim(player, penalty('defeat', color))).rewards,
      ).toEqual(first.rewards);
      expect((await repository.get(2)).rewards).toHaveLength(1);
      expect((await repository.get(2)).revision).toBe(
        nominalAmount > 0 ? 1 : 0,
      );
    },
  );
  it.each([0, 75])(
    'clamps a loss at zero from %s PD and never charges the missing remainder after later money arrives',
    async (initialBalance) => {
      const row = await repository.get(2);
      row.balance = initialBalance;
      row.storageRevision++;
      await repository.compareAndSwap(row, 0);
      const first = await service.rewardClaim(player, penalty());
      expect(first.rewards[0]).toMatchObject({
        nominalAmount: 400,
        amount: initialBalance,
        status: 'debited',
        balanceBefore: initialBalance,
        balanceAfter: 0,
      });
      expect(first.wallet.balance).toBe(0);
      const later = await repository.get(2),
        previous = later.storageRevision;
      later.balance = 600;
      later.revision++;
      later.storageRevision++;
      await repository.compareAndSwap(later, previous);
      const replay = await service.rewardClaim(player, penalty());
      expect(replay.rewards).toEqual(first.rewards);
      expect(replay.wallet.balance).toBe(600);
    },
  );
  it.each([true, false])(
    'settles conflicting win/loss intents for one encounter only once (winFirst=%s)',
    async (winFirst) => {
      const win = claim('same-encounter', 'green'),
        lose = penalty('same-encounter', 'green');
      const first = await service.rewardClaim(player, winFirst ? win : lose);
      const contrary = await service.rewardClaim(player, winFirst ? lose : win);
      expect(contrary.rewards).toEqual(first.rewards);
      expect(contrary.wallet.balance).toBe(winFirst ? 800 : 400);
      const otherDevice = {
        ...player,
        clientId: 'loss-other-client',
        socketId: 'loss-other-socket',
      };
      service.connect(otherDevice);
      expect((await service.rewardClaim(otherDevice, lose)).rewards).toEqual(
        first.rewards,
      );
      await expect(
        service.rewardClaim(otherDevice, penalty('same-encounter', 'red')),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      await expect(
        service.rewardClaim(otherDevice, penalty('same-encounter', 'green', 1)),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      expect((await repository.get(2)).rewards).toHaveLength(1);
    },
  );
  it('serializes simultaneous contrary outcomes so their shared reward identity can never credit and debit', async () => {
    const [first, second] = await Promise.all([
      service.rewardClaim(player, claim('concurrent-outcomes', 'green')),
      service.rewardClaim(player, penalty('concurrent-outcomes', 'green')),
    ]);
    expect(first.rewards).toEqual(second.rewards);
    expect((await repository.get(2)).rewards).toHaveLength(1);
    expect((await repository.get(2)).balance).toBe(
      first.rewards[0].status === 'credited' ? 800 : 400,
    );
  });
  it('rejects stale loss epochs terminally without changing the new balance or any saved items and badges', async () => {
    const reset = await service.reset(player, {
      requestId: 'loss-reset',
      expectedWalletRevision: 0,
    });
    await service.resetApplied(player, {
      requestId: 'loss-reset',
      revision: reset.reset.walletRevision,
    });
    const rejected = await service.rewardClaim(
      player,
      penalty('old-offline-loss', 'red', 0),
    );
    expect(rejected.rewards[0]).toMatchObject({
      penaltyVersion: 1,
      nominalAmount: 400,
      status: 'rejected',
      reason: 'STALE_GAME',
      amount: 0,
    });
    expect(rejected.wallet.balance).toBe(500);
    const next = await service.rewardClaim(
      player,
      penalty('new-game-loss', 'red', 1),
    );
    expect(next.wallet.balance).toBe(100);
    expect(
      (await service.rewardClaim(player, penalty('old-offline-loss', 'red', 0)))
        .wallet.balance,
    ).toBe(100);
  });
  it('accepts no client amount or invalid penalty version and defers fresh debits while another central operation is pending', async () => {
    for (const invalid of [0, 2, null, '1'])
      await expect(
        service.rewardClaim(player, {
          rewards: [{ ...penalty().rewards[0], penaltyVersion: invalid }],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const key of ['amount', 'nominalAmount'])
      await expect(
        service.rewardClaim(player, {
          rewards: [{ ...penalty().rewards[0], [key]: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    activity.register('shop', async () => [2]);
    await expect(service.rewardClaim(player, penalty())).rejects.toMatchObject({
      code: 'PLAYER_BUSY',
    });
    expect((await repository.get(2)).rewards).toBeUndefined();
    activity.register('shop', async () => []);
    expect((await service.rewardClaim(player, penalty())).wallet.balance).toBe(
      100,
    );
  });
  it('an administrative loss can never later turn into cash, a TM or a badge for the same battle', async () => {
    const loss = await service.debitBattlePenalty(
      2,
      'one-battle',
      'kanto-brock',
      0,
    );
    expect(loss).toMatchObject({
      penaltyVersion: 1,
      nominalAmount: 50,
      amount: 50,
      status: 'debited',
    });
    expect(
      await service.creditBattleReward(2, 'one-battle', 'kanto-brock', 0, 1),
    ).toEqual(loss);
    expect(await repository.get(2)).toMatchObject({ balance: 450, items: {} });
    expect((await repository.get(2)).badges).toBeUndefined();
    await expect(
      service.debitBattlePenalty(2, 'one-battle', 'kanto-misty', 0),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  });
  it.each([
    ['kanto-brock', 50],
    ['kanto-misty', 100],
    ['kanto-surge', 200],
    ['kanto-erika', 300],
    ['kanto-koga', 400],
    ['kanto-sabrina', 400],
    ['kanto-blaine', 500],
    ['kanto-giovanni', 500],
    ['kanto-lorelei', 500],
    ['kanto-bruno', 500],
    ['kanto-agatha', 500],
    ['kanto-lance', 500],
    ['kanto-rival-lab-grass', 50],
    ['kanto-rival-lab-fire', 50],
    ['kanto-rival-lab-water', 50],
    ['kanto-rival-champion-grass', 500],
    ['kanto-rival-champion-fire', 500],
    ['kanto-rival-champion-water', 500],
  ])(
    'keeps the exact %s defeat tariff and clamps administrative debits',
    async (presetId, nominalAmount) => {
      expect(trainerPresetPenalty(presetId as string)).toBe(nominalAmount);
      const receipt = await service.debitBattlePenalty(
        2,
        'preset-loss',
        presetId as string,
        0,
      );
      expect(receipt).toMatchObject({
        penaltyVersion: 1,
        nominalAmount,
        amount: nominalAmount,
        status: 'debited',
      });
      expect((await repository.get(2)).balance).toBe(
        500 - Number(nominalAmount),
      );
    },
  );
});
