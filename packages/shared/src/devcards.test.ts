/**
 * devcards.test.ts — wave 3: buyDevCard, playMonopoly, playRoadBuilding,
 * playYearOfPlenty, the devBoughtLast restriction, one-dev-per-turn, and
 * the devHand immunities (robber steal + discardSeven touch resources only;
 * victoryPoint has no op and is never playable).
 *
 * Test-side state construction follows the give/forceRoll pattern from
 * turn.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ActionError, OpSchema } from "./actions.js";
import { buildIsland } from "./board.js";
import { Rng } from "./rng.js";
import { variableSetup } from "./setup.js";
import {
  GameStateSchema,
  type DevCardType,
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
const devCardTotal = (s: GameState): number =>
  s.deck.length +
  s.discardPile.length +
  s.players.reduce((a, p) => a + p.devHand.length, 0);

function playSetup(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase === "setup") {
    if (++guard > 64) throw new Error("setup did not terminate");
    s = applyAction(s, legalMoves(s, s.currentSeat)[0]);
  }
  return s;
}

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

/** Zero a seat's hand, returning the cards to the bank (exact-hand tests). */
function zeroHand(state: GameState, seat: number): GameState {
  const players = state.players.slice();
  const p = players[seat];
  const bank = { ...state.bank };
  for (const r of RESOURCES) bank[r] += p.hand[r];
  players[seat] = { ...p, hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 } };
  return { ...state, players, bank };
}

