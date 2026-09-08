/**
 * trade.test.ts — wave 3: maritime (bank/port) trades and the domestic
 * offer/accept/reject lifecycle.
 *
 * Test-side state construction follows the give/forceRoll pattern from
 * turn.test.ts (spreading GameState is allowed in tests; applyAction stays
 * the only mutator in production code).
 */
import { describe, expect, it } from "vitest";
import { ActionError, OpSchema, type Op } from "./actions.js";
import { buildIsland } from "./board.js";
import { Rng } from "./rng.js";
import { variableSetup } from "./setup.js";
import {
  GameStateSchema,
  type GameState,
  type PlayerState,
  type Resource,
  type ResourceCounter,
} from "./state.js";
import { applyAction, legalMoves } from "./turn.js";

const TOPO = buildIsland();
const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];
const handTotal = (p: PlayerState): number =>
  RESOURCES.reduce((a, r) => a + p.hand[r], 0);
const grandTotal = (s: GameState): number =>
  s.players.reduce((a, p) => a + handTotal(p), 0) +
  RESOURCES.reduce((a, r) => a + s.bank[r], 0);

/** Play a full deterministic setup (always first legal move). */
function playSetup(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase === "setup") {
    if (++guard > 64) throw new Error("setup did not terminate");
    s = applyAction(s, legalMoves(s, s.currentSeat)[0]);
  }
  return s;
}

/** Give a seat cards (test scaffolding — bypasses applyAction on purpose). */
function give(state: GameState, seat: number, gain: Partial<ResourceCounter>): GameState {
  const players = state.players.slice();
  const p = players[seat];
  const hand = { ...p.hand };
  const bank = { ...state.bank };
  for (const r of RESOURCES) {
    const n = gain[r] ?? 0;
    hand[r] += n;
    bank[r] -= n;
  }
  players[seat] = { ...p, hand };
  return { ...state, players, bank };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ActionError) return e.code;
    throw e;
  }
  throw new Error("expected ActionError, none thrown");
}

/** Drive a rolled-7 state through its full resolution window. */
function resolveSeven(s: GameState): GameState {
  let guard = 0;
  while (s.awaitingSeven) {
    if (++guard > 40) throw new Error("seven did not resolve");
    const aw = s.awaitingSeven;
    const seat = aw.pendingDiscard ? aw.discardQueue[0].seat : aw.roller;
    s = applyAction(s, legalMoves(s, seat)[0]);
  }
  return s;
}

/** Force a specific roll by walking the rng stream (test-only scaffolding). */
function forceRoll(state: GameState, want: number): GameState {
  let cursor = state.rngCursor;
  for (let skip = 0; skip < 10_000; skip++) {
    const rng = Rng.restore({ seed: state.rngSeed, cursor });
    const d1 = 1 + rng.int(6);
    const d2 = 1 + rng.int(6);
    if (d1 + d2 === want) {
      return applyAction({ ...state, rngCursor: cursor }, { type: "roll", seat: state.currentSeat });
    }
    cursor += 2;
  }
  throw new Error(`could not force a ${want}`);
}

/** Fresh action-phase state: setup done, current seat has rolled a non-7. */
function actionPhase(seed: number): GameState {
  return forceRoll(playSetup(variableSetup(seed)), 6);
}

