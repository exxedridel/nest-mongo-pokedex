import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthIdentityService } from '../messages/auth-identity.service';
import { PlayerActivityService } from '../messages/player-activity.service';
import { Actor } from '../pvp/pvp.types';
import { digest } from '../pvp/pvp.validation';
import { SHOP_REPOSITORY, ShopRepository } from './shop.repository';
import {
  clone,
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
  useView,
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
    },
  ) => Promise<{
    ok: boolean;
    revision?: number;
    error?: { message?: string };
  }>;
  constructor(
    @Inject(SHOP_REPOSITORY) readonly repository: ShopRepository,
    private readonly auth: AuthIdentityService,
    private readonly activity: PlayerActivityService,
  ) {}
  async onModuleInit() {
    await this.repository.ready();
    this.activity.register('shop', async (userIds) => {
      const rows = await Promise.all(
        userIds.map((userId) => this.repository.get(userId)),
      );
      return rows
        .filter(
          (row) =>
            row?.purchases.some((purchase) => purchase.status === 'pending') ||
            row?.resets?.some((reset) => reset.status === 'pending') ||
            row?.uses?.some((use) => use.status === 'pending'),
        )
        .map((row) => row.userId);
    });
  }
  async fullRestoreStock(userId: number): Promise<number> {
    return (await this.repository.get(userId))?.items['full-restore'] ?? 0;
  }
  /** Called only for a durable, authorized battle checkpoint outbox. */
  async consumeBattleFullRestore(
    userId: number,
    battleId: string,
    commandId: string,
  ) {
    const key = digest([battleId, commandId]);
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await this.repository.get(userId);
      if (!row)
        fail('INVENTORY_UNAVAILABLE', 'No se encontró la Bag del jugador.');
      if (row.battleUses?.some((use) => use.key === key)) return;
      if ((row.items['full-restore'] ?? 0) < 1)
        fail(
          'INSUFFICIENT_ITEMS',
          'No quedan Full Restore para completar esta acción.',
        );
      const previous = row.storageRevision;
      row.items['full-restore']--;
      row.revision++;
      row.storageRevision++;
      (row.battleUses ??= []).push({ key, battleId, commandId });
      if (!(await this.repository.compareAndSwap(row, previous))) continue;
      this.activity.changed();
      return;
    }
    fail('WALLET_CONFLICT', 'No se pudo confirmar el consumo de Full Restore.');
  }
  connect(actor: Actor) {
    const previous = this.actors.get(actor.socketId);
    this.actors.set(actor.socketId, {
      ...actor,
      ready: previous?.ready ?? false,
      localBattle: previous?.localBattle ?? false,
    });
  }
  disconnect(socketId: string) {
    this.actors.delete(socketId);
  }
  setPrepareHandler(handler: typeof this.prepareHandler) {
    this.prepareHandler = handler;
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
    object(payload, ['ready', 'localBattle']);
    if (
      typeof payload.ready !== 'boolean' ||
      typeof payload.localBattle !== 'boolean'
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
      current.ready = payload.ready;
      current.localBattle = payload.localBattle;
      await this.ensureWallet(actor.user.id);
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
    object(payload, []);
    this.self(actor);
    if (actor.user.role === 'player') {
      const row = await this.ensureWallet(actor.user.id);
      return {
        wallet: walletView(row),
        purchases: row.purchases
          .filter((purchase) => purchase.clientId === actor.clientId)
          .slice(-50)
          .map(purchaseView),
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
      players.push({
        user: clone(valid.user),
        clientId: candidate.clientId,
        online: true,
        ready: current.ready,
        inBattle: current.localBattle || busy.has(candidate.user.id),
        wallet: wallet ? walletView(wallet) : null,
        pending: pending || pendingReset || pendingUse,
        pendingReset,
        pendingUse,
      });
    }
    const rows = await this.repository.forAdmin(actor.user.id);
    return {
      players,
      purchases: rows
        .flatMap((row) => row.purchases)
        .filter((purchase) => purchase.adminUserId === actor.user.id)
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .slice(-50)
        .map(purchaseView),
    };
  }
  async purchase(actor: Actor, payload: any): Promise<ShopState> {
    this.admin(actor);
    object(payload, [
      'requestId',
      'playerUserId',
      'clientId',
      'itemId',
      'quantity',
      'expectedWalletRevision',
    ]);
    id(payload.requestId);
    id(payload.clientId);
    integer(payload.playerUserId, 1);
    integer(payload.quantity, 1, 99);
    integer(payload.expectedWalletRevision);
    if (
      typeof payload.itemId !== 'string' ||
      !Object.prototype.hasOwnProperty.call(SHOP_CATALOG, payload.itemId)
    )
      fail('INVALID_ITEM', 'Ese objeto no está disponible en Poké Mart.');
    const itemId = payload.itemId as ShopItemId;
    const unitPrice = SHOP_CATALOG[itemId];
    const total = unitPrice * payload.quantity;
    const hash = digest([
      actor.user.id,
      payload.playerUserId,
      payload.clientId,
      itemId,
      payload.quantity,
      payload.expectedWalletRevision,
    ]);
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
        if (prior.requestHash !== hash)
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
          if (replay.requestHash !== hash)
            fail(
              'REQUEST_CONFLICT',
              'Esa solicitud ya corresponde a otra compra.',
            );
          return;
        }
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
        });
        if (!prepared?.ok || prepared.revision !== row.revision)
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
        const purchase: Purchase = {
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
        if (!(await this.repository.compareAndSwap(row, previous))) continue;
        this.activity.changed();
        return;
      }
      fail(
        'WALLET_CONFLICT',
        'Otra operación actualizó la cuenta. Sincroniza y reintenta.',
      );
    });
    return this.sync(actor, {});
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
        if (purchase.status === 'applied') return;
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
    ]);
    id(payload.requestId);
    id(payload.captureId);
    integer(payload.expectedWalletRevision);
    if (
      !['party', 'local-battle'].includes(payload.context) ||
      typeof payload.planHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.planHash)
    )
      fail('INVALID_INPUT', 'El plan de uso de Full Restore no es válido.');
    this.self(actor);
    if (actor.user.role !== 'player')
      fail(
        'PLAYER_REQUIRED',
        'Sólo el jugador puede usar objetos de su propia Bag.',
      );
    return digest([
      actor.user.id,
      actor.clientId,
      payload.captureId,
      payload.context,
      payload.planHash,
      payload.expectedWalletRevision,
    ]);
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
        'Reconecta este navegador antes de usar Full Restore.',
      );
    if ((context === 'local-battle') !== owner.localBattle)
      fail(
        'PLAYER_IN_BATTLE',
        context === 'party'
          ? 'Usa la acción de objeto del combate mientras estás en batalla.'
          : 'La batalla local cambió; vuelve a preparar el uso del objeto.',
      );
  }
  async use(actor: Actor, payload: any): Promise<ShopState> {
    const requestHash = this.itemUseRequest(actor, payload);
    const use = await this.activity.runExclusive(
      [actor.user.id],
      async (): Promise<ItemUse> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          this.self(actor);
          const row = await this.repository.get(actor.user.id);
          if (!row)
            fail(
              'PLAYER_NOT_READY',
              'Sincroniza tu Bag antes de usar Full Restore.',
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
          if (row.revision !== payload.expectedWalletRevision)
            fail(
              'WALLET_CONFLICT',
              'La Bag cambió. Sincroniza antes de usar el objeto.',
            );
          if ((row.items['full-restore'] ?? 0) < 1)
            fail('ITEM_UNAVAILABLE', 'No tienes Full Restore en tu Bag.');
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
            itemId: 'full-restore',
            captureId: payload.captureId,
            context: payload.context,
            planHash: payload.planHash,
            expectedWalletRevision: payload.expectedWalletRevision,
            walletRevision: row.revision + 1,
            status: 'pending',
          };
          row.items['full-restore']--;
          row.revision++;
          row.storageRevision++;
          (row.uses ??= []).push({ ...receipt, requestHash });
          if (!(await this.repository.compareAndSwap(row, previous))) continue;
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
            itemId: 'full-restore',
            captureId: payload.captureId,
            context: payload.context,
            planHash: payload.planHash,
            expectedWalletRevision: payload.expectedWalletRevision,
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
        'Sólo el propietario puede confirmar el uso de Full Restore.',
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
