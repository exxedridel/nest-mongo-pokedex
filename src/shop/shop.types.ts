import { Actor } from '../pvp/pvp.types';
import { UserPublic } from '../messages/messages.types';

export const SHOP_CATALOG = {
  'poke-ball': 150,
  'great-ball': 300,
  'ultra-ball': 450,
  'full-restore': 350,
  'max-ether': 350,
  'max-elixir': 700,
  tm: 500,
  bicycle: 1200,
} as const;
export type ShopItemId = keyof typeof SHOP_CATALOG;
export const MAX_SHOP_PRICE = Math.floor(Number.MAX_SAFE_INTEGER / 99);
export type ShopCatalog = {
  revision: number;
  prices: Record<ShopItemId, number>;
};
export type BalanceAdjustment = {
  adjustmentId: string;
  requestId: string;
  adminUserId: number;
  userId: number;
  clientId: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  walletRevision: number;
  status: 'pending' | 'applied' | 'cancelled';
  cancelledWalletRevision?: number;
  cancelledBalance?: number;
};
export type StoredBalanceAdjustment = BalanceAdjustment & {
  requestHash: string;
  createdAt?: number;
};
export type CenterPokemon = {
  captureId: string;
  pokemonId: number;
  name: string;
  image: string | null;
  level: number;
  currentHp: number;
  maxHp: number;
  statuses: string[];
  moves: { id: number; name: string; currentPp: number; maxPp: number }[];
  needsHealing: boolean;
};
export type CenterPreview = {
  userId: number;
  clientId: string;
  partyRevision: number;
  partyHash: string;
  pokemons: CenterPokemon[];
};
export type CenterHeal = {
  requestId: string;
  adminUserId: number;
  userId: number;
  clientId: string;
  captureIds: string[];
  partyHash: string;
  partyRevision: number;
  planHash: string;
  centerRevision: number;
  status: 'pending' | 'applied' | 'cancelled';
};
export type StoredCenterHeal = CenterHeal & { requestHash: string };
export const CONSUMABLE_ITEM_IDS = [
  'full-restore',
  'max-ether',
  'max-elixir',
] as const;
export type ConsumableItemId = (typeof CONSUMABLE_ITEM_IDS)[number];
// Battle inventory intentionally excludes learning items.
export const USABLE_ITEM_IDS = [...CONSUMABLE_ITEM_IDS, 'tm'] as const;
export type UsableItemId = (typeof USABLE_ITEM_IDS)[number];
export type Wallet = {
  userId: number;
  balance: number;
  revision: number;
  items: Partial<Record<ShopItemId, number>>;
  currencyVersion: 1;
};
export type Purchase = {
  purchaseId: string;
  requestId: string;
  adminUserId: number;
  userId: number;
  clientId: string;
  itemId: ShopItemId;
  quantity: number;
  unitPrice: number;
  total: number;
  balanceBefore: number;
  balanceAfter: number;
  walletRevision: number;
  status: 'pending' | 'applied';
};
export type StoredPurchase = Purchase & {
  requestHash: string;
  createdAt?: number;
};
export type GameReset = {
  requestId: string;
  userId: number;
  clientId: string;
  walletRevision: number;
  status: 'pending' | 'applied' | 'cancelled';
};
export type StoredGameReset = GameReset & { requestHash: string };
export type ItemUse = {
  requestId: string;
  userId: number;
  clientId: string;
  itemId: UsableItemId;
  moveId?: number;
  captureId: string;
  context: 'party' | 'local-battle';
  planHash: string;
  expectedWalletRevision: number;
  walletRevision: number;
  status: 'pending' | 'applied' | 'cancelled';
};
export type StoredItemUse = ItemUse & { requestHash: string };
export type WalletRecord = Wallet & {
  storageRevision: number;
  purchases: StoredPurchase[];
  // Absent on wallets created before game reset support.
  resets?: StoredGameReset[];
  uses?: StoredItemUse[];
  adjustments?: StoredBalanceAdjustment[];
  centerRevision?: number;
  centerHeals?: StoredCenterHeal[];
  battleUses?: {
    key: string;
    battleId: string;
    commandId: string;
    itemId?: ConsumableItemId;
    moveId?: number;
  }[];
};
export type ShopActor = Actor & {
  ready: boolean;
  localBattle: boolean;
  supportsBalanceAdjustments: boolean;
  supportsCenterHealing: boolean;
};
export type ShopPlayer = {
  user: UserPublic;
  clientId: string;
  online: boolean;
  ready: boolean;
  inBattle: boolean;
  wallet: Wallet | null;
  pending: boolean;
  pendingReset?: boolean;
  pendingUse?: boolean;
  pendingAdjustment?: boolean;
  supportsBalanceAdjustments?: boolean;
  pendingCenter?: boolean;
  supportsCenterHealing?: boolean;
};
export type ShopState = {
  catalog?: ShopCatalog;
  adjustment?: BalanceAdjustment;
  adjustments?: BalanceAdjustment[];
  wallet?: Wallet;
  players?: ShopPlayer[];
  purchases?: Purchase[];
  resets?: GameReset[];
  reset?: GameReset;
  uses?: ItemUse[];
  use?: ItemUse;
  centerPreview?: CenterPreview;
  centerHeal?: CenterHeal;
  centerHeals?: CenterHeal[];
};
export class ShopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string): never => {
  throw new ShopError(code, message);
};
export const clone = <T>(value: T): T => structuredClone(value);
export function walletView(record: WalletRecord): Wallet {
  return clone({
    userId: record.userId,
    balance: record.balance,
    revision: record.revision,
    items: record.items,
    currencyVersion: record.currencyVersion,
  });
}
export function purchaseView(record: StoredPurchase): Purchase {
  const { requestHash: _, createdAt: __, ...purchase } = record;
  return clone(purchase);
}
export function resetView(record: StoredGameReset): GameReset {
  const { requestHash: _, ...reset } = record;
  return clone(reset);
}
export function useView(record: StoredItemUse): ItemUse {
  const { requestHash: _, ...use } = record;
  return clone(use);
}
export function centerView(record: StoredCenterHeal): CenterHeal {
  const { requestHash: _, ...receipt } = record;
  return clone(receipt);
}