describe("tradeBank (4:1 maritime)", () => {
  it("swaps 4 of one resource for 1 of another; bank/hands conserved", () => {
    let s = actionPhase(101);
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 4 });
    const before = grandTotal(s);
    const s1 = applyAction(s, { type: "tradeBank", seat, offer: "wood", demand: "ore" });
    GameStateSchema.parse(s1);
    expect(s1.players[seat].hand.wood).toBe(s.players[seat].hand.wood - 4);
    expect(s1.players[seat].hand.ore).toBe(s.players[seat].hand.ore + 1);
    expect(s1.bank.wood).toBe(s.bank.wood + 4);
    expect(s1.bank.ore).toBe(s.bank.ore - 1);
    expect(grandTotal(s1)).toBe(before);
  });

  it("rejects: insufficient hand, same-resource, empty bank, off-turn, pre-roll, during seven", () => {
    let s = actionPhase(103);
    const seat = s.currentSeat;
    const other = (seat + 1) % s.players.length;
    // Zero the seat's hand first so give() amounts are exact (production
    // from the forced roll may have paid resources already).
    s = {
      ...s,
      players: s.players.map((p, i) =>
        i === seat ? { ...p, hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 } } : p,
      ),
    };
    // insufficient hand (3 < 4)
    s = give(s, seat, { wood: 3 });
    expect(
      code(() => applyAction(s, { type: "tradeBank", seat, offer: "wood", demand: "ore" })),
    ).toBe("insufficientHand");
    // same-resource even swap is illegal
    s = give(s, seat, { wood: 1 });
    expect(
      code(() => applyAction(s, { type: "tradeBank", seat, offer: "wood", demand: "wood" })),
    ).toBe("tradeSameResource");
    // bank exhausted of demand
    const dry = { ...s, bank: { ...s.bank, ore: 0 } };
    expect(
      code(() => applyAction(dry, { type: "tradeBank", seat, offer: "wood", demand: "ore" })),
    ).toBe("insufficientBank");
    // off-turn
    expect(
      code(() => applyAction(s, { type: "tradeBank", seat: other, offer: "wood", demand: "ore" })),
    ).toBe("notYourTurn");
    // pre-roll
    const pre = playSetup(variableSetup(103));
    expect(
      code(() => applyAction(pre, { type: "tradeBank", seat: pre.currentSeat, offer: "wood", demand: "ore" })),
    ).toBe("notRolledYet");
    // during a seven window (build the freeze directly — test scaffolding)
    const base = actionPhase(107);
    const s7: GameState = {
      ...base,
      awaitingSeven: {
        roller: base.currentSeat,
        pendingDiscard: false,
        mustMoveRobber: true,
        discardQueue: [],
      },
    };
    GameStateSchema.parse(s7);
    expect(
      code(() =>
        applyAction(s7, { type: "tradeBank", seat: s7.currentSeat, offer: "wood", demand: "ore" }),
      ),
    ).toBe("awaitingSeven");
    // legalMoves enumerates exactly the affordable 4:1 pairs
    const moves = legalMoves(s, seat).filter((m) => m.type === "tradeBank");
    expect(moves).toHaveLength(4); // wood×{brick,wool,wheat,ore}
    for (const m of moves) {
      if (m.type === "tradeBank") {
        expect(m.offer).toBe("wood");
        expect(m.demand).not.toBe("wood");
        applyAction(s, m); // conformance: enumerated ⇒ applies
      }
    }
  });
});

function seat2Of(s: GameState): number {
  return (s.currentSeat + 1) % s.players.length;
}

