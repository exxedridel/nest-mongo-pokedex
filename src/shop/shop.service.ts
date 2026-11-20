import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthIdentityService } from '../messages/auth-identity.service';
import { PlayerActivityService } from '../messages/player-activity.service';
import { Actor } from '../pvp/pvp.types';
import { digest } from '../pvp/pvp.validation';
import { SHOP_REPOSITORY, ShopRepository } from './shop.repository';
import { ShopCatalogService } from './shop-catalog.service';
import { MemoryShopCatalogRepository } from './shop-catalog.repository';
import {
  CombatReward,
  GYM_REWARD_BADGES,
  LOCAL_TRAINER_REWARDS,
  LOCAL_TRAINER_PENALTIES,
  LocalTrainerRewardClaim,
  trainerPresetReward,
  trainerPresetPenalty,
} from './combat-rewards';
import {
  clone,
  BALL_ITEM_IDS,
  BalanceAdjustment,
  CenterHeal,
  CenterPreview,
  centerView,
  CONSUMABLE_ITEM_IDS,
  ConsumableItemId,
  ConsumptionOperation,
  fail,
  GameReset,
  ItemUse,
  Purchase,
  purchaseView,
  resetView,
  SHOP_CATALOG,
  ShopActor,
  ShopItemId,
  ShopPlayer,
  ShopState,
  StoredPurchase,
  useView,
  USABLE_ITEM_IDS,
  UsableItemId,
  WalletRecord,
  walletView,
} from './shop.types';

function object(value: any, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('INVALID_INPUT', 'Datos de tienda no válidos.');
}
function integer(value: any, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID_INPUT', 'Cantidad o revisión no válida.');
}
function id(value: any) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    fail('INVALID_INPUT', 'Identificador de tienda no válido.');
}
function visiblePurchases(purchases: StoredPurchase[], requestId?: string) {
  const recent = new Set(purchases.slice(-50));
  return purchases
    .filter(
      (entry) =>
        entry.status === 'pending' ||
        recent.has(entry) ||
        entry.requestId === requestId,
    )
    .map(purchaseView);
}