/** Set a seat's devHand (test scaffolding). */
function withDevHand(state: GameState, seat: number, devHand: DevCardType[]): GameState {
  const players = state.players.slice();
  players[seat] = { ...players[seat], devHand };
  return { ...state, players };
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

describe("buyDevCard", () => {
  it("pays ore+wool+wheat to the bank, draws the TOP of the deck, sets devBoughtLast", () => {
    let s = actionPhase(201);
    const seat = s.currentSeat;
    s = give(s, seat, { ore: 1, wool: 1, wheat: 1 });
    const top = s.deck[0];
    const before = grandTotal(s);
    const s1 = applyAction(s, { type: "buyDevCard", seat });
    GameStateSchema.parse(s1);
    expect(s1.players[seat].devHand).toEqual([...s.players[seat].devHand, top]);
    expect(s1.players[seat].devBoughtLast).toBe(top);
    expect(s1.deck).toEqual(s.deck.slice(1));
    expect(s1.deck).toHaveLength(s.deck.length - 1);
    for (const r of ["ore", "wool", "wheat"] as const) {
      expect(s1.players[seat].hand[r]).toBe(s.players[seat].hand[r] - 1);
      expect(s1.bank[r]).toBe(s.bank[r] + 1);
    }
    expect(grandTotal(s1)).toBe(before);
    expect(devCardTotal(s1)).toBe(25);
  });

  it("rejects: deck empty, insufficient hand, off-turn, pre-roll, during seven", () => {
    let s = actionPhase(203);
    const seat = s.currentSeat;
    const other = (seat + 1) % s.players.length;
    const rich = give(s, seat, { ore: 1, wool: 1, wheat: 1 });
    // deckEmpty
    const emptyDeck = { ...rich, deck: [] as DevCardType[] };
    expect(code(() => applyAction(emptyDeck, { type: "buyDevCard", seat }))).toBe("deckEmpty");
    // insufficientHand (missing ore)
    expect(code(() => applyAction(s, { type: "buyDevCard", seat }))).toBe("insufficientHand");
    // off-turn
    expect(code(() => applyAction(rich, { type: "buyDevCard", seat: other }))).toBe("notYourTurn");
    // pre-roll
    const pre = playSetup(variableSetup(203));
    expect(code(() => applyAction(pre, { type: "buyDevCard", seat: pre.currentSeat }))).toBe(
      "notRolledYet",
    );
    // during a seven window
    const frozen: GameState = {
      ...rich,
      awaitingSeven: {
        roller: seat,
        pendingDiscard: false,
        mustMoveRobber: true,
        discardQueue: [],
      },
    };
    expect(code(() => applyAction(frozen, { type: "buyDevCard", seat }))).toBe("awaitingSeven");
  });
});

describe("devBoughtLast restriction", () => {
  it("a card bought this turn cannot be played; an identical OLDER card can", () => {
    let s = actionPhase(211);
    const seat = s.currentSeat;
    // Rig the deck so the top card is a knight.
    s = { ...s, deck: ["knight", ...s.deck.filter((c) => c !== "knight")] };
    s = give(s, seat, { ore: 2, wool: 2, wheat: 2 });
    // Case A: fresh hand — bought knight is the ONLY knight → unplayable.
    let s1 = applyAction(s, { type: "buyDevCard", seat });
    expect(s1.players[seat].devBoughtLast).toBe("knight");
    expect(code(() => applyAction(s1, { type: "playKnight", seat }))).toBe("noDevCard");
    expect(legalMoves(s1, seat).some((m) => m.type === "playKnight")).toBe(false);
    // Case B: an older knight sat in hand before the buy → playable.
    const sB = withDevHand(s, seat, ["knight"]);
    let s2 = applyAction(sB, { type: "buyDevCard", seat });
    expect(s2.players[seat].devHand).toEqual(["knight", "knight"]);
    s2 = applyAction(s2, { type: "playKnight", seat });
    expect(s2.players[seat].devHand).toEqual(["knight"]); // the bought one stays
    expect(s2.discardPile).toEqual(["knight"]);
    // endTurn clears devBoughtLast: next turn the card is playable.
    const s3 = applyAction(s1, { type: "endTurn", seat });
    expect(s3.players[seat].devBoughtLast).toBeNull();
  });

  it("endTurn clears devPlayedThisTurn AND devBoughtLast AND pendingTrade together", () => {
    let s = actionPhase(213);
    const seat = s.currentSeat;
    s = { ...s, deck: ["knight", ...s.deck.slice(1)] };
    s = give(s, seat, { ore: 1, wool: 1, wheat: 1, wood: 1 });
    let s1 = applyAction(s, { type: "buyDevCard", seat });
    // Leave a domestic offer standing.
    s1 = applyAction(s1, {
      type: "tradeOffer",
      seat,
      with: (seat + 1) % s1.players.length,
      give: ["wood"],
      want: ["ore"],
    });
    const s2 = applyAction(s1, { type: "endTurn", seat });
    expect(s2.players[seat].devPlayedThisTurn).toBe(false);
    expect(s2.players[seat].devBoughtLast).toBeNull();
    expect(s2.pendingTrade).toBeNull();
  });
});

describe("playMonopoly", () => {
  it("takes ALL copies of the resource from every other player; bank untouched", () => {
    let s = actionPhase(223);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["monopoly"]);
    // Rig hands: strip ALL wheat first, then give the others known totals.
    const zeroWheat: GameState = {
      ...s,
      players: s.players.map((p) => ({ ...p, hand: { ...p.hand, wheat: 0 } })),
      bank: {
        ...s.bank,
        wheat: s.bank.wheat + s.players.reduce((a, p) => a + p.hand.wheat, 0),
      },
    };
    GameStateSchema.parse(zeroWheat);
    s = zeroWheat;
    const others = s.players.map((p) => p.seat).filter((x) => x !== seat);
    s = give(s, others[0], { wheat: 2 });
    if (others[1] !== undefined) s = give(s, others[1], { wheat: 3 });
    const expected = others.reduce((a, o) => a + s.players[o].hand.wheat, 0);
    const before = grandTotal(s);
    const seatBefore = s.players[seat].hand.wheat;
    const cardsBefore = devCardTotal(s);
    const s1 = applyAction(s, { type: "playMonopoly", seat, resource: "wheat" });
    GameStateSchema.parse(s1);
    expect(s1.players[seat].hand.wheat).toBe(seatBefore + expected);
    for (const o of others) {
      expect(s1.players[o].hand.wheat, `seat ${o} must be stripped of wheat`).toBe(0);
    }
    expect(s1.bank).toEqual(s.bank);
    expect(grandTotal(s1)).toBe(before);
    expect(s1.discardPile).toEqual(["monopoly"]);
    expect(s1.players[seat].devPlayedThisTurn).toBe(true);
    expect(s1.players[seat].devHand).toEqual([]);
    expect(devCardTotal(s1)).toBe(cardsBefore);
  });

  it("rejects without the card, and a second dev the same turn", () => {
    let s = actionPhase(227);
    const seat = s.currentSeat;
    expect(code(() => applyAction(s, { type: "playMonopoly", seat, resource: "ore" }))).toBe(
      "noDevCard",
    );
    // One dev per turn: after monopoly, a knight is refused.
    s = withDevHand(s, seat, ["monopoly", "knight"]);
    const s1 = applyAction(s, { type: "playMonopoly", seat, resource: "ore" });
    expect(code(() => applyAction(s1, { type: "playKnight", seat }))).toBe("devAlreadyPlayed");
    // legalMoves agrees.
    expect(legalMoves(s1, seat).some((m) => m.type === "playKnight")).toBe(false);
  });

  it("is playable PRE-ROLL (production phase), like the knight", () => {
    let s = playSetup(variableSetup(229));
    const seat = s.currentSeat;
    expect(s.hasRolled).toBe(false);
    s = withDevHand(s, seat, ["monopoly"]);
    const s1 = applyAction(s, { type: "playMonopoly", seat, resource: "brick" });
    expect(s1.hasRolled).toBe(false);
    expect(s1.players[seat].devPlayedThisTurn).toBe(true);
    // Rolling is still available.
    expect(legalMoves(s1, seat).some((m) => m.type === "roll")).toBe(true);
  });
});

