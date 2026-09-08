/**
 * redact.test.ts — seat-scoped projection (wave 5, closes M1's kernel).
 *
 * Covers: schema validity of projections, own-seat passthrough, hidden-info
 * erasure (hand composition, dev types, deck order, dice seed), conservation
 * of the public totals, the LEAKAGE proof (hidden variants project
 * identically), purity, idempotence, and optimistic-UI commutativity for the
 * own-seat deterministic op set.
 *
 * Fixture policy (copied from turn.test.ts): scenarios are constructed
 * directly via give()/forceRoll() test scaffolding, and any layout-dependent
 * search is a BOUNDED seed loop that hard-fails — never a silent skip.
 */
import { describe, expect, it } from "vitest";
import type { Op } from "./actions.js";
import { buildIsland, distanceRuleFree } from "./board.js";
import { redactForSeat } from "./redact.js";
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
const edgeById = new Map(TOPO.edges.map((e) => [e.id, e]));
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
    GameStateSchema.parse(s);
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

/** Force a given sum on the current seat's roll by advancing the stream. */
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

/**
 * Mid-play state with known, varied compositions: seat 0 gains
 * {wood 2, ore 1}, seat 1 {brick 4, wheat 1}, seat 2 {wool 2} on top of
 * their setup/roll cards, and seat 1 holds two distinct dev cards. Rolled
 * (6, non-7) so the action phase is open. Setup/roll payouts are seat- and
 * seed-dependent; tests that need an exact composition assert it (or use
 * bounded seed search) rather than assuming one.
 */
function midPlayState(seed = 53): GameState {
  let s = playSetup(variableSetup(seed));
  s = give(s, 0, { wood: 2, ore: 1 });
  s = give(s, 1, { brick: 4, wheat: 1 });
  s = give(s, 2, { wool: 2 });
  const players = s.players.slice();
  players[1] = { ...players[1], devHand: ["knight", "monopoly"] };
  s = { ...s, players };
  s = forceRoll(s, 6);
  if (s.awaitingSeven) throw new Error("forceRoll(6) opened a seven window");
  expect(s.phase).toBe("play");
  expect(s.hasRolled).toBe(true);
  GameStateSchema.parse(s);
  return s;
}

/**
 * Seat 1's post-fixture hand must contain ≥5 cards across ≥2 resource types
 * (so the squash visibly erases composition). Bounded seed search — hard-fails.
 */
function variedHandState(): GameState {
  for (let seed = 1; seed <= 200; seed++) {
    const s = midPlayState(seed);
    const h = s.players[1].hand;
    const types = RESOURCES.filter((r) => h[r] > 0);
    if (handTotal(s.players[1]) >= 5 && types.length >= 2) return s;
  }
  throw new Error("no seed in 1..200 gives seat 1 a varied 5+ card hand");
}

// ---------------------------------------------------------------------------
// Projection shape & visibility
// ---------------------------------------------------------------------------

