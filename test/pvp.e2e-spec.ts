import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import {
  AuthIdentityService,
  MessageAuthError,
} from '../src/messages/auth-identity.service';
import { PvpModule } from '../src/pvp/pvp.module';
import { ShopService } from '../src/shop/shop.service';
import { MemoryShopRepository } from '../src/shop/shop.repository';
import { ConsumableItemId } from '../src/shop/shop.types';
import { PlayerActivityService } from '../src/messages/player-activity.service';
import {
  MemoryPvpRepository,
  PvpBattleSchema,
} from '../src/pvp/pvp.repository';
import { PvpService } from '../src/pvp/pvp.service';
import { trainerPreset } from '../src/pvp/pvp.trainers';
import { Actor, Battle, clone, Snapshot } from '../src/pvp/pvp.types';
import {
  digest,
  requestKey,
  stableJson,
  validateSnapshot,
  validateSession,
} from '../src/pvp/pvp.validation';

function fakeAuth() {
  const users = new Map(
    [1, 2, 3, 4, 5, 6].map((id) => [
      id,
      {
        id,
        email: `user${id}@example.test`,
        first_name: `User${id}`,
        last_name: 'QA',
        role: id === 1 || id === 5 ? 'admin' : 'player',
      },
    ]),
  );
  return {
    users,
    async authenticate(token: any) {
      const user = users.get(Number(String(token).replace('test-user-', '')));
      if (!user)
        throw new MessageAuthError('SESSION_REVOKED', 'Test session revoked');
      return { user: clone(user), expiresAt: Date.now() + 3600000 };
    },
    async contacts(token: string, selfId: number) {
      await this.authenticate(token);
      return clone([...users.values()].filter((user) => user.id !== selfId));
    },
  };
}
function capture(name = 'test-mon', large = false): any {
  const names = [
    'hp',
    'attack',
    'defense',
    'special-attack',
    'special-defense',
    'speed',
  ];
  const move = {
    id: 1,
    name: 'pound',
    displayName: 'Pound',
    type: 'normal',
    damageClass: 'physical',
    power: 40,
    accuracy: 100,
    pp: 35,
    priority: 0,
    description: large ? 'x'.repeat(9000) : 'Test',
    source: 'wild',
  };
  return {
    captureId: 'same-id-across-players',
    pokemon: {
      id: 35,
      name,
      image: null,
      types: ['fairy'],
      progressionVersion: 1,
      level: 20,
      hpMultiplier: 1.3,
      baseStats: names.map((name) => ({ name, value: 100 })),
      stats: names.map((name) => ({ name, value: name === 'hp' ? 70 : 45 })),
      battleStages: Object.fromEntries(
        [...names.slice(1), 'accuracy', 'evasiveness'].map((name) => [name, 0]),
      ),
    },
    moves: large ? [move, { ...move, id: 2 }, { ...move, id: 3 }] : [move],
    statuses: ['burned', 'confused'],
    statusTurns: { confused: 2 },
  };
}
function snapshot(
  battle: Battle | any,
  userId: number,
  clientId: string,
  large = false,
): Snapshot {
  const pokemons = [capture(`private-pokemon-${userId}`, large)];
  return {
    version: 1,
    battleId: battle.battleId,
    snapshotId: `snapshot-${userId}`,
    userId,
    clientId,
    dataVersion: '1.6.0',
    baseHash: digest(pokemons),
    pokemons,
    activeCaptureId: pokemons[0].captureId,
    hpMultiplier: 1.3,
  };
}
function session(battle: Battle): any {
  const request = {
    moves: [{ id: 1, name: 'pound', pp: 35, maxpp: 35, disabled: false }],
    forceSwitch: false,
    waiting: false,
    locked: false,
    trapped: false,
    gender: '',
  };
  return {
    version: 1,
    id: battle.battleId,
    networkBattleId: battle.battleId,
    phase: 'battle',
    hpMultiplier: 1.3,
    teams: Object.fromEntries(
      ['a', 'b'].map((side) => {
        const npc = side === 'b' && battle.mode === 'trainer';
        const team = npc ? battle.trainer.team : battle.players[side].snapshot;
        return [
          side,
          {
            name: npc ? battle.trainer.team.name : side,
            pokemons: clone(team.pokemons),
            activeCaptureId: team.activeCaptureId,
          },
        ];
      }),
    ),
    weather: { kind: 'none' },
    history: [],
    runtime: {
      engine: JSON.stringify({ testEngine: true, padding: 'x'.repeat(20000) }),
      serial: 0,
      turn: 1,
      pending: {},
      requests: { a: clone(request), b: clone(request) },
      ended: false,
      winner: null,
    },
  };
}

