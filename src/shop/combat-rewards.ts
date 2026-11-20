export const LOCAL_TRAINER_REWARDS = {
  pink: 200,
  green: 300,
  blue: 400,
  yellow: 500,
  red: 600,
  gold: 0,
} as const;

export type TrainerRewardColor = keyof typeof LOCAL_TRAINER_REWARDS;
export const GYM_REWARD_BADGES = {
  'kanto-brock': 'boulder',
  'kanto-misty': 'cascade',
  'kanto-surge': 'thunder',
  'kanto-erika': 'rainbow',
  'kanto-koga': 'soul',
  'kanto-sabrina': 'marsh',
  'kanto-blaine': 'volcano',
  'kanto-giovanni': 'earth',
} as const;
export type GymBadgeId =
  (typeof GYM_REWARD_BADGES)[keyof typeof GYM_REWARD_BADGES];
export type LocalTrainerRewardClaim = {
  encounterId: string;
  epoch: number;
  color: TrainerRewardColor;
};
export type CombatReward = {
  rewardId: string;
  userId: number;
  source: 'local-trainer' | 'admin-trainer';
  encounterId?: string;
  battleId?: string;
  epoch: number;
  color?: TrainerRewardColor;
  presetId?: string;
  amount: number;
  walletRevision: number;
  status: 'credited' | 'rejected';
  reason?: 'STALE_GAME';
  /** Absent on historical cash-only receipts; never infer or upgrade these. */
  rewardBundleVersion?: 1;
  badgeId?: GymBadgeId;
  items?: { tm: 1 };
};
export type StoredCombatReward = CombatReward & { requestHash: string };

export function trainerPresetReward(presetId: string): number | undefined {
  const gyms: Record<string, number> = {
    'kanto-brock': 1200,
    'kanto-misty': 1400,
    'kanto-surge': 1600,
    'kanto-erika': 1800,
    'kanto-koga': 2000,
    'kanto-sabrina': 2000,
    'kanto-blaine': 2300,
    'kanto-giovanni': 2600,
  };
  if (Object.prototype.hasOwnProperty.call(gyms, presetId))
    return gyms[presetId];
  if (
    ['kanto-lorelei', 'kanto-bruno', 'kanto-agatha', 'kanto-lance'].includes(
      presetId,
    )
  )
    return 3000;
  if (/^kanto-rival-lab-(grass|fire|water)$/.test(presetId)) return 500;
  if (/^kanto-rival-champion-(grass|fire|water)$/.test(presetId)) return 6660;
  return undefined;
}
