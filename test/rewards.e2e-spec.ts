import { PlayerActivityService } from '../src/messages/player-activity.service';
import { Actor } from '../src/pvp/pvp.types';
import { digest } from '../src/pvp/pvp.validation';
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
  it.each(['grass', 'fire', 'water'])(
    'pays the version-2 first rival %s with 250 PD and exactly one Great Ball per new victory',
    async (starter) => {
      const presetId = `kanto-rival-lab-${starter}`;
      expect(trainerPresetReward(presetId, 2)).toBe(250);
      expect(trainerPresetReward(presetId, 1)).toBe(500);
      expect(trainerPresetReward(presetId)).toBe(500);
      const first = await service.creditBattleReward(
        2,
        'rival-one',
        presetId,
        0,
        2,
      );
      expect(first).toMatchObject({
        rewardBundleVersion: 2,
        amount: 250,
        items: { 'great-ball': 1 },
        status: 'credited',
        walletRevision: 1,
      });
      expect(first).not.toHaveProperty('badgeId');
      const afterFirst = await repository.get(2);
      expect(afterFirst.balance).toBe(750);
      expect(afterFirst.items).toEqual({ 'great-ball': 1 });
      expect(afterFirst.badges).toBeUndefined();
      expect(
        await service.creditBattleReward(2, 'rival-one', presetId, 0, 2),
      ).toEqual(first);
      expect(await repository.get(2)).toEqual(afterFirst);
      await service.creditBattleReward(2, 'rival-two', presetId, 0, 2);
      const afterSecond = await repository.get(2);
      expect(afterSecond.balance).toBe(1000);
      expect(afterSecond.items).toEqual({ 'great-ball': 2 });
      expect(afterSecond.rewards).toHaveLength(2);
    },
  );
  it.each([undefined, 1] as const)(
    'preserves first-rival cash-only receipts and hashes for legacy bundle %s',
    async (version) => {
      const first = await service.creditBattleReward(
        2,
        'old-rival',
        'kanto-rival-lab-grass',
        0,
        version,
      );
      const saved = await repository.get(2);
      expect(first.amount).toBe(500);
      expect(first).not.toHaveProperty('items');
      expect(saved.balance).toBe(1000);
      expect(saved.items).toEqual({});
      await expect(
        service.creditBattleReward(
          2,
          'old-rival',
          'kanto-rival-lab-grass',
          0,
          2,
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
      expect(
        await service.creditBattleReward(
          2,
          'old-rival',
          'kanto-rival-lab-grass',
          0,
          version,
        ),
      ).toEqual(first);
      expect(await repository.get(2)).toEqual(saved);
    },
  );
  it('keeps all version-2 gym, Elite Four, champion and defeat tariffs and grants unchanged', async () => {
    const gym = await service.creditBattleReward(
      2,
      'new-gym',
      'kanto-brock',
      0,
      2,
    );
    expect(gym).toMatchObject({
      amount: 1200,
      items: { tm: 1 },
      badgeId: 'boulder',
      rewardBundleVersion: 2,
    });
    for (const presetId of ['kanto-lorelei', 'kanto-rival-champion-fire']) {
      const reward = await service.creditBattleReward(
        2,
        presetId,
        presetId,
        0,
        2,
      );
      expect(reward.amount).toBe(trainerPresetReward(presetId));
      expect(reward).not.toHaveProperty('items');
      expect(reward).not.toHaveProperty('badgeId');
    }
    const penaltyReceipt = await service.debitBattlePenalty(
      2,
      'lost-lab',
      'kanto-rival-lab-water',
      0,
    );
    expect(penaltyReceipt).toMatchObject({
      nominalAmount: 50,
      amount: 50,
      status: 'debited',
    });
    const row = await repository.get(2);
    expect(row.items).toEqual({ tm: 1 });
    expect(row.badges).toEqual(['boulder']);
  });
  it('rejects a stale new rival bundle with no money, Great Ball, TM or badge', async () => {
    const row = await repository.get(2);
    const revision = row.storageRevision++;
    row.rewardEpoch = 1;
    await repository.compareAndSwap(row, revision);
    const rejected = await service.creditBattleReward(
      2,
      'stale-rival',
      'kanto-rival-lab-water',
      0,
      2,
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'STALE_GAME',
      rewardBundleVersion: 2,
      amount: 0,
    });
    expect(rejected).not.toHaveProperty('items');
    expect(rejected).not.toHaveProperty('badgeId');
    expect((await repository.get(2)).balance).toBe(500);
    expect((await repository.get(2)).items).toEqual({});
  });
  it('saves the new cash and Great Ball together through CAS conflict and failed persistence', async () => {
    const before = await repository.get(2);
    jest
      .spyOn(repository, 'compareAndSwap')
      .mockRejectedValueOnce(new Error('failed wallet write'));
    await expect(
      service.creditBattleReward(
        2,
        'save-rival',
        'kanto-rival-lab-grass',
        0,
        2,
      ),
    ).rejects.toThrow('failed wallet write');
    expect(await repository.get(2)).toEqual(before);
    jest.spyOn(repository, 'compareAndSwap').mockResolvedValueOnce(false);
    const receipt = await service.creditBattleReward(
      2,
      'save-rival',
      'kanto-rival-lab-grass',
      0,
      2,
    );
    const saved = await repository.get(2);
    expect(saved.balance).toBe(750);
    expect(saved.items).toEqual({ 'great-ball': 1 });
    expect(saved.rewards).toHaveLength(1);
    expect(
      await service.creditBattleReward(
        2,
        'save-rival',
        'kanto-rival-lab-grass',
        0,
        2,
      ),
    ).toEqual(receipt);
    expect(await repository.get(2)).toEqual(saved);
  });
  it('refuses overflowing Great Ball inventory without crediting the accompanying money', async () => {
    const row = await repository.get(2);
    const previous = row.storageRevision++;
    row.items['great-ball'] = Number.MAX_SAFE_INTEGER;
    await repository.compareAndSwap(row, previous);
    const before = await repository.get(2);
    await expect(
      service.creditBattleReward(
        2,
        'overflow-rival',
        'kanto-rival-lab-fire',
        0,
        2,
      ),
    ).rejects.toMatchObject({ code: 'WALLET_CONFLICT' });
    expect(await repository.get(2)).toEqual(before);
  });
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

describe('Durable level-based and legacy payouts for player-side Pokémon releases', () => {
  let repository: MemoryShopRepository;
  let service: ShopService;
  let activity: PlayerActivityService;
  let player: Actor;
  let auth: any;
  const claim = (
    captureId = 'released-pokemon',
    epoch = 0,
    level?: number,
  ) => ({
    releases: [{ captureId, epoch, ...(level === undefined ? {} : { level }) }],
  });
  beforeEach(async () => {
    player = {
      user: {
        id: 2,
        email: 'release@example.test',
        first_name: 'Player',
        last_name: 'Release',
        role: 'player',
      },
      token: 'release-token',
      clientId: 'release-client',
      socketId: 'release-socket',
    };
    repository = new MemoryShopRepository();
    activity = new PlayerActivityService();
    auth = { authenticate: async () => ({ user: player.user }) };
    service = new ShopService(repository, auth, activity);
    await service.onModuleInit();
    service.connect(player);
    await service.presence(player, { ready: true, localBattle: false });
  });
  it.each([1, 15, 20, 100])(
    'derives a level %i release payout as level × 10 and persists the exact immutable receipt once',
    async (level) => {
      const first = await service.releaseClaim(
        player,
        claim('leveled', 0, level),
      );
      expect(first.wallet.balance).toBe(500 + level * 10);
      expect(first.rewards).toEqual([
        {
          rewardId: 'release:0:leveled',
          userId: 2,
          source: 'pokemon-release',
          captureId: 'leveled',
          epoch: 0,
          level,
          amount: level * 10,
          walletRevision: 1,
          status: 'credited',
        },
      ]);
      const saved = await repository.get(2);
      expect(saved.rewards[0].requestHash).toBe(
        digest([
          'combat-reward-v1',
          {
            rewardId: 'release:0:leveled',
            userId: 2,
            source: 'pokemon-release',
            captureId: 'leveled',
            epoch: 0,
            level,
            amount: level * 10,
          },
        ]),
      );
      expect(
        (await service.releaseClaim(player, claim('leveled', 0, level)))
          .rewards,
      ).toEqual(first.rewards);
      expect(await repository.get(2)).toEqual(saved);
    },
  );
  it('retains a pre-upgrade fixed 150 PD receipt and its original hash when a new device reports a higher level', async () => {
    const first = await service.releaseClaim(player, claim());
    const original = await repository.get(2);
    expect(first.rewards[0]).not.toHaveProperty('level');
    service = new ShopService(repository, auth, activity);
    await service.onModuleInit();
    service.connect(player);
    const replay = await service.releaseClaim(
      player,
      claim('released-pokemon', 0, 100),
    );
    expect(replay.rewards).toEqual(first.rewards);
    expect(replay.wallet.balance).toBe(650);
    expect(await repository.get(2)).toEqual(original);
  });
  it('retains a level-based receipt when a legacy 150 PD outbox replays that same capture', async () => {
    const first = await service.releaseClaim(player, claim('new-first', 0, 20));
    const original = await repository.get(2);
    const replay = await service.releaseClaim(player, claim('new-first'));
    expect(replay.rewards).toEqual(first.rewards);
    expect(replay.wallet.balance).toBe(700);
    expect(await repository.get(2)).toEqual(original);
  });
  it('settles differing simultaneous device snapshots once and returns the first persisted receipt to both devices and later replays', async () => {
    const alternate = {
      ...player,
      socketId: 'new-level-socket',
      clientId: 'new-level-client',
    };
    service.connect(alternate);
    const [first, other] = await Promise.all([
      service.releaseClaim(player, claim('same-capture', 0, 20)),
      service.releaseClaim(alternate, claim('same-capture', 0, 50)),
    ]);
    expect(other.rewards).toEqual(first.rewards);
    const saved = await repository.get(2);
    expect(saved.rewards).toHaveLength(1);
    expect(saved.balance).toBe(500 + first.rewards[0].level * 10);
    expect(saved.revision).toBe(1);
    for (const level of [1, 15, 100])
      expect(
        (await service.releaseClaim(alternate, claim('same-capture', 0, level)))
          .rewards,
      ).toEqual(first.rewards);
    expect(await repository.get(2)).toEqual(saved);
  });
  it('keeps a stale level-based release terminal after reset and preserves its first level instead of paying a later snapshot', async () => {
    const reset = await service.reset(player, {
      requestId: 'new-release-game',
      expectedWalletRevision: 0,
      starterItemsVersion: 1,
    });
    const first = await service.releaseClaim(
      player,
      claim('late-release', 0, 60),
    );
    expect(first.rewards[0]).toMatchObject({
      level: 60,
      amount: 0,
      status: 'rejected',
      reason: 'STALE_GAME',
    });
    await service.resetApplied(player, {
      requestId: 'new-release-game',
      revision: reset.reset.walletRevision,
    });
    const saved = await repository.get(2);
    expect(
      (await service.releaseClaim(player, claim('late-release', 0, 100)))
        .rewards,
    ).toEqual(first.rewards);
    expect(
      (await service.releaseClaim(player, claim('late-release'))).rewards,
    ).toEqual(first.rewards);
    expect(await repository.get(2)).toEqual(saved);
    expect(
      (await service.releaseClaim(player, claim('late-release', 1, 20))).wallet
        .balance,
    ).toBe(700);
    expect((await repository.get(2)).items).toEqual({ 'poke-ball': 6 });
  });
  it('validates every provided release level as an integer between 1 and 100, including replays, and rejects client-supplied amounts', async () => {
    const first = await service.releaseClaim(
      player,
      claim('valid-level', 0, 15),
    );
    const original = await repository.get(2);
    for (const level of [
      0,
      101,
      -1,
      15.5,
      NaN,
      Infinity,
      null,
      '15',
      true,
      {},
      [],
    ])
      await expect(
        service.releaseClaim(player, claim('valid-level', 0, level as any)),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.releaseClaim(player, {
        releases: [{ ...claim('valid-level', 0, 15).releases[0], amount: 150 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      (await service.releaseClaim(player, claim('valid-level', 0, 15))).rewards,
    ).toEqual(first.rewards);
    expect(await repository.get(2)).toEqual(original);
  });
  it('advertises support without changing a wallet, then pays exactly 150 PD while retaining stock, badges and all old receipt hashes', async () => {
    const prior = await service.rewardClaim(player, {
      rewards: [{ encounterId: 'prior-trainer', color: 'pink', epoch: 0 }],
    });
    repository.rows.get(2).items = { 'poke-ball': 3, tm: 2 };
    repository.rows.get(2).badges = ['boulder'];
    const before = await repository.get(2);
    expect((await service.sync(player)).releaseRewardsVersion).toBe(2);
    expect(await repository.get(2)).toEqual(before);
    const first = await service.releaseClaim(player, claim());
    expect(first.wallet.balance).toBe(850);
    expect(first.wallet.items).toEqual(before.items);
    expect(first.wallet.badges).toEqual(before.badges);
    expect(first.rewards).toEqual([
      {
        rewardId: 'release:0:released-pokemon',
        userId: 2,
        source: 'pokemon-release',
        captureId: 'released-pokemon',
        epoch: 0,
        amount: 150,
        walletRevision: 2,
        status: 'credited',
      },
    ]);
    const row = await repository.get(2);
    expect(row.rewards[0]).toEqual(before.rewards[0]);
    expect(row.rewards[1].requestHash).toBe(
      digest([
        'combat-reward-v1',
        {
          rewardId: 'release:0:released-pokemon',
          userId: 2,
          source: 'pokemon-release',
          captureId: 'released-pokemon',
          epoch: 0,
          amount: 150,
        },
      ]),
    );
    expect(
      (
        await service.rewardClaim(player, {
          rewards: [{ encounterId: 'prior-trainer', color: 'pink', epoch: 0 }],
        })
      ).rewards,
    ).toEqual(prior.rewards);
    expect((await service.releaseClaim(player, claim())).rewards).toEqual(
      first.rewards,
    );
    expect(await repository.get(2)).toEqual(row);
  });
  it('deduplicates simultaneous releases and repeated entries across devices by account, epoch and capture identity', async () => {
    const alternate = {
      ...player,
      socketId: 'release-other-socket',
      clientId: 'release-other-client',
    };
    service.connect(alternate);
    const [first, second] = await Promise.all([
      service.releaseClaim(player, claim()),
      service.releaseClaim(alternate, {
        releases: [claim().releases[0], claim().releases[0]],
      }),
    ]);
    expect(second.rewards).toEqual([first.rewards[0], first.rewards[0]]);
    expect((await repository.get(2)).balance).toBe(650);
    expect((await repository.get(2)).rewards).toHaveLength(1);
    expect((await repository.get(2)).revision).toBe(1);
    await Promise.all([
      service.releaseClaim(player, claim('second')),
      service.releaseClaim(alternate, claim('third')),
    ]);
    expect((await repository.get(2)).balance).toBe(950);
    expect((await repository.get(2)).rewards).toHaveLength(3);
  });
  it('keeps identical capture IDs independent across authenticated accounts', async () => {
    const other = {
      ...player,
      user: { ...player.user, id: 3 },
      token: 'other-token',
      socketId: 'other-socket',
      clientId: 'other-client',
    };
    auth.authenticate = async (token: string) => ({
      user: token === other.token ? other.user : player.user,
    });
    service.connect(other);
    await service.presence(other, { ready: true, localBattle: false });
    const first = await service.releaseClaim(player, claim());
    const second = await service.releaseClaim(other, claim());
    expect(first.rewards[0].userId).toBe(2);
    expect(second.rewards[0].userId).toBe(3);
    expect((await repository.get(2)).balance).toBe(650);
    expect((await repository.get(3)).balance).toBe(650);
  });
  it('retains exact historical receipts beyond the recent window and across a service restart', async () => {
    const first = await service.releaseClaim(player, {
      releases: Array.from({ length: 60 }, (_, index) => ({
        captureId: `released-${index}`,
        epoch: 0,
      })),
    });
    const before = await repository.get(2);
    expect((await service.sync(player)).rewards).toHaveLength(50);
    expect(before.balance).toBe(9500);
    service = new ShopService(repository, auth, activity);
    await service.onModuleInit();
    service.connect(player);
    const replay = await service.releaseClaim(player, claim('released-0'));
    expect(replay.rewards).toEqual([first.rewards[0]]);
    expect(await repository.get(2)).toEqual(before);
  });
  it('retries a CAS collision once and recovers a lost success response without paying a second time', async () => {
    const cas = repository.compareAndSwap.bind(repository);
    let calls = 0;
    repository.compareAndSwap = async (...args) => {
      calls++;
      if (calls === 1) return false;
      const saved = await cas(...args);
      if (calls === 2) throw new Error('Lost release success response');
      return saved;
    };
    await expect(service.releaseClaim(player, claim())).rejects.toThrow(
      'Lost release',
    );
    expect((await repository.get(2)).balance).toBe(650);
    const committed = await repository.get(2);
    const replay = await service.releaseClaim(player, claim());
    expect(replay.rewards[0]).toMatchObject({
      amount: 150,
      status: 'credited',
      walletRevision: 1,
    });
    expect(await repository.get(2)).toEqual(committed);
    expect(calls).toBe(2);
  });
  it('never reports or retains a payout when its wallet write fails', async () => {
    const original = await repository.get(2);
    const cas = repository.compareAndSwap.bind(repository);
    repository.compareAndSwap = async () => {
      throw new Error('Release DB unavailable');
    };
    await expect(service.releaseClaim(player, claim())).rejects.toThrow(
      'Release DB unavailable',
    );
    expect(await repository.get(2)).toEqual(original);
    repository.compareAndSwap = cas;
    expect((await service.releaseClaim(player, claim())).wallet.balance).toBe(
      650,
    );
  });
  it('waits for pending central operations without consuming a fresh identity and still permits an exact prior replay', async () => {
    const first = await service.releaseClaim(player, claim());
    activity.register('shop', async () => [2]);
    await expect(
      service.releaseClaim(player, claim('next')),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    expect((await service.releaseClaim(player, claim())).rewards).toEqual(
      first.rewards,
    );
    expect((await repository.get(2)).rewards).toHaveLength(1);
    activity.register('shop', async () => []);
    expect(
      (await service.releaseClaim(player, claim('next'))).wallet.balance,
    ).toBe(800);
  });
  it('rejects stale releases after reset, preserves a pre-reset receipt, and scopes a later release of the same capture ID to the new epoch', async () => {
    const first = await service.releaseClaim(player, claim());
    const reset = await service.reset(player, {
      requestId: 'release-reset',
      expectedWalletRevision: 1,
      starterItemsVersion: 1,
    });
    expect(reset.wallet).toMatchObject({ balance: 500, rewardEpoch: 1 });
    const stale = await service.releaseClaim(
      player,
      claim('old-offline-release'),
    );
    expect(stale.rewards[0]).toMatchObject({
      source: 'pokemon-release',
      captureId: 'old-offline-release',
      epoch: 0,
      amount: 0,
      status: 'rejected',
      reason: 'STALE_GAME',
      walletRevision: 2,
    });
    expect(stale.wallet.items).toEqual({ 'poke-ball': 6 });
    expect((await service.releaseClaim(player, claim())).rewards).toEqual(
      first.rewards,
    );
    expect((await repository.get(2)).balance).toBe(500);
    await service.resetApplied(player, {
      requestId: 'release-reset',
      revision: 2,
    });
    const current = await service.releaseClaim(
      player,
      claim('released-pokemon', 1),
    );
    expect(current.wallet.balance).toBe(650);
    expect(current.rewards[0].rewardId).toBe('release:1:released-pokemon');
    const final = await repository.get(2);
    expect(
      (await service.releaseClaim(player, claim('old-offline-release')))
        .rewards,
    ).toEqual(stale.rewards);
    expect(await repository.get(2)).toEqual(final);
  });
  it('does not change the release epoch on a cancelled reset and rejects future epochs with a terminal zero receipt', async () => {
    await service.resetCancel(player, {
      requestId: 'cancelled-reset',
      expectedWalletRevision: 0,
      starterItemsVersion: 1,
    });
    expect((await service.releaseClaim(player, claim())).wallet.balance).toBe(
      650,
    );
    const future = await service.releaseClaim(player, claim('future', 2));
    expect(future.rewards[0]).toMatchObject({
      amount: 0,
      status: 'rejected',
      reason: 'STALE_GAME',
    });
    expect(future.wallet.rewardEpoch).toBe(0);
    expect(future.wallet.balance).toBe(650);
  });
  it('validates bounded batches, capture IDs and epochs and refuses every client-supplied payout or reward field before writing', async () => {
    const original = await repository.get(2);
    const invalid: any[] = [
      {},
      { releases: [] },
      { releases: null },
      { releases: Array.from({ length: 101 }, () => claim().releases[0]) },
      ...['', ' ', 'x'.repeat(129), '__bad/id'].map((captureId) =>
        claim(captureId),
      ),
      ...[-1, 1.5, null, '0', Number.MAX_SAFE_INTEGER + 1].map((epoch) =>
        claim('bad', epoch as any),
      ),
      ...[
        'amount',
        'source',
        'color',
        'items',
        'badgeId',
        'penaltyVersion',
        'userId',
        'clientId',
        'rewardId',
        'pokemon',
        'party',
      ].map((key) => ({ releases: [{ ...claim().releases[0], [key]: 999 }] })),
      { ...claim(), amount: 999 },
    ];
    for (const payload of invalid)
      await expect(service.releaseClaim(player, payload)).rejects.toMatchObject(
        { code: 'INVALID_INPUT' },
      );
    await expect(
      service.rewardClaim(player, { rewards: [claim().releases[0]] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await repository.get(2)).toEqual(original);
    const maximum = await service.releaseClaim(player, claim('x'.repeat(128)));
    expect(maximum.rewards[0].rewardId.length).toBe(138);
    expect(maximum.wallet.balance).toBe(650);
  });
  it('rejects administrators, changed identities, revoked authentication and disconnects before any new receipt', async () => {
    const original = await repository.get(2);
    const admin = {
      ...player,
      user: { ...player.user, role: 'admin' as const },
    };
    await expect(service.releaseClaim(admin, claim())).rejects.toMatchObject({
      code: 'PLAYER_REQUIRED',
    });
    auth.authenticate = async () => ({ user: { ...player.user, id: 3 } });
    await expect(service.releaseClaim(player, claim())).rejects.toMatchObject({
      code: 'INVALID_PLAYER',
    });
    auth.authenticate = async () => {
      throw new Error('Session revoked');
    };
    await expect(service.releaseClaim(player, claim())).rejects.toThrow(
      'Session revoked',
    );
    auth.authenticate = async () => {
      service.disconnect(player.socketId);
      return { user: player.user };
    };
    await expect(service.releaseClaim(player, claim())).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
    });
    expect(await repository.get(2)).toEqual(original);
  });
  it('rejects unsafe balance increments without recording a completed release', async () => {
    repository.rows.get(2).balance = Number.MAX_SAFE_INTEGER - 100;
    const original = await repository.get(2);
    await expect(service.releaseClaim(player, claim())).rejects.toMatchObject({
      code: 'WALLET_CONFLICT',
    });
    expect(await repository.get(2)).toEqual(original);
  });
});