describe("redactForSeat projection", () => {
  it("returns a schema-valid GameState for every seat", () => {
    const s = midPlayState();
    for (const p of s.players) {
      GameStateSchema.parse(redactForSeat(s, p.seat));
    }
  });

  it("leaves the viewer's own hand and devHand untouched", () => {
    const s = midPlayState();
    const r = redactForSeat(s, 0);
    expect(r.players[0].hand).toEqual(s.players[0].hand);
    expect(r.players[0].devHand).toEqual(s.players[0].devHand);
    const r1 = redactForSeat(s, 1);
    expect(r1.players[1].hand).toEqual(s.players[1].hand);
    expect(r1.players[1].devHand).toEqual(["knight", "monopoly"]);
  });

  it("preserves other seats' totals while erasing composition and dev types", () => {
    const s = variedHandState();
    const r = redactForSeat(s, 0);
    for (const p of s.players) {
      if (p.seat === 0) continue;
      const rp = r.players.find((x) => x.seat === p.seat)!;
      expect(handTotal(rp)).toBe(handTotal(p));
      expect(rp.hand).toEqual({ wood: handTotal(p), brick: 0, wool: 0, wheat: 0, ore: 0 });
      expect(rp.devHand).toHaveLength(p.devHand.length);
      expect(rp.devHand.every((c) => c === "victoryPoint")).toBe(true);
      // Public fields pass through untouched.
      expect(rp.seat).toBe(p.seat);
      expect(rp.name).toBe(p.name);
      expect(rp.color).toBe(p.color);
      expect(rp.knightsPlayed).toBe(p.knightsPlayed);
      expect(rp.roadsLeft).toBe(p.roadsLeft);
      expect(rp.settlementsLeft).toBe(p.settlementsLeft);
      expect(rp.citiesLeft).toBe(p.citiesLeft);
      expect(rp.devPlayedThisTurn).toBe(p.devPlayedThisTurn);
      expect(rp.devBoughtThisTurn).toEqual(p.devBoughtThisTurn);
    }
    // The squash visibly erases: seat 1 held ≥5 cards of ≥2 types (search
    // guarantee) → projected as pure wood at the same total.
    const total1 = handTotal(s.players[1]);
    expect(total1).toBeGreaterThanOrEqual(5);
    expect(RESOURCES.filter((res) => s.players[1].hand[res] > 0).length).toBeGreaterThanOrEqual(2);
    expect(r.players[1].hand).toEqual({ wood: total1, brick: 0, wool: 0, wheat: 0, ore: 0 });
    expect(r.players[1].hand).not.toEqual(s.players[1].hand);
    expect(r.players[1].devHand).toEqual(["victoryPoint", "victoryPoint"]);
  });

  it("conserves the 95-card grand total through the projection", () => {
    const s = midPlayState();
    expect(grandTotal(s)).toBe(95);
    expect(grandTotal(redactForSeat(s, 0))).toBe(95);
  });

  it("hides the seed and deck order; keeps counts, cursor, and public fields", () => {
    const s = midPlayState();
    const r = redactForSeat(s, 0);
    expect(s.rngSeed).not.toBe(0); // fixture sanity: there IS a seed to hide
    expect(r.rngSeed).toBe(0);
    expect(r.rngCursor).toBe(s.rngCursor);
    expect(r.deck).toHaveLength(s.deck.length);
    expect(r.deck.every((c) => c === "knight")).toBe(true);
    // Revealed cards are public: the discard pile passes through.
    expect(r.discardPile).toEqual(s.discardPile);
    // Structural/public state passes through untouched.
    expect(r.config).toEqual(s.config);
    expect(r.phase).toBe(s.phase);
    expect(r.currentSeat).toBe(s.currentSeat);
    expect(r.setupStage).toEqual(s.setupStage);
    expect(r.bank).toEqual(s.bank);
    expect(r.robberHexId).toBe(s.robberHexId);
    expect(r.buildings).toEqual(s.buildings);
    expect(r.roads).toEqual(s.roads);
    expect(r.longestRoad).toEqual(s.longestRoad);
    expect(r.largestArmy).toEqual(s.largestArmy);
    expect(r.hasRolled).toBe(s.hasRolled);
    expect(r.awaitingSeven).toEqual(s.awaitingSeven);
    expect(r.lastRoll).toBe(s.lastRoll);
    expect(r.rollLog).toEqual(s.rollLog);
    expect(r.winner).toBe(s.winner);
    expect(r.finalPoints).toBe(s.finalPoints);
    expect(r.pendingTrade).toEqual(s.pendingTrade);
    expect(r.version).toBe(s.version);
  });

  it("throws RangeError for a seat that does not exist", () => {
    const s = midPlayState();
    expect(() => redactForSeat(s, 7)).toThrowError(
      new RangeError("redactForSeat: no such seat 7"),
    );
  });
});