describe("playRoadBuilding", () => {
  it("places two roads free of charge, anchored to the PRE-existing network", () => {
    let s = actionPhase(233);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["roadBuilding"]);
    const candidates = legalMoves(s, seat).filter((m) => m.type === "playRoadBuilding");
    expect(candidates.length).toBeGreaterThan(0);
    const two = candidates.find((m) => m.type === "playRoadBuilding" && m.edgeIds.length === 2);
    expect(two, "no 2-edge roadBuilding candidate").toBeDefined();
    if (two!.type !== "playRoadBuilding") throw new Error("unreachable");
    const before = grandTotal(s);
    const roadsLeft = s.players[seat].roadsLeft;
    const cardsBefore = devCardTotal(s);
    const s1 = applyAction(s, two!);
    GameStateSchema.parse(s1);
    for (const eId of two!.edgeIds) {
      expect(s1.roads[eId]).toEqual({ owner: seat });
    }
    expect(s1.players[seat].roadsLeft).toBe(roadsLeft - 2);
    expect(s1.players[seat].hand).toEqual(s.players[seat].hand); // no cost
    expect(grandTotal(s1)).toBe(before);
    expect(s1.discardPile).toEqual(["roadBuilding"]);
    expect(devCardTotal(s1)).toBe(cardsBefore);
  });

  it("rejects chaining: an edge only touching the OTHER new edge is illegal", () => {
    let s = actionPhase(239);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["roadBuilding"]);
    const edgeById = new Map(TOPO.edges.map((e) => [e.id, e]));
    // Find e1 (legal now) and e2 that touches e1's far end but is NOT
    // legal now — i.e. e2 would only be legal after e1 lands (chaining).
    const legalNow = new Set(
      TOPO.edges
        .filter((e) => {
          // mirror of roadPlacementLegal: empty + touches the seat network
          if (s.roads[e.id]) return false;
          const net = new Set<string>();
          for (const [id, r] of Object.entries(s.roads)) {
            if (r.owner !== seat) continue;
            const x = edgeById.get(id)!;
            net.add(x.a);
            net.add(x.b);
          }
          for (const vId of Object.keys(s.buildings)) {
            if (s.buildings[vId].owner === seat) net.add(vId);
          }
          return net.has(e.a) || net.has(e.b);
        })
        .map((e) => e.id),
    );
    expect(legalNow.size).toBeGreaterThan(0);
    let chain: [string, string] | null = null;
    for (const e1Id of legalNow) {
      const e1 = edgeById.get(e1Id)!;
      for (const far of [e1.a, e1.b]) {
        const v = TOPO.vertices.find((x) => x.id === far)!;
        for (const e2Id of v.edges) {
          if (e2Id === e1Id || legalNow.has(e2Id) || s.roads[e2Id]) continue;
          chain = [e1Id, e2Id];
          break;
        }
        if (chain) break;
      }
      if (chain) break;
    }
    expect(chain, "no chaining pair found in this layout").not.toBeNull();
    expect(
      code(() => applyAction(s, { type: "playRoadBuilding", seat, edgeIds: chain! })),
    ).toBe("notConnected");
  });

  it("rejects with 0 roadsLeft (and with 1 road left for a 2-edge request)", () => {
    let s = actionPhase(241);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["roadBuilding"]);
    const none = {
      ...s,
      players: s.players.map((p, i) => (i === seat ? { ...p, roadsLeft: 0 } : p)),
    };
    expect(
      code(() =>
        applyAction(none, { type: "playRoadBuilding", seat, edgeIds: [TOPO.edges[0].id] }),
      ),
    ).toBe("noRoadsLeft");
    expect(
      legalMoves(none, seat).some((m) => m.type === "playRoadBuilding"),
    ).toBe(false);
    const one = {
      ...s,
      players: s.players.map((p, i) => (i === seat ? { ...p, roadsLeft: 1 } : p)),
    };
    expect(
      code(() =>
        applyAction(one, {
          type: "playRoadBuilding",
          seat,
          edgeIds: [TOPO.edges[0].id, TOPO.edges[1].id],
        }),
      ),
    ).toBe("noRoadsLeft");
    // With 1 road left, legalMoves enumerates only single-edge plays.
    const singles = legalMoves(one, seat).filter((m) => m.type === "playRoadBuilding");
    expect(singles.length).toBeGreaterThan(0);
    expect(singles.every((m) => m.type === "playRoadBuilding" && m.edgeIds.length === 1)).toBe(true);
    // Duplicate edge ids are rejected loudly.
    expect(
      code(() =>
        applyAction(s, {
          type: "playRoadBuilding",
          seat,
          edgeIds: [TOPO.edges[0].id, TOPO.edges[0].id],
        }),
      ),
    ).toBe("badOp");
  });
});

