/**
 * redact.ts — seat-scoped state projection for the networked/optimistic layers.
 *
 * M2: the server holds the full GameState and ships each client ONLY the
 * projection for its own seat. M3: clients apply deterministic ops to that
 * projection locally (optimistic UI), so the projection must stay a valid
 * GameState end-to-end — applyAction and GameStateSchema work unchanged on it.
 *
 * LEAK BUDGET (what a seated player may NOT learn from their projection):
 * - other seats' hand COMPOSITION (totals are public table knowledge — the
 *   7-discard rule and the 95-card conservation both hinge on them);
 * - the deck ORDER (its length is public — buys shrink it visibly);
 * - the dice SEED (seed + cursor together predict every future draw).
 *
 * ENCODING (leak-free by construction — the projection cannot leak what it
 * does not contain):
 * - every OTHER player's hand is squashed to all-wood at the same TOTAL
 *   (composition erased, count preserved);
 * - every OTHER player's devHand becomes all 'victoryPoint' at the same
 *   LENGTH (types erased, count public). KNOWN QUIRK: victoryPoints() on a
 *   projection OVER-REPORTS other seats (fake VP-cards count 1 each) — the
 *   ledger is only trustworthy on the TRUE state; M3 UI must show server-
 *   shipped values, never compute other seats' VP from a projection.
 * - the deck becomes all 'knight' at the same LENGTH (order erased);
 * - rngSeed becomes 0; rngCursor is KEPT so draw-count invariants hold.
 *
 * Everything else is public table knowledge and passes through untouched:
 * config, phase, board (buildings/roads), robber, longestRoad/largestArmy,
 * piece counts, knightsPlayed, devPlayedThisTurn,
 * discardPile (revealed cards), pendingTrade (announced publicly), roll
 * history, winner/finalPoints, setupStage, version.
 *
 * DELIBERATE EXPANSION of physical-game visibility (v1 friends-table call):
 * other seats' devBoughtThisTurn (per-type) passes through — at a real
 * table you see THAT someone bought, not WHICH type. It is structurally
 * hard to hide (5-key counter in PlayerStateSchema) and leaks no hand
 * composition, but it is a conscious loosening, not an oversight.
 *
 * CONSEQUENCE of the squash encoding: seat-scoped projections are NOT
 * composable — applyAction(redact(s, seatA), op) may diverge from
 * redact(applyAction(s, op), seatA) for any op whose handler branches on
 * another seat's hidden data (production payouts, steal draws, a debtor's
 * discardSeven). Those ops are SERVER-AUTHORITATIVE by design: the server
 * applies them to the true state and re-ships projections. Only own-seat,
 * own-hand ops commute (see redact.test.ts for the exact set).
 *
 * M3 CLIENT RULE: legalMoves output computed ON A PROJECTION must be
 * filtered to the commuting set (builds, own trades, own dev plays,
 * endTurn, moveRobber) before optimistic apply. legalMoves will still
 * enumerate roll/stealCard/buyDevCard/tradeAccept on a projection — they
 * are valid table moves — but applying them client-side draws from the
 * fallback rng stream / fake deck and silently diverges from the server.
 */
import { GameStateSchema, type GameState, type PlayerState, type Resource } from "./state.js";

const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];

/**
 * Project `state` for `seat`. Pure: parses the input, returns a NEW state,
 * never mutates the argument. The result always passes GameStateSchema.
 *
 * @throws RangeError if `seat` is not a player index in this state.
 */
export function redactForSeat(state: GameState, seat: number): GameState {
  const s = GameStateSchema.parse(state);
  const idx = s.players.findIndex((p) => p.seat === seat);
  if (idx === -1) {
    throw new RangeError(`redactForSeat: no such seat ${seat}`);
  }

  const players: PlayerState[] = s.players.map((p) => {
    // Own seat: untouched (defensive copy of hand/devHand so the projection
    // shares no mutable refs with the input — applyAction never mutates in
    // place, but nothing enforces that; do not introduce a mutator).
    if (p.seat === seat)
      return { ...p, hand: { ...p.hand }, devHand: [...p.devHand] };
    const total = RESOURCES.reduce((a, r) => a + p.hand[r], 0);
    return {
      ...p,
      hand: { wood: total, brick: 0, wool: 0, wheat: 0, ore: 0 },
      devHand: Array<"victoryPoint">(p.devHand.length).fill("victoryPoint"),
    };
  });

  return {
    ...s,
    players,
    deck: Array<"knight">(s.deck.length).fill("knight"),
    rngSeed: 0,
  };
}