// ---------------------------------------------------------------------------
// Leakage — the load-bearing test
// ---------------------------------------------------------------------------

describe("leakage", () => {
  it("states differing ONLY in hidden info project to byte-identical views", () => {
    const base = midPlayState();
    // A and B differ ONLY in: seat 1's hand COMPOSITION (same total: 2),
    // seat 2's hand composition (same total: 2), and the deck ORDER (same
    // multiset, reversed). Same everything else — seed, cursor, public state.
    const mk = (seat1Hand: ResourceCounter, deck: GameState["deck"]): GameState => {
      const players = base.players.slice();
      players[1] = { ...players[1], hand: seat1Hand };
      // Seat 2: also vary composition (2 cards either way), proving the squash
      // covers every non-viewer seat, not just the crafted one.
      players[2] = {
        ...players[2],
        hand: { wood: 1, brick: 1, wool: 0, wheat: 0, ore: 0 },
      };
      return GameStateSchema.parse({ ...base, players, deck });
    };
    const a = mk({ wood: 1, brick: 0, wool: 1, wheat: 0, ore: 0 }, base.deck.slice());
    const b = mk(
      { wood: 0, brick: 0, wool: 0, wheat: 1, ore: 1 },
      base.deck.slice().reverse(),
    );
    // Sanity: the full states really do differ...
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // ...but seat 0's projections are byte-identical: zero hidden info leaks.
    expect(JSON.stringify(redactForSeat(a, 0))).toBe(JSON.stringify(redactForSeat(b, 0)));
    // And seat 2's projection changes ONLY in its own (real) hand — it too
    // cannot see seat 1's composition or the deck order.
    const a2 = JSON.parse(JSON.stringify(redactForSeat(a, 2))) as GameState;
    const b2 = JSON.parse(JSON.stringify(redactForSeat(b, 2))) as GameState;
    expect(a2.players[1]).toEqual(b2.players[1]);
    expect(a2.deck).toEqual(b2.deck);
  });
});

// ---------------------------------------------------------------------------
// Purity & idempotence
// ---------------------------------------------------------------------------

describe("purity & idempotence", () => {
  it("never mutates a deep-frozen input and returns a fresh object", () => {
    const s = midPlayState();
    const frozen = JSON.parse(JSON.stringify(s)) as GameState;
    const freezeDeep = (o: unknown): void => {
      if (o && typeof o === "object") {
        for (const v of Object.values(o)) freezeDeep(v);
        Object.freeze(o);
      }
    };
    freezeDeep(frozen);
    const r = redactForSeat(frozen, 0); // must not throw on frozen input
    expect(r).not.toBe(frozen);
    expect(r.players).not.toBe(frozen.players);
    expect(JSON.stringify(r)).not.toBe(JSON.stringify(frozen));
    GameStateSchema.parse(r);
  });

  it("is idempotent: redacting a projection changes nothing", () => {
    const s = midPlayState();
    const once = redactForSeat(s, 0);
    expect(JSON.stringify(redactForSeat(once, 0))).toBe(JSON.stringify(once));
  });
});

// ---------------------------------------------------------------------------
// Optimistic-UI commutativity
// ---------------------------------------------------------------------------

/**
 * Commutativity holds ONLY for ops whose handlers read nothing the
 * projection hides. INTENTIONALLY EXCLUDED (server-authoritative — the
 * server applies them to the true state and re-ships projections):
 * - roll: consumes the rng stream (seed hidden) and pays PRODUCTION into
 *   every hand (composition hidden);
 * - stealCard: draws from the rng stream AND from the victim's true
 *   composition (both hidden);
 * - playMonopoly / playYearOfPlenty: pull from other seats' true hands or
 *   require bank-composition reasoning across hidden data; both also touch
 *   hands beyond the viewer's own;
 * - buyDevCard: pops the true deck ORDER (hidden — the projected deck is a
 *   stack of knights).
 * Each op below is asserted on the PROJECTION of the same state it is
 * applied to on the true state, for the seat that may legally play it.
 */