describe("playYearOfPlenty", () => {
  it("takes any 2 cards from the bank — pair or double-same", () => {
    let s = actionPhase(251);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["yearOfPlenty"]);
    const before = grandTotal(s);
    const cardsBefore = devCardTotal(s);
    const s1 = applyAction(s, { type: "playYearOfPlenty", seat, cards: ["ore", "wheat"] });
    expect(s1.players[seat].hand.ore).toBe(s.players[seat].hand.ore + 1);
    expect(s1.players[seat].hand.wheat).toBe(s.players[seat].hand.wheat + 1);
    expect(s1.bank.ore).toBe(s.bank.ore - 1);
    expect(s1.bank.wheat).toBe(s.bank.wheat - 1);
    expect(grandTotal(s1)).toBe(before);
    expect(s1.discardPile).toEqual(["yearOfPlenty"]);
    // Double-same (rig a second card via a fresh state).
    let s2 = withDevHand(actionPhase(251), seat, ["yearOfPlenty"]);
    s2 = applyAction(s2, { type: "playYearOfPlenty", seat, cards: ["brick", "brick"] });
    expect(s2.bank.brick).toBe(s.bank.brick - 2);
    expect(devCardTotal(s2)).toBe(cardsBefore);
  });

  it("rejects when the bank cannot cover (incl. only-1-left for a double)", () => {
    let s = actionPhase(257);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["yearOfPlenty"]);
    const dry = { ...s, bank: { ...s.bank, ore: 1 } };
    expect(
      code(() => applyAction(dry, { type: "playYearOfPlenty", seat, cards: ["ore", "ore"] })),
    ).toBe("insufficientBank");
    const ok = applyAction(dry, { type: "playYearOfPlenty", seat, cards: ["ore", "wood"] });
    expect(ok.bank.ore).toBe(0);
  });
});