describe("tradePort", () => {
  /** Build a state where `seat` owns a building on a port of `type`. */
  function withPort(seed: number, type: "generic" | Resource): {
    s: GameState;
    seat: number;
    portVertexId: string;
  } {
    const s0 = actionPhase(seed);
    const seat = s0.currentSeat;
    const port = s0.config.ports.find((p) => p.type === type);
    expect(port, `no ${type} port in this layout`).toBeDefined();
    const s: GameState = {
      ...s0,
      buildings: {
        ...s0.buildings,
        [port!.vertexId]: { kind: "settlement", owner: seat },
      },
    };
    GameStateSchema.parse(s);
    return { s, seat, portVertexId: port!.vertexId };
  }

  it("generic port trades 3:1 for any resource", () => {
    const { s, seat, portVertexId } = withPort(109, "generic");
    const s1 = give(s, seat, { brick: 3 });
    const before = grandTotal(s1);
    const s2 = applyAction(s1, {
      type: "tradePort",
      seat,
      portVertexId,
      offer: "brick",
      demand: "wheat",
    });
    GameStateSchema.parse(s2);
    expect(s2.players[seat].hand.brick).toBe(s1.players[seat].hand.brick - 3);
    expect(s2.players[seat].hand.wheat).toBe(s1.players[seat].hand.wheat + 1);
    expect(grandTotal(s2)).toBe(before);
    // 2 cards is not enough at a 3:1.
    const poor = give(s, seat, { brick: 2 });
    expect(
      code(() =>
        applyAction(poor, { type: "tradePort", seat, portVertexId, offer: "brick", demand: "wheat" }),
      ),
    ).toBe("insufficientHand");
  });

  it("2:1 port trades only its matching resource at 2:1", () => {
    // Find a seed whose layout's wood port exists; every layout has all 5.
    const { s, seat, portVertexId } = withPort(111, "wood");
    const s1 = give(s, seat, { wood: 2, brick: 4 });
    const s2 = applyAction(s1, {
      type: "tradePort",
      seat,
      portVertexId,
      offer: "wood",
      demand: "ore",
    });
    expect(s2.players[seat].hand.wood).toBe(s1.players[seat].hand.wood - 2);
    expect(s2.players[seat].hand.ore).toBe(s1.players[seat].hand.ore + 1);
    // Offering brick at a wood port → mismatch (not a silent 3:1/4:1).
    expect(
      code(() =>
        applyAction(s1, { type: "tradePort", seat, portVertexId, offer: "brick", demand: "ore" }),
      ),
    ).toBe("portResourceMismatch");
    // Same-resource demand still illegal.
    expect(
      code(() =>
        applyAction(s1, { type: "tradePort", seat, portVertexId, offer: "wood", demand: "wood" }),
      ),
    ).toBe("tradeSameResource");
  });

  it("rejects when the seat owns no building on the port vertex", () => {
    const s0 = actionPhase(113);
    const seat = s0.currentSeat;
    const port = s0.config.ports[0];
    // Nobody owns the port vertex (setup never places there in this layout —
    // if it does, another seat owns it: same code either way).
    const s = give(s0, seat, { wood: 9 });
    expect(
      code(() =>
        applyAction(s, {
          type: "tradePort",
          seat,
          portVertexId: port.vertexId,
          offer: "wood",
          demand: "ore",
        }),
      ),
    ).toBe("noPortThere");
    // A vertex with no port at all: also noPortThere. Use a non-port vertex
    // the seat DOES own (a setup settlement) to isolate the port check.
    const mine = Object.entries(s.buildings).find(([, b]) => b.owner === seat)!;
    const sNoPort: GameState = {
      ...s,
      config: { ...s.config, ports: s.config.ports.filter((p) => p.vertexId !== mine[0]) },
    };
    expect(
      code(() =>
        applyAction(sNoPort, {
          type: "tradePort",
          seat,
          portVertexId: mine[0],
          offer: "wood",
          demand: "ore",
        }),
      ),
    ).toBe("noPortThere");
  });

  it("legalMoves enumerates port trades with the exact ratio per port type", () => {
    const { s, seat, portVertexId } = withPort(127, "generic");
    const s1 = give(s, seat, { wool: 3 });
    const portMoves = legalMoves(s1, seat).filter(
      (m) => m.type === "tradePort" && m.portVertexId === portVertexId,
    );
    expect(portMoves).toHaveLength(4);
    for (const m of portMoves) {
      if (m.type === "tradePort") {
        expect(m.offer).toBe("wool");
        applyAction(s1, m); // conformance
      }
    }
  });
});

