/**
 * hud.test.ts — P2(a) HUD display logic against REAL kernel-built games.
 *
 * Fixtures come from testFixtures.ts (kernel applyAction/legalMoves — allowed
 * in tests, AC3 covers src runtime). Every assertion sits on non-empty,
 * reachable state; P1's vacuous-fixture lesson is a hard rule here.
 */
import { describe, expect, it } from "vitest";
import type { GameState } from "@catan-vtt/shared";
import {
  devChips,
  handChips,
  handTotal,
  pendingTradeView,
  pickMove,
  playerName,
  turnBanner,
  visiblePoints,
} from "./hudLogic.js";
import { afterRoll, afterSetup, freshGame, giveCards, SEATS, withPendingTrade } from "./testFixtures.js";

describe("turnBanner", () => {
  it("mid-setup: waiting line names placement, yours flips with the seat", () => {
    const st = freshGame(); // variableSetup lands in phase "setup"
    expect(st.phase).toBe("setup");
    expect(st.currentSeat).toBeLessThan(SEATS); // real bound, not >=0 tautology
    const cur = st.currentSeat;
    const mine = turnBanner(st, cur);
    expect(mine.yours).toBe(true);
    expect(mine.title).toBe("Your turn");
    expect(mine.waiting).toBe("Setup: place your pieces");
    const other = turnBanner(st, (cur + 1) % SEATS);
    expect(other.yours).toBe(false);
    expect(other.title).toContain(`Seat ${cur}`);
    expect(other.title).toContain(playerName(st, cur));
  });

  it("after the roll: phase play, spectator seat=null is never 'yours'", () => {
    const st = afterRoll();
    expect(st.phase).toBe("play");
    expect(st.hasRolled || st.awaitingSeven !== null).toBe(true);
    const spec = turnBanner(st, null);
    expect(spec.yours).toBe(false);
    expect(turnBanner(st, st.currentSeat).yours).toBe(true);
  });
});

describe("hand chips / totals", () => {
  it("spectator gets no chips; a real hand rounds back to handTotal", () => {
    const st = afterRoll();
    expect(handChips(st, null)).toEqual([]);
    expect(handTotal(st, null)).toBe(0);
    const before = handTotal(st, 0);
    expect(handChips(st, 0).reduce((a, c) => a + c.count, 0)).toBe(before); // chips == total
    const bumped = giveCards(st, 0, ["wood"]);
    expect(handTotal(bumped, 0)).toBe(before + 1);
    const wood = handChips(bumped, 0).find((c) => c.resource === "wood");
    expect(wood?.count).toBe(st.players[0]!.hand.wood + 1);
    expect(wood?.abbr).toBe("WOD"); // 3-letter chips render (no emoji/icons)
    expect(handChips(st, 0)).toHaveLength(5);
  });
});

describe("visiblePoints", () => {
  it("setup-complete board: each seat's 2 settlements = 2 points, nothing else", () => {
    const st = afterSetup();
    const buildings = Object.keys(st.buildings).length;
    expect(buildings).toBe(SEATS * 2); // non-vacuous: pieces really exist
    for (let seat = 0; seat < SEATS; seat++) {
      expect(visiblePoints(st, seat)).toBe(2); // no road/army/dev yet
    }
    const cityed: GameState = {
      ...st,
      buildings: { ...st.buildings, [Object.keys(st.buildings)[0]!]: { kind: "city", owner: 0 } },
    };
    expect(visiblePoints(cityed, 0)).toBe(3); // 1 city + 1 settlement
  });
});

describe("devChips", () => {
  it("cards bought this turn are not playable; counts split by type", () => {
    const st = afterRoll();
    expect(st.players.every((p) => p.devHand.length === 0)).toBe(true); // fresh
    const withOnes: GameState = {
      ...st,
      players: st.players.map((p) =>
        p.seat === 0
          ? {
              ...p,
              devHand: ["knight", "knight", "victoryPoint"] as typeof p.devHand,
              devBoughtThisTurn: { ...p.devBoughtThisTurn, knight: 1 },
            }
          : p,
      ),
    };
    const chips = devChips(withOnes, 0);
    const knight = chips.find((c) => c.type === "knight");
    expect(knight?.count).toBe(2);
    expect(knight?.playable).toBe(1); // one was bought THIS turn
    expect(chips.find((c) => c.type === "victoryPoint")?.playable).toBe(1);
  });
});

describe("pendingTradeView + pickMove", () => {
  it("a kernel-live offer: counterparty sees an actionable card, others don't", () => {
    const { state, moves, offeror, offeree } = withPendingTrade();
    expect(state.pendingTrade).not.toBeNull(); // fixture really made it
    const v = pendingTradeView(state, offeree)!;
    expect(v.actionable).toBe(true);
    expect(v.summary).toContain("wood");
    expect(pendingTradeView(state, offeror)!.actionable).toBe(false);
    expect(pendingTradeView(state, null)!.actionable).toBe(false);
    // the accept op the HUD button must fire is the SERVER's shipped object:
    const accept = pickMove(moves, "tradeAccept");
    expect(accept).not.toBeNull();
    expect(accept!.seat).toBe(offeree);
    expect(pendingTradeView(state, null)).not.toBeNull();
  });

  it("no pending trade → null view (no phantom banner)", () => {
    expect(pendingTradeView(afterRoll(), 0)).toBeNull();
  });
});
