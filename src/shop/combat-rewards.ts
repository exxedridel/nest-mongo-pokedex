export const LOCAL_TRAINER_REWARDS = {
  pink: 200,
  green: 300,
  blue: 400,
  yellow: 500,
  red: 600,
  gold: 0,
} as const;

export type TrainerRewardColor = keyof typeof LOCAL_TRAINER_REWARDS;
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