@Injectable()
export class ShopService implements OnModuleInit {
  readonly actors = new Map<string, ShopActor>();
  private prepareHandler?: (
    actor: ShopActor,
    request: {
      requestId: string;
      playerUserId: number;
      clientId: string;
      expectedWalletRevision: number;
      operation?: 'balance-adjustment' | 'gift';
      adminUserId?: number;
      itemId?: ShopItemId;
      quantity?: number;
    },
  ) => Promise<{
    ok: boolean;
    revision?: number;
    operation?: 'balance-adjustment' | 'gift';
    error?: { message?: string };
  }>;
  private centerSnapshotHandler?: (
    actor: ShopActor,
    request: { playerUserId: number; clientId: string },
  ) => Promise<{ ok: boolean; preview?: CenterPreview }>;
  private centerPrepareHandler?: (
    actor: ShopActor,
    request: {
      requestId: string;
      playerUserId: number;
      clientId: string;
      adminUserId: number;
      partyHash: string;
      partyRevision: number;
      captureIds: string[];
      centerRevision: number;
    },
  ) => Promise<{
    ok: boolean;
    operation?: 'center-heal';
    planHash?: string;
    partyHash?: string;
    partyRevision?: number;
  }>;
  constructor(
    @Inject(SHOP_REPOSITORY) readonly repository: ShopRepository,
    private readonly auth: AuthIdentityService,
    private readonly activity: PlayerActivityService,
    @Optional()
    readonly catalog: ShopCatalogService = new ShopCatalogService(
      new MemoryShopCatalogRepository(),
    ),
  ) {}
  async onModuleInit() {
    await this.repository.ready();
    await this.catalog.onModuleInit();
    this.activity.register('shop', async (userIds) => {
      const rows = await Promise.all(
        userIds.map((userId) => this.repository.get(userId)),
      );
      return rows
        .filter(
          (row) =>
            row?.purchases.some((purchase) => purchase.status === 'pending') ||
            row?.resets?.some((reset) => reset.status === 'pending') ||
            row?.uses?.some((use) => use.status === 'pending') ||
            row?.adjustments?.some(
              (adjustment) => adjustment.status === 'pending',
            ) ||
            row?.centerHeals?.some((receipt) => receipt.status === 'pending'),
        )
        .map((row) => row.userId);
    });
    this.activity.register('consumption-queue', async (userIds) => {
      const requested = new Set(userIds);
      return [...this.actors.values()]
        .filter(
          (actor) => requested.has(actor.user.id) && actor.pendingConsumption,
        )
        .map((actor) => actor.user.id);
    });
  }
  async fullRestoreStock(userId: number): Promise<number> {
    return (await this.repository.get(userId))?.items['full-restore'] ?? 0;
  }
  async battleItemStock(
    userId: number,
  ): Promise<Partial<Record<ConsumableItemId, number>>> {
    const row = await this.repository.get(userId);
    return Object.fromEntries(
      CONSUMABLE_ITEM_IDS.map((itemId) => [itemId, row?.items[itemId] ?? 0]),
    );
  }
  /** Called only for a durable, authorized battle checkpoint outbox. */
  async consumeBattleFullRestore(
    userId: number,
    battleId: string,
    commandId: string,
  ) {
    return this.consumeBattleItem(userId, battleId, commandId, 'full-restore');
  }
  async consumeBattleItem(
    userId: number,
    battleId: string,
    commandId: string,
    itemId: ConsumableItemId,
    moveId?: number,
  ) {
    if (
      !CONSUMABLE_ITEM_IDS.includes(itemId) ||
      (itemId === 'max-ether'
        ? !Number.isSafeInteger(moveId) || moveId < 1 || moveId > 354
        : moveId !== undefined)
    )
      fail('INVALID_INPUT', 'Objeto o movimiento no válido.');
    const key = digest([battleId, commandId]);
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await this.repository.get(userId);
      if (!row)
        fail('INVENTORY_UNAVAILABLE', 'No se encontró la Bag del jugador.');
      const replay = row.battleUses?.find((use) => use.key === key);
      if (replay) {
        if (
          (replay.itemId ?? 'full-restore') !== itemId ||
          replay.moveId !== moveId
        )
          fail('REQUEST_CONFLICT', 'La acción ya corresponde a otro consumo.');
        return;
      }
      if ((row.items[itemId] ?? 0) < 1)
        fail(
          'INSUFFICIENT_ITEMS',
          'No quedan existencias del objeto para completar esta acción.',
        );
      const previous = row.storageRevision;
      row.items[itemId]--;
      row.revision++;
      row.storageRevision++;
      (row.battleUses ??= []).push({
        key,
        battleId,
        commandId,
        itemId,
        ...(moveId === undefined ? {} : { moveId }),
      });
      if (!(await this.repository.compareAndSwap(row, previous))) continue;
      this.activity.changed();
      return;
    }
    fail('WALLET_CONFLICT', 'No se pudo confirmar el consumo del objeto.');
  }
  connect(actor: Actor) {
    const previous = this.actors.get(actor.socketId);
    this.actors.set(actor.socketId, {
      ...actor,
      ready: previous?.ready ?? false,
      localBattle: previous?.localBattle ?? false,
      supportsBalanceAdjustments: previous?.supportsBalanceAdjustments ?? false,
      supportsCenterHealing: previous?.supportsCenterHealing ?? false,
      supportsItemGifts: previous?.supportsItemGifts ?? false,
      supportsBackgroundItemUses: previous?.supportsBackgroundItemUses ?? false,
      pendingConsumption: previous?.pendingConsumption ?? false,
    });
  }
  disconnect(socketId: string) {
    this.actors.delete(socketId);
  }
  setPrepareHandler(handler: typeof this.prepareHandler) {
    this.prepareHandler = handler;
  }
  setCenterSnapshotHandler(handler: typeof this.centerSnapshotHandler) {
    this.centerSnapshotHandler = handler;
  }
  setCenterPrepareHandler(handler: typeof this.centerPrepareHandler) {
    this.centerPrepareHandler = handler;
  }
  private current(userId: number): ShopActor | undefined {
    return [...this.actors.values()]
      .reverse()
      .find((actor) => actor.user.id === userId);
  }
  private self(actor: Actor) {
    if (this.actors.get(actor.socketId)?.user.id !== actor.user.id)
      fail('SESSION_CHANGED', 'Reconecta la sesión de tienda para continuar.');
  }
  private admin(actor: Actor) {
    this.self(actor);
    if (actor.user.role !== 'admin')
      fail('ADMIN_REQUIRED', 'Sólo el administrador puede confirmar compras.');
  }
  private async ensureWallet(userId: number): Promise<WalletRecord> {
    let row = await this.repository.get(userId);
    if (row) return row;
    const initial: WalletRecord = {
      userId,
      currencyVersion: 1,
      balance: 500,
      revision: 0,
      storageRevision: 0,
      items: {},
      purchases: [],
      resets: [],
      uses: [],
    };
    if (await this.repository.insert(initial)) {
      this.activity.changed();
      return initial;
    }
    row = await this.repository.get(userId);
    if (!row)
      fail('SHOP_UNAVAILABLE', 'No se pudo preparar la cuenta de Pokedollars.');
    return row;
  }
  async presence(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, [
      'ready',
      'localBattle',
      'supportsBalanceAdjustments',
      'supportsCenterHealing',
      'supportsItemGifts',
      'supportsBackgroundItemUses',
      'pendingConsumption',
    ]);
    if (
      typeof payload.ready !== 'boolean' ||
      typeof payload.localBattle !== 'boolean' ||
      (payload.supportsBalanceAdjustments !== undefined &&
        typeof payload.supportsBalanceAdjustments !== 'boolean') ||
      (payload.supportsCenterHealing !== undefined &&
        typeof payload.supportsCenterHealing !== 'boolean') ||
      (payload.supportsItemGifts !== undefined &&
        typeof payload.supportsItemGifts !== 'boolean') ||
      (payload.supportsBackgroundItemUses !== undefined &&
        typeof payload.supportsBackgroundItemUses !== 'boolean') ||
      (payload.pendingConsumption !== undefined &&
        typeof payload.pendingConsumption !== 'boolean') ||
      (payload.pendingConsumption === true &&
        payload.supportsBackgroundItemUses !== true)
    )
      fail('INVALID_INPUT', 'Estado de conexión de tienda no válido.');
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo un jugador anuncia el estado de su partida.',
      );
    return this.activity.runExclusive([actor.user.id], async () => {
      this.self(actor);
      const current = this.actors.get(actor.socketId);
      current.ready = payload.ready && payload.pendingConsumption !== true;
      current.localBattle = payload.localBattle;
      current.supportsBalanceAdjustments =
        payload.supportsBalanceAdjustments === true;
      current.supportsCenterHealing = payload.supportsCenterHealing === true;
      current.supportsItemGifts = payload.supportsItemGifts === true;
      current.supportsBackgroundItemUses =
        payload.supportsBackgroundItemUses === true;
      current.pendingConsumption = payload.pendingConsumption === true;
      let wallet = await this.ensureWallet(actor.user.id);
      if (
        current.supportsBackgroundItemUses &&
        !wallet.consumptionClients?.some(
          (entry) => entry.clientId === actor.clientId,
        )
      ) {
        for (let attempt = 0; attempt < 20; attempt++) {
          if (
            wallet.consumptionClients?.some(
              (entry) => entry.clientId === actor.clientId,
            )
          )
            break;
          if ((wallet.consumptionClients?.length ?? 0) >= 128)
            fail(
              'CONSUMPTION_CLIENT_LIMIT',
              'Esta cuenta alcanzó el límite de navegadores de inventario.',
            );
          const previous = wallet.storageRevision;
          (wallet.consumptionClients ??= []).push({
            clientId: actor.clientId,
            throughSequence: 0,
          });
          wallet.storageRevision++;
          if (await this.repository.compareAndSwap(wallet, previous)) break;
          wallet = await this.repository.get(actor.user.id);
          if (attempt === 19)
            fail(
              'WALLET_CONFLICT',
              'No se pudo preparar la sincronización del inventario.',
            );
        }
      }
      this.activity.changed();
      return this.state(actor, {});
    });
  }
  async sync(actor: Actor, payload: any = {}): Promise<ShopState> {
    return this.activity.runExclusive([actor.user.id], () =>
      this.state(actor, payload),
    );
  }
  private async state(actor: Actor, payload: any = {}): Promise<ShopState> {
    object(payload, [
      'adjustmentRequestId',
      'centerRequestId',
      'purchaseRequestId',
    ]);
    if (payload.adjustmentRequestId !== undefined)
      id(payload.adjustmentRequestId);
    if (payload.centerRequestId !== undefined) id(payload.centerRequestId);
    if (payload.purchaseRequestId !== undefined) id(payload.purchaseRequestId);
    this.self(actor);
    const catalog = await this.catalog.snapshot();
    if (actor.user.role === 'player') {
      const row = await this.ensureWallet(actor.user.id);
      return {
        catalog,
        ...(payload.centerRequestId &&
        row.centerHeals?.some(
          (entry) => entry.requestId === payload.centerRequestId,
        )
          ? {
              centerHeal: centerView(
                row.centerHeals.find(
                  (entry) => entry.requestId === payload.centerRequestId,
                ),
              ),
            }
          : {}),
        centerHeals: [
          ...(row.centerHeals ?? []).filter(
            (entry) => entry.status === 'pending',
          ),
          ...(row.centerHeals ?? [])
            .filter((entry) => entry.status !== 'pending')
            .slice(-50),
        ].map(centerView),
        ...(payload.adjustmentRequestId &&
        row.adjustments?.some(
          (entry) => entry.requestId === payload.adjustmentRequestId,
        )
          ? {
              adjustment: (() => {
                const {
                  requestHash: _,
                  createdAt: __,
                  ...receipt
                } = row.adjustments.find(
                  (entry) => entry.requestId === payload.adjustmentRequestId,
                );
                return receipt;
              })(),
            }
          : {}),
        wallet: walletView(row, actor.clientId),
        rewards: (row.rewards ?? [])
          .slice(-50)
          .map(({ requestHash: _, ...entry }) => entry),
        purchases: visiblePurchases(
          row.purchases.filter(
            (purchase) =>
              purchase.clientId === actor.clientId ||
              (purchase.kind === 'gift' && purchase.status === 'pending'),
          ),
          payload.purchaseRequestId,
        ),
        // Pending resets are visible to every browser for this account, so an
        // alternate device cannot operate while its original owner saves it.
        resets: [
          ...(row.resets ?? []).filter((reset) => reset.status === 'pending'),
          ...(row.resets ?? [])
            .filter((reset) => reset.status !== 'pending')
            .slice(-50),
        ]
          .sort((left, right) => left.walletRevision - right.walletRevision)
          .map(resetView),
        uses: [
          ...(row.uses ?? []).filter((use) => use.status === 'pending'),
          ...(row.uses ?? [])
            .filter((use) => use.status !== 'pending')
            .slice(-50),
        ].map(useView),
        adjustments: (row.adjustments ?? [])
          .filter((adjustment) => adjustment.status === 'pending')
          .concat(
            (row.adjustments ?? [])
              .filter((adjustment) => adjustment.status !== 'pending')
              .slice(-50),
          )
          .map(
            ({ requestHash: _, createdAt: __, ...adjustment }) => adjustment,
          ),
      };
    }
    this.admin(actor);
    const contacts = await this.auth.contacts(actor.token, actor.user.id);
    const candidates = new Map<number, ShopActor>();
    for (const candidate of this.actors.values())
      if (candidate.user.role === 'player')
        candidates.set(candidate.user.id, candidate);
    const busy = new Set(
      await this.activity.busyUsers([...candidates.keys()], ['battle']),
    );
    const players: ShopPlayer[] = [];
    for (const candidate of candidates.values()) {
      if (
        !contacts.some(
          (user) => user.id === candidate.user.id && user.role === 'player',
        )
      )
        continue;
      let valid: Awaited<ReturnType<AuthIdentityService['authenticate']>>;
      try {
        valid = await this.auth.authenticate(candidate.token);
      } catch (error) {
        if (error?.code === 'AUTH_UNAVAILABLE') throw error;
        this.disconnect(candidate.socketId);
        continue;
      }
      if (valid.user.role !== 'player' || valid.user.id !== candidate.user.id) {
        this.disconnect(candidate.socketId);
        continue;
      }
      const current = this.current(candidate.user.id);
      if (!current || current.socketId !== candidate.socketId) continue;
      const wallet = await this.repository.get(candidate.user.id);
      const pending = !!wallet?.purchases.some(
        (purchase) => purchase.status === 'pending',
      );
      const pendingReset = !!wallet?.resets?.some(
        (reset) => reset.status === 'pending',
      );
      const pendingUse = !!wallet?.uses?.some(
        (use) => use.status === 'pending',
      );
      const pendingAdjustment = !!wallet?.adjustments?.some(
        (adjustment) => adjustment.status === 'pending',
      );
      const pendingCenter = !!wallet?.centerHeals?.some(
        (receipt) => receipt.status === 'pending',
      );
      players.push({
        user: clone(valid.user),
        clientId: candidate.clientId,
        online: true,
        ready: current.ready,
        inBattle: current.localBattle || busy.has(candidate.user.id),
        wallet: wallet ? walletView(wallet, candidate.clientId) : null,
        pending:
          pending ||
          pendingReset ||
          pendingUse ||
          pendingAdjustment ||
          pendingCenter ||
          current.pendingConsumption,
        pendingReset,
        pendingUse,
        pendingAdjustment,
        supportsBalanceAdjustments: current.supportsBalanceAdjustments,
        pendingCenter,
        supportsCenterHealing: current.supportsCenterHealing,
        supportsItemGifts: current.supportsItemGifts,
        supportsBackgroundItemUses: current.supportsBackgroundItemUses,
        pendingConsumption: current.pendingConsumption,
      });
    }
    const rows = await this.repository.forAdmin(actor.user.id);
    const adjustments = rows
      .flatMap((row) => row.adjustments ?? [])
      .filter((adjustment) => adjustment.adminUserId === actor.user.id)
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
    const centerHeals = rows
      .flatMap((row) => row.centerHeals ?? [])
      .filter((entry) => entry.adminUserId === actor.user.id);
    const recentCenterHeals = new Set(
      centerHeals.filter((entry) => entry.status !== 'pending').slice(-50),
    );
    const exactCenterHeal = payload.centerRequestId
      ? centerHeals.find((entry) => entry.requestId === payload.centerRequestId)
      : undefined;
    return {
      catalog,
      players,
      centerHeals: centerHeals
        .filter(
          (entry) => entry.status === 'pending' || recentCenterHeals.has(entry),
        )
        .map(centerView),
      ...(exactCenterHeal ? { centerHeal: centerView(exactCenterHeal) } : {}),
      purchases: visiblePurchases(
        rows
          .flatMap((row) => row.purchases)
          .filter((purchase) => purchase.adminUserId === actor.user.id)
          .sort(
            (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
          ),
        payload.purchaseRequestId,
      ),
      adjustments: [
        ...adjustments.filter((adjustment) => adjustment.status === 'pending'),
        ...adjustments
          .filter((adjustment) => adjustment.status !== 'pending')
          .slice(-50),
      ].map(({ requestHash: _, createdAt: __, ...adjustment }) => adjustment),
    };
  }
  private centerSelection(payload: any) {
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.playerUserId, 1);
    integer(payload.partyRevision);
    if (
      typeof payload.partyHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.partyHash)
    )
      fail('INVALID_INPUT', 'La huella del equipo no es válida.');
    if (
      !Array.isArray(payload.captureIds) ||
      payload.captureIds.length < 1 ||
      payload.captureIds.length > 2 ||
      new Set(payload.captureIds).size !== payload.captureIds.length
    )
      fail(
        'INVALID_INPUT',
        'Elige uno o dos Pokémon distintos para recuperar.',
      );
    payload.captureIds.forEach(id);
  }
  private centerFingerprint(adminUserId: number, payload: any) {
    return digest([
      adminUserId,
      payload.playerUserId,
      payload.clientId,
      payload.partyHash,
      payload.partyRevision,
      payload.captureIds,
    ]);
  }
  private centerOwner(
    userId: number,
    clientId: string,
    ready = true,
  ): ShopActor {
    const owner = this.current(userId);
    if (!owner || owner.clientId !== clientId || owner.user.role !== 'player')
      fail(
        'PLAYER_OFFLINE',
        'Reconecta el navegador original del jugador al Poké Center.',
      );
    if (!owner.supportsCenterHealing)
      fail(
        'PLAYER_UPDATE_REQUIRED',
        'Actualiza y recarga el frontend del jugador para usar Poké Center.',
      );
    if (owner.localBattle)
      fail(
        'PLAYER_IN_BATTLE',
        'El jugador está en batalla. Termínala antes de usar Poké Center.',
      );
    if (ready && !owner.ready)
      fail(
        'PLAYER_NOT_READY',
        'El jugador debe sincronizar su partida antes de usar Poké Center.',
      );
    return owner;
  }
  private async centerIdentity(actor: Actor, owner: ShopActor) {
    this.admin(actor);
    const adminIdentity = await this.auth.authenticate(actor.token);
    if (
      adminIdentity.user.id !== actor.user.id ||
      adminIdentity.user.role !== 'admin'
    )
      fail(
        'ADMIN_REQUIRED',
        'La cuenta ya no tiene permisos de administrador.',
      );
    const contacts = await this.auth.contacts(actor.token, actor.user.id);
    if (
      !contacts.some(
        (user) => user.id === owner.user.id && user.role === 'player',
      )
    )
      fail('INVALID_PLAYER', 'El jugador seleccionado ya no está disponible.');
    const identity = await this.auth.authenticate(owner.token);
    if (identity.user.id !== owner.user.id || identity.user.role !== 'player')
      fail(
        'INVALID_PLAYER',
        'La sesión ya no corresponde a un jugador vigente.',
      );
    this.admin(actor);
  }
  private validCenterPreview(
    value: any,
    userId: number,
    clientId: string,
  ): value is CenterPreview {
    if (
      !value ||
      value.userId !== userId ||
      value.clientId !== clientId ||
      !Number.isSafeInteger(value.partyRevision) ||
      value.partyRevision < 0 ||
      typeof value.partyHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.partyHash) ||
      !Array.isArray(value.pokemons) ||
      value.pokemons.length < 1 ||
      value.pokemons.length > 6
    )
      return false;
    const captures = new Set<string>();
    return value.pokemons.every((pokemon: any) => {
      if (
        !pokemon ||
        typeof pokemon.captureId !== 'string' ||
        !/^[\w.:-]{1,128}$/.test(pokemon.captureId) ||
        captures.has(pokemon.captureId)
      )
        return false;
      captures.add(pokemon.captureId);
      return (
        Number.isSafeInteger(pokemon.pokemonId) &&
        pokemon.pokemonId > 0 &&
        pokemon.pokemonId <= 386 &&
        typeof pokemon.name === 'string' &&
        pokemon.name.length > 0 &&
        pokemon.name.length <= 100 &&
        (pokemon.image === null ||
          (typeof pokemon.image === 'string' &&
            pokemon.image.length <= 2048)) &&
        Number.isSafeInteger(pokemon.level) &&
        pokemon.level >= 1 &&
        pokemon.level <= 100 &&
        Number.isSafeInteger(pokemon.maxHp) &&
        pokemon.maxHp > 0 &&
        pokemon.maxHp <= 1000000 &&
        Number.isSafeInteger(pokemon.currentHp) &&
        pokemon.currentHp >= 0 &&
        pokemon.currentHp <= pokemon.maxHp &&
        typeof pokemon.needsHealing === 'boolean' &&
        Array.isArray(pokemon.statuses) &&
        pokemon.statuses.length <= 32 &&
        pokemon.statuses.every(
          (status: any) => typeof status === 'string' && status.length <= 64,
        ) &&
        Array.isArray(pokemon.moves) &&
        pokemon.moves.length <= 4 &&
        new Set(pokemon.moves.map((move: any) => move?.id)).size ===
          pokemon.moves.length &&
        pokemon.moves.every(
          (move: any) =>
            move &&
            Number.isSafeInteger(move.id) &&
            move.id >= 1 &&
            move.id <= 354 &&
            typeof move.name === 'string' &&
            move.name.length > 0 &&
            move.name.length <= 128 &&
            Number.isSafeInteger(move.maxPp) &&
            move.maxPp >= 0 &&
            move.maxPp <= 100 &&
            Number.isSafeInteger(move.currentPp) &&
            move.currentPp >= 0 &&
            move.currentPp <= move.maxPp,
        )
      );
    });
  }
  async centerPreview(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    object(payload, ['playerUserId', 'clientId']);
    integer(payload.playerUserId, 1);
    id(payload.clientId);
    const preview = await this.activity.runExclusive(
      [payload.playerUserId],
      async () => {
        this.admin(actor);
        await this.activity.assertAvailable([payload.playerUserId]);
        const owner = this.centerOwner(payload.playerUserId, payload.clientId);
        await this.centerIdentity(actor, owner);
        if (!this.centerSnapshotHandler)
          fail(
            'CENTER_UNAVAILABLE',
            'No se pudo solicitar el equipo del jugador.',
          );
        const response = await this.centerSnapshotHandler(
          owner,
          clone(payload),
        );
        const latest = this.centerOwner(payload.playerUserId, payload.clientId);
        if (
          latest.socketId !== owner.socketId ||
          !response?.ok ||
          !this.validCenterPreview(
            response.preview,
            payload.playerUserId,
            payload.clientId,
          )
        )
          fail(
            'PLAYER_NOT_READY',
            'No se pudo leer el equipo actual. Actualiza y vuelve a seleccionar al jugador.',
          );
        await this.centerIdentity(actor, latest);
        if (
          this.centerOwner(payload.playerUserId, payload.clientId).socketId !==
          owner.socketId
        )
          fail(
            'SESSION_CHANGED',
            'La conexión del jugador cambió al leer su equipo.',
          );
        // Only the validated display summary is returned. No general Party is stored.
        return clone({
          userId: response.preview.userId,
          clientId: response.preview.clientId,
          partyRevision: response.preview.partyRevision,
          partyHash: response.preview.partyHash,
          pokemons: response.preview.pokemons.map((pokemon) => ({
            captureId: pokemon.captureId,
            pokemonId: pokemon.pokemonId,
            name: pokemon.name,
            image: pokemon.image,
            level: pokemon.level,
            currentHp: pokemon.currentHp,
            maxHp: pokemon.maxHp,
            statuses: pokemon.statuses,
            needsHealing: pokemon.needsHealing,
            moves: pokemon.moves.map(({ id, name, currentPp, maxPp }) => ({
              id,
              name,
              currentPp,
              maxPp,
            })),
          })),
        });
      },
    );
    return { centerPreview: preview };
  }
  async centerHeal(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    object(payload, [
      'requestId',
      'playerUserId',
      'clientId',
      'partyHash',
      'partyRevision',
      'captureIds',
    ]);
    this.centerSelection(payload);
    const fingerprint = this.centerFingerprint(actor.user.id, payload);
    const receipt = await this.activity.runExclusive(
      [payload.playerUserId],
      async () => {
        this.admin(actor);
        const prior = (await this.repository.forAdmin(actor.user.id))
          .flatMap((row) => row.centerHeals ?? [])
          .find(
            (entry) =>
              entry.adminUserId === actor.user.id &&
              entry.requestId === payload.requestId,
          );
        if (prior) {
          if (prior.requestHash !== fingerprint)
            fail(
              'REQUEST_CONFLICT',
              'Esta solicitud ya corresponde a otra recuperación.',
            );
          return centerView(prior);
        }
        const row = await this.repository.get(payload.playerUserId);
        if (!row)
          fail(
            'PLAYER_NOT_READY',
            'Sincroniza la partida del jugador antes de recuperar su equipo.',
          );
        if (
          row.centerHeals?.some(
            (entry) => entry.requestId === payload.requestId,
          )
        )
          fail(
            'REQUEST_CONFLICT',
            'Esta solicitud ya pertenece a otra recuperación o administrador.',
          );
        if ((row.centerHeals?.length ?? 0) >= 4096)
          fail(
            'CENTER_HISTORY_FULL',
            'El historial de recuperaciones requiere mantenimiento.',
          );
        await this.activity.assertAvailable([payload.playerUserId]);
        const owner = this.centerOwner(payload.playerUserId, payload.clientId);
        await this.centerIdentity(actor, owner);
        const sequence = (row.centerRevision ?? 0) + 1;
        if (!Number.isSafeInteger(sequence))
          fail(
            'CENTER_CONFLICT',
            'La revisión del Poké Center está fuera de rango.',
          );
        if (!this.centerPrepareHandler)
          fail(
            'CENTER_UNAVAILABLE',
            'No se pudo reservar la recuperación del equipo.',
          );
        const prepared = await this.centerPrepareHandler(owner, {
          ...clone(payload),
          adminUserId: actor.user.id,
          centerRevision: sequence,
        });
        if (
          !prepared?.ok ||
          prepared.operation !== 'center-heal' ||
          prepared.partyHash !== payload.partyHash ||
          prepared.partyRevision !== payload.partyRevision ||
          typeof prepared.planHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(prepared.planHash)
        )
          fail(
            'PLAYER_NOT_READY',
            'El jugador no confirmó la recuperación de su equipo actual.',
          );
        const latest = this.centerOwner(
          payload.playerUserId,
          payload.clientId,
          false,
        );
        if (latest.socketId !== owner.socketId)
          fail(
            'SESSION_CHANGED',
            'La conexión cambió mientras se reservaba la recuperación.',
          );
        await this.centerIdentity(actor, latest);
        if (
          this.centerOwner(payload.playerUserId, payload.clientId, false)
            .socketId !== owner.socketId
        )
          fail(
            'SESSION_CHANGED',
            'Reconecta el navegador que preparó la recuperación.',
          );
        await this.activity.assertAvailable([payload.playerUserId]);
        const receipt: CenterHeal = {
          requestId: payload.requestId,
          adminUserId: actor.user.id,
          userId: payload.playerUserId,
          clientId: payload.clientId,
          captureIds: [...payload.captureIds],
          partyHash: payload.partyHash,
          partyRevision: payload.partyRevision,
          planHash: prepared.planHash,
          centerRevision: sequence,
          status: 'pending',
        };
        const previous = row.storageRevision;
        row.centerRevision = sequence;
        (row.centerHeals ??= []).push({ ...receipt, requestHash: fingerprint });
        row.storageRevision++;
        if (!(await this.repository.compareAndSwap(row, previous)))
          fail(
            'CENTER_CONFLICT',
            'La partida cambió mientras se guardaba la recuperación. Sincroniza para recuperarla.',
          );
        this.activity.changed();
        return receipt;
      },
    );
    return { ...(await this.sync(actor, {})), centerHeal: receipt };
  }
  async centerApplied(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['requestId', 'centerRevision', 'planHash']);
    id(payload.requestId);
    integer(payload.centerRevision, 1);
    if (
      typeof payload.planHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.planHash)
    )
      fail('INVALID_INPUT', 'La huella de recuperación no es válida.');
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el jugador puede confirmar el guardado de su equipo.',
      );
    const receipt = await this.activity.runExclusive(
      [actor.user.id],
      async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          const heal = row?.centerHeals?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (!heal || heal.clientId !== actor.clientId)
            fail(
              'OWNER_REQUIRED',
              'Confirma la recuperación desde su navegador original.',
            );
          if (
            heal.centerRevision !== payload.centerRevision ||
            heal.planHash !== payload.planHash
          )
            fail(
              'CENTER_CONFLICT',
              'El recibo no coincide con la recuperación guardada.',
            );
          if (heal.status !== 'pending') return centerView(heal);
          if (this.current(actor.user.id)?.socketId !== actor.socketId)
            fail(
              'OWNER_REQUIRED',
              'Reconecta el navegador que preparó esta recuperación.',
            );
          const previous = row.storageRevision;
          heal.status = 'applied';
          row.storageRevision++;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return centerView(heal);
        }
        fail('CENTER_CONFLICT', 'No se pudo confirmar el guardado del equipo.');
      },
    );
    return { ...(await this.sync(actor, {})), centerHeal: receipt };
  }
  async centerCancel(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, [
      'requestId',
      'playerUserId',
      'clientId',
      'adminUserId',
      'partyHash',
      'partyRevision',
      'captureIds',
      'planHash',
      'centerRevision',
    ]);
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.playerUserId, 1);
    this.self(actor);
    const receipt = await this.activity.runExclusive(
      [payload.playerUserId],
      async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(payload.playerUserId);
          if (!row)
            fail(
              'PLAYER_NOT_READY',
              'Sincroniza la partida antes de cancelar la recuperación.',
            );
          const heal = row.centerHeals?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (heal) {
            if (
              heal.clientId !== payload.clientId ||
              (actor.user.id !== heal.userId &&
                (actor.user.role !== 'admin' ||
                  actor.user.id !== heal.adminUserId))
            )
              fail(
                'OWNER_REQUIRED',
                'Sólo el jugador o el administrador que inició esta recuperación pueden cancelarla.',
              );
            if (heal.status !== 'pending') return centerView(heal);
            const previous = row.storageRevision;
            heal.status = 'cancelled';
            row.storageRevision++;
            if (!(await this.repository.compareAndSwap(row, previous)))
              continue;
            this.activity.changed();
            return centerView(heal);
          }
          // A persisted PREPARE without a server receipt is closed with an exact
          // tombstone. A late request can never execute it after the lock releases.
          if (
            actor.user.role !== 'player' ||
            actor.user.id !== payload.playerUserId ||
            actor.clientId !== payload.clientId ||
            this.current(actor.user.id)?.socketId !== actor.socketId
          )
            fail(
              'CENTER_NOT_FOUND',
              'La recuperación no se ha confirmado. Reconecta el navegador del jugador para cerrar su reserva.',
            );
          this.centerSelection(payload);
          integer(payload.adminUserId, 1);
          integer(payload.centerRevision, 1);
          if (
            typeof payload.planHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(payload.planHash)
          )
            fail('INVALID_INPUT', 'La huella de recuperación no es válida.');
          if (payload.centerRevision > (row.centerRevision ?? 0) + 1)
            fail(
              'CENTER_CONFLICT',
              'La revisión cambió; sincroniza la recuperación original.',
            );
          if (
            row.centerHeals?.some(
              (entry) =>
                entry.requestId !== payload.requestId &&
                entry.centerRevision === payload.centerRevision &&
                entry.status === 'pending',
            )
          )
            fail(
              'CENTER_CONFLICT',
              'Completa o cancela la otra recuperación pendiente antes de cerrar esta reserva antigua.',
            );
          if ((row.centerHeals?.length ?? 0) >= 4096)
            fail(
              'CENTER_HISTORY_FULL',
              'El historial de recuperaciones requiere mantenimiento.',
            );
          const cancelled: CenterHeal = {
            requestId: payload.requestId,
            adminUserId: payload.adminUserId,
            userId: payload.playerUserId,
            clientId: payload.clientId,
            captureIds: [...payload.captureIds],
            partyHash: payload.partyHash,
            partyRevision: payload.partyRevision,
            planHash: payload.planHash,
            centerRevision: payload.centerRevision,
            status: 'cancelled',
          };
          const previous = row.storageRevision;
          // A failed PREPARE may return after another browser completed a newer
          // request. Its exact historical tombstone still closes the old lock;
          // it never rewinds the monotonic sequence or grants another healing.
          row.centerRevision = Math.max(
            row.centerRevision ?? 0,
            payload.centerRevision,
          );
          (row.centerHeals ??= []).push({
            ...cancelled,
            requestHash: this.centerFingerprint(payload.adminUserId, payload),
          });
          row.storageRevision++;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return cancelled;
        }
        fail(
          'CENTER_CONFLICT',
          'No se pudo cancelar la recuperación. Reintenta con la misma solicitud.',
        );
      },
    );
    return { ...(await this.sync(actor, {})), centerHeal: receipt };
  }
  async purchase(actor: Actor, payload: any): Promise<ShopState> {
    return this.inventoryGrant(actor, payload);
  }
  async gift(actor: Actor, payload: any): Promise<ShopState> {
    return this.inventoryGrant(actor, payload, 'gift');
  }
  async giftCancel(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, [
      'requestId',
      'adminUserId',
      'playerUserId',
      'clientId',
      'itemId',
      'quantity',
      'expectedWalletRevision',
    ]);
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.adminUserId, 1);
    integer(payload.playerUserId, 1);
    integer(payload.quantity, 1, 99);
    integer(payload.expectedWalletRevision);
    if (
      typeof payload.itemId !== 'string' ||
      !Object.prototype.hasOwnProperty.call(SHOP_CATALOG, payload.itemId)
    )
      fail('INVALID_ITEM', 'Ese objeto no está disponible en Poké Mart.');
    const authorize = () => {
      this.self(actor);
      if (actor.user.role === 'admin') {
        this.admin(actor);
        if (actor.user.id !== payload.adminUserId)
          fail('OWNER_REQUIRED', 'El regalo pertenece a otro administrador.');
      } else if (
        actor.user.role !== 'player' ||
        actor.user.id !== payload.playerUserId ||
        actor.clientId !== payload.clientId
      )
        fail(
          'OWNER_REQUIRED',
          'Reconecta el navegador que reservó este regalo.',
        );
    };
    authorize();
    const hash = digest([
      'gift',
      payload.adminUserId,
      payload.playerUserId,
      payload.clientId,
      payload.itemId,
      payload.quantity,
      payload.expectedWalletRevision,
    ]);
    await this.activity.runExclusive([payload.playerUserId], async () => {
      authorize();
      const prior = (await this.repository.forAdmin(payload.adminUserId))
        .flatMap((wallet) => wallet.purchases)
        .find(
          (entry) =>
            entry.requestId === payload.requestId &&
            entry.adminUserId === payload.adminUserId,
        );
      if (prior) {
        if (prior.kind !== 'gift' || prior.requestHash !== hash)
          fail(
            'REQUEST_CONFLICT',
            'Esa solicitud corresponde a otra operación.',
          );
        return;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.repository.get(payload.playerUserId);
        if (!row)
          fail(
            'PLAYER_NOT_READY',
            'Sincroniza la cartera antes de recuperar el regalo.',
          );
        const replay = row.purchases.find(
          (entry) =>
            entry.adminUserId === payload.adminUserId &&
            entry.requestId === payload.requestId,
        );
        if (replay) {
          if (replay.kind !== 'gift' || replay.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'Esa solicitud corresponde a otra operación.',
            );
          return;
        }
        if (row.purchases.length >= 4096)
          fail(
            'PURCHASE_LIMIT',
            'La cuenta alcanzó el límite de historial de esta versión.',
          );
        if (payload.expectedWalletRevision > row.revision)
          fail(
            'WALLET_CONFLICT',
            'La revisión del regalo aún no existe en la cartera.',
          );
        const verified = await this.auth.authenticate(actor.token);
        if (
          verified.user.id !== actor.user.id ||
          verified.user.role !== actor.user.role
        )
          fail('OWNER_REQUIRED', 'La cuenta ya no puede cerrar este regalo.');
        authorize();
        const previous = row.storageRevision;
        row.purchases.push({
          kind: 'gift',
          purchaseId: randomUUID(),
          requestId: payload.requestId,
          adminUserId: payload.adminUserId,
          userId: payload.playerUserId,
          clientId: payload.clientId,
          itemId: payload.itemId,
          quantity: payload.quantity,
          unitPrice: 0,
          total: 0,
          balanceBefore: row.balance,
          balanceAfter: row.balance,
          // A tombstone proves the original intent, even if later transactions
          // already advanced this wallet. No money or inventory was changed.
          walletRevision: payload.expectedWalletRevision,
          status: 'cancelled',
          requestHash: hash,
          createdAt: Date.now(),
        });
        row.storageRevision++;
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'No se pudo cerrar el intento de regalo. Reintenta con la misma solicitud.',
      );
    });
    return this.sync(actor, { purchaseRequestId: payload.requestId });
  }
  private async inventoryGrant(
    actor: Actor,
    payload: any,
    kind?: 'gift',
  ): Promise<ShopState> {
    this.admin(actor);
    object(payload, [
      'requestId',
      'playerUserId',
      'clientId',
      'itemId',
      'quantity',
      'expectedWalletRevision',
      ...(kind === 'gift' ? [] : ['expectedCatalogRevision']),
    ]);
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.playerUserId, 1);
    integer(payload.quantity, 1, 99);
    integer(payload.expectedWalletRevision);
    if (payload.expectedCatalogRevision !== undefined)
      integer(payload.expectedCatalogRevision);
    if (
      typeof payload.itemId !== 'string' ||
      !Object.prototype.hasOwnProperty.call(SHOP_CATALOG, payload.itemId)
    )
      fail('INVALID_ITEM', 'Ese objeto no está disponible en Poké Mart.');
    const itemId = payload.itemId as ShopItemId;
    const fingerprint = [
      actor.user.id,
      payload.playerUserId,
      payload.clientId,
      itemId,
      payload.quantity,
      payload.expectedWalletRevision,
    ];
    if (payload.expectedCatalogRevision !== undefined)
      fingerprint.push(payload.expectedCatalogRevision);
    // Do not change the established purchase fingerprint, even when its price
    // is zero. Gifts have a separate domain and cannot replay as a purchase.
    const hash = digest(
      kind === 'gift' ? ['gift', ...fingerprint] : fingerprint,
    );
    await this.activity.runExclusive([payload.playerUserId], async () => {
      this.admin(actor);
      const prior = (await this.repository.forAdmin(actor.user.id))
        .flatMap((wallet) => wallet.purchases)
        .find(
          (purchase) =>
            purchase.adminUserId === actor.user.id &&
            purchase.requestId === payload.requestId,
        );
      if (prior) {
        if (prior.kind !== kind || prior.requestHash !== hash)
          fail(
            'REQUEST_CONFLICT',
            'Esa solicitud ya corresponde a otra compra.',
          );
        return;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.repository.get(payload.playerUserId);
        if (!row)
          fail(
            'PLAYER_OFFLINE',
            'El jugador todavía no sincroniza sus Pokedollars.',
          );
        const replay = row.purchases.find(
          (purchase) =>
            purchase.requestId === payload.requestId &&
            purchase.adminUserId === actor.user.id,
        );
        if (replay) {
          if (replay.kind !== kind || replay.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'Esa solicitud ya corresponde a otra compra.',
            );
          return;
        }
        const quote =
          kind === 'gift'
            ? undefined
            : await this.catalog.quote(payload.expectedCatalogRevision);
        const unitPrice = kind === 'gift' ? 0 : quote.prices[itemId];
        const total = unitPrice * payload.quantity;
        await this.activity.assertAvailable([payload.playerUserId]);
        const candidate = this.current(payload.playerUserId);
        if (!candidate || candidate.clientId !== payload.clientId)
          fail(
            'PLAYER_OFFLINE',
            'El jugador cambió de conexión. Selecciónalo de nuevo.',
          );
        const identity = await this.auth.authenticate(candidate.token);
        if (
          identity.user.id !== payload.playerUserId ||
          identity.user.role !== 'player'
        )
          fail('INVALID_PLAYER', 'La cuenta seleccionada ya no es un jugador.');
        const latest = this.current(payload.playerUserId);
        if (
          !latest ||
          latest.socketId !== candidate.socketId ||
          latest.clientId !== payload.clientId ||
          !latest.ready
        )
          fail(
            'PLAYER_NOT_READY',
            'Espera a que el jugador conecte y sincronice su partida.',
          );
        if (latest.localBattle)
          fail(
            'PLAYER_IN_BATTLE',
            'El jugador debe terminar su batalla antes de comprar.',
          );
        if (kind === 'gift' && !latest.supportsItemGifts)
          fail(
            'PLAYER_UPDATE_REQUIRED',
            'El jugador debe actualizar su aplicación antes de recibir objetos.',
          );
        if (row.revision !== payload.expectedWalletRevision)
          fail(
            'WALLET_CONFLICT',
            'El saldo cambió. Actualiza y confirma nuevamente la compra.',
          );
        if (row.balance < total)
          fail(
            'INSUFFICIENT_FUNDS',
            'El jugador no tiene suficientes Pokedollars.',
          );
        const currentQuantity = row.items[itemId] ?? 0;
        if (!Number.isSafeInteger(currentQuantity + payload.quantity))
          fail(
            'ITEM_LIMIT',
            'La cantidad de objetos supera el límite permitido.',
          );
        // Never forget an idempotency key. Archiving needs a dedicated migration;
        // safely stop before exceeding Mongo's document limits in this version.
        if (row.purchases.length >= 4096)
          fail(
            'PURCHASE_LIMIT',
            'La cuenta alcanzó el límite de historial de esta versión.',
          );
        if (!this.prepareHandler)
          fail(
            'SHOP_UNAVAILABLE',
            'No se pudo reservar el guardado del jugador.',
          );
        const prepared = await this.prepareHandler(latest, {
          requestId: payload.requestId,
          playerUserId: payload.playerUserId,
          clientId: payload.clientId,
          expectedWalletRevision: payload.expectedWalletRevision,
          ...(kind === 'gift'
            ? {
                operation: 'gift' as const,
                adminUserId: actor.user.id,
                itemId,
                quantity: payload.quantity,
              }
            : {}),
        });
        if (
          !prepared?.ok ||
          prepared.revision !== row.revision ||
          (kind === 'gift' && prepared.operation !== 'gift')
        )
          fail(
            'PLAYER_NOT_READY',
            prepared?.error?.message ??
              'El jugador no pudo reservar su partida para la compra.',
          );
        const owner = this.current(payload.playerUserId);
        if (
          !owner ||
          owner.socketId !== latest.socketId ||
          owner.clientId !== payload.clientId ||
          owner.localBattle
        )
          fail(
            'PLAYER_NOT_READY',
            'El jugador cambió de conexión o entró en batalla antes de confirmar.',
          );
        const [verified, administrator] = await Promise.all([
          this.auth.authenticate(owner.token),
          this.auth.authenticate(actor.token),
        ]);
        this.admin(actor);
        if (
          administrator.user.id !== actor.user.id ||
          administrator.user.role !== 'admin'
        )
          fail('ADMIN_REQUIRED', 'La cuenta ya no puede autorizar compras.');
        if (
          verified.user.id !== payload.playerUserId ||
          verified.user.role !== 'player'
        )
          fail('INVALID_PLAYER', 'La cuenta seleccionada ya no es un jugador.');
        // Authentication is asynchronous: the exact prepared connection may
        // have disappeared or been replaced while MySQL answered. Fence it
        // again immediately before committing the wallet replacement.
        const finalOwner = this.current(payload.playerUserId);
        if (
          !finalOwner ||
          finalOwner.socketId !== owner.socketId ||
          finalOwner.clientId !== payload.clientId ||
          finalOwner.localBattle
        )
          fail(
            'PLAYER_NOT_READY',
            'El jugador cambió de conexión o entró en batalla antes de guardar la compra.',
          );
        const previous = row.storageRevision;
        if (kind === 'gift' && !finalOwner.supportsItemGifts)
          fail(
            'PLAYER_UPDATE_REQUIRED',
            'El jugador cambió su compatibilidad antes de guardar el regalo.',
          );
        const purchase: Purchase = {
          ...(kind === 'gift' ? { kind } : {}),
          purchaseId: randomUUID(),
          requestId: payload.requestId,
          adminUserId: actor.user.id,
          userId: payload.playerUserId,
          clientId: payload.clientId,
          itemId,
          quantity: payload.quantity,
          unitPrice,
          total,
          balanceBefore: row.balance,
          balanceAfter: row.balance - total,
          walletRevision: row.revision + 1,
          status: 'pending',
        };
        row.balance = purchase.balanceAfter;
        row.revision++;
        row.storageRevision++;
        row.items[itemId] = currentQuantity + payload.quantity;
        row.purchases.push({
          ...purchase,
          requestHash: hash,
          createdAt: Date.now(),
        });
        if (
          !(kind === 'gift'
            ? await this.repository.compareAndSwap(row, previous)
            : await this.catalog.commit(quote.revision, () =>
                this.repository.compareAndSwap(row, previous),
              ))
        )
          continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'Otra operación actualizó la cuenta. Sincroniza y reintenta.',
      );
    });
    return this.sync(
      actor,
      kind === 'gift' ? { purchaseRequestId: payload.requestId } : {},
    );
  }
  async priceSet(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    await this.catalog.setPrice(actor.user.id, payload, async () => {
      const verified = await this.auth.authenticate(actor.token);
      this.admin(actor);
      if (verified.user.id !== actor.user.id || verified.user.role !== 'admin')
        fail('ADMIN_REQUIRED', 'La cuenta ya no puede modificar precios.');
    });
    this.activity.changed();
    return this.sync(actor, {});
  }
  async opponentAutomationSet(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    await this.catalog.setOpponentAutomation(
      actor.user.id,
      payload,
      async () => {
        const verified = await this.auth.authenticate(actor.token);
        this.admin(actor);
        if (
          verified.user.id !== actor.user.id ||
          verified.user.role !== 'admin'
        )
          fail(
            'ADMIN_REQUIRED',
            'La cuenta ya no puede modificar el control automático de rivales.',
          );
      },
    );
    this.activity.changed();
    return this.sync(actor, {});
  }
  async captureDifficultySet(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    await this.catalog.setCaptureDifficulty(
      actor.user.id,
      payload,
      async () => {
        const verified = await this.auth.authenticate(actor.token);
        this.admin(actor);
        if (
          verified.user.id !== actor.user.id ||
          verified.user.role !== 'admin'
        )
          fail(
            'ADMIN_REQUIRED',
            'La cuenta ya no puede modificar la dificultad de captura.',
          );
      },
    );
    this.activity.changed();
    return this.sync(actor, {});
  }
  async balanceAdjust(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    object(payload, [
      'requestId',
      'playerUserId',
      'clientId',
      'delta',
      'expectedWalletRevision',
    ]);
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.playerUserId, 1);
    integer(payload.expectedWalletRevision);
    integer(payload.delta, -Number.MAX_SAFE_INTEGER);
    if (payload.delta === 0)
      fail('INVALID_INPUT', 'Indica una cantidad distinta de cero.');
    const hash = digest([
      actor.user.id,
      payload.playerUserId,
      payload.clientId,
      payload.delta,
      payload.expectedWalletRevision,
    ]);
    const view = (
      entry: import('./shop.types').StoredBalanceAdjustment,
    ): BalanceAdjustment => {
      const { requestHash: _, createdAt: __, ...adjustment } = entry;
      return adjustment;
    };
    const adjustment = await this.activity.runExclusive(
      [payload.playerUserId],
      async (): Promise<BalanceAdjustment> => {
        this.admin(actor);
        const prior = (await this.repository.forAdmin(actor.user.id))
          .flatMap((row) => row.adjustments ?? [])
          .find(
            (entry) =>
              entry.adminUserId === actor.user.id &&
              entry.requestId === payload.requestId,
          );
        if (prior) {
          if (prior.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'La solicitud corresponde a otro ajuste de saldo.',
            );
          return view(prior);
        }
        for (let attempt = 0; attempt < 20; attempt++) {
          this.admin(actor);
          const row = await this.repository.get(payload.playerUserId);
          if (!row)
            fail(
              'PLAYER_OFFLINE',
              'El jugador todavía no sincroniza sus Pokedollars.',
            );
          const replay = row.adjustments?.find(
            (entry) =>
              entry.adminUserId === actor.user.id &&
              entry.requestId === payload.requestId,
          );
          if (replay) {
            if (replay.requestHash !== hash)
              fail(
                'REQUEST_CONFLICT',
                'La solicitud corresponde a otro ajuste de saldo.',
              );
            return view(replay);
          }
          await this.activity.assertAvailable([payload.playerUserId]);
          const owner = this.current(payload.playerUserId);
          if (!owner || owner.clientId !== payload.clientId)
            fail(
              'PLAYER_OFFLINE',
              'El jugador cambió de conexión. Selecciónalo nuevamente.',
            );
          if (!owner.ready)
            fail(
              'PLAYER_NOT_READY',
              'Espera a que el jugador sincronice su partida.',
            );
          if (owner.localBattle)
            fail(
              'PLAYER_IN_BATTLE',
              'Termina la batalla antes de ajustar Pokedollars.',
            );
          if (!owner.supportsBalanceAdjustments)
            fail(
              'PLAYER_UPDATE_REQUIRED',
              'El jugador debe actualizar y recargar la aplicación antes de recibir un ajuste de Pokedollars.',
            );
          const [identity, contacts] = await Promise.all([
            this.auth.authenticate(owner.token),
            this.auth.contacts(actor.token, actor.user.id),
          ]);
          if (
            identity.user.id !== payload.playerUserId ||
            identity.user.role !== 'player' ||
            !contacts.some(
              (contact) =>
                contact.id === payload.playerUserId &&
                contact.role === 'player',
            )
          )
            fail(
              'INVALID_PLAYER',
              'La cuenta seleccionada ya no es un jugador vigente.',
            );
          const connected = this.current(payload.playerUserId);
          if (
            !connected ||
            connected.socketId !== owner.socketId ||
            connected.clientId !== payload.clientId ||
            !connected.ready ||
            connected.localBattle
          )
            fail(
              'PLAYER_NOT_READY',
              'La conexión o batalla del jugador cambió.',
            );
          if (row.revision !== payload.expectedWalletRevision)
            fail(
              'WALLET_CONFLICT',
              'El saldo cambió. Actualiza y confirma nuevamente el ajuste.',
            );
          const balanceAfter = row.balance + payload.delta;
          if (balanceAfter < 0)
            fail(
              'INSUFFICIENT_FUNDS',
              'No puedes retirar más Pokedollars de los disponibles.',
            );
          if (!Number.isSafeInteger(balanceAfter))
            fail('BALANCE_LIMIT', 'El saldo supera el límite permitido.');
          if ((row.adjustments?.length ?? 0) >= 4096)
            fail(
              'ADJUSTMENT_LIMIT',
              'Se alcanzó el límite de historial de ajustes de esta cuenta.',
            );
          if (!this.prepareHandler)
            fail(
              'SHOP_UNAVAILABLE',
              'No se pudo reservar el guardado del jugador.',
            );
          const prepared = await this.prepareHandler(connected, {
            requestId: payload.requestId,
            playerUserId: payload.playerUserId,
            clientId: payload.clientId,
            expectedWalletRevision: payload.expectedWalletRevision,
            operation: 'balance-adjustment',
          });
          if (
            !prepared?.ok ||
            prepared.revision !== row.revision ||
            prepared.operation !== 'balance-adjustment'
          )
            fail(
              'PLAYER_NOT_READY',
              prepared?.error?.message ??
                'El jugador no pudo reservar su partida para el ajuste.',
            );
          const [player, administrator] = await Promise.all([
            this.auth.authenticate(owner.token),
            this.auth.authenticate(actor.token),
          ]);
          this.admin(actor);
          if (
            administrator.user.id !== actor.user.id ||
            administrator.user.role !== 'admin'
          )
            fail(
              'ADMIN_REQUIRED',
              'La cuenta ya no puede ajustar Pokedollars.',
            );
          if (
            player.user.id !== payload.playerUserId ||
            player.user.role !== 'player'
          )
            fail('INVALID_PLAYER', 'La cuenta ya no pertenece al jugador.');
          const finalOwner = this.current(payload.playerUserId);
          if (
            !finalOwner ||
            finalOwner.socketId !== connected.socketId ||
            finalOwner.clientId !== payload.clientId ||
            finalOwner.localBattle
          )
            fail(
              'PLAYER_NOT_READY',
              'El jugador cambió de conexión o entró en batalla antes de guardar el ajuste.',
            );
          if (!finalOwner.supportsBalanceAdjustments)
            fail(
              'PLAYER_UPDATE_REQUIRED',
              'El jugador debe actualizar y recargar la aplicación para confirmar el ajuste.',
            );
          const previous = row.storageRevision;
          const receipt: BalanceAdjustment = {
            adjustmentId: randomUUID(),
            requestId: payload.requestId,
            adminUserId: actor.user.id,
            userId: payload.playerUserId,
            clientId: payload.clientId,
            delta: payload.delta,
            balanceBefore: row.balance,
            balanceAfter,
            walletRevision: row.revision + 1,
            status: 'pending',
          };
          row.balance = balanceAfter;
          row.revision++;
          row.storageRevision++;
          (row.adjustments ??= []).push({
            ...receipt,
            requestHash: hash,
            createdAt: Date.now(),
          });
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return receipt;
        }
        fail(
          'WALLET_CONFLICT',
          'Otra operación actualizó el saldo. Sincroniza y reintenta.',
        );
      },
    );
    return { ...(await this.sync(actor, {})), adjustment };
  }
  async balanceApplied(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['adjustmentId', 'revision']);
    id(payload.adjustmentId);
    integer(payload.revision, 1);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el propietario puede confirmar el guardado.',
      );
    const adjustment = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<BalanceAdjustment> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          const receipt = row?.adjustments?.find(
            (entry) => entry.adjustmentId === payload.adjustmentId,
          );
          if (
            !receipt ||
            receipt.userId !== actor.user.id ||
            receipt.clientId !== actor.clientId
          )
            fail(
              'OWNER_REQUIRED',
              'El ajuste pertenece al navegador original de otro jugador.',
            );
          if (receipt.walletRevision !== payload.revision)
            fail(
              'WALLET_CONFLICT',
              'La revisión no corresponde al ajuste de Pokedollars.',
            );
          const { requestHash: _, createdAt: __, ...view } = receipt;
          if (receipt.status !== 'pending') return view;
          const owner = this.current(actor.user.id);
          if (
            !owner ||
            owner.socketId !== actor.socketId ||
            owner.clientId !== receipt.clientId
          )
            fail(
              'OWNER_REQUIRED',
              'Reconecta el navegador que recibió el ajuste.',
            );
          const previous = row.storageRevision;
          receipt.status = 'applied';
          row.storageRevision++;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return { ...view, status: 'applied' };
        }
        fail('WALLET_CONFLICT', 'No se pudo confirmar el guardado del ajuste.');
      },
    );
    return { ...(await this.sync(actor, {})), adjustment };
  }
  async balanceAbort(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['adjustmentId']);
    id(payload.adjustmentId);
    this.self(actor);
    const rows =
      actor.user.role === 'admin'
        ? await this.repository.forAdmin(actor.user.id)
        : [await this.repository.get(actor.user.id)];
    const known = rows
      .filter(Boolean)
      .flatMap((row) => row.adjustments ?? [])
      .find((entry) => entry.adjustmentId === payload.adjustmentId);
    if (
      !known ||
      (actor.user.role === 'admin'
        ? known.adminUserId !== actor.user.id
        : known.userId !== actor.user.id)
    )
      fail(
        'OWNER_REQUIRED',
        'Sólo el jugador afectado o el administrador que inició el ajuste puede abortarlo.',
      );
    const adjustment = await this.activity.runExclusive(
      [known.userId],
      async (): Promise<BalanceAdjustment> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(known.userId);
          const receipt = row?.adjustments?.find(
            (entry) => entry.adjustmentId === payload.adjustmentId,
          );
          if (
            !receipt ||
            (actor.user.role === 'admin'
              ? receipt.adminUserId !== actor.user.id
              : receipt.userId !== actor.user.id)
          )
            fail('OWNER_REQUIRED', 'El ajuste no pertenece a esta cuenta.');
          const { requestHash: _, createdAt: __, ...view } = receipt;
          if (receipt.status !== 'pending') return view;
          if (
            row.revision !== receipt.walletRevision ||
            row.balance !== receipt.balanceAfter
          )
            fail(
              'BALANCE_CONFLICT',
              'El saldo cambió después del ajuste. Recupera su estado antes de abortarlo.',
            );
          if (!Number.isSafeInteger(row.revision + 1))
            fail(
              'BALANCE_LIMIT',
              'No se puede registrar otra revisión de saldo.',
            );
          // Revalidate the requesting account after the asynchronous read. The
          // player need not be on the original browser to request this escape.
          const identity = await this.auth.authenticate(actor.token);
          this.self(actor);
          if (
            identity.user.id !== actor.user.id ||
            identity.user.role !== actor.user.role
          )
            fail(
              actor.user.role === 'admin' ? 'ADMIN_REQUIRED' : 'OWNER_REQUIRED',
              'La cuenta ya no puede abortar este ajuste.',
            );
          const previous = row.storageRevision;
          row.balance = receipt.balanceBefore;
          row.revision++;
          row.storageRevision++;
          receipt.status = 'cancelled';
          receipt.cancelledWalletRevision = row.revision;
          receipt.cancelledBalance = row.balance;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return {
            ...view,
            status: 'cancelled',
            cancelledWalletRevision: row.revision,
            cancelledBalance: row.balance,
          };
        }
        fail(
          'WALLET_CONFLICT',
          'No se pudo abortar el ajuste. Sincroniza y reintenta la misma operación.',
        );
      },
    );
    return { ...(await this.sync(actor, {})), adjustment };
  }
  async applied(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['purchaseId', 'revision']);
    id(payload.purchaseId);
    integer(payload.revision, 1);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el propietario puede confirmar el guardado.',
      );
    await this.activity.runExclusive([actor.user.id], async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.repository.get(actor.user.id);
        const purchase = row?.purchases.find(
          (entry) => entry.purchaseId === payload.purchaseId,
        );
        if (
          !purchase ||
          purchase.userId !== actor.user.id ||
          purchase.clientId !== actor.clientId
        )
          fail(
            'OWNER_REQUIRED',
            'Esta compra pertenece al navegador original de otro jugador.',
          );
        if (purchase.walletRevision !== payload.revision)
          fail(
            'WALLET_CONFLICT',
            'La confirmación no corresponde a la revisión de la compra.',
          );
        if (purchase.status === 'applied' || purchase.status === 'cancelled')
          return;
        const current = this.current(actor.user.id);
        if (
          !current ||
          current.socketId !== actor.socketId ||
          current.clientId !== purchase.clientId
        )
          fail(
            'OWNER_REQUIRED',
            'Reconecta el navegador que recibió la compra.',
          );
        const previous = row.storageRevision;
        purchase.status = 'applied';
        row.storageRevision++;
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'No se pudo confirmar el guardado. Sincroniza y reintenta.',
      );
    });
    return this.sync(actor, {});
  }

  private itemUseRequest(actor: Actor, payload: any): string {
    object(payload, [
      'requestId',
      'captureId',
      'context',
      'planHash',
      'expectedWalletRevision',
      'itemId',
      'moveId',
      'expectedCaptureRevision',
    ]);
    id(payload.requestId);
    id(payload.captureId);
    integer(payload.expectedWalletRevision);
    const itemId =
      payload.itemId === undefined ? 'full-restore' : payload.itemId;
    if (!USABLE_ITEM_IDS.includes(itemId))
      fail('INVALID_INPUT', 'Objeto no disponible para usar.');
    if (itemId === 'max-ether' || itemId === 'tm')
      integer(payload.moveId, 1, 354);
    else if (payload.moveId !== undefined)
      fail('INVALID_INPUT', 'Este objeto no admite un movimiento objetivo.');
    if (
      !['party', 'local-battle'].includes(payload.context) ||
      typeof payload.planHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.planHash)
    )
      fail('INVALID_INPUT', 'El plan de uso del objeto no es válido.');
    if (itemId === 'tm' && payload.context !== 'party')
      fail('PLAYER_IN_BATTLE', 'Las TM sólo se pueden usar fuera de combate.');
    if (BALL_ITEM_IDS.includes(itemId) && payload.context !== 'local-battle')
      fail(
        'PLAYER_IN_BATTLE',
        'Las pokebolas sólo se pueden lanzar en un encuentro salvaje local.',
      );
    if (payload.expectedCaptureRevision !== undefined) {
      if (!BALL_ITEM_IDS.includes(itemId))
        fail(
          'INVALID_INPUT',
          'Sólo una pokebola puede confirmar una revisión de captura.',
        );
      integer(payload.expectedCaptureRevision);
    }
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el jugador puede usar objetos de su propia Bag.',
      );
    const content = [
      actor.user.id,
      actor.clientId,
      payload.captureId,
      payload.context,
      payload.planHash,
      payload.expectedWalletRevision,
    ];
    // Keep the exact original Full Restore fingerprint for pending legacy uses.
    if (itemId !== 'full-restore') content.push(itemId, payload.moveId ?? null);
    if (payload.expectedCaptureRevision !== undefined)
      content.push('capture-settings', payload.expectedCaptureRevision);
    return digest(content);
  }
  private itemUseOwner(actor: Actor, context: ItemUse['context']) {
    this.self(actor);
    const owner = this.current(actor.user.id);
    if (
      !owner ||
      owner.socketId !== actor.socketId ||
      owner.clientId !== actor.clientId
    )
      fail(
        'OWNER_REQUIRED',
        'Reconecta este navegador antes de usar el objeto.',
      );
    if ((context === 'local-battle') !== owner.localBattle)
      fail(
        'PLAYER_IN_BATTLE',
        context === 'party'
          ? 'Usa la acción de objeto del combate mientras estás en batalla.'
          : 'La batalla local cambió; vuelve a preparar el uso del objeto.',
      );
  }
  private consumptionOperations(payload: any): ConsumptionOperation[] {
    object(payload, ['clientId', 'operations']);
    id(payload.clientId);
    if (
      !Array.isArray(payload.operations) ||
      payload.operations.length < 1 ||
      payload.operations.length > 100
    )
      fail('INVALID_INPUT', 'Envía entre uno y cien consumos locales.');
    const ids = new Set<string>();
    let previous: number | undefined;
    return payload.operations.map((operation: any) => {
      object(operation, [
        'operationId',
        'sequence',
        'itemId',
        'quantity',
        'captureId',
        'context',
        'moveId',
      ]);
      id(operation.operationId);
      id(operation.captureId);
      integer(operation.sequence, 1);
      if (
        operation.quantity !== 1 ||
        !USABLE_ITEM_IDS.includes(operation.itemId) ||
        !['party', 'local-battle'].includes(operation.context) ||
        ids.has(operation.operationId) ||
        (previous !== undefined && operation.sequence !== previous + 1)
      )
        fail(
          'INVALID_INPUT',
          'El lote de consumos no tiene una secuencia válida.',
        );
      if (operation.itemId === 'max-ether' || operation.itemId === 'tm')
        integer(operation.moveId, 1, 354);
      else if (operation.moveId !== undefined)
        fail('INVALID_INPUT', 'Este objeto no admite un movimiento objetivo.');
      if (
        (operation.itemId === 'tm' && operation.context !== 'party') ||
        (BALL_ITEM_IDS.includes(operation.itemId) &&
          operation.context !== 'local-battle')
      )
        fail('INVALID_INPUT', 'El contexto del objeto no es válido.');
      ids.add(operation.operationId);
      previous = operation.sequence;
      return clone(operation);
    });
  }
  private consumptionSession(actor: Actor, row: WalletRecord) {
    this.self(actor);
    if (actor.user.role !== 'player')
      fail('PLAYER_REQUIRED', 'Sólo el jugador sincroniza sus consumos.');
    const connected = this.actors.get(actor.socketId);
    if (!connected?.supportsBackgroundItemUses)
      fail(
        'PLAYER_UPDATE_REQUIRED',
        'Reconecta la app actualizada antes de sincronizar la Bag.',
      );
    if (
      !row.consumptionClients?.some(
        (entry) => entry.clientId === actor.clientId,
      )
    )
      fail(
        'PLAYER_NOT_READY',
        'Anuncia la conexión de este navegador antes de sincronizar consumos.',
      );
  }
  /** The local effect is already durable. This only settles stock, never
   * executes a move, checks an effect, or requires an application ACK. */
  /** Credits use the existing wallet CAS, so concurrent purchases or resets can
   * never overwrite the result. The caller owns the shared activity queue. */
  private async commitCombatRewards(
    userId: number,
    requested: Omit<CombatReward, 'walletRevision' | 'status' | 'reason'>[],
  ): Promise<CombatReward[]> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await this.ensureWallet(userId);
      const previous = row.storageRevision;
      const receipts: CombatReward[] = [];
      let changed = false;
      for (const request of requested) {
        const penalty = request.penaltyVersion === 1;
        const nominalAmount = penalty ? Number(request.nominalAmount) : 0;
        if (
          penalty &&
          (!Number.isSafeInteger(nominalAmount) ||
            nominalAmount < 0 ||
            request.amount !== nominalAmount ||
            request.rewardBundleVersion !== undefined ||
            request.items ||
            request.badgeId)
        )
          fail(
            'INVALID_INPUT',
            'La penalización debe conservar su tarifa y no incluir premios.',
          );
        // The hash binds the fixed intent and nominal tariff, never the current
        // balance or actual clamped debit. Historical win hashes stay unchanged.
        const requestHash = digest([
          penalty ? 'combat-penalty-v1' : 'combat-reward-v1',
          request,
        ]);
        const prior = (row.rewards ?? []).find(
          (entry) => entry.rewardId === request.rewardId,
        );
        if (prior) {
          const sameSubject = (entry: CombatReward) =>
            digest([
              entry.rewardId,
              entry.userId,
              entry.source,
              entry.encounterId ?? null,
              entry.battleId ?? null,
              entry.epoch,
              entry.color ?? null,
              entry.presetId ?? null,
            ]);
          const contraryOutcome = (prior.penaltyVersion === 1) !== penalty;
          if (
            prior.requestHash !== requestHash &&
            (!contraryOutcome ||
              sameSubject(prior) !== sameSubject(request as CombatReward))
          )
            fail(
              'REQUEST_CONFLICT',
              'Esta recompensa ya corresponde a otro encuentro.',
            );
          const { requestHash: _, ...receipt } = prior;
          receipts.push(receipt);
          continue;
        }
        if ((row.rewards?.length ?? 0) >= 8192)
          fail(
            'REWARD_HISTORY_FULL',
            'El historial de recompensas requiere mantenimiento.',
          );
        const stale = request.epoch !== (row.rewardEpoch ?? 0);
        const balanceBefore = row.balance;
        const amount = stale
          ? 0
          : penalty
            ? Math.min(row.balance, nominalAmount)
            : request.amount;
        if (
          !stale &&
          (await this.activity.busyUsers([userId], ['shop'])).length
        )
          fail(
            'PLAYER_BUSY',
            'La recompensa se confirmará al terminar la operación pendiente.',
          );
        if (
          !stale &&
          (!Number.isSafeInteger(row.balance + (penalty ? -amount : amount)) ||
            !Number.isSafeInteger(row.revision + 1))
        )
          fail(
            'WALLET_CONFLICT',
            'El saldo o la revisión está fuera de rango.',
          );
        const grants = Object.entries(request.items ?? {}) as [
          'tm' | 'great-ball',
          number,
        ][];
        if (!stale)
          for (const [itemId, quantity] of grants)
            if (!Number.isSafeInteger((row.items[itemId] ?? 0) + quantity))
              fail(
                'WALLET_CONFLICT',
                'Las existencias del objeto de recompensa están fuera de rango.',
              );
        if (!stale && (amount > 0 || request.items || request.badgeId)) {
          row.balance += penalty ? -amount : amount;
          for (const [itemId, quantity] of grants)
            row.items[itemId] = (row.items[itemId] ?? 0) + quantity;
          if (request.badgeId && !row.badges?.includes(request.badgeId))
            (row.badges ??= []).push(request.badgeId);
          row.revision++;
        }
        const { badgeId, items, ...visibleRequest } = request;
        const receipt: CombatReward = {
          ...visibleRequest,
          ...(!stale && badgeId ? { badgeId } : {}),
          ...(!stale && items ? { items } : {}),
          amount,
          status: stale ? 'rejected' : penalty ? 'debited' : 'credited',
          ...(penalty ? { balanceBefore, balanceAfter: row.balance } : {}),
          ...(stale ? { reason: 'STALE_GAME' as const } : {}),
          walletRevision: row.revision,
        };
        (row.rewards ??= []).push({ ...receipt, requestHash });
        receipts.push(receipt);
        changed = true;
      }
      if (!changed) return clone(receipts);
      row.storageRevision++;
      if (!(await this.repository.compareAndSwap(row, previous))) continue;
      this.activity.changed();
      return clone(receipts);
    }
    fail(
      'WALLET_CONFLICT',
      'La recompensa sigue pendiente. Reintenta el mismo encuentro.',
    );
  }

  async battleRewardEpoch(userId: number): Promise<number> {
    return (await this.ensureWallet(userId)).rewardEpoch ?? 0;
  }

  /** Internal only: PvP owns the persisted winner and preset, never an RPC. */
  async creditBattleReward(
    userId: number,
    battleId: string,
    presetId: string,
    epoch: number,
    rewardBundleVersion?: 1 | 2,
  ): Promise<CombatReward> {
    const amount = trainerPresetReward(presetId, rewardBundleVersion);
    if (amount === undefined)
      fail('INVALID_TRAINER', 'No existe recompensa para este Trainer.');
    id(battleId);
    integer(epoch);
    if (
      rewardBundleVersion !== undefined &&
      ![1, 2].includes(rewardBundleVersion)
    )
      fail('INVALID_INPUT', 'La versión de recompensa no es válida.');
    const badgeId =
      rewardBundleVersion !== undefined &&
      Object.prototype.hasOwnProperty.call(GYM_REWARD_BADGES, presetId)
        ? GYM_REWARD_BADGES[presetId as keyof typeof GYM_REWARD_BADGES]
        : undefined;
    const firstRival =
      rewardBundleVersion === 2 &&
      /^kanto-rival-lab-(grass|fire|water)$/.test(presetId);
    return this.activity.runExclusive(
      [userId],
      async () =>
        (
          await this.commitCombatRewards(userId, [
            {
              rewardId: `admin:${battleId}`,
              userId,
              source: 'admin-trainer',
              battleId,
              presetId,
              epoch,
              amount,
              ...(rewardBundleVersion !== undefined
                ? { rewardBundleVersion }
                : {}),
              ...(badgeId ? { badgeId, items: { tm: 1 as const } } : {}),
              ...(firstRival ? { items: { 'great-ball': 1 as const } } : {}),
            },
          ])
        )[0],
    );
  }

  /** Internal only: the persisted admin battle decides a trainer loss/forfeit. */
  async debitBattlePenalty(
    userId: number,
    battleId: string,
    presetId: string,
    epoch: number,
  ): Promise<CombatReward> {
    const nominalAmount = trainerPresetPenalty(presetId);
    if (nominalAmount === undefined)
      fail('INVALID_TRAINER', 'No existe penalización para este Trainer.');
    integer(userId, 1);
    id(battleId);
    integer(epoch);
    return this.activity.runExclusive(
      [userId],
      async () =>
        (
          await this.commitCombatRewards(userId, [
            {
              rewardId: `admin:${battleId}`,
              userId,
              source: 'admin-trainer',
              battleId,
              presetId,
              epoch,
              penaltyVersion: 1,
              nominalAmount,
              amount: nominalAmount,
            },
          ])
        )[0],
    );
  }

  async rewardClaim(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['rewards']);
    if (
      !Array.isArray(payload.rewards) ||
      payload.rewards.length < 1 ||
      payload.rewards.length > 100
    )
      fail('INVALID_INPUT', 'Envía de una a cien recompensas pendientes.');
    for (const claim of payload.rewards) {
      object(claim, ['encounterId', 'epoch', 'color', 'penaltyVersion']);
      id(claim.encounterId);
      integer(claim.epoch);
      if (claim.penaltyVersion !== undefined && claim.penaltyVersion !== 1)
        fail('INVALID_INPUT', 'La versión de penalización no es válida.');
      if (
        !Object.prototype.hasOwnProperty.call(
          LOCAL_TRAINER_REWARDS,
          claim.color,
        )
      )
        fail('INVALID_INPUT', 'La casilla de recompensa no es válida.');
    }
    this.self(actor);
    if (actor.user.role !== 'player')
      fail('PLAYER_REQUIRED', 'Sólo el jugador confirma sus encuentros.');
    const verified = await this.auth.authenticate(actor.token);
    if (verified.user.id !== actor.user.id || verified.user.role !== 'player')
      fail('INVALID_PLAYER', 'La sesión ya no pertenece a un jugador vigente.');
    const rewards = await this.activity.runExclusive(
      [actor.user.id],
      async () => {
        this.self(actor);
        return this.commitCombatRewards(
          actor.user.id,
          (payload.rewards as LocalTrainerRewardClaim[]).map((claim) => ({
            rewardId: `local:${claim.encounterId}`,
            userId: actor.user.id,
            source: 'local-trainer',
            encounterId: claim.encounterId,
            epoch: claim.epoch,
            color: claim.color,
            amount:
              claim.penaltyVersion === 1
                ? LOCAL_TRAINER_PENALTIES[claim.color]
                : LOCAL_TRAINER_REWARDS[claim.color],
            ...(claim.penaltyVersion === 1
              ? {
                  penaltyVersion: 1 as const,
                  nominalAmount: LOCAL_TRAINER_PENALTIES[claim.color],
                }
              : {}),
          })),
        );
      },
    );
    return { ...(await this.sync(actor)), rewards };
  }

  async consumeBatch(actor: Actor, payload: any): Promise<ShopState> {
    const operations = this.consumptionOperations(payload);
    if (payload.clientId !== actor.clientId)
      fail('OWNER_REQUIRED', 'El lote pertenece a otro navegador.');
    this.self(actor);
    if (actor.user.role !== 'player')
      fail('PLAYER_REQUIRED', 'Sólo el jugador sincroniza sus consumos.');
    await this.activity.runExclusive([actor.user.id], async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const row = await this.repository.get(actor.user.id);
        if (!row)
          fail(
            'PLAYER_NOT_READY',
            'Sincroniza tu Bag antes de confirmar sus consumos.',
          );
        this.consumptionSession(actor, row);
        const ledger = row.consumptions ?? [];
        const stream = row.consumptionClients.find(
          (entry) => entry.clientId === actor.clientId,
        );
        let through = stream.throughSequence;
        const fresh: {
          operation: ConsumptionOperation;
          requestHash: string;
        }[] = [];
        for (const operation of operations) {
          const requestHash = digest([
            'background-item-use',
            actor.user.id,
            actor.clientId,
            operation.operationId,
            operation.sequence,
            operation.itemId,
            operation.quantity,
            operation.captureId,
            operation.context,
            operation.moveId ?? null,
          ]);
          const prior = ledger.find(
            (entry) =>
              entry.clientId === actor.clientId &&
              (entry.sequence === operation.sequence ||
                entry.operationId === operation.operationId),
          );
          if (prior) {
            if (
              prior.clientId !== actor.clientId ||
              prior.requestHash !== requestHash
            )
              fail(
                'REQUEST_CONFLICT',
                'Ese consumo ya corresponde a otra operación.',
              );
            continue;
          }
          if (operation.sequence !== through + 1)
            fail(
              'CONSUMPTION_GAP',
              'Recupera primero los consumos anteriores de este navegador.',
            );
          through = operation.sequence;
          fresh.push({ operation, requestHash });
        }
        if (!fresh.length) return;
        if (ledger.length + fresh.length > 8192)
          fail(
            'CONSUMPTION_HISTORY_FULL',
            'El historial de consumos requiere mantenimiento.',
          );
        if (
          (
            await this.activity.busyUsers(
              [actor.user.id],
              ['shop', 'battle-consumption'],
            )
          ).length
        )
          fail(
            'PLAYER_BUSY',
            'Confirma la operación pendiente antes de sincronizar consumos nuevos.',
          );
        const verified = await this.auth.authenticate(actor.token);
        if (
          verified.user.id !== actor.user.id ||
          verified.user.role !== 'player'
        )
          fail(
            'INVALID_PLAYER',
            'La sesión ya no pertenece a un jugador vigente.',
          );
        this.consumptionSession(actor, row);
        if (
          (
            await this.activity.busyUsers(
              [actor.user.id],
              ['shop', 'battle-consumption'],
            )
          ).length
        )
          fail(
            'PLAYER_BUSY',
            'La batalla ya congeló el inventario de este equipo.',
          );
        const previous = row.storageRevision;
        const results = fresh.map(({ operation, requestHash }) => {
          const accepted = (row.items[operation.itemId] ?? 0) > 0;
          if (accepted) row.items[operation.itemId]--;
          return {
            ...operation,
            userId: actor.user.id,
            clientId: actor.clientId,
            status: accepted ? ('accepted' as const) : ('rejected' as const),
            ...(accepted ? {} : { reason: 'INSUFFICIENT_ITEMS' as const }),
            walletRevision: row.revision,
            requestHash,
          };
        });
        const accepted = results.some((entry) => entry.status === 'accepted');
        if (accepted && !Number.isSafeInteger(row.revision + 1))
          fail(
            'WALLET_CONFLICT',
            'La revisión de la cartera está fuera de rango.',
          );
        if (accepted) row.revision++;
        row.storageRevision++;
        stream.throughSequence = through;
        (row.consumptions ??= []).push(
          ...results.map((entry) => ({
            ...entry,
            walletRevision: row.revision,
          })),
        );
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'No se pudo confirmar el lote. Reintenta las mismas operaciones.',
      );
    });
    const state = await this.sync(actor, {});
    const row = await this.repository.get(actor.user.id);
    return {
      ...state,
      consumptions: (row.consumptions ?? [])
        .filter(
          (entry) =>
            entry.clientId === actor.clientId &&
            operations.some(
              (operation) => operation.sequence === entry.sequence,
            ),
        )
        .map(({ requestHash: _, ...entry }) => entry),
    };
  }
  async use(actor: Actor, payload: any): Promise<ShopState> {
    const requestHash = this.itemUseRequest(actor, payload);
    const itemId = (
      payload.itemId === undefined ? 'full-restore' : payload.itemId
    ) as UsableItemId;
    const use = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<ItemUse> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          if (!row)
            fail(
              'PLAYER_NOT_READY',
              'Sincroniza tu Bag antes de usar el objeto.',
            );
          const replay = row.uses?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (replay) {
            if (replay.requestHash !== requestHash)
              fail(
                'REQUEST_CONFLICT',
                'Esa solicitud corresponde a otro uso de objeto.',
              );
            return useView(replay);
          }
          await this.activity.assertAvailable([actor.user.id]);
          this.itemUseOwner(actor, payload.context);
          const captureQuote = BALL_ITEM_IDS.includes(itemId as any)
            ? await this.catalog.captureQuote(payload.expectedCaptureRevision)
            : undefined;
          if (row.revision !== payload.expectedWalletRevision)
            fail(
              'WALLET_CONFLICT',
              'La Bag cambió. Sincroniza antes de usar el objeto.',
            );
          if ((row.items[itemId] ?? 0) < 1)
            fail(
              'ITEM_UNAVAILABLE',
              'No tienes existencias de este objeto en tu Bag.',
            );
          const identity = await this.auth.authenticate(actor.token);
          if (
            identity.user.id !== actor.user.id ||
            identity.user.role !== 'player'
          )
            fail(
              'INVALID_PLAYER',
              'La sesión ya no pertenece a un jugador vigente.',
            );
          this.itemUseOwner(actor, payload.context);
          const previous = row.storageRevision;
          const receipt: ItemUse = {
            requestId: payload.requestId,
            userId: actor.user.id,
            clientId: actor.clientId,
            itemId,
            ...(payload.moveId === undefined ? {} : { moveId: payload.moveId }),
            captureId: payload.captureId,
            context: payload.context,
            planHash: payload.planHash,
            expectedWalletRevision: payload.expectedWalletRevision,
            ...(payload.expectedCaptureRevision === undefined
              ? {}
              : { captureRevision: payload.expectedCaptureRevision }),
            walletRevision: row.revision + 1,
            status: 'pending',
          };
          row.items[itemId]--;
          row.revision++;
          row.storageRevision++;
          (row.uses ??= []).push({ ...receipt, requestHash });
          const committed = captureQuote
            ? await this.catalog.commitCapture(captureQuote.revision, () =>
                this.repository.compareAndSwap(row, previous),
              )
            : await this.repository.compareAndSwap(row, previous);
          if (!committed) continue;
          this.activity.changed();
          return receipt;
        }
        fail(
          'WALLET_CONFLICT',
          'No se pudo guardar el consumo. Sincroniza y reintenta.',
        );
      },
    );
    const state = await this.sync(actor, {});
    return {
      ...state,
      use:
        state.uses?.find((entry) => entry.requestId === use.requestId) ?? use,
    };
  }
  async useCancel(actor: Actor, payload: any): Promise<ShopState> {
    const requestHash = this.itemUseRequest(actor, payload);
    const itemId = (
      payload.itemId === undefined ? 'full-restore' : payload.itemId
    ) as UsableItemId;
    const use = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<ItemUse> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          if (!row)
            fail('PLAYER_NOT_READY', 'Sincroniza tu Bag antes de continuar.');
          const replay = row.uses?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (replay) {
            if (replay.requestHash !== requestHash)
              fail(
                'REQUEST_CONFLICT',
                'Esa solicitud corresponde a otro uso de objeto.',
              );
            return useView(replay);
          }
          const identity = await this.auth.authenticate(actor.token);
          if (
            identity.user.id !== actor.user.id ||
            identity.user.role !== 'player'
          )
            fail(
              'INVALID_PLAYER',
              'La sesión ya no pertenece a un jugador vigente.',
            );
          this.self(actor);
          const previous = row.storageRevision;
          const receipt: ItemUse = {
            requestId: payload.requestId,
            userId: actor.user.id,
            clientId: actor.clientId,
            itemId,
            ...(payload.moveId === undefined ? {} : { moveId: payload.moveId }),
            captureId: payload.captureId,
            context: payload.context,
            planHash: payload.planHash,
            expectedWalletRevision: payload.expectedWalletRevision,
            ...(payload.expectedCaptureRevision === undefined
              ? {}
              : { captureRevision: payload.expectedCaptureRevision }),
            walletRevision: row.revision,
            status: 'cancelled',
          };
          (row.uses ??= []).push({ ...receipt, requestHash });
          row.storageRevision++;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return receipt;
        }
        fail(
          'WALLET_CONFLICT',
          'No se pudo cancelar el uso. Sincroniza y reintenta.',
        );
      },
    );
    const state = await this.sync(actor, {});
    return {
      ...state,
      use:
        state.uses?.find((entry) => entry.requestId === use.requestId) ?? use,
    };
  }
  async useApplied(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['requestId', 'revision']);
    id(payload.requestId);
    integer(payload.revision, 1);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el propietario puede confirmar el uso del objeto.',
      );
    await this.activity.runExclusive([actor.user.id], async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        this.self(actor);
        const row = await this.repository.get(actor.user.id);
        const use = row?.uses?.find(
          (entry) => entry.requestId === payload.requestId,
        );
        if (
          !use ||
          use.userId !== actor.user.id ||
          use.clientId !== actor.clientId
        )
          fail(
            'OWNER_REQUIRED',
            'Confirma el uso desde su navegador original.',
          );
        if (use.status === 'cancelled')
          fail('ITEM_USE_CANCELLED', 'El uso del objeto fue cancelado.');
        if (use.walletRevision !== payload.revision)
          fail('WALLET_CONFLICT', 'La revisión no corresponde al consumo.');
        if (use.status === 'applied') return;
        const owner = this.current(actor.user.id);
        if (
          !owner ||
          owner.socketId !== actor.socketId ||
          owner.clientId !== use.clientId
        )
          fail('OWNER_REQUIRED', 'Reconecta el navegador que usó el objeto.');
        const previous = row.storageRevision;
        use.status = 'applied';
        row.storageRevision++;
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'No se pudo confirmar el guardado del uso. Sincroniza y reintenta.',
      );
    });
    return this.sync(actor, {});
  }

  async reset(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['requestId', 'expectedWalletRevision']);
    id(payload.requestId);
    integer(payload.expectedWalletRevision);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail('PLAYER_REQUIRED', 'Sólo el jugador puede reiniciar su partida.');
    const requestHash = digest([
      actor.user.id,
      actor.clientId,
      payload.expectedWalletRevision,
    ]);
    const reset = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<GameReset> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          if (!row)
            fail(
              'PLAYER_NOT_READY',
              'Sincroniza tus Pokedollars antes de reiniciar.',
            );
          const replay = row.resets?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (replay) {
            if (replay.requestHash !== requestHash)
              fail(
                'REQUEST_CONFLICT',
                'Esa solicitud corresponde a otro reinicio.',
              );
            return resetView(replay);
          }
          await this.activity.assertAvailable([actor.user.id]);
          const owner = this.current(actor.user.id);
          if (
            !owner ||
            owner.socketId !== actor.socketId ||
            owner.clientId !== actor.clientId
          )
            fail(
              'OWNER_REQUIRED',
              'Reconecta este navegador antes de reiniciar.',
            );
          if (owner.localBattle)
            fail('PLAYER_IN_BATTLE', 'Termina tu batalla antes de reiniciar.');
          if (row.revision !== payload.expectedWalletRevision)
            fail(
              'WALLET_CONFLICT',
              'El saldo cambió. Sincroniza antes de reiniciar.',
            );
          const verified = await this.auth.authenticate(actor.token);
          if (
            verified.user.id !== actor.user.id ||
            verified.user.role !== 'player'
          )
            fail(
              'INVALID_PLAYER',
              'La sesión ya no pertenece a un jugador vigente.',
            );
          this.self(actor);
          const finalOwner = this.current(actor.user.id);
          if (
            !finalOwner ||
            finalOwner.socketId !== actor.socketId ||
            finalOwner.clientId !== actor.clientId ||
            finalOwner.localBattle
          )
            fail(
              'OWNER_REQUIRED',
              'La conexión o batalla cambió antes de guardar el reinicio.',
            );
          const previous = row.storageRevision;
          const receipt: GameReset = {
            requestId: payload.requestId,
            userId: actor.user.id,
            clientId: actor.clientId,
            walletRevision: row.revision + 1,
            status: 'pending',
          };
          row.balance = 500;
          row.items = {};
          if (!Number.isSafeInteger((row.rewardEpoch ?? 0) + 1))
            fail(
              'WALLET_CONFLICT',
              'La generación de la partida está fuera de rango.',
            );
          row.rewardEpoch = (row.rewardEpoch ?? 0) + 1;
          row.badges = [];
          row.revision++;
          row.storageRevision++;
          (row.resets ??= []).push({ ...receipt, requestHash });
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return receipt;
        }
        fail(
          'WALLET_CONFLICT',
          'No se pudo guardar el reinicio. Sincroniza y reintenta.',
        );
      },
    );
    const state = await this.sync(actor, {});
    return {
      ...state,
      reset:
        state.resets?.find((entry) => entry.requestId === reset.requestId) ??
        reset,
    };
  }

  async resetCancel(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['requestId', 'expectedWalletRevision']);
    id(payload.requestId);
    integer(payload.expectedWalletRevision);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el jugador puede cancelar su solicitud de reinicio.',
      );
    const requestHash = digest([
      actor.user.id,
      actor.clientId,
      payload.expectedWalletRevision,
    ]);
    const reset = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<GameReset> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          if (!row)
            fail(
              'PLAYER_NOT_READY',
              'Sincroniza tus Pokedollars antes de continuar.',
            );
          const replay = row.resets?.find(
            (entry) => entry.requestId === payload.requestId,
          );
          if (replay) {
            if (replay.requestHash !== requestHash)
              fail(
                'REQUEST_CONFLICT',
                'Esa solicitud corresponde a otro reinicio.',
              );
            // A cancel is a fence against a request that has not committed.
            // It can never undo a successful reset or release its pending ACK.
            return resetView(replay);
          }
          const verified = await this.auth.authenticate(actor.token);
          if (
            verified.user.id !== actor.user.id ||
            verified.user.role !== 'player'
          )
            fail(
              'INVALID_PLAYER',
              'La sesión ya no pertenece a un jugador vigente.',
            );
          this.self(actor);
          const previous = row.storageRevision;
          const receipt: GameReset = {
            requestId: payload.requestId,
            userId: actor.user.id,
            clientId: actor.clientId,
            walletRevision: row.revision,
            status: 'cancelled',
          };
          (row.resets ??= []).push({ ...receipt, requestHash });
          row.storageRevision++;
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
          this.activity.changed();
          return receipt;
        }
        fail(
          'WALLET_CONFLICT',
          'No se pudo cancelar la solicitud. Sincroniza y reintenta.',
        );
      },
    );
    const state = await this.sync(actor, {});
    return {
      ...state,
      reset:
        state.resets?.find((entry) => entry.requestId === reset.requestId) ??
        reset,
    };
  }

  async resetApplied(actor: Actor, payload: any): Promise<ShopState> {
    object(payload, ['requestId', 'revision']);
    id(payload.requestId);
    integer(payload.revision, 1);
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el propietario puede confirmar el reinicio.',
      );
    await this.activity.runExclusive([actor.user.id], async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        this.self(actor);
        const row = await this.repository.get(actor.user.id);
        const reset = row?.resets?.find(
          (entry) => entry.requestId === payload.requestId,
        );
        if (
          !reset ||
          reset.userId !== actor.user.id ||
          reset.clientId !== actor.clientId
        )
          fail(
            'OWNER_REQUIRED',
            'Confirma el reinicio desde su navegador original.',
          );
        if (reset.status === 'cancelled')
          fail('RESET_CANCELLED', 'La solicitud de reinicio fue cancelada.');
        if (reset.walletRevision !== payload.revision)
          fail('WALLET_CONFLICT', 'La revisión no corresponde al reinicio.');
        if (reset.status === 'applied') return;
        const owner = this.current(actor.user.id);
        if (
          !owner ||
          owner.socketId !== actor.socketId ||
          owner.clientId !== actor.clientId
        )
          fail(
            'OWNER_REQUIRED',
            'Reconecta el navegador que reinició la partida.',
          );
        const previous = row.storageRevision;
        reset.status = 'applied';
        row.storageRevision++;
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'No se pudo confirmar el reinicio. Sincroniza y reintenta.',
      );
    });
    return this.sync(actor, {});
  }
}
