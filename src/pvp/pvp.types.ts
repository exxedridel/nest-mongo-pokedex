import { UserPublic } from '../messages/messages.types';

export type Side = 'a' | 'b';
export const SIDES: Side[] = ['a', 'b'];
export type Phase =
  | 'collecting'
  | 'ready'
  | 'active'
  | 'finished'
  | 'finalizing'
  | 'finalized'
  | 'cancelled';
export type Choice =
  | { kind: 'move'; moveId: number }
  | { kind: 'switch'; captureId: string }
  | { kind: 'item'; item: 'full-restore'; captureId: string }
  | { kind: 'wait' | 'cancel' | 'forfeit' };
export type Capture = {
  captureId: string;
  pokemon: Record<string, any>;
  statuses?: string[];
  statusTurns?: Record<string, number>;
  [key: string]: any;
};
export type Snapshot = {
  version: 1;
  battleId: string;
  snapshotId: string;
  userId: number;
  clientId: string;
  dataVersion: string;
  baseHash: string;
  pokemons: Capture[];
  activeCaptureId: string;
  hpMultiplier: number;
};
export type Command = {
  commandId: string;
  userId: number;
  side: Side;
  requestKey: string;
  choice: Choice;
  inventoryAuthorized?: true;
};
export type Result = {
  battleId: string;
  resultId: string;
  userId: number;
  snapshotId: string;
  baseHash: string;
  outcome: 'win' | 'lose' | 'draw';
  patches: {
    captureId: string;
    hp: number;
    statuses: string[];
    statusTurns: Record<string, number>;
  }[];
};
export type Actor = {
  user: UserPublic;
  clientId: string;
  socketId: string;
  token: string;
};
export type TrainerTeam = {
  name: string;
  pokemons: Capture[];
  activeCaptureId: string | null;
};
export type BattlePlayer = {
  user: UserPublic;
  clientId: string;
  snapshot?: Snapshot;
};
export type BattleTrainer = {
  presetId: string;
  region: 'kanto';
  name: string;
  category: 'gym' | 'elite-four' | 'rival';
  location: string;
  starterType?: 'grass' | 'fire' | 'water';
  team: TrainerTeam;
};
export type Battle = {
  battleId: string;
  mode?: 'trainer';
  trainer?: BattleTrainer;
  creationKey: string;
  creationHash: string;
  phase: Phase;
  revision: number;
  checkpointRevision: number;
  lockHeld: boolean;
  lockedUserIds: number[];
  adminId: number;
  host: { userId: number; clientId: string; epoch: number };
  players: { a: BattlePlayer; b?: BattlePlayer };
  session: Record<string, any> | null;
  commands: Command[];
  commandHashes: Record<string, string>;
  applied: Record<Side, boolean>;
  results?: Partial<Record<Side, Result>>;
  lastCheckpoint?: { hash: string; expectedRevision: number; epoch: number };
  inventory?: Partial<Record<Side, number>>;
  itemCommands?: Record<
    string,
    { commandId: string; side: Side; captureId: string; requestKey: string }
  >;
  pendingInventoryCheckpoint?: {
    session: Record<string, any>;
    processedCommandIds: string[];
    expectedRevision: number;
    epoch: number;
    fingerprint: string;
    charges: { commandId: string; userId: number; side: Side }[];
  };
};
export const humanSides = (battle: Battle): Side[] =>
  battle.mode === 'trainer' ? ['a'] : SIDES;
export class PvpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string): never => {
  throw new PvpError(code, message);
};
export const clone = <T>(value: T): T => structuredClone(value);
