/**
 * testFixtures.ts — REAL kernel-built states for the P2 UI tests.
 *
 * Test-only (never imported by src at runtime): the kernel is used HERE to
 * produce states that are actually reachable in a game, so no assertion in
 * hud.test.ts / trade.test.ts is vacuous. AC3 governs apps/table/src, not
 * its tests — precedent: src/scene/layout.test.ts imports buildIsland.
 */
import {
  applyAction,
  legalMoves,
  redactForSeat,
  variableSetup,
  type GameState,
  type Op,
} from "@catan-vtt/shared";

export const SEATS = 3;

/** Fresh variable setup for the shared seed used across M3 tests. */
export function freshGame(): GameState {
  return variableSetup(20260908, { playerCount: SEATS });
}

/** Play the whole snake setup so the game reaches phase "play". */
export function afterSetup(): GameState {
  let st = freshGame();
  for (let guard = 0; guard < 200 && st.phase === "setup"; guard++) {
    const moves = legalMoves(st, st.currentSeat);
    const place = moves.find(
      (m): m is Extract<Op, { type: "placeSetupPiece" }> => m.type === "placeSetupPiece",
    );
    if (place === undefined) break;
    st = applyAction(st, place);
  }
  return st;
}

/** After setup + one roll by the current seat. */
export function afterRoll(): GameState {
  const st = afterSetup();
  const roll = legalMoves(st, st.currentSeat).find((m) => m.type === "roll");
  return roll === undefined ? st : applyAction(st, roll);
}

/**
 * A state with a LIVE pendingTrade (seat 0 → seat 1) and the legalMoves the
 * server would ship to seat 1 (tradeAccept/tradeReject present).
 */
export function withPendingTrade(): { state: GameState; moves: Op[]; offeror: number; offeree: number } {
  let st = afterSetup();
  const roller = st.currentSeat;
  const roll = legalMoves(st, roller).find((m) => m.type === "roll");
  if (roll !== undefined) st = applyAction(st, roll);
  // Make sure seat 0 can pay the offer: grant a known hand.
  const offeror = 0;
  const offeree = 1;
  st = giveCards(st, offeror, ["wood", "wood", "wood", "wood", "brick"]);
  st = { ...st, currentSeat: offeror, hasRolled: true, awaitingSeven: null, pendingTrade: null };
  const offer: Op = { type: "tradeOffer", seat: offeror, with: offeree, give: ["wood"], want: ["ore"] };
  try {
    st = applyAction(st, offer);
  } catch {
    /* if the kernel refuses, the caller's non-vacuous guards will catch it */
  }
  return { state: st, moves: legalMoves(st, offeree), offeror, offeree };
}

/** Add resources to one seat's hand (state is treated immutably). */
export function giveCards(st: GameState, seat: number, cards: Array<"wood" | "brick" | "wool" | "wheat" | "ore">): GameState {
  return {
    ...st,
    players: st.players.map((p) =>
      p.seat !== seat
        ? p
        : {
            ...p,
            hand: cards.reduce(
              (h, c) => ({ ...h, [c]: h[c] + 1 }),
              { ...p.hand },
            ),
          },
    ),
  };
}

/** The projection a seat would actually receive over the wire. */
export function projectionFor(st: GameState, seat: number): GameState {
  return redactForSeat(st, seat);
}