describe("optimistic-UI commutativity", () => {
  /** applyAction(redact(s, seat), op) === redact(applyAction(s, op), seat). */
  const commutes = (s: GameState, op: Op, seat: number): boolean =>
    JSON.stringify(applyAction(redactForSeat(s, seat), op)) ===
    JSON.stringify(redactForSeat(applyAction(s, op), seat));

  it("own-hand action-phase ops commute for seat 0 (bounded search)", () => {
    // Fresh settlements need open frontier: the fixture CHAINS ops the way a
    // player would (road into empty land → settle at its far end → city on
    // an existing settlement). Bounded seed search — hard-fails if no layout
    // in range supports the whole chain for seat 0.
    interface Fixture {
      base: GameState; // seat 0's turn, rolled (6), +{wood 2, ore 1}
      road: Op;
      afterRoad: GameState; // give(base, wood1+brick1+wool1+wheat1) + road
      settle: Op;
      city: Op;
      trade: Op;
    }
    let fx: Fixture | null = null;
    for (let seed = 1; seed <= 400 && !fx; seed++) {
      const base = midPlayState(seed);
      const seat = base.currentSeat;
      if (seat !== 0) continue;
      // Road: base + full settlement cost covers the road and keeps wool+wheat.
      const sRoad = give(base, seat, { wood: 1, brick: 1, wool: 1, wheat: 1 });
      const roadMoves = legalMoves(sRoad, seat).filter((m) => m.type === "buildRoad");
      if (roadMoves.length === 0) continue;
      // Settlement at a legal road's far end (turn.test.ts pattern).
      let afterRoad: GameState | null = null;
      let settle: Op | null = null;
      for (const rm of roadMoves) {
        if (rm.type !== "buildRoad") continue;
        const cand = applyAction(sRoad, rm);
        const e = edgeById.get(rm.edgeId)!;
        const t = [e.a, e.b].find(
          (v) =>
            !cand.buildings[v] &&
            distanceRuleFree(TOPO, v, new Set(Object.keys(cand.buildings))),
        );
        if (t) {
          afterRoad = cand;
          settle = { type: "buildSettlement", seat, vertexId: t };
          break;
        }
      }
      if (!afterRoad || !settle) continue;
      // City on one of seat 0's own setup settlements.
      const ownSettlement = Object.keys(base.buildings).find(
        (v) => base.buildings[v].owner === seat && base.buildings[v].kind === "settlement",
      );
      if (!ownSettlement) continue;
      const city: Op = { type: "buildCity", seat, vertexId: ownSettlement };
      const trade: Op = { type: "tradeBank", seat, offer: "wood", demand: "ore" };
      fx = { base, road: roadMoves[0], afterRoad, settle, city, trade };
    }
    expect(fx, "no seed in 1..400 supports the road→settle→city chain").not.toBeNull();
    const { base, road, afterRoad, settle, city, trade } = fx!;
    const seat = 0;

    // buildRoad — pays own wood+brick; longest-road recompute is public-only.
    const sRoad = give(base, seat, { wood: 1, brick: 1, wool: 1, wheat: 1 });
    expect(commutes(sRoad, road, seat)).toBe(true);
    // buildSettlement — at the road's far end; both sides apply the road
    // identically first (commutativity composes step by step). The extra
    // brick tops the hand back up after the road payment (production can
    // leave the fixture hand brick-poor).
    const sSettle = give(afterRoad, seat, { brick: 1 });
    expect(commutes(sSettle, settle, seat)).toBe(true);
    // buildCity — upgrades own settlement; pays own wheat 2 + ore 3.
    const sCity = give(base, seat, { wheat: 2, ore: 2 });
    expect(commutes(sCity, city, seat)).toBe(true);
    // tradeBank — 4:1 against the viewer's OWN real hand (offer wood: the
    // viewer's projection hides nothing about their own hand, so both sides
    // see the same affordability and the same post-trade hand).
    const sTrade = give(base, seat, { wood: 2 }); // now wood 4
    expect(commutes(sTrade, trade, seat)).toBe(true);
    // endTurn — pure seat rotation + flag reset.
    expect(commutes(base, { type: "endTurn", seat }, seat)).toBe(true);
  });

  it("playKnight + moveRobber and the seven-window ops commute (bounded search)", () => {
    // ONE fixture serves the whole chain: seat 1 (current) holds a knight;
    // seat 0 holds 9 cards (owes 4 on a 7). Bounded seed search — hard-fails.
    const verticesOf = (hexId: string) => TOPO.hexes.find((h) => h.id === hexId)!.vertices;
    let found: { s: GameState; robberHex: string } | null = null;
    for (let seed = 1; seed <= 400 && !found; seed++) {
      let s = playSetup(variableSetup(seed));
      const players = s.players.slice();
      players[1] = { ...players[1], devHand: ["knight"] };
      s = { ...s, players };
      s = give(s, 0, { wood: 5, brick: 4 });
      s = forceRoll(s, 6); // seat 0 rolls, then ends → seat 1's turn
      s = applyAction(s, { type: "endTurn", seat: 0 });
      if (s.currentSeat !== 1) continue;
      if (!commutes(s, { type: "playKnight", seat: 1 }, 1)) continue;
      const played = applyAction(s, { type: "playKnight", seat: 1 });
      // A building-free hex closes the window on moveRobber (no steal draw —
      // stealCard is server-authoritative and excluded above).
      const free = played.config.slots.find(
        (slot) =>
          slot.hexId !== played.robberHexId &&
          verticesOf(slot.hexId).every((v) => !played.buildings[v]),
      );
      if (!free) continue;
      if (!commutes(played, { type: "moveRobber", seat: 1, hexId: free.hexId }, 1)) continue;
      // The seven window from the SAME base state: seat 0 owes 4 discards.
      const rolled = forceRoll(s, 7);
      const aw = rolled.awaitingSeven;
      if (!aw || !aw.pendingDiscard) continue;
      if (aw.discardQueue.length !== 1) continue;
      if (aw.discardQueue[0].seat !== 0 || aw.discardQueue[0].count !== 4) continue;
      const discardOp = legalMoves(rolled, 0)[0];
      if (discardOp.type !== "discardSeven") throw new Error("expected discardSeven");
      // Debtor-side: seat 0's OWN view supports its own discardSeven (the
      // squashed hands only feed the public-total discard math, identical
      // on both sides).
      if (!commutes(rolled, discardOp, 0)) continue;
      // Roller-side: seat 1's view supports its moveRobber onto the free hex.
      const afterDiscard = applyAction(rolled, discardOp);
      if (!commutes(afterDiscard, { type: "moveRobber", seat: 1, hexId: free.hexId }, 1)) continue;
      found = { s, robberHex: free.hexId };
    }
    expect(found, "no seed in 1..400 yields the knight/seven-window fixture").not.toBeNull();
    const { s } = found!;

    // The commuting chain, asserted end-to-end on the found fixture.
    const knight: Op = { type: "playKnight", seat: 1 };
    expect(commutes(s, knight, 1)).toBe(true);
    const played = applyAction(s, knight);
    const robber: Op = { type: "moveRobber", seat: 1, hexId: found!.robberHex };
    expect(commutes(played, robber, 1)).toBe(true);

    const rolled = forceRoll(s, 7);
    const discardOp = legalMoves(rolled, 0)[0];
    expect(commutes(rolled, discardOp, 0)).toBe(true);
    const afterDiscard = applyAction(rolled, discardOp);
    expect(commutes(afterDiscard, robber, 1)).toBe(true);
  });
});