describe('Durable PvP service, repository and private projection', () => {
  let repo: MemoryPvpRepository;
  let auth: ReturnType<typeof fakeAuth>;
  let service: PvpService;
  let actors: Record<number, Actor>;
  beforeEach(async () => {
    repo = new MemoryPvpRepository();
    auth = fakeAuth();
    service = new PvpService(repo, auth as any);
    actors = Object.fromEntries(
      [...auth.users.values()].map((user) => [
        user.id,
        {
          user: clone(user),
          clientId: `client-${user.id}`,
          socketId: `socket-${user.id}`,
          token: `test-user-${user.id}`,
        },
      ]),
    ) as any;
    Object.values(actors).forEach((actor) => service.connect(actor));
    await service.onModuleInit();
  });
  const createPayload = (commandId = 'create-1') => ({
    commandId,
    playerAId: 2,
    playerBId: 3,
  });
  async function ready(): Promise<Battle> {
    const battle = await service.create(actors[1], createPayload());
    await Promise.all(
      [2, 3].map((id) =>
        service.snapshot(actors[id], {
          snapshot: snapshot(battle, id, actors[id].clientId),
        }),
      ),
    );
    return repo.get(battle.battleId);
  }
  async function active(): Promise<Battle> {
    const battle = await ready();
    return service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  }
  async function readyTrainer(
    presetId = 'kanto-brock',
    rewardBundleVersion?: 1 | 2,
  ): Promise<Battle> {
    const battle = await service.create(actors[1], {
      commandId: 'create-trainer',
      playerAId: 2,
      trainerPresetId: presetId,
      ...(rewardBundleVersion !== undefined ? { rewardBundleVersion } : {}),
    });
    const snap = snapshot(battle, 2, actors[2].clientId);
    snap.hpMultiplier = 2;
    return service.snapshot(actors[2], { snapshot: snap });
  }
  async function activeTrainer(): Promise<Battle> {
    const battle = await readyTrainer();
    return service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  }
  async function rewardBattle(
    trainer = true,
    winnerLevel = 20,
    presetId = 'kanto-brock',
    rewardBundleVersion?: 1 | 2,
    levelRuleVersion?: 2,
  ) {
    const activity = new PlayerActivityService();
    const wallets = new MemoryShopRepository();
    const shop = new ShopService(wallets, auth as any, activity);
    await shop.onModuleInit();
    service = new PvpService(repo, auth as any, activity, shop);
    await service.onModuleInit();
    for (const actor of Object.values(actors)) {
      service.connect(actor);
      shop.connect(actor);
    }
    for (const userId of [2, 3])
      await shop.presence(actors[userId], { ready: true, localBattle: false });
    const readyBattle = trainer
      ? await readyTrainer(presetId, rewardBundleVersion)
      : await ready();
    if (winnerLevel !== 20) {
      const mon = readyBattle.players.a.snapshot.pokemons[0];
      mon.pokemon.level = winnerLevel;
      mon.pokemon.stats = mon.pokemon.baseStats.map((stat: any) => ({
        name: stat.name,
        value:
          stat.name === 'hp'
            ? Math.floor(
                (Math.floor((stat.value * winnerLevel) / 50) +
                  winnerLevel +
                  10) *
                  1.3,
              )
            : Math.floor((stat.value * winnerLevel) / 50) + 5,
      }));
      readyBattle.players.a.snapshot.baseHash = digest(
        readyBattle.players.a.snapshot.pokemons,
      );
      const previous = readyBattle.revision++;
      await repo.compareAndSwap(readyBattle, previous);
    }
    const initial = session(readyBattle);
    initial.rewards = { version: 1, defeats: [] };
    let battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: initial,
      processedCommandIds: [],
    });
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.serial++;
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    const winner = finished.teams.a.pokemons[0];
    for (const [index, defeated] of finished.teams.b.pokemons.entries()) {
      defeated.pokemon.stats.find((stat: any) => stat.name === 'hp').value = 0;
      finished.rewards.defeats.push({
        id: `${battle.battleId}:1:ko:${index}`,
        winnerSide: 'a',
        winnerCaptureId: winner.captureId,
        defeatedSide: 'b',
        defeatedCaptureId: defeated.captureId,
        winnerLevel: winner.pokemon.level,
        defeatedLevel: defeated.pokemon.level,
        levels: (
          levelRuleVersion === 2
            ? defeated.pokemon.level >= winner.pokemon.level
            : defeated.pokemon.level > winner.pokemon.level
        )
          ? 2
          : 1,
        ...(levelRuleVersion === 2 ? { levelRuleVersion } : {}),
      });
    }
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: finished,
      processedCommandIds: [],
    });
    return { battle, shop, wallets };
  }
  async function featureBattle(
    trainer = true,
    extraMembers = false,
    lossPenalty = false,
  ) {
    const activity = new PlayerActivityService();
    const wallets = new MemoryShopRepository();
    const shop = new ShopService(wallets, auth as any, activity);
    await shop.onModuleInit();
    service = new PvpService(repo, auth as any, activity, shop);
    await service.onModuleInit();
    for (const actor of Object.values(actors)) {
      service.connect(actor);
      shop.connect(actor);
    }
    for (const userId of [2, 3])
      await shop.presence(actors[userId], { ready: true, localBattle: false });
    const created = await service.create(actors[1], {
      commandId: 'new-features',
      playerAId: 2,
      levelRewards: 'immediate',
      ...(trainer
        ? {
            trainerPresetId: 'kanto-brock',
            rewardBundleVersion: 1,
            ...(lossPenalty ? { lossPenaltyVersion: 1 } : {}),
          }
        : { playerBId: 3 }),
    });
    let battle: Battle = created;
    for (const userId of trainer ? [2] : [2, 3]) {
      const snap = snapshot(created, userId, actors[userId].clientId);
      if (extraMembers) {
        snap.pokemons.push({
          ...clone(snap.pokemons[0]),
          captureId: `second-${userId}`,
        });
        const fainted = {
          ...clone(snap.pokemons[0]),
          captureId: `fainted-${userId}`,
        };
        fainted.pokemon.stats.find((stat: any) => stat.name === 'hp').value = 0;
        snap.pokemons.push(fainted);
        snap.baseHash = digest(snap.pokemons);
      }
      battle = await service.snapshot(actors[userId], { snapshot: snap });
    }
    return { battle, shop, wallets };
  }
  const immediateSession = (battle: Battle) => ({
    ...session(battle),
    rewards: {
      version: 1,
      defeats: [],
      timing: 'immediate',
      eligibleSides: battle.mode === 'trainer' ? ['a'] : ['a', 'b'],
      appliedCount: 0,
    },
  });
  async function lostTrainer(
    mode: 'defeat' | 'forfeit' | 'draw' = 'defeat',
    enabled = true,
  ) {
    const {
      battle: readyBattle,
      wallets,
      shop,
    } = await featureBattle(true, false, enabled);
    let battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: immediateSession(readyBattle),
      processedCommandIds: [],
    });
    const ended = clone(battle.session);
    ended.runtime.serial++;
    ended.phase = 'finished';
    ended.runtime.ended = true;
    ended.runtime.winner = mode === 'draw' ? 'draw' : 'b';
    if (mode !== 'forfeit')
      for (const mon of ended.teams.a.pokemons)
        mon.pokemon.stats.find((stat: any) => stat.name === 'hp').value = 0;
    if (mode === 'draw')
      for (const mon of ended.teams.b.pokemons)
        mon.pokemon.stats.find((stat: any) => stat.name === 'hp').value = 0;
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: ended,
      processedCommandIds: [],
    });
    return { battle, wallets, shop };
  }
  it.each(['defeat', 'forfeit'] as const)(
    'settles a newly enabled Trainer %s once at finalization while preserving team state and existing progression',
    async (mode) => {
      const { battle, wallets } = await lostTrainer(mode);
      expect(battle.lossPenaltyVersion).toBe(1);
      expect(service.view(battle, actors[1]).lossPenaltyVersion).toBe(1);
      expect((await wallets.get(2)).balance).toBe(500);
      const done = await service.finalize(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
      });
      expect(done.results.a.outcome).toBe('lose');
      expect(done.results.a.patches[0]).toMatchObject({
        hp: mode === 'forfeit' ? 70 : 0,
        statuses: ['burned'],
      });
      expect(done.results.a.patches[0]).not.toHaveProperty('level');
      const wallet = await wallets.get(2);
      expect(wallet.balance).toBe(450);
      expect(wallet.rewards[0]).toMatchObject({
        rewardId: `admin:${battle.battleId}`,
        penaltyVersion: 1,
        status: 'debited',
        nominalAmount: 50,
        amount: 50,
      });
      expect(wallet.items).toEqual({});
      expect(wallet.badges).toBeUndefined();
      expect(
        (
          await service.finalize(actors[1], {
            battleId: battle.battleId,
            hostEpoch: 1,
          })
        ).results,
      ).toEqual(done.results);
      const result = done.results.a;
      await service.applied(actors[2], {
        battleId: battle.battleId,
        resultId: result.resultId,
        snapshotId: result.snapshotId,
        baseHash: result.baseHash,
      });
      await service.sync(actors[1], { battleId: battle.battleId });
      expect((await wallets.get(2)).balance).toBe(450);
      expect((await wallets.get(2)).rewards).toHaveLength(1);
    },
  );
  it('does not add a new loss tariff to saved old Trainer battles or charge a draw', async () => {
    for (const [mode, enabled] of [
      ['defeat', false],
      ['draw', true],
    ] as const) {
      repo = new MemoryPvpRepository();
      const { battle, wallets } = await lostTrainer(mode, enabled);
      await service.finalize(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
      });
      expect((await wallets.get(2)).balance).toBe(500);
      expect((await wallets.get(2)).rewards).toBeUndefined();
    }
  });
  it('recovers a persisted loss settlement after a clamped debit response is lost without charging later money', async () => {
    const { battle, wallets, shop } = await lostTrainer('forfeit');
    const low = await wallets.get(2),
      previous = low.storageRevision;
    low.balance = 25;
    low.revision++;
    low.storageRevision++;
    await wallets.compareAndSwap(low, previous);
    const debit = shop.debitBattlePenalty.bind(shop);
    jest
      .spyOn(shop, 'debitBattlePenalty')
      .mockImplementationOnce(async (...args) => {
        await debit(...args);
        throw new Error('lost penalty response');
      });
    await expect(
      service.finalize(actors[1], { battleId: battle.battleId, hostEpoch: 1 }),
    ).rejects.toThrow('lost penalty response');
    const pending = await repo.get(battle.battleId);
    expect(pending.phase).toBe('finalizing');
    expect(pending.lockHeld).toBe(true);
    expect(pending.pendingRewards[0].penaltyVersion).toBe(1);
    expect((await wallets.get(2)).balance).toBe(0);
    const later = await wallets.get(2),
      laterRevision = later.storageRevision;
    later.balance = 100;
    later.revision++;
    later.storageRevision++;
    await wallets.compareAndSwap(later, laterRevision);
    const restored = await service.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.phase).toBe('finalizing');
    expect((await repo.get(battle.battleId)).pendingRewards).toEqual([]);
    expect((await wallets.get(2)).balance).toBe(100);
    expect((await wallets.get(2)).rewards[0]).toMatchObject({
      nominalAmount: 50,
      amount: 25,
      balanceBefore: 25,
      balanceAfter: 0,
    });
    expect((await wallets.get(2)).rewards).toHaveLength(1);
  });
  it('binds the opt-in loss rule to creation identity and refuses penalties in player-vs-player battles', async () => {
    for (const value of [0, 2, null, '1'])
      await expect(
        service.create(actors[1], {
          commandId: 'invalid-loss-rule',
          playerAId: 2,
          trainerPresetId: 'kanto-brock',
          lossPenaltyVersion: value,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.create(actors[1], {
        commandId: 'invalid-pvp-loss',
        playerAId: 2,
        playerBId: 3,
        lossPenaltyVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const { battle } = await featureBattle(true, false, true);
    const replay = await service.create(actors[1], {
      commandId: 'new-features',
      playerAId: 2,
      trainerPresetId: 'kanto-brock',
      levelRewards: 'immediate',
      rewardBundleVersion: 1,
      lossPenaltyVersion: 1,
    });
    expect(replay.battleId).toBe(battle.battleId);
    await expect(
      service.create(actors[1], {
        commandId: 'new-features',
        playerAId: 2,
        trainerPresetId: 'kanto-brock',
        levelRewards: 'immediate',
        rewardBundleVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
  });
  const fixtureLevel = (mon: any, level: number) => {
    const baseHp = mon.pokemon.baseStats.find(
      (stat: any) => stat.name === 'hp',
    ).value;
    const oldMax = Math.floor(
      (Math.floor((baseHp * mon.pokemon.level) / 50) + mon.pokemon.level + 10) *
        (mon.pokemon.hpMultiplier ?? 1.3),
    );
    const oldHp = mon.pokemon.stats.find(
      (stat: any) => stat.name === 'hp',
    ).value;
    mon.pokemon.level = level;
    mon.pokemon.stats = mon.pokemon.baseStats.map((stat: any) => {
      const value =
        Math.floor((stat.value * level) / 50) +
        (stat.name === 'hp' ? level + 10 : 5);
      return {
        name: stat.name,
        value:
          stat.name === 'hp'
            ? Math.floor(
                (oldHp *
                  Math.floor(value * (mon.pokemon.hpMultiplier ?? 1.3))) /
                  oldMax,
              )
            : value,
      };
    });
  };
  const fixtureDefeat = (
    next: any,
    winnerSide: 'a' | 'b',
    defeatedSide: 'a' | 'b',
    defeatedIndex = 0,
    levelRuleVersion?: 2,
  ) => {
    const winner = next.teams[winnerSide].pokemons[0];
    const defeated = next.teams[defeatedSide].pokemons[defeatedIndex];
    defeated.pokemon.stats.find((stat: any) => stat.name === 'hp').value = 0;
    next.rewards.defeats.push({
      id: `ko:${next.runtime.serial}:${next.rewards.defeats.length}`,
      winnerSide,
      winnerCaptureId: winner.captureId,
      defeatedSide,
      defeatedCaptureId: defeated.captureId,
      winnerLevel: winner.pokemon.level,
      defeatedLevel: defeated.pokemon.level,
      levels: (
        levelRuleVersion === 2
          ? defeated.pokemon.level >= winner.pokemon.level
          : defeated.pokemon.level > winner.pokemon.level
      )
        ? 2
        : 1,
      ...(levelRuleVersion === 2 ? { levelRuleVersion } : {}),
    });
  };
  async function startLevelRuleBattle(
    winnerLevel = 20,
    defeatedLevel = 20,
    extraMembers = false,
  ) {
    const prepared = await featureBattle(false, extraMembers);
    const readyBattle = prepared.battle;
    fixtureLevel(readyBattle.players.a.snapshot.pokemons[0], winnerLevel);
    fixtureLevel(readyBattle.players.b.snapshot.pokemons[0], defeatedLevel);
    for (const side of ['a', 'b'] as const)
      readyBattle.players[side].snapshot.baseHash = digest(
        readyBattle.players[side].snapshot.pokemons,
      );
    const previous = readyBattle.revision++;
    await repo.compareAndSwap(readyBattle, previous);
    const battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: immediateSession(readyBattle),
      processedCommandIds: [],
    });
    return { ...prepared, battle };
  }
  const finishNewLevelRule = (battle: Battle, levels: number) => {
    const final = clone(battle.session);
    final.runtime.serial++;
    fixtureDefeat(final, 'a', 'b', 0, 2);
    fixtureLevel(
      final.teams.a.pokemons[0],
      Math.min(100, final.teams.a.pokemons[0].pokemon.level + levels),
    );
    final.rewards.appliedCount = 1;
    final.phase = 'finished';
    final.runtime.ended = true;
    final.runtime.winner = 'a';
    return final;
  };
  it.each([
    [19, 1],
    [20, 2],
    [21, 2],
  ])(
    'accepts new rule opponent level %i with exactly %i immediate levels and no replayed gain',
    async (defeatedLevel, levels) => {
      const { battle: started, wallets } = await startLevelRuleBattle(
        20,
        defeatedLevel,
      );
      const final = finishNewLevelRule(started, levels);
      expect(final.rewards.defeats[0]).toMatchObject({
        levelRuleVersion: 2,
        winnerLevel: 20,
        defeatedLevel,
        levels,
      });
      const payload = {
        battleId: started.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: final,
        processedCommandIds: [],
      };
      const saved = await service.checkpoint(actors[1], payload);
      expect(saved.session.teams.a.pokemons[0].pokemon.level).toBe(20 + levels);
      expect((await service.checkpoint(actors[1], payload)).revision).toBe(
        saved.revision,
      );
      const done = await service.finalize(actors[1], {
        battleId: started.battleId,
        hostEpoch: 1,
      });
      expect(done.results.a.patches[0]).toMatchObject({
        level: 20 + levels,
        statuses: ['burned'],
      });
      expect(
        (
          await service.finalize(actors[1], {
            battleId: started.battleId,
            hostEpoch: 1,
          })
        ).results,
      ).toEqual(done.results);
      expect((await wallets.get(2)).balance).toBe(500);
      expect((await wallets.get(3)).balance).toBe(500);
    },
  );
  it('caps a new equal-level two-level reward at 100 without changing PP or adding progress again', async () => {
    const { battle: started } = await startLevelRuleBattle(99, 99);
    const final = finishNewLevelRule(started, 2);
    final.teams.a.pokemons[0].moves[0].currentPp = 0;
    const saved = await service.checkpoint(actors[1], {
      battleId: started.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: final,
      processedCommandIds: [],
    });
    expect(saved.session.rewards.defeats[0].levels).toBe(2);
    expect(saved.session.teams.a.pokemons[0].pokemon.level).toBe(100);
    const done = await service.finalize(actors[1], {
      battleId: started.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0]).toMatchObject({
      level: 100,
      movesPp: [{ moveId: 1, currentPp: 0 }],
      statuses: ['burned'],
    });
  });
  it('rejects wrong rule versions, equal-level one-point new rewards and unversioned two-point rewards without changing the reserved battle', async () => {
    const { battle } = await startLevelRuleBattle();
    const final = finishNewLevelRule(battle, 2);
    for (const version of [1, 3, '2', null]) {
      const bad = clone(final);
      bad.rewards.defeats[0].levelRuleVersion = version;
      expect(() => validateSession(bad, battle)).toThrow();
    }
    const oldRate = clone(final);
    oldRate.rewards.defeats[0].levels = 1;
    fixtureLevel(oldRate.teams.a.pokemons[0], 21);
    expect(() => validateSession(oldRate, battle)).toThrow();
    const unversioned = clone(final);
    delete unversioned.rewards.defeats[0].levelRuleVersion;
    expect(() => validateSession(unversioned, battle)).toThrow();
    const stored = await repo.get(battle.battleId);
    expect(stored.session.rewards.defeats).toEqual([]);
    expect(stored.lockHeld).toBe(true);
    expect(stored.checkpointRevision).toBe(1);
  });
  it('preserves a saved equal-level legacy reward and appends a new equal-level reward after reload without rewriting its prefix', async () => {
    const {
      battle: readyBattle,
      shop,
      wallets,
    } = await featureBattle(false, true);
    fixtureLevel(readyBattle.players.b.snapshot.pokemons[1], 21);
    readyBattle.players.b.snapshot.baseHash = digest(
      readyBattle.players.b.snapshot.pokemons,
    );
    const previous = readyBattle.revision++;
    await repo.compareAndSwap(readyBattle, previous);
    let battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: immediateSession(readyBattle),
      processedCommandIds: [],
    });
    const old = clone(battle.session);
    old.runtime.serial++;
    fixtureDefeat(old, 'a', 'b');
    fixtureLevel(old.teams.a.pokemons[0], 21);
    old.rewards.appliedCount = 1;
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: old,
      processedCommandIds: [],
    });
    const originalPrefix = stableJson(battle.session.rewards.defeats);
    expect(battle.session.rewards.defeats[0]).not.toHaveProperty(
      'levelRuleVersion',
    );
    expect(battle.session.rewards.defeats[0].levels).toBe(1);
    const reloaded = new PvpService(repo, auth as any, undefined, shop);
    await reloaded.onModuleInit();
    for (const actor of Object.values(actors)) reloaded.connect(actor);
    service = reloaded;
    await service.sync(actors[1], { battleId: battle.battleId });
    battle = await repo.get(battle.battleId);
    expect(stableJson(battle.session.rewards.defeats)).toBe(originalPrefix);
    const final = clone(battle.session);
    final.runtime.serial++;
    fixtureDefeat(final, 'a', 'b', 1, 2);
    expect(final.rewards.defeats[1]).toMatchObject({
      winnerLevel: 21,
      defeatedLevel: 21,
      levels: 2,
      levelRuleVersion: 2,
    });
    fixtureLevel(final.teams.a.pokemons[0], 23);
    final.rewards.appliedCount = 2;
    final.phase = 'finished';
    final.runtime.ended = true;
    final.runtime.winner = 'a';
    const rewritten = clone(final);
    rewritten.rewards.defeats[0].levelRuleVersion = 2;
    rewritten.rewards.defeats[0].levels = 2;
    expect(() => validateSession(rewritten, battle)).toThrow();
    const payload = {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 2,
      session: final,
      processedCommandIds: [],
    };
    const saved = await service.checkpoint(actors[1], payload);
    expect(stableJson(saved.session.rewards.defeats.slice(0, 1))).toBe(
      originalPrefix,
    );
    expect((await service.checkpoint(actors[1], payload)).revision).toBe(
      saved.revision,
    );
    const done = await service.finalize(actors[1], {
      battleId: saved.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0].level).toBe(23);
    expect((await wallets.get(2)).balance).toBe(500);
    expect((await wallets.get(3)).balance).toBe(500);
  });
  it('applies the new per-event equal-level rate to a resumed deferred battle while preserving legacy unmarked events', async () => {
    const { battle } = await rewardBattle(
      false,
      20,
      'kanto-brock',
      undefined,
      2,
    );
    expect(battle.levelRewards).toBeUndefined();
    expect(battle.session.teams.a.pokemons[0].pokemon.level).toBe(20);
    expect(battle.session.rewards.defeats[0]).toMatchObject({
      levelRuleVersion: 2,
      levels: 2,
    });
    const done = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0].level).toBe(22);
    expect(
      (
        await service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).results,
    ).toEqual(done.results);
  });
  it('persists a living human lead before start without changing team order, snapshots or opponent privacy', async () => {
    const { battle } = await featureBattle(false, true);
    const originals = clone(battle.players);
    const payload = {
      battleId: battle.battleId,
      hostEpoch: 1,
      side: 'a',
      captureId: 'second-2',
      expectedRevision: battle.revision,
    };
    const selected = await service.lead(actors[1], payload);
    expect(selected.leads).toEqual({ a: 'second-2' });
    expect(selected.players).toEqual(originals);
    expect((await service.lead(actors[1], payload)).revision).toBe(
      selected.revision,
    );
    expect(service.view(selected, actors[3]).leads).toEqual({});
    expect(service.view(selected, actors[2]).leads).toEqual({ a: 'second-2' });
    await expect(
      service.lead(actors[1], {
        ...payload,
        captureId: 'same-id-across-players',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      service.lead(actors[2], {
        ...payload,
        expectedRevision: selected.revision,
      }),
    ).rejects.toMatchObject({ code: 'HOST_REQUIRED' });
    await expect(
      service.lead(actors[1], {
        ...payload,
        captureId: 'fainted-2',
        expectedRevision: selected.revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LEAD' });
    const proposed = immediateSession(selected);
    expect(() => validateSession(proposed, selected)).toThrow();
    proposed.teams.a.activeCaptureId = 'second-2';
    const started = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: proposed,
      processedCommandIds: [],
    });
    expect(started.session.teams.a.activeCaptureId).toBe('second-2');
    await expect(
      service.lead(actors[1], {
        ...payload,
        expectedRevision: started.revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PHASE' });
  });
  it('applies human levels during Trainer combat and finalizes the same levels plus badge/TM cash bundle once', async () => {
    const { battle: readyBattle, wallets } = await featureBattle();
    let battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: immediateSession(readyBattle),
      processedCommandIds: [],
    });
    const first = clone(battle.session);
    first.runtime.serial++;
    fixtureDefeat(first, 'a', 'b');
    fixtureLevel(first.teams.a.pokemons[0], 21);
    first.teams.a.pokemons[0].moves[0].currentPp = 34;
    first.rewards.appliedCount = 1;
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: first,
      processedCommandIds: [],
    });
    expect(battle.session.teams.a.pokemons[0].pokemon.level).toBe(21);
    expect(battle.players.a.snapshot.pokemons[0].pokemon.level).toBe(20);
    expect(battle.results).toBeUndefined();
    for (const mutate of [
      (input: any) => {
        input.rewards.appliedCount = 0;
      },
      (input: any) => {
        fixtureLevel(input.teams.a.pokemons[0], 22);
      },
      (input: any) => {
        fixtureLevel(input.teams.b.pokemons[0], 13);
      },
      (input: any) => {
        input.rewards.eligibleSides = ['a', 'b'];
      },
    ]) {
      const invalid = clone(battle.session);
      mutate(invalid);
      expect(() => validateSession(invalid, battle)).toThrow();
    }
    const final = clone(battle.session);
    final.runtime.serial++;
    fixtureDefeat(final, 'a', 'b', 1);
    expect(final.rewards.defeats[1].winnerLevel).toBe(21);
    fixtureLevel(final.teams.a.pokemons[0], 22);
    final.rewards.appliedCount = 2;
    final.phase = 'finished';
    final.runtime.ended = true;
    final.runtime.winner = 'a';
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 2,
      session: final,
      processedCommandIds: [],
    });
    const done = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0]).toMatchObject({
      level: 22,
      hp: 75,
      movesPp: [{ moveId: 1, currentPp: 34 }],
    });
    expect(await wallets.get(2)).toMatchObject({
      balance: 1700,
      badges: ['boulder'],
      items: { tm: 1 },
    });
    await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect((await wallets.get(2)).items.tm).toBe(1);
  });
  it('validates double-KO rewards against pre-batch levels and advances both human levels while preserving zero HP', async () => {
    const { battle: readyBattle, wallets } = await featureBattle(false);
    let battle = await service.checkpoint(actors[1], {
      battleId: readyBattle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: immediateSession(readyBattle),
      processedCommandIds: [],
    });
    const final = clone(battle.session);
    final.runtime.serial++;
    fixtureDefeat(final, 'a', 'b');
    fixtureDefeat(final, 'b', 'a');
    expect(
      final.rewards.defeats.map((entry: any) => entry.winnerLevel),
    ).toEqual([20, 20]);
    for (const side of ['a', 'b'])
      fixtureLevel(final.teams[side].pokemons[0], 21);
    final.rewards.appliedCount = 2;
    final.phase = 'finished';
    final.runtime.ended = true;
    final.runtime.winner = 'draw';
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: final,
      processedCommandIds: [],
    });
    const done = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    for (const side of ['a', 'b'])
      expect(done.results[side].patches[0]).toMatchObject({ level: 21, hp: 0 });
    expect((await wallets.get(2)).balance).toBe(500);
    expect((await wallets.get(3)).balance).toBe(500);
  });
  it('awards deferred levels with proportional HP and pays the winning Trainer preset exactly once', async () => {
    const { battle, wallets } = await rewardBattle();
    expect(battle.session.teams.a.pokemons[0].pokemon.level).toBe(20);
    const done = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0]).toMatchObject({
      level: 22,
      hp: 75,
      statuses: ['burned'],
    });
    expect((await wallets.get(2)).balance).toBe(1700);
    expect(done.pendingRewards).toEqual([]);
    const again = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(again.results).toEqual(done.results);
    expect((await wallets.get(2)).rewards).toHaveLength(1);
  });
  it.each([
    [5, 9],
    [99, 100],
  ])(
    'sums higher-level knockouts and caps progression: level %s becomes %s',
    async (initial, expected) => {
      const { battle } = await rewardBattle(true, initial);
      const done = await service.finalize(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
      });
      expect(done.results.a.patches[0].level).toBe(expected);
      expect(done.results.a.patches[0].statuses).toEqual(['burned']);
    },
  );
  it('does not mint cash for a forfeit, a draw or an existing legacy finished session', async () => {
    for (const outcome of ['forfeit', 'draw', 'legacy']) {
      repo = new MemoryPvpRepository();
      const { battle, wallets } = await rewardBattle();
      const before = await repo.get(battle.battleId);
      if (outcome === 'forfeit') {
        before.session.teams.b.pokemons[0].pokemon.stats.find(
          (stat: any) => stat.name === 'hp',
        ).value = 1;
        before.session.rewards.defeats = [];
      } else if (outcome === 'draw') before.session.runtime.winner = 'draw';
      else delete before.session.rewards;
      const previous = before.revision++;
      await repo.compareAndSwap(before, previous);
      await service.finalize(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
      });
      expect((await wallets.get(2)).balance).toBe(500);
      expect((await wallets.get(2)).rewards).toBeUndefined();
    }
  });
  it('recovers a durable finalized reward after a credit response is lost without paying again', async () => {
    const { battle, shop, wallets } = await rewardBattle();
    const credit = shop.creditBattleReward.bind(shop);
    jest
      .spyOn(shop, 'creditBattleReward')
      .mockImplementationOnce(async (...args) => {
        await credit(...args);
        throw new Error('lost reward response');
      });
    await expect(
      service.finalize(actors[1], { battleId: battle.battleId, hostEpoch: 1 }),
    ).rejects.toThrow('lost reward response');
    const pending = await repo.get(battle.battleId);
    expect(pending.phase).toBe('finalizing');
    expect(pending.pendingRewards).toHaveLength(1);
    expect(pending.lockHeld).toBe(true);
    const restored = await service.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.phase).toBe('finalizing');
    expect((await repo.get(battle.battleId)).pendingRewards).toEqual([]);
    expect((await wallets.get(2)).balance).toBe(1700);
    expect((await wallets.get(2)).rewards).toHaveLength(1);
  });
  it.each([undefined, 1, 2] as const)(
    'preserves first-rival reward bundle %s through persisted finalization and lost credit responses',
    async (version) => {
      const { battle, shop, wallets } = await rewardBattle(
        true,
        20,
        'kanto-rival-lab-grass',
        version,
      );
      expect(battle.rewardBundleVersion).toBe(version);
      expect(service.view(battle, actors[1]).rewardBundleVersion).toBe(version);
      const credit = shop.creditBattleReward.bind(shop);
      jest
        .spyOn(shop, 'creditBattleReward')
        .mockImplementationOnce(async (...args) => {
          await credit(...args);
          throw new Error('lost rival reward response');
        });
      await expect(
        service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        }),
      ).rejects.toThrow('lost rival reward response');
      const pending = await repo.get(battle.battleId);
      expect(pending.phase).toBe('finalizing');
      expect(pending.lockHeld).toBe(true);
      expect(pending.pendingRewards).toHaveLength(1);
      expect(pending.pendingRewards[0].rewardBundleVersion).toBe(version);
      const beforeRecovery = await wallets.get(2);
      expect(beforeRecovery.balance).toBe(version === 2 ? 750 : 1000);
      expect(beforeRecovery.items).toEqual(
        version === 2 ? { 'great-ball': 1 } : {},
      );
      expect(beforeRecovery.rewards[0]).not.toHaveProperty('badgeId');
      await service.sync(actors[1], { battleId: battle.battleId });
      expect((await repo.get(battle.battleId)).pendingRewards).toEqual([]);
      expect(await wallets.get(2)).toEqual(beforeRecovery);
      const done = await service.finalize(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
      });
      expect(done.results.a.patches[0].level).toBe(21);
      expect((await wallets.get(2)).rewards).toHaveLength(1);
      expect(await wallets.get(2)).toEqual(beforeRecovery);
    },
  );
  it('awards player-vs-player levels but never money', async () => {
    const { battle, wallets } = await rewardBattle(false);
    const done = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(done.results.a.patches[0].level).toBe(21);
    expect(done.results.b.patches[0]).not.toHaveProperty('level');
    expect((await wallets.get(2)).balance).toBe(500);
    expect((await wallets.get(3)).balance).toBe(500);
    expect(done.pendingRewards).toBeUndefined();
  });
  it('rejects forged, repeated and rolled-back knockout rewards while retaining the battle reservation', async () => {
    const { battle } = await rewardBattle(false);
    for (const mutation of [
      (next: any) => {
        next.rewards.defeats = [];
      },
      (next: any) => {
        delete next.rewards;
      },
      (next: any) => {
        next.rewards.defeats[0].levels = 2;
      },
      (next: any) => {
        next.rewards.defeats.push({
          ...next.rewards.defeats[0],
          id: 'forged-additional-ko',
        });
      },
    ]) {
      const next = clone(battle.session);
      mutation(next);
      expect(() => validateSession(next, battle)).toThrow();
    }
    expect((await repo.get(battle.battleId)).lockHeld).toBe(true);
  });
  it('accepts long historical knockout ledgers after repeated revivals without lowering the frontend limit', async () => {
    const { battle } = await rewardBattle(false);
    const entry = battle.session.rewards.defeats[0];
    battle.session.rewards.defeats = Array.from(
      { length: 600 },
      (_, index) => ({ ...entry, id: `historical-ko-${index}` }),
    );
    expect(() => validateSession(clone(battle.session), battle)).not.toThrow();
  });
  it('declares unique partial reservation indexes for players and administrator', () => {
    const indexes = PvpBattleSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { lockedUserIds: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { lockHeld: true },
          }),
        ],
        [
          { adminId: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { lockHeld: true },
          }),
        ],
      ]),
    );
  });
  it('reserves intersecting players atomically and prevents a second battle for an admin', async () => {
    const results = await Promise.allSettled([
      service.create(actors[1], createPayload()),
      service.create(actors[5], {
        commandId: 'other',
        playerAId: 3,
        playerBId: 4,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await repo.locked()).toHaveLength(1);
    const battle = (await repo.locked())[0];
    await expect(
      service.create(actors[battle.adminId], {
        commandId: 'another',
        playerAId: 4,
        playerBId: 6,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
  });
  it('deduplicates create and rejects identity or selection changes', async () => {
    const battle = await service.create(actors[1], createPayload());
    expect((await service.create(actors[1], createPayload())).battleId).toBe(
      battle.battleId,
    );
    await expect(
      service.create(actors[1], { ...createPayload(), playerBId: 4 }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(
      service.create(actors[2], createPayload()),
    ).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });
  it('merges simultaneous snapshots with CAS and preserves the player board exactly', async () => {
    const battle = await ready();
    expect(battle.phase).toBe('ready');
    expect(battle.players.a.snapshot.pokemons[0].pokemon.types).toEqual([
      'fairy',
    ]);
    expect(battle.players.a.snapshot.pokemons[0].pokemon.stats[0].value).toBe(
      70,
    );
    expect(battle.players.a.snapshot.pokemons[0].statuses).toEqual([
      'burned',
      'confused',
    ]);
    expect(battle.players.a.snapshot.pokemons[0].captureId).toBe(
      battle.players.b.snapshot.pokemons[0].captureId,
    );
    expect(
      (
        await service.snapshot(actors[2], {
          snapshot: battle.players.a.snapshot,
        })
      ).revision,
    ).toBe(battle.revision);
  });
  it('validates 1..6 unique captures, current HP, hashes, versions and four moves without healing', async () => {
    const battle = await service.create(actors[1], createPayload());
    const base = snapshot(battle, 2, actors[2].clientId);
    for (const change of [
      (s: any) => s.pokemons.splice(0),
      (s: any) => s.pokemons.push(clone(s.pokemons[0])),
      (s: any) => (s.pokemons[0].pokemon.stats[0].value = 92),
      (s: any) => (s.pokemons[0].pokemon.level = 0),
      (s: any) => (s.dataVersion = 'unknown'),
      (s: any) => (s.pokemons[0].moves = []),
    ]) {
      const invalid = clone(base);
      change(invalid);
      invalid.baseHash = digest(invalid.pokemons);
      expect(() => validateSnapshot(invalid)).toThrow();
    }
    const four = clone(base);
    four.pokemons[0].moves = [1, 2, 3, 4].map((id) => ({
      ...four.pokemons[0].moves[0],
      id,
    }));
    four.baseHash = digest(four.pokemons);
    expect(validateSnapshot(four)).toEqual(four);
    await expect(
      service.snapshot(
        { ...actors[2], clientId: 'other-device' },
        { snapshot: base },
      ),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
  });
  it('uses UTF-16 key ordering and JSON undefined semantics for hashes and request keys', () => {
    expect(
      stableJson({ '\ufffd': 1, '😀': 2, a: undefined, Z: [undefined, 4] }),
    ).toBe('{"Z":[null,4],"😀":2,"�":1}');
  });
  it('rejects forfeit outside the acting side request and duplicate queued choices', async () => {
    let battle = await active();
    const waiting = clone(battle.session);
    waiting.runtime.serial++;
    waiting.runtime.requests.a.waiting = true;
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: battle.checkpointRevision,
      session: waiting,
      processedCommandIds: [],
    });
    await expect(
      service.command(actors[1], {
        battleId: battle.battleId,
        commandId: 'invalid-forfeit',
        side: 'a',
        requestKey: requestKey(battle.session, 'a'),
        choice: { kind: 'forfeit' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
    const payload = {
      battleId: battle.battleId,
      commandId: 'forfeit-b',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'forfeit' },
    };
    await service.command(actors[1], payload);
    await expect(
      service.command(actors[1], { ...payload, commandId: 'forfeit-b-again' }),
    ).rejects.toMatchObject({ code: 'COMMAND_PENDING' });
    expect((await repo.get(battle.battleId)).commands).toHaveLength(1);
  });
  it('keeps reservations on disconnection/restart and resumes from the durable checkpoint', async () => {
    const battle = await active();
    service.disconnect(actors[2].socketId);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    expect(await repo.locked()).toHaveLength(1);
    const restarted = new PvpService(repo, auth as any);
    Object.values(actors).forEach((actor) => restarted.connect(actor));
    const restored = await restarted.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.session).toEqual(battle.session);
    expect(restored.state.checkpointRevision).toBe(1);
  });
  it('fences an older admin tab after a new claim', async () => {
    const battle = await ready();
    const newHost = {
      ...actors[1],
      clientId: 'new-admin-tab',
      socketId: 'new-admin-socket',
    };
    service.connect(newHost);
    const claimed = await service.claim(newHost, { battleId: battle.battleId });
    expect(claimed.host.epoch).toBe(2);
    const data = {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    };
    await expect(service.checkpoint(actors[1], data)).rejects.toMatchObject({
      code: 'HOST_REQUIRED',
    });
    await expect(service.checkpoint(newHost, data)).rejects.toMatchObject({
      code: 'HOST_FENCED',
    });
  });
  it('accepts commands only from the host, deduplicates them and keeps checkpoint revision independent of enqueue', async () => {
    const battle = await active();
    const commandA = {
      battleId: battle.battleId,
      commandId: 'cmd-a',
      side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: { kind: 'move', moveId: 1 },
    };
    await expect(service.command(actors[2], commandA)).rejects.toMatchObject({
      code: 'HOST_REQUIRED',
    });
    await service.command(actors[1], commandA);
    await service.command(actors[1], commandA);
    expect((await repo.get(battle.battleId)).commands).toHaveLength(1);
    await expect(
      service.command(actors[1], { ...commandA, choice: { kind: 'forfeit' } }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    const actualCas = repo.compareAndSwap.bind(repo);
    jest
      .spyOn(repo, 'compareAndSwap')
      .mockImplementationOnce(async (next, expected) => {
        await service.command(actors[1], {
          ...commandA,
          commandId: 'cmd-b',
          side: 'b',
          requestKey: requestKey(battle.session, 'b'),
        });
        return actualCas(next, expected);
      });
    const saved = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: battle.session,
      processedCommandIds: ['cmd-a'],
    });
    expect(saved.checkpointRevision).toBe(2);
    expect(saved.commands.map((command) => command.commandId)).toEqual([
      'cmd-b',
    ]);
  });
  it('rejects stale requests, permanent-field edits and unknown processed commands', async () => {
    const battle = await active();
    await expect(
      service.command(actors[1], {
        battleId: battle.battleId,
        commandId: 'stale',
        side: 'a',
        requestKey: 'old',
        choice: { kind: 'wait' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REQUEST' });
    const changed = clone(battle.session);
    changed.teams.a.pokemons[0].pokemon.level++;
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: changed,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['unknown'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
  });
  it('persists immutable private results and unlocks only after both owners apply them', async () => {
    const battle = await active();
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    finished.runtime.serial++;
    finished.teams.b.pokemons[0].pokemon.stats[0].value = 0;
    finished.teams.a.pokemons[0].statuses = ['asleep', 'confused'];
    finished.teams.a.pokemons[0].statusTurns = { asleep: 2, confused: 2 };
    await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: finished,
      processedCommandIds: [],
    });
    const finalized = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(
      (
        await service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).results,
    ).toEqual(finalized.results);
    const own = service.view(finalized, actors[2]);
    expect(own.session).toBeUndefined();
    expect(own.commands).toBeUndefined();
    expect(own.players.b.snapshot).toBeUndefined();
    expect(JSON.stringify(own)).not.toContain('private-pokemon-3');
    expect(own.result.patches[0]).toEqual({
      captureId: 'same-id-across-players',
      hp: 70,
      statuses: ['asleep'],
      statusTurns: { asleep: 2 },
    });
    for (const userId of [2, 3]) {
      const side = userId === 2 ? 'a' : 'b';
      const result = finalized.results[side];
      const applied = await service.applied(actors[userId], {
        battleId: battle.battleId,
        resultId: result.resultId,
        snapshotId: result.snapshotId,
        baseHash: result.baseHash,
      });
      expect(applied.lockHeld).toBe(userId === 2);
      expect(
        (
          await service.applied(actors[userId], {
            battleId: battle.battleId,
            resultId: result.resultId,
            snapshotId: result.snapshotId,
            baseHash: result.baseHash,
          })
        ).revision,
      ).toBe(applied.revision);
    }
    expect((await repo.get(battle.battleId)).phase).toBe('finalized');
    expect(await repo.locked()).toHaveLength(0);
  });
  it('preserves depleted PP on the first checkpoint, accepts later changes, and exports only bounded learned move PP', async () => {
    let battle = await service.create(actors[1], createPayload());
    for (const userId of [2, 3]) {
      const sent = snapshot(battle, userId, actors[userId].clientId);
      sent.pokemons[0].moves[0].currentPp = userId === 2 ? 0 : 20;
      sent.baseHash = digest(sent.pokemons);
      await service.snapshot(actors[userId], { snapshot: sent });
    }
    battle = await repo.get(battle.battleId);
    const initial = session(battle);
    initial.teams.a.pokemons[0].moves[0].currentPp = 35;
    const payload = {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      processedCommandIds: [],
    };
    await expect(
      service.checkpoint(actors[1], { ...payload, session: initial }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    initial.teams.a.pokemons[0].moves[0].currentPp = 0;
    battle = await service.checkpoint(actors[1], {
      ...payload,
      session: initial,
    });
    const finished = clone(battle.session);
    finished.teams.a.pokemons[0].moves[0].currentPp = 35;
    finished.teams.b.pokemons[0].moves[0].currentPp = 19;
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    finished.runtime.serial++;
    const invalid = clone(finished);
    invalid.teams.a.pokemons[0].moves[0].pp = 40;
    await expect(
      service.checkpoint(actors[1], {
        ...payload,
        expectedCheckpointRevision: 1,
        session: invalid,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    await service.checkpoint(actors[1], {
      ...payload,
      expectedCheckpointRevision: 1,
      session: finished,
    });
    const result = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(result.results.a.patches[0].movesPp).toEqual([
      { moveId: 1, currentPp: 35 },
    ]);
    expect(result.results.b.patches[0].movesPp).toEqual([
      { moveId: 1, currentPp: 19 },
    ]);
    expect(result.results.a.baseHash).toBe(battle.players.a.snapshot.baseHash);
  });
  it.each([-1, 1.5, 36, null, '1'])(
    'rejects invalid current PP %s without changing a snapshot hash',
    async (currentPp) => {
      const battle = await service.create(actors[1], createPayload());
      const sent = snapshot(battle, 2, actors[2].clientId);
      sent.pokemons[0].moves[0].currentPp = currentPp;
      sent.baseHash = digest(sent.pokemons);
      expect(() => validateSnapshot(sent)).toThrow();
    },
  );
  it('validates missing catalog PP with the shared Gen III fallback without rewriting the snapshot', async () => {
    const battle = await service.create(actors[1], createPayload());
    const sent = snapshot(battle, 2, actors[2].clientId);
    sent.pokemons[0].moves[0].pp = null;
    sent.pokemons[0].moves[0].currentPp = 35;
    sent.baseHash = digest(sent.pokemons);
    const before = clone(sent);
    expect(validateSnapshot(sent)).toEqual(before);
    sent.pokemons[0].moves[0].currentPp = 36;
    sent.baseHash = digest(sent.pokemons);
    expect(() => validateSnapshot(sent)).toThrow();
  });
  it('only cancels preparation and reuses released player/admin reservations', async () => {
    const battle = await active();
    await expect(
      service.cancel(actors[1], { battleId: battle.battleId, hostEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_PHASE' });
    const otherRepo = new MemoryPvpRepository();
    const other = new PvpService(otherRepo, auth as any);
    Object.values(actors).forEach((actor) => other.connect(actor));
    const collecting = await other.create(actors[1], createPayload());
    await other.cancel(
      actors[2],
      { battleId: collecting.battleId, reason: 'Local encounter active' },
      true,
    );
    expect(
      (await other.create(actors[1], createPayload('after-cancel'))).phase,
    ).toBe('collecting');
  });
  it('creates a Kanto Trainer battle with only one human owner and an immutable scaled preset', async () => {
    const battle = await readyTrainer();
    expect(battle.mode).toBe('trainer');
    expect(battle.phase).toBe('ready');
    expect(battle.lockedUserIds).toEqual([2]);
    expect(battle.players.b).toBeUndefined();
    expect(battle.applied).toEqual({ a: false, b: true });
    expect(battle.trainer.presetId).toBe('kanto-brock');
    expect(
      battle.trainer.team.pokemons.map((p) => [p.pokemon.id, p.pokemon.level]),
    ).toEqual([
      [74, 12],
      [95, 14],
    ]);
    expect(battle.trainer.team.pokemons[0].pokemon.hpMultiplier).toBe(2);
    expect(
      battle.trainer.team.pokemons[0].pokemon.stats.find((s) => s.name === 'hp')
        .value,
    ).toBe(62);
    expect(
      trainerPreset('kanto-brock').team.pokemons[0].pokemon.hpMultiplier,
    ).toBe(1.3);
    expect(service.view(battle, actors[1]).trainer.team).toEqual(
      battle.trainer.team,
    );
    const own = service.view(battle, actors[2]);
    expect(own.trainer.presetId).toBe('kanto-brock');
    expect(own.trainer.name).toBeTruthy();
    expect(own.trainer.team).toBeUndefined();
    expect(own.players.b).toBeUndefined();
    expect(own.session).toBeUndefined();
    expect(own.snapshot).toEqual(battle.players.a.snapshot);
    expect(() => service.view(battle, actors[3])).toThrow();
  });
  it('validates and deduplicates trainer selection without accepting a forged NPC or second account', async () => {
    const payload = {
      commandId: 'create-trainer',
      playerAId: 2,
      trainerPresetId: 'kanto-brock',
    };
    await expect(
      service.create(actors[1], {
        ...payload,
        trainerPresetId: 'missing-trainer',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRAINER' });
    await expect(
      service.create(actors[1], { ...payload, playerBId: 3 }),
    ).rejects.toMatchObject({ code: 'INVALID_PLAYERS' });
    await expect(
      service.create(actors[1], { ...payload, trainer: { team: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.create(actors[2], payload)).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    const battle = await service.create(actors[1], payload);
    expect((await service.create(actors[1], payload)).battleId).toBe(
      battle.battleId,
    );
    await expect(
      service.create(actors[1], { ...payload, trainerPresetId: 'kanto-misty' }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(
      service.create(actors[5], {
        commandId: 'pvp-overlap',
        playerAId: 2,
        playerBId: 3,
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await expect(
      service.create(actors[5], { ...payload, commandId: 'trainer-overlap' }),
    ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
    await service.cancel(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(
      (
        await service.create(actors[5], {
          ...payload,
          commandId: 'trainer-after-cancel',
        })
      ).lockedUserIds,
    ).toEqual([2]);
  });
  it('rejects altered NPC levels, moves, HP and initial state before accepting a checkpoint', async () => {
    const battle = await readyTrainer();
    for (const change of [
      (s: any) => s.teams.b.pokemons[0].pokemon.level++,
      (s: any) => s.teams.b.pokemons[0].moves[0].id++,
      (s: any) =>
        s.teams.b.pokemons[0].pokemon.stats.find((stat) => stat.name === 'hp')
          .value--,
      (s: any) => s.teams.b.pokemons[0].statuses.push('burned'),
      (s: any) => s.teams.b.pokemons[0].pokemon.battleStages.attack++,
      (s: any) => (s.teams.b.name = 'Forged Trainer'),
      (s: any) => (s.teams.b.activeCaptureId = s.teams.b.pokemons[1].captureId),
    ]) {
      const changed = session(battle);
      change(changed);
      await expect(
        service.checkpoint(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 0,
          session: changed,
          processedCommandIds: [],
        }),
      ).rejects.toThrow();
    }
    expect((await repo.get(battle.battleId)).checkpointRevision).toBe(0);
    expect((await repo.get(battle.battleId)).lockHeld).toBe(true);
  });
  it('requires only the real player online and original device to resume Trainer battle', async () => {
    const battle = await activeTrainer();
    service.disconnect(actors[3].socketId);
    const command = {
      battleId: battle.battleId,
      commandId: 'npc-choice',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'move', moveId: 1 },
    };
    const queued = await service.command(actors[1], command);
    expect(queued.commands).toHaveLength(1);
    service.disconnect(actors[2].socketId);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['npc-choice'],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    const foreign = {
      ...actors[2],
      clientId: 'foreign-player-device',
      socketId: 'foreign-player-socket',
    };
    service.connect(foreign);
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 1,
        session: battle.session,
        processedCommandIds: ['npc-choice'],
      }),
    ).rejects.toMatchObject({ code: 'PLAYER_OFFLINE' });
    expect(
      service.view(await repo.get(battle.battleId), actors[1]).players.a.online,
    ).toBe(false);
    service.connect(actors[2]);
    const restarted = new PvpService(repo, auth as any);
    [actors[1], actors[2]].forEach((actor) => restarted.connect(actor));
    const restored = await restarted.sync(actors[1], {
      battleId: battle.battleId,
    });
    expect(restored.state.session).toEqual(battle.session);
    expect(restored.state.trainer.team).toEqual(battle.trainer.team);
    expect(
      (
        await restarted.checkpoint(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 1,
          session: battle.session,
          processedCommandIds: ['npc-choice'],
        })
      ).commands,
    ).toEqual([]);
  });
  it('delivers a Trainer result only to its player and releases after that player saves once', async () => {
    const battle = await activeTrainer();
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'b';
    finished.runtime.serial++;
    finished.teams.a.pokemons[0].pokemon.stats[0].value = 0;
    await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: finished,
      processedCommandIds: [],
    });
    service.disconnect(actors[2].socketId);
    const finalizing = await service.finalize(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
    });
    expect(finalizing.phase).toBe('finalizing');
    expect(finalizing.lockHeld).toBe(true);
    expect(Object.keys(finalizing.results)).toEqual(['a']);
    expect(finalizing.results.a.outcome).toBe('lose');
    expect(finalizing.results.a.patches[0].hp).toBe(0);
    const result = finalizing.results.a;
    const payload = {
      battleId: battle.battleId,
      resultId: result.resultId,
      snapshotId: result.snapshotId,
      baseHash: result.baseHash,
    };
    const foreign = {
      ...actors[2],
      clientId: 'foreign',
      socketId: 'foreign-socket',
    };
    service.connect(foreign);
    await expect(service.applied(foreign, payload)).rejects.toMatchObject({
      code: 'OWNER_REQUIRED',
    });
    service.connect(actors[2]);
    const completed = await service.applied(actors[2], payload);
    expect(completed.phase).toBe('finalized');
    expect(completed.lockHeld).toBe(false);
    expect((await service.applied(actors[2], payload)).revision).toBe(
      completed.revision,
    );
    expect(
      (
        await service.finalize(actors[1], {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).results,
    ).toEqual(finalizing.results);
    expect(await repo.locked()).toEqual([]);
  });
  it('accepts native Struggle for either side at zero PP without enabling exhausted ordinary moves', async () => {
    let battle = await activeTrainer();
    const exhausted = clone(battle.session);
    exhausted.runtime.serial++;
    for (const side of ['a', 'b']) {
      exhausted.runtime.requests[side].moves = [
        { id: 33, name: 'Tackle', pp: 0, maxpp: 35, disabled: false },
        { id: 165, name: 'Struggle', pp: 0, maxpp: 0, disabled: false },
      ];
    }
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: exhausted,
      processedCommandIds: [],
    });
    for (const side of ['a', 'b'] as const) {
      const base = {
        battleId: battle.battleId,
        commandId: `struggle-${side}`,
        side,
        requestKey: requestKey(battle.session, side),
      };
      await expect(
        service.command(actors[1], {
          ...base,
          choice: { kind: 'move', moveId: 33 },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
      await service.command(actors[1], {
        ...base,
        choice: { kind: 'move', moveId: 165 },
      });
    }
    expect(
      (await repo.get(battle.battleId)).commands.map((command) => [
        command.side,
        command.choice,
      ]),
    ).toEqual([
      ['a', { kind: 'move', moveId: 165 }],
      ['b', { kind: 'move', moveId: 165 }],
    ]);
  });
  it('supports native locked recharge move zero but rejects it outside its forced request', async () => {
    let battle = await activeTrainer();
    const payload = {
      battleId: battle.battleId,
      commandId: 'recharge',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'move', moveId: 0 },
    };
    await expect(service.command(actors[1], payload)).rejects.toMatchObject({
      code: 'INVALID_CHOICE',
    });
    const forced = clone(battle.session);
    forced.runtime.serial++;
    forced.runtime.requests.b.locked = true;
    forced.runtime.requests.b.moves = [
      { id: 0, name: 'Recharge', pp: 0, maxpp: 0, disabled: false },
    ];
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 1,
      session: forced,
      processedCommandIds: [],
    });
    const queued = await service.command(actors[1], {
      ...payload,
      requestKey: requestKey(battle.session, 'b'),
    });
    expect(queued.commands[0].choice).toEqual({ kind: 'move', moveId: 0 });
    const pending = clone(forced);
    pending.runtime.serial++;
    pending.runtime.pending.b = { kind: 'move', moveId: 0 };
    battle = await service.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 2,
      session: pending,
      processedCommandIds: ['recharge'],
    });
    const invalid = clone(pending);
    invalid.runtime.requests.b.locked = false;
    await expect(
      service.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 3,
        session: invalid,
        processedCommandIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(battle.session.runtime.pending.b.moveId).toBe(0);
  });
});

describe('Real PvP Socket.IO gateway with fake authoritative auth and memory durability', () => {
  let app: INestApplication;
  let address: string;
  let repo: MemoryPvpRepository;
  let auth: ReturnType<typeof fakeAuth>;
  let sockets: Socket[];
  beforeEach(async () => {
    repo = new MemoryPvpRepository();
    auth = fakeAuth();
    sockets = [];
    const moduleRef = await Test.createTestingModule({
      imports: [PvpModule.withRepository(repo)],
    })
      .overrideProvider(AuthIdentityService)
      .useValue(auth)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    address = await app.getUrl();
  });
  afterEach(async () => {
    for (const socket of sockets) {
      socket.disconnect();
      socket.removeAllListeners();
    }
    await app.close();
  });
  async function connect(userId: number): Promise<Socket> {
    const socket = io(`${address}/pvp`, {
      auth: { token: `test-user-${userId}`, clientId: `client-${userId}` },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      forceNew: true,
      extraHeaders: { Origin: 'http://localhost:5173' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  function ack(socket: Socket, event: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) =>
      socket
        .timeout(6000)
        .emit(event, payload, (error: Error, result: any) =>
          error ? reject(error) : resolve(result),
        ),
    );
  }
  it('transports snapshots larger than 16KB and projects no rival engine or team to players/third parties', async () => {
    const [admin, a, b, outsider] = await Promise.all(
      [1, 2, 3, 4].map(connect),
    );
    const created = await ack(admin, 'pvp:create', {
      commandId: 'large-snapshot',
      playerAId: 2,
      playerBId: 3,
    });
    expect(created.ok).toBe(true);
    const snapA = snapshot(created.state, 2, 'client-2', true);
    expect(Buffer.byteLength(JSON.stringify(snapA))).toBeGreaterThan(16384);
    expect((await ack(a, 'pvp:snapshot', { snapshot: snapA })).ok).toBe(true);
    expect(
      (
        await ack(b, 'pvp:snapshot', {
          snapshot: snapshot(created.state, 3, 'client-3'),
        })
      ).ok,
    ).toBe(true);
    const playerState = await ack(a, 'pvp:sync', {
      battleId: created.state.battleId,
    });
    expect(playerState.state.snapshot).toEqual(snapA);
    expect(playerState.state.players.b.snapshot).toBeUndefined();
    expect(playerState.state.session).toBeUndefined();
    expect(JSON.stringify(playerState)).not.toContain('private-pokemon-3');
    expect(
      (await ack(outsider, 'pvp:sync', { battleId: created.state.battleId }))
        .error.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await ack(a, 'pvp:command', {
          battleId: created.state.battleId,
          commandId: 'forged-player-command',
          side: 'a',
          requestKey: 'none',
          choice: { kind: 'forfeit' },
        })
      ).error.code,
    ).toBe('HOST_REQUIRED');
  });
  it('rejects revoked identities while preserving battle reservations for recovery', async () => {
    const [admin, a] = await Promise.all([connect(1), connect(2), connect(3)]);
    const created = await ack(admin, 'pvp:create', {
      commandId: 'revocation',
      playerAId: 2,
      playerBId: 3,
    });
    expect(created.ok).toBe(true);
    auth.users.delete(2);
    expect(
      (await ack(a, 'pvp:sync', { battleId: created.state.battleId })).error
        .code,
    ).toBe('SESSION_REVOKED');
    expect((await repo.get(created.state.battleId)).lockHeld).toBe(true);
  });
  it('transports a one-player Trainer battle and final result without an NPC socket or false owner', async () => {
    const [admin, player, outsider] = await Promise.all([
      connect(1),
      connect(2),
      connect(3),
    ]);
    const created = await ack(admin, 'pvp:create', {
      commandId: 'socket-trainer',
      playerAId: 2,
      trainerPresetId: 'kanto-misty',
    });
    expect(created.ok).toBe(true);
    expect(created.state.mode).toBe('trainer');
    expect(created.state.players.b).toBeUndefined();
    expect(
      (
        await ack(player, 'pvp:snapshot', {
          snapshot: snapshot(created.state, 2, 'client-2'),
        })
      ).ok,
    ).toBe(true);
    const own = await ack(player, 'pvp:sync', {});
    expect(own.state.phase).toBe('ready');
    expect(own.state.trainer.name).toBe('Misty');
    expect(own.state.trainer.team).toBeUndefined();
    expect(own.state.session).toBeUndefined();
    expect((await ack(outsider, 'pvp:sync', {})).state).toBeNull();
    let battle = await repo.get(created.state.battleId);
    expect(
      (
        await ack(admin, 'pvp:checkpoint', {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 0,
          session: session(battle),
          processedCommandIds: [],
        })
      ).ok,
    ).toBe(true);
    battle = await repo.get(battle.battleId);
    const forbidden = await ack(player, 'pvp:command', {
      battleId: battle.battleId,
      commandId: 'player-npc-choice',
      side: 'b',
      requestKey: requestKey(battle.session, 'b'),
      choice: { kind: 'forfeit' },
    });
    expect(forbidden.error.code).toBe('HOST_REQUIRED');
    const finished = clone(battle.session);
    finished.phase = 'finished';
    finished.runtime.ended = true;
    finished.runtime.winner = 'a';
    finished.runtime.serial++;
    expect(
      (
        await ack(admin, 'pvp:checkpoint', {
          battleId: battle.battleId,
          hostEpoch: 1,
          expectedCheckpointRevision: 1,
          session: finished,
          processedCommandIds: [],
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await ack(admin, 'pvp:finalize', {
          battleId: battle.battleId,
          hostEpoch: 1,
        })
      ).ok,
    ).toBe(true);
    const resultView = (await ack(player, 'pvp:sync', {})).state;
    expect(resultView.phase).toBe('finalizing');
    expect(resultView.result.outcome).toBe('win');
    const result = resultView.result;
    const applied = await ack(player, 'pvp:applied', {
      battleId: battle.battleId,
      resultId: result.resultId,
      snapshotId: result.snapshotId,
      baseHash: result.baseHash,
    });
    expect(applied.ok).toBe(true);
    expect(applied.state.phase).toBe('finalized');
    expect((await repo.get(battle.battleId)).lockHeld).toBe(false);
  });
});
describe('Background consumption snapshot barriers', () => {
  let repo: MemoryPvpRepository,
    wallets: MemoryShopRepository,
    shop: ShopService,
    pvp: PvpService,
    auth: ReturnType<typeof fakeAuth>,
    actors: Record<number, Actor>;
  const operation = (sequence = 1) => ({
    operationId: `pre-battle-${sequence}`,
    sequence,
    itemId: 'full-restore',
    quantity: 1,
    captureId: 'past-local-actor',
    context: 'local-battle',
  });
  const batch = (sequence = 1) => ({
    clientId: 'client-2',
    operations: [operation(sequence)],
  });
  const barrierSnapshot = (
    battle: Battle,
    userId: number,
    throughSequence = 0,
  ) => ({
    ...snapshot(battle, userId, actors[userId].clientId),
    consumptionBarrier: { clientId: actors[userId].clientId, throughSequence },
  });
  beforeEach(async () => {
    auth = fakeAuth();
    repo = new MemoryPvpRepository();
    wallets = new MemoryShopRepository();
    const activity = new PlayerActivityService();
    shop = new ShopService(wallets, auth as any, activity);
    pvp = new PvpService(repo, auth as any, activity, shop);
    await shop.onModuleInit();
    await pvp.onModuleInit();
    actors = Object.fromEntries(
      [...auth.users.values()].map((user) => [
        user.id,
        {
          user: clone(user),
          clientId: `client-${user.id}`,
          socketId: `socket-${user.id}`,
          token: `test-user-${user.id}`,
        },
      ]),
    ) as any;
    for (const actor of Object.values(actors)) {
      shop.connect(actor);
      pvp.connect(actor);
    }
    for (const userId of [2, 3]) {
      await shop.presence(actors[userId], {
        ready: true,
        localBattle: false,
        supportsBackgroundItemUses: true,
      });
      wallets.rows.get(userId).items['full-restore'] = 2;
    }
  });
  it.each(['pvp', 'trainer'])(
    'settles a preexisting outbox during %s collection and freezes fresh canonical stock at the snapshot barrier',
    async (mode) => {
      let battle = await pvp.create(actors[1], {
        commandId: `batch-${mode}`,
        playerAId: 2,
        ...(mode === 'trainer'
          ? { trainerPresetId: 'kanto-brock' }
          : { playerBId: 3 }),
      });
      await pvp.sync(actors[1], { battleId: battle.battleId });
      expect((await repo.get(battle.battleId)).inventory).toBeUndefined();
      await shop.presence(actors[2], {
        ready: false,
        localBattle: false,
        supportsBackgroundItemUses: true,
        pendingConsumption: true,
      });
      const settled = await shop.consumeBatch(actors[2], batch());
      expect(settled.wallet.items['full-restore']).toBe(1);
      await expect(
        pvp.snapshot(actors[2], {
          snapshot: snapshot(battle, 2, actors[2].clientId),
        }),
      ).rejects.toMatchObject({ code: 'INVENTORY_PENDING' });
      await expect(
        pvp.snapshot(actors[2], { snapshot: barrierSnapshot(battle, 2, 0) }),
      ).rejects.toMatchObject({ code: 'INVENTORY_PENDING' });
      await pvp.snapshot(actors[2], {
        snapshot: barrierSnapshot(battle, 2, 1),
      });
      await expect(
        shop.consumeBatch(actors[2], batch(2)),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      expect(
        (await shop.consumeBatch(actors[2], batch())).consumptions[0].status,
      ).toBe('accepted');
      if (mode === 'pvp')
        await pvp.snapshot(actors[3], { snapshot: barrierSnapshot(battle, 3) });
      battle = await repo.get(battle.battleId);
      expect(battle.phase).toBe('ready');
      expect(battle.itemInventory.a['full-restore']).toBe(1);
      expect(battle.inventory.a).toBe(1);
      if (mode === 'pvp') expect(battle.inventory.b).toBe(2);
      const active = await pvp.checkpoint(actors[1], {
        battleId: battle.battleId,
        hostEpoch: 1,
        expectedCheckpointRevision: 0,
        session: session(battle),
        processedCommandIds: [],
      });
      expect(active.phase).toBe('active');
      await expect(
        shop.consumeBatch(actors[2], batch(2)),
      ).rejects.toMatchObject({ code: 'PLAYER_BUSY' });
      expect((await wallets.get(2)).consumptions).toHaveLength(1);
      expect((await wallets.get(2)).items['full-restore']).toBe(1);
    },
  );
  it('refreshes budgets from a legacy collecting document after background settlement without rewriting old snapshots', async () => {
    const battle = await pvp.create(actors[1], {
      commandId: 'legacy-collecting',
      playerAId: 2,
      playerBId: 3,
    });
    const old = await repo.get(battle.battleId);
    old.inventory = { a: 2, b: 2 };
    old.itemInventory = { a: { 'full-restore': 2 }, b: { 'full-restore': 2 } };
    old.revision++;
    await repo.compareAndSwap(old, old.revision - 1);
    await shop.consumeBatch(actors[2], batch());
    await pvp.snapshot(actors[2], { snapshot: barrierSnapshot(battle, 2, 1) });
    await pvp.snapshot(actors[3], { snapshot: barrierSnapshot(battle, 3) });
    expect((await repo.get(battle.battleId)).inventory).toEqual({ a: 1, b: 2 });
    const oldSnapshot = snapshot(battle, 2, actors[2].clientId);
    const original = stableJson(oldSnapshot);
    expect(validateSnapshot(oldSnapshot)).toEqual(oldSnapshot);
    expect(stableJson(oldSnapshot)).toBe(original);
    expect(oldSnapshot).not.toHaveProperty('consumptionBarrier');
  });
  it('serializes an asynchronous background CAS before a queued snapshot and rejects gaps without freezing stale inventory', async () => {
    const battle = await pvp.create(actors[1], {
      commandId: 'barrier-race',
      playerAId: 2,
      playerBId: 3,
    });
    const original = auth.authenticate.bind(auth);
    let entered: () => void, release: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    auth.authenticate = async (token) => {
      const result = await original(token);
      if (token === actors[2].token) {
        entered();
        await hold;
      }
      return result;
    };
    const settling = shop.consumeBatch(actors[2], batch());
    await started;
    const sending = pvp.snapshot(actors[2], {
      snapshot: barrierSnapshot(battle, 2, 1),
    });
    release();
    await settling;
    await sending;
    await pvp.snapshot(actors[3], { snapshot: barrierSnapshot(battle, 3) });
    expect((await repo.get(battle.battleId)).inventory.a).toBe(1);
    await expect(shop.consumeBatch(actors[2], batch(3))).rejects.toMatchObject({
      code: 'CONSUMPTION_GAP',
    });
    expect(
      (await wallets.get(2)).consumptionClients.find(
        (entry) => entry.clientId === actors[2].clientId,
      ).throughSequence,
    ).toBe(1);
  });
});

describe('Full Restore battle inventory settlement', () => {
  let repo: MemoryPvpRepository,
    wallets: MemoryShopRepository,
    shop: ShopService,
    pvp: PvpService;
  let actors: Record<number, Actor>, battle: Battle;
  beforeEach(async () => {
    const auth = fakeAuth();
    const activity = new PlayerActivityService();
    repo = new MemoryPvpRepository();
    wallets = new MemoryShopRepository();
    shop = new ShopService(wallets, auth as any, activity);
    pvp = new PvpService(repo, auth as any, activity, shop);
    await shop.onModuleInit();
    await pvp.onModuleInit();
    actors = Object.fromEntries(
      [...auth.users.values()].map((user) => [
        user.id,
        {
          user: clone(user),
          clientId: `client-${user.id}`,
          socketId: `socket-${user.id}`,
          token: `test-user-${user.id}`,
        },
      ]),
    ) as any;
    for (const actor of Object.values(actors)) {
      shop.connect(actor);
      pvp.connect(actor);
    }
    for (const userId of [2, 3]) {
      await shop.presence(actors[userId], { ready: true, localBattle: false });
      wallets.rows.get(userId).items['full-restore'] = 2;
      wallets.rows.get(userId).items['max-ether'] = 2;
      wallets.rows.get(userId).items['max-elixir'] = 2;
    }
    battle = await pvp.create(actors[1], {
      commandId: 'inventory-battle',
      playerAId: 2,
      playerBId: 3,
    });
    for (const userId of [2, 3])
      await pvp.snapshot(actors[userId], {
        snapshot: snapshot(battle, userId, actors[userId].clientId),
      });
    battle = await repo.get(battle.battleId);
    battle = await pvp.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  });
  async function item(
    itemId: ConsumableItemId = 'full-restore',
    moveId?: number,
  ) {
    return pvp.command(actors[1], {
      battleId: battle.battleId,
      commandId: 'restore-action',
      side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: {
        kind: 'item',
        item: itemId,
        captureId: battle.session.teams.a.activeCaptureId,
        ...(moveId === undefined ? {} : { moveId }),
      },
    });
  }
  function checkpoint(input: Battle, used: string[], pending = false) {
    const next = clone(input.session);
    const choice = input.commands.find(
      (command) => command.choice.kind === 'item',
    )?.choice;
    next.networkItems = {
      pending: pending
        ? {
            a: {
              commandId: 'restore-action',
              captureId: next.teams.a.activeCaptureId,
              ...(choice?.kind === 'item'
                ? {
                    itemId: choice.item,
                    ...(choice.moveId === undefined
                      ? {}
                      : { moveId: choice.moveId }),
                  }
                : {}),
            },
          }
        : {},
      used,
    };
    next.runtime.pending = pending
      ? {
          a: {
            kind: 'item',
            item: choice?.kind === 'item' ? choice.item : 'full-restore',
            captureId: next.teams.a.activeCaptureId,
            ...(choice?.kind === 'item' && choice.moveId !== undefined
              ? { moveId: choice.moveId }
              : {}),
          },
        }
      : {};
    next.runtime.serial++;
    return {
      battleId: input.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: input.checkpointRevision,
      session: next,
      processedCommandIds: input.commands.map((c) => c.commandId),
    };
  }
  it('reserves a legal choice without debit, then charges once on effect checkpoint and survives replay', async () => {
    const queued = await item();
    expect(queued.commands[0].inventoryAuthorized).toBe(true);
    expect(await shop.fullRestoreStock(2)).toBe(2);
    const payload = checkpoint(queued, ['restore-action']);
    const done = await pvp.checkpoint(actors[1], payload);
    expect(done.inventory.a).toBe(1);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    await pvp.checkpoint(actors[1], payload);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(wallets.rows.get(2).battleUses).toHaveLength(1);
    expect(wallets.rows.get(2).balance).toBe(500);
  });
  it('a pending choice cancelled before execution never consumes a unit', async () => {
    const selected = await pvp.checkpoint(
      actors[1],
      checkpoint(await item(), [], true),
    );
    const cancelled = await pvp.command(actors[1], {
      battleId: battle.battleId,
      commandId: 'cancel-item',
      side: 'a',
      requestKey: requestKey(selected.session, 'a'),
      choice: { kind: 'cancel' },
    });
    await pvp.checkpoint(actors[1], checkpoint(cancelled, []));
    expect(await shop.fullRestoreStock(2)).toBe(2);
  });
  it('keeps an already authorized legacy Full Restore command replayable after its target faints', async () => {
    const queued = await item();
    const legacy = clone(queued);
    legacy.session.teams.a.pokemons[0].pokemon.stats[0].value = 0;
    legacy.revision++;
    await repo.compareAndSwap(legacy, queued.revision);
    const originalHashes = clone(legacy.commandHashes);
    const replay = await item();
    expect(replay.revision).toBe(legacy.revision);
    expect(replay.commandHashes).toEqual(originalHashes);
    expect(replay.commands).toEqual(legacy.commands);
    expect(replay.lockHeld).toBe(true);
    expect(await shop.fullRestoreStock(2)).toBe(2);
    const payload = checkpoint(replay, ['restore-action']);
    payload.session.teams.a.pokemons[0].pokemon.stats[0].value = 91;
    const settled = await pvp.checkpoint(actors[1], payload);
    expect(settled.session.teams.a.pokemons[0].pokemon.stats[0].value).toBe(91);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    await pvp.checkpoint(actors[1], payload);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(wallets.rows.get(2).battleUses).toHaveLength(1);
  });
  it('recovering after wallet debit and a failed checkpoint write does not debit again', async () => {
    const queued = await item(),
      payload = checkpoint(queued, ['restore-action']);
    const cas = repo.compareAndSwap.bind(repo);
    let failCommit = true;
    repo.compareAndSwap = async (next, rev) => {
      if (
        failCommit &&
        next.session?.networkItems?.used?.includes('restore-action') &&
        !next.pendingInventoryCheckpoint
      ) {
        failCommit = false;
        throw new Error('simulated checkpoint write failure');
      }
      return cas(next, rev);
    };
    await expect(pvp.checkpoint(actors[1], payload)).rejects.toThrow(
      'simulated',
    );
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint,
    ).toBeDefined();
    // An upgrade may resume an old Full Restore outbox after its wallet debit.
    const legacy = await repo.get(battle.battleId);
    delete legacy.itemInventory;
    for (const entry of Object.values(legacy.itemCommands)) delete entry.itemId;
    for (const charge of legacy.pendingInventoryCheckpoint.charges)
      delete charge.itemId;
    legacy.revision++;
    await cas(legacy, legacy.revision - 1);
    delete wallets.rows.get(2).battleUses[0].itemId;
    const resumed = await pvp.sync(actors[1], { battleId: battle.battleId });
    expect(resumed.state.session.networkItems.used).toEqual(['restore-action']);
    expect(resumed.state.itemInventory.a['full-restore']).toBe(1);
    expect(await shop.fullRestoreStock(2)).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint,
    ).toBeUndefined();
  });
  it('rejects zero stock and invented inventory receipts', async () => {
    await repo.compareAndSwap(
      { ...battle, inventory: { a: 0, b: 2 }, revision: battle.revision + 1 },
      battle.revision,
    );
    await expect(item()).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' });
    await expect(
      pvp.checkpoint(
        actors[1],
        checkpoint(await repo.get(battle.battleId), ['invented']),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect(await shop.fullRestoreStock(2)).toBe(2);
  });
  it('keeps unusual command IDs as data across persistence and inventory settlement', async () => {
    const queued = await pvp.command(actors[1], {
      battleId: battle.battleId,
      commandId: '__proto__',
      side: 'a',
      requestKey: requestKey(battle.session, 'a'),
      choice: {
        kind: 'item',
        item: 'full-restore',
        captureId: battle.session.teams.a.activeCaptureId,
      },
    });
    await pvp.checkpoint(actors[1], checkpoint(queued, ['__proto__']));
    expect(await shop.fullRestoreStock(2)).toBe(1);
  });
  it.each(['max-ether', 'max-elixir'] as const)(
    'settles %s separately from Full Restore and rejects altered pending selectors',
    async (itemId) => {
      const queued = await item(itemId, itemId === 'max-ether' ? 1 : undefined);
      expect(pvp.view(queued, actors[1]).itemInventory.a[itemId]).toBe(2);
      const payload = checkpoint(queued, [], true);
      const wrong = clone(payload);
      wrong.session.networkItems.pending.a.itemId = 'full-restore';
      await expect(pvp.checkpoint(actors[1], wrong)).rejects.toMatchObject({
        code: 'INVALID_CHECKPOINT',
      });
      if (itemId === 'max-ether') {
        const changedMove = clone(payload);
        changedMove.session.networkItems.pending.a.moveId = 2;
        await expect(
          pvp.checkpoint(actors[1], changedMove),
        ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
      }
      const selected = await pvp.checkpoint(actors[1], payload);
      const executed = checkpoint(selected, ['restore-action']);
      const done = await pvp.checkpoint(actors[1], executed);
      expect(done.itemInventory.a[itemId]).toBe(1);
      expect(done.inventory.a).toBe(2);
      expect((await shop.battleItemStock(2))[itemId]).toBe(1);
      expect(await shop.fullRestoreStock(2)).toBe(2);
      await pvp.checkpoint(actors[1], executed);
      expect(wallets.rows.get(2).battleUses).toHaveLength(1);
    },
  );
  it('rejects an Ether selector outside the target learned moves and item-specific empty stock', async () => {
    await expect(item('max-ether')).rejects.toThrow();
    await expect(item('max-ether', 2)).rejects.toMatchObject({
      code: 'INVALID_CHOICE',
    });
    const depleted = clone(battle);
    depleted.itemInventory.a['max-elixir'] = 0;
    depleted.revision++;
    await repo.compareAndSwap(depleted, battle.revision);
    await expect(item('max-elixir')).rejects.toMatchObject({
      code: 'ITEM_UNAVAILABLE',
    });
    expect(await shop.fullRestoreStock(2)).toBe(2);
  });
  it('recovers a Max Ether outbox after a failed checkpoint write with exactly one item debit', async () => {
    const queued = await item('max-ether', 1);
    const payload = checkpoint(queued, ['restore-action']);
    const cas = repo.compareAndSwap.bind(repo);
    let failCommit = true;
    repo.compareAndSwap = async (next, rev) => {
      if (
        failCommit &&
        next.session?.networkItems?.used?.includes('restore-action') &&
        !next.pendingInventoryCheckpoint
      ) {
        failCommit = false;
        throw new Error('simulated Ether checkpoint write failure');
      }
      return cas(next, rev);
    };
    await expect(pvp.checkpoint(actors[1], payload)).rejects.toThrow(
      'simulated Ether',
    );
    expect((await shop.battleItemStock(2))['max-ether']).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint.charges[0],
    ).toMatchObject({ itemId: 'max-ether', moveId: 1 });
    const resumed = await pvp.sync(actors[1], { battleId: battle.battleId });
    expect(resumed.state.itemInventory.a['max-ether']).toBe(1);
    expect((await shop.battleItemStock(2))['max-ether']).toBe(1);
    expect(wallets.rows.get(2).battleUses).toHaveLength(1);
  });
});

describe('Max Revive battle authorization and durable settlement', () => {
  let repo: MemoryPvpRepository,
    wallets: MemoryShopRepository,
    shop: ShopService,
    pvp: PvpService,
    actors: Record<number, Actor>,
    battle: Battle;
  beforeEach(async () => {
    const auth = fakeAuth();
    const activity = new PlayerActivityService();
    repo = new MemoryPvpRepository();
    wallets = new MemoryShopRepository();
    shop = new ShopService(wallets, auth as any, activity);
    pvp = new PvpService(repo, auth as any, activity, shop);
    await shop.onModuleInit();
    await pvp.onModuleInit();
    actors = Object.fromEntries(
      [...auth.users.values()].map((user) => [
        user.id,
        {
          user: clone(user),
          clientId: `revive-client-${user.id}`,
          socketId: `revive-socket-${user.id}`,
          token: `test-user-${user.id}`,
        },
      ]),
    ) as any;
    for (const actor of Object.values(actors)) {
      shop.connect(actor);
      pvp.connect(actor);
    }
    for (const id of [2, 3]) {
      await shop.presence(actors[id], { ready: true, localBattle: false });
      wallets.rows.get(id).items = {
        'max-revive': 2,
        'rare-candy': 2,
        'full-restore': 2,
      };
    }
  });
  async function start(mode: 'pvp' | 'trainer' = 'pvp') {
    battle = await pvp.create(actors[1], {
      commandId: 'revive-battle',
      playerAId: 2,
      ...(mode === 'pvp'
        ? { playerBId: 3 }
        : { trainerPresetId: 'kanto-brock' }),
    });
    for (const id of mode === 'pvp' ? [2, 3] : [2]) {
      const snap = snapshot(battle, id, actors[id].clientId);
      const reserve = capture('fainted-reserve');
      reserve.captureId = 'revive-reserve';
      reserve.pokemon.stats[0].value = 0;
      reserve.moves[0].currentPp = 4;
      snap.pokemons.push(reserve);
      snap.baseHash = digest(snap.pokemons);
      await pvp.snapshot(actors[id], { snapshot: snap });
    }
    battle = await repo.get(battle.battleId);
    battle = await pvp.checkpoint(actors[1], {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: 0,
      session: session(battle),
      processedCommandIds: [],
    });
  }
  const command = (
    item = 'max-revive',
    captureId = 'revive-reserve',
    extras = {},
  ) => ({
    battleId: battle.battleId,
    commandId: 'revive-command',
    side: 'a',
    requestKey: requestKey(battle.session, 'a'),
    choice: { kind: 'item', item, captureId, ...extras },
  });
  function resolved(queued: Battle) {
    const next = clone(queued.session);
    next.teams.a.pokemons.find(
      (mon: any) => mon.captureId === 'revive-reserve',
    ).pokemon.stats[0].value = 91;
    next.networkItems = { pending: {}, used: ['revive-command'] };
    next.runtime.serial++;
    next.runtime.pending = {};
    return {
      battleId: battle.battleId,
      hostEpoch: 1,
      expectedCheckpointRevision: queued.checkpointRevision,
      session: next,
      processedCommandIds: ['revive-command'],
    };
  }
  it.each(['pvp', 'trainer'] as const)(
    'rejects a new Full Restore on a fainted reserve in %s without reserving a command or spending stock, while allowing a living target',
    async (mode) => {
      await start(mode);
      const original = await repo.get(battle.battleId);
      await expect(
        pvp.command(actors[1], command('full-restore')),
      ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
      expect(await repo.get(battle.battleId)).toEqual(original);
      expect((await wallets.get(2)).items).toMatchObject({
        'full-restore': 2,
        'max-revive': 2,
      });
      expect((await wallets.get(2)).battleUses ?? []).toEqual([]);
      const queued = await pvp.command(
        actors[1],
        command('full-restore', battle.session.teams.a.activeCaptureId),
      );
      expect(queued.commands[0].inventoryAuthorized).toBe(true);
      expect(queued.lockHeld).toBe(true);
      expect((await wallets.get(2)).items['full-restore']).toBe(2);
    },
  );
  it.each(['pvp', 'trainer'] as const)(
    'revives a fainted reserve in %s only when its authorized effect is saved and never debits a replay twice',
    async (mode) => {
      await start(mode);
      const original = clone(battle.session.teams.a.pokemons[1]);
      const queued = await pvp.command(actors[1], command());
      expect(queued.commands[0].inventoryAuthorized).toBe(true);
      expect((await shop.battleItemStock(2))['max-revive']).toBe(2);
      const payload = resolved(queued);
      const saved = await pvp.checkpoint(actors[1], payload);
      const revived = saved.session.teams.a.pokemons[1];
      expect(revived.pokemon.stats[0].value).toBe(91);
      expect(revived.moves).toEqual(original.moves);
      expect(revived.statuses).toEqual(original.statuses);
      expect(revived.pokemon.battleStages).toEqual(
        original.pokemon.battleStages,
      );
      expect(saved.itemInventory.a['max-revive']).toBe(1);
      expect(saved.inventory.a).toBe(2);
      expect((await shop.battleItemStock(2))['max-revive']).toBe(1);
      expect((await wallets.get(2)).items['rare-candy']).toBe(2);
      await pvp.checkpoint(actors[1], payload);
      expect((await wallets.get(2)).battleUses).toHaveLength(1);
      expect((await wallets.get(2)).balance).toBe(500);
    },
  );
  it('rejects a living target, move selectors, Rare Candy and forced replacements without spending inventory', async () => {
    await start();
    await expect(
      pvp.command(
        actors[1],
        command('max-revive', battle.session.teams.a.activeCaptureId),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
    await expect(
      pvp.command(
        actors[1],
        command('max-revive', 'revive-reserve', { moveId: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
    await expect(
      pvp.command(actors[1], command('rare-candy')),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
    const forced = clone(battle);
    forced.session.runtime.requests.a.forceSwitch = true;
    forced.revision++;
    await repo.compareAndSwap(forced, battle.revision);
    battle = forced;
    await expect(pvp.command(actors[1], command())).rejects.toMatchObject({
      code: 'INVALID_CHOICE',
    });
    expect((await wallets.get(2)).items).toMatchObject({
      'max-revive': 2,
      'rare-candy': 2,
    });
  });
  it('keeps a legacy battle inventory unchanged and treats its missing Max Revive budget as zero', async () => {
    await start();
    const legacy = clone(battle);
    delete legacy.itemInventory.a['max-revive'];
    delete legacy.itemInventory.b['max-revive'];
    legacy.revision++;
    await repo.compareAndSwap(legacy, battle.revision);
    battle = legacy;
    const originalSnapshots = clone(battle.players);
    const sync = await pvp.sync(actors[1], { battleId: battle.battleId });
    expect(sync.state.itemInventory.a).not.toHaveProperty('max-revive');
    expect((await repo.get(battle.battleId)).players).toEqual(
      originalSnapshots,
    );
    await expect(pvp.command(actors[1], command())).rejects.toMatchObject({
      code: 'ITEM_UNAVAILABLE',
    });
    expect((await wallets.get(2)).items['max-revive']).toBe(2);
  });
  it('recovers a Max Revive checkpoint after its wallet debit without repeating either revival or stock consumption', async () => {
    await start();
    const queued = await pvp.command(actors[1], command());
    const payload = resolved(queued);
    const cas = repo.compareAndSwap.bind(repo);
    let interrupted = true;
    repo.compareAndSwap = async (next, revision) => {
      if (
        interrupted &&
        !next.pendingInventoryCheckpoint &&
        next.session?.networkItems?.used?.includes('revive-command')
      ) {
        interrupted = false;
        throw new Error(
          'Max Revive saved wallet before lost checkpoint response',
        );
      }
      return cas(next, revision);
    };
    await expect(pvp.checkpoint(actors[1], payload)).rejects.toThrow(
      'Max Revive saved wallet',
    );
    expect((await wallets.get(2)).items['max-revive']).toBe(1);
    expect(
      (await repo.get(battle.battleId)).pendingInventoryCheckpoint.charges[0],
    ).toMatchObject({ itemId: 'max-revive' });
    const recovered = await pvp.sync(actors[1], { battleId: battle.battleId });
    expect(
      recovered.state.session.teams.a.pokemons[1].pokemon.stats[0].value,
    ).toBe(91);
    expect(recovered.state.itemInventory.a['max-revive']).toBe(1);
    expect((await wallets.get(2)).battleUses).toHaveLength(1);
  });
});
