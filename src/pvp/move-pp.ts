/** Same Gen III fallback as the browser; catalog pp stays immutable. */
const movePp: Record<string, number> = require('./movePpData.json');

export function maxMovePp(move: { id: number; pp?: number | null }): number {
  return Number.isSafeInteger(move.pp) && move.pp >= 0 && move.pp <= 100
    ? move.pp
    : (movePp[String(move.id)] ?? 0);
}

export function currentMovePp(move: {
  id: number;
  pp?: number | null;
  currentPp?: number;
}): number {
  return move.currentPp ?? maxMovePp(move);
}