describe("devHand immunities and victoryPoint", () => {
  it("robber stealCard draws from RESOURCE hand only — devHand is immune", () => {
    let s = actionPhase(263);
    const seat = s.currentSeat;
    const other = (seat + 1) % s.players.length;
    s = withDevHand(s, other, ["knight", "victoryPoint", "monopoly"]);
    // Construct the steal-pending window directly (test scaffolding):
    // robber sits on a hex where `other` has a building.
    const hexWithOther = s.config.slots.find((slot) =>
      TOPO.hexes
        .find((h) => h.id === slot.hexId)!
        .vertices.some((v) => s.buildings[v]?.owner === other),
    );
    expect(hexWithOther, "no hex with an offeree building").toBeDefined();
    let s1: GameState = {
      ...s,
      robberHexId: hexWithOther!.hexId,
      awaitingSeven: {
        roller: seat,
        pendingDiscard: false,
        mustMoveRobber: false,
        discardQueue: [],
      },
    };
    GameStateSchema.parse(s1);
    const victimMoves = legalMoves(s1, seat).filter((m) => m.type === "stealCard");
    expect(victimMoves.length).toBeGreaterThan(0);
    const steal = victimMoves.find((m) => m.type === "stealCard" && m.victimSeat === other);
    if (steal) {
      s1 = applyAction(s1, steal);
      expect(s1.players[other].devHand).toEqual(["knight", "victoryPoint", "monopoly"]);
    }
  });

  it("discardSeven validates resource cards only — dev cards cannot be discarded", () => {
    let s = playSetup(variableSetup(267));
    s = withDevHand(s, 1, ["knight"]);
    s = give(s, 1, { wood: 8 }); // 8+ cards → owes discards
    const rolled = forceRoll(s, 7);
    const entry = rolled.awaitingSeven!.discardQueue.find((q) => q.seat === 1);
    expect(entry).toBeDefined();
    // Enumerated discards are resource arrays only; the knight survives.
    const s1 = applyAction(rolled, legalMoves(rolled, 1)[0]);
    expect(s1.players[1].devHand).toEqual(["knight"]);
    // OpSchema has no way to name a dev card in a discard — structural.
    expect(
      OpSchema.safeParse({ type: "discardSeven", seat: 1, cards: ["knight"] }).success,
    ).toBe(false);
  });

  it("victoryPoint is never playable: no op exists; it idles in devHand all game", () => {
    let s = actionPhase(269);
    const seat = s.currentSeat;
    s = withDevHand(s, seat, ["victoryPoint"]);
    // No enumerated op can touch it.
    const moves = legalMoves(s, seat);
    expect(moves.some((m) => m.type.startsWith("play"))).toBe(false);
    // There is no generic playDevCard op; a hand-rolled one fails to parse.
    expect(
      OpSchema.safeParse({ type: "playDevCard", seat, card: "victoryPoint" }).success,
    ).toBe(false);
    // Buying keeps it company; both stay put.
    s = { ...s, deck: ["knight", ...s.deck.slice(1)] };
    s = give(s, seat, { ore: 1, wool: 1, wheat: 1 });
    const s1 = applyAction(s, { type: "buyDevCard", seat });
    expect(s1.players[seat].devHand).toEqual(["victoryPoint", "knight"]);
    expect(devCardTotal(s1)).toBe(devCardTotal(s));
  });
});