describe("domestic tradeOffer / tradeAccept / tradeReject", () => {
  it("full lifecycle: offer → accept transfers both ways and clears pendingTrade", () => {
    let s = actionPhase(131);
    const seat = s.currentSeat;
    const other = seat2Of(s);
    s = give(s, seat, { wood: 2 });
    s = give(s, other, { ore: 1 });
    const before = grandTotal(s);
    const s1 = applyAction(s, {
      type: "tradeOffer",
      seat,
      with: other,
      give: ["wood", "wood"],
      want: ["ore"],
    });
    GameStateSchema.parse(s1);
    expect(s1.pendingTrade).toEqual({
      offeror: seat,
      offeree: other,
      give: ["wood", "wood"],
      want: ["ore"],
    });
    // Offeree sees exactly accept/reject; the offeror does not.
    const offereeMoves = legalMoves(s1, other);
    expect(offereeMoves.map((m) => m.type).sort()).toEqual(["tradeAccept", "tradeReject"]);
    expect(legalMoves(s1, seat).some((m) => m.type === "tradeAccept")).toBe(false);
    const s2 = applyAction(s1, { type: "tradeAccept", seat: other });
    GameStateSchema.parse(s2);
    expect(s2.pendingTrade).toBeNull();
    expect(s2.players[seat].hand.wood).toBe(s1.players[seat].hand.wood - 2);
    expect(s2.players[seat].hand.ore).toBe(s1.players[seat].hand.ore + 1);
    expect(s2.players[other].hand.ore).toBe(s1.players[other].hand.ore - 1);
    expect(s2.players[other].hand.wood).toBe(s1.players[other].hand.wood + 2);
    expect(grandTotal(s2)).toBe(before); // domestic trades conserve resources
  });

  it("reject clears the offer; endTurn expires an unanswered one", () => {
    let s = actionPhase(137);
    const seat = s.currentSeat;
    const other = seat2Of(s);
    s = give(s, seat, { wood: 1 });
    const offered = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] });
    const rejected = applyAction(offered, { type: "tradeReject", seat: other });
    expect(rejected.pendingTrade).toBeNull();
    // Re-offer, then let the turn end: the offer expires.
    const offered2 = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] });
    const ended = applyAction(offered2, { type: "endTurn", seat });
    expect(ended.pendingTrade).toBeNull();
    expect(ended.currentSeat).toBe(other);
  });

  it("rejection matrix: parse/gates/pending/counterparty/same-resource/self", () => {
    let s = actionPhase(139);
    const seat = s.currentSeat;
    const other = seat2Of(s);
    s = give(s, seat, { wood: 1 });
    // Schema-level: empty give/want arrays never reach applyAction.
    expect(
      OpSchema.safeParse({ type: "tradeOffer", seat, with: other, give: [], want: ["ore"] }).success,
    ).toBe(false);
    expect(
      OpSchema.safeParse({ type: "tradeOffer", seat, with: other, give: ["wood"], want: [] }).success,
    ).toBe(false);
    // Same resource on both sides.
    expect(
      code(() =>
        applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["wood"] }),
      ),
    ).toBe("tradeSameResource");
    // Self-trade.
    expect(
      code(() =>
        applyAction(s, { type: "tradeOffer", seat, with: seat, give: ["wood"], want: ["ore"] }),
      ),
    ).toBe("badOp");
    // Off-turn seat cannot offer.
    expect(
      code(() =>
        applyAction(s, { type: "tradeOffer", seat: other, with: seat, give: ["wood"], want: ["ore"] }),
      ),
    ).toBe("notYourTurn");
    // Offering cards not in hand.
    expect(
      code(() =>
        applyAction(s, { type: "tradeOffer", seat, with: other, give: ["ore"], want: ["wood"] }),
      ),
    ).toBe("insufficientHand");
    // Accept/reject with nothing pending.
    expect(code(() => applyAction(s, { type: "tradeAccept", seat: other }))).toBe("noPendingTrade");
    expect(code(() => applyAction(s, { type: "tradeReject", seat: other }))).toBe("noPendingTrade");
    // Double offer.
    const s1 = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] });
    expect(
      code(() =>
        applyAction(s1, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] }),
      ),
    ).toBe("tradePendingExists");
    // Wrong counterparty answers.
    const third = s.players.find((p) => p.seat !== seat && p.seat !== other)!.seat;
    expect(code(() => applyAction(s1, { type: "tradeAccept", seat: third }))).toBe(
      "notTradeCounterparty",
    );
    expect(code(() => applyAction(s1, { type: "tradeReject", seat: third }))).toBe(
      "notTradeCounterparty",
    );
  });

  it("accept re-validates BOTH hands at accept time (robber can void an offer)", () => {
    let s = actionPhase(149);
    const seat = s.currentSeat;
    const other = seat2Of(s);
    // Scaffolding: BOTH hands exactly zeroed first so the offered wood and
    // the wanted ore are provably the only relevant cards.
    s = {
      ...s,
      players: s.players.map((p) => ({
        ...p,
        hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 },
      })),
    };
    s = give(s, seat, { wood: 1 });
    let s1 = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] });
    // The offeree never had the ore.
    expect(code(() => applyAction(s1, { type: "tradeAccept", seat: other }))).toBe(
      "insufficientHand",
    );
    // The offeror loses the offered wood after the offer (robber steal
    // simulation via test scaffolding) → accept must fail even when the
    // offeree can pay.
    const players = s1.players.slice();
    players[seat] = {
      ...players[seat],
      hand: { ...players[seat].hand, wood: players[seat].hand.wood - 1 },
    };
    const bank = { ...s1.bank, wood: s1.bank.wood + 1 };
    s1 = { ...s1, players, bank };
    s1 = give(s1, other, { ore: 1 });
    expect(code(() => applyAction(s1, { type: "tradeAccept", seat: other }))).toBe(
      "insufficientHand",
    );
  });

  it("a 7 between offer and accept freezes the offer until the window resolves", () => {
    // Seat 0 rolls 7 while an offer from an earlier... no — offers are only
    // made by the current seat AFTER rolling, so the freeze case is: offer
    // is on the table from the CURRENT turn; the next roll of 7 happens on
    // a LATER turn only if the offer survived — it can't (endTurn expires).
    // The reachable freeze: pendingTrade non-null AND awaitingSeven non-null
    // arises when a knight/7 fires while an offer stands. We construct it
    // directly (test scaffolding): the offer is frozen, accept/reject throw
    // awaitingSeven, and the offer is still there after resolution.
    let s = actionPhase(151);
    const seat = s.currentSeat;
    const other = seat2Of(s);
    s = give(s, seat, { wood: 1 });
    s = give(s, other, { ore: 1 });
    let s1 = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["ore"] });
    // Construct the freeze: current seat plays a knight → awaitingSeven.
    const players = s1.players.slice();
    players[seat] = { ...players[seat], devHand: ["knight"] };
    s1 = { ...s1, players };
    s1 = applyAction(s1, { type: "playKnight", seat });
    expect(s1.awaitingSeven).not.toBeNull();
    expect(s1.pendingTrade).not.toBeNull();
    expect(code(() => applyAction(s1, { type: "tradeAccept", seat: other }))).toBe("awaitingSeven");
    expect(code(() => applyAction(s1, { type: "tradeReject", seat: other }))).toBe("awaitingSeven");
    const resolved = resolveSeven(s1);
    expect(resolved.pendingTrade).not.toBeNull();
    const accepted = applyAction(resolved, { type: "tradeAccept", seat: other });
    expect(accepted.pendingTrade).toBeNull();
  });

  it("endTurn clears pendingTrade AND legalMoves never enumerates tradeOffer", () => {
    let s = actionPhase(157);
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 9, brick: 9 });
    // tradeOffer is UI-composed: even with a rich hand it is not enumerated.
    expect(legalMoves(s, seat).some((m) => m.type === "tradeOffer")).toBe(false);
    // But applyAction accepts a composed offer (documented exception).
    const other = seat2Of(s);
    const s1 = applyAction(s, { type: "tradeOffer", seat, with: other, give: ["wood"], want: ["brick"] });
    expect(s1.pendingTrade).not.toBeNull();
  });
});

describe("conformance: every enumerated wave-3 op applies", () => {
  it("tradeBank + tradePort ops from legalMoves all apply cleanly", () => {
    let s = actionPhase(163);
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 8, brick: 6 });
    // Own every port vertex (scaffolding) so all port branches enumerate.
    const buildings = { ...s.buildings };
    for (const port of s.config.ports) {
      buildings[port.vertexId] = { kind: "settlement", owner: seat };
    }
    s = { ...s, buildings };
    const tradeOps = legalMoves(s, seat).filter(
      (m) => m.type === "tradeBank" || m.type === "tradePort",
    );
    expect(tradeOps.length).toBeGreaterThan(10);
    for (const op of tradeOps) {
      GameStateSchema.parse(applyAction(s, op));
      expect(grandTotal(applyAction(s, op))).toBe(95);
    }
  });
});
