/**
 * vp.ts — the official victory-point ledger (wave 4).
 *
 * EXACT official base-game ledger for a seat:
 *   +1 per settlement standing on the board (own buildings, kind settlement)
 *   +2 per city standing on the board        (own buildings, kind city)
 *   +2 while holding the Longest Road tile
 *   +2 while holding the Largest Army tile
 *   +1 per victoryPoint dev card held in devHand
 *
 * VP dev cards are never played or discarded — they sit hidden in the hand
 * and are revealed only at the win declaration, so they count toward the
 * ledger the moment they are bought (including on the same turn).
 *
 * Pure functions over GameState; no schema work here (the state already
 * carries buildings / longestRoad / largestArmy / devHand).
 */
import type { GameState } from "./state.js";

/** Points required to win the base game. */
export const VP_TO_WIN = 10;

/** Official victory-point ledger for one seat. */
export function victoryPoints(state: GameState, seat: number): number {
  const p = state.players[seat];
  if (!p) return 0;
  let vp = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.owner !== seat) continue;
    vp += b.kind === "city" ? 2 : 1;
  }
  if (state.longestRoad.holder === seat) vp += 2;
  if (state.largestArmy.holder === seat) vp += 2;
  for (const c of p.devHand) {
    if (c === "victoryPoint") vp += 1;
  }
  return vp;
}

/** Per-seat ledger snapshot (tests, UI scoreboard). */
export function totalVpLedger(state: GameState): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of state.players) out[p.seat] = victoryPoints(state, p.seat);
  return out;
}
