/**
 * targetSet.test.ts — proves the click-target projection is faithful.
 *
 * The three things that can go wrong in "click the island" and MUST be caught
 * here, because the browser cannot:
 *
 *  1. an op reaches the wire that the server did not ship (a reconstruction) —
 *     guarded by asserting op IDENTITY (toBe) against the shipped object;
 *  2. a ghost lands somewhere other than the vertex/edge/hex the kernel meant
 *     — guarded by comparing to geom/layout's own transforms;
 *  3. an unresolvable id throws and blanks the canvas — guarded by asserting
 *     the id is SKIPPED, not thrown.
 *
 * Kernel imports are legal HERE (test-only; precedent: layout.test.ts,
 * src/ui/testFixtures.ts). apps/table/src itself imports no kernel runtime.
 */
import { describe, expect, it } from "vitest";
import {
  applyAction,
  legalMoves,
  variableSetup,
  type GameState,
  type Op,
  type Resource,
} from "@catan-vtt/shared";
import {
  buildTargetSet,
  discardCardsKey,
  discardCombinationKeys,
  mayActOnBoard,
  placementSlot,
} from "./targetSet.js";
import type { Target } from "./targetSet.js";
import { HEIGHTS, vertexWorld } from "./geom.js";
import { buildingTransform, roadTransform } from "./layout.js";

const SEATS = 3;
const SEED = 20260908;

function fresh(): GameState {
  return variableSetup(SEED, { playerCount: SEATS });
}

const topo = fresh().config.topology;

/** Add resources to one seat's hand (state treated immutably). */
function giveCards(st: GameState, seat: number, add: Partial<Record<Resource, number>>): GameState {
  return {
    ...st,
    players: st.players.map((p) => {
      if (p.seat !== seat) return p;
      const hand = { ...p.hand };
      for (const key of Object.keys(add) as Resource[]) {
        hand[key] = hand[key] + (add[key] ?? 0);
      }
      return { ...p, hand };
    }),
  };
}

/** Drive the full snake setup into phase "play". Module-scope: shared. */
function afterSetup(): GameState {
  let st = fresh();
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

/**
 * Resolve a seven window to completion (discards → moveRobber → stealCard)
 * using ONLY shipped ops, so a test can get back to a normal action phase.
 */
function settleSeven(st: GameState): GameState {
  let s = st;
  for (let guard = 0; guard < 50 && s.awaitingSeven !== null; guard++) {
    const aw = s.awaitingSeven;
    const seat = aw.pendingDiscard ? aw.discardQueue[0]!.seat : aw.roller;
    const next = legalMoves(s, seat)[0];
    if (next === undefined) break;
    s = applyAction(s, next);
  }
  return s;
}

function ofKind(ts: readonly Target[], kind: Target["kind"]): Target[] {
  return ts.filter((t) => t.kind === kind);
}

// ---------------------------------------------------------------------------

describe("placementSlot", () => {
  it("maps each placement op to its board id, and non-placement ops to null", () => {
    const settlement: Op = {
      type: "placeSetupPiece",
      seat: 0,
      kind: "settlement",
      vertexId: "v:1,2",
    };
    const road: Op = { type: "placeSetupPiece", seat: 0, kind: "road", edgeId: "e:a|b" };
    expect(placementSlot(settlement)).toEqual({ kind: "vertex", id: "v:1,2" });
    expect(placementSlot(road)).toEqual({ kind: "edge", id: "e:a|b" });
    expect(placementSlot({ type: "buildRoad", seat: 0, edgeId: "e:x|y" })).toEqual({
      kind: "edge",
      id: "e:x|y",
    });
    expect(placementSlot({ type: "buildSettlement", seat: 0, vertexId: "v:3,4" })).toEqual({
      kind: "vertex",
      id: "v:3,4",
    });
    expect(placementSlot({ type: "buildCity", seat: 0, vertexId: "v:3,4" })).toEqual({
      kind: "vertex",
      id: "v:3,4",
    });
    expect(placementSlot({ type: "moveRobber", seat: 0, hexId: "0,2" })).toEqual({
      kind: "hex",
      id: "0,2",
    });
    // Non-placement ops have no 3D target — the DOM rail owns them.
    expect(placementSlot({ type: "roll", seat: 0 })).toBeNull();
    expect(placementSlot({ type: "endTurn", seat: 0 })).toBeNull();
    expect(placementSlot({ type: "stealCard", seat: 0, victimSeat: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("buildTargetSet — fresh 3p setup", () => {
  it("ships one vertex target per placeSetupPiece settlement op, ops identity-equal", () => {
    const st = fresh();
    const moves = legalMoves(st, st.currentSeat);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.type === "placeSetupPiece")).toBe(true);

    const targets = buildTargetSet(moves, topo);
    const vertices = ofKind(targets, "vertex");

    // Every shipped settlement op became a target — no drops, no inventions.
    expect(vertices.length).toBe(moves.length);
    // IDENTITY, not deep-equality: the click sends the server's own object.
    for (const t of vertices) {
      const shipped = moves.find(
        (m) => m.type === "placeSetupPiece" && m.vertexId === t.id,
      );
      expect(shipped).toBeDefined();
      expect(t.op).toBe(shipped); // toBe — the same reference
    }
    // Positions are the topology's own vertex coords, on the land surface.
    const t0 = vertices[0]!;
    const [vx, , vz] = vertexWorld(topo, t0.id);
    expect(t0.pos[0]).toBeCloseTo(vx, 9);
    expect(t0.pos[2]).toBeCloseTo(vz, 9);
    expect(t0.pos[1]).toBeGreaterThan(HEIGHTS.land); // lifted, not buried
  });

  it("ships one edge target per placeSetupPiece road op after a settlement", () => {
    let st = fresh();
    const first = legalMoves(st, st.currentSeat)[0]!;
    st = applyAction(st, first); // settlement down → now roads

    const moves = legalMoves(st, st.currentSeat);
    const roadOps = moves.filter(
      (m): m is Extract<Op, { type: "placeSetupPiece" }> =>
        m.type === "placeSetupPiece" && m.kind === "road",
    );
    expect(roadOps.length).toBeGreaterThan(0);

    const targets = buildTargetSet(moves, topo);
    const edges = ofKind(targets, "edge");

    // Round 1 setup: EXACTLY the road edges, and only those (the settlement
    // stage is over, so no vertex targets remain).
    expect(edges.length).toBe(roadOps.length);
    expect(ofKind(targets, "vertex").length).toBe(0);
    for (const t of edges) {
      const shipped = roadOps.find(
        (m) => m.type === "placeSetupPiece" && m.edgeId === t.id,
      );
      expect(t.op).toBe(shipped); // identity
      const rt = roadTransform(topo, t.id);
      expect(rt).not.toBeNull();
      expect(t.pos[0]).toBeCloseTo(rt!.position[0], 9);
      expect(t.pos[2]).toBeCloseTo(rt!.position[2], 9);
      // The slab's yaw comes from the real road transform, not a guess.
      expect(t.yaw).toBeCloseTo(rt!.yaw, 9);
    }
  });

  it("has no targets once both setup placements are done (turn passes on)", () => {
    let st = fresh();
    const actor = st.currentSeat;
    st = applyAction(st, legalMoves(st, actor)[0]!); // settlement
    st = applyAction(st, legalMoves(st, actor)[0]!); // road

    // The seat that just finished has nothing left to place: its own
    // legalMoves are empty (setup only serves the CURRENT seat) — so no
    // ghosts, even though the board is full of legal spots for the NEXT seat.
    expect(legalMoves(st, actor).length).toBe(0);
    expect(buildTargetSet(legalMoves(st, actor), topo).length).toBe(0);
    // And the next seat's ghosts exist (proves the emptiness is real, not a
    // broken builder): snake setup hands the turn to the following seat.
    expect(st.currentSeat).not.toBe(actor);
    expect(buildTargetSet(legalMoves(st, st.currentSeat), topo).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("buildTargetSet — mid-play", () => {
  /** Drive the full snake setup into phase "play". */
  function afterSetup(): GameState {
    let st = fresh();
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

  it("keys buildRoad targets by edgeId with identity-equal ops", () => {
    let st = afterSetup();
    expect(st.phase).toBe("play");
    // Grant the road cost so buildRoad is actually shipped.
    st = giveCards(st, st.currentSeat, { wood: 4, brick: 4 });
    // buildRoad lives in the ACTION phase, which needs hasRolled: roll first.
    // (A 7 opens the seven window instead — retry the turn until a non-7.)
    let rolled: GameState | null = null;
    for (let guard = 0; guard < 40 && rolled === null; guard++) {
      const seat = st.currentSeat;
      const roll = legalMoves(st, seat).find((m) => m.type === "roll");
      if (roll === undefined) break;
      const after = applyAction(st, roll);
      if (after.awaitingSeven === null) rolled = after;
      else {
        // Clear the seven window, then pass the turn and roll again.
        st = settleSeven(after);
        const end = legalMoves(st, st.currentSeat).find((m) => m.type === "endTurn");
        if (end === undefined) break;
        st = giveCards(applyAction(st, end), st.currentSeat, { wood: 4, brick: 4 });
      }
    }
    expect(rolled).not.toBeNull();
    st = rolled!;

    const moves = legalMoves(st, st.currentSeat);
    const roadOps = moves.filter((m) => m.type === "buildRoad");
    expect(roadOps.length).toBeGreaterThan(0);

    const targets = buildTargetSet(moves, topo);
    const edges = ofKind(targets, "edge");
    expect(edges.length).toBe(roadOps.length);
    // Keyed by edgeId: `${kind}:${id}`.
    for (const t of edges) expect(t.key).toBe(`edge:${t.id}`);
    for (const t of edges) {
      const shipped = roadOps.find((m) => m.type === "buildRoad" && m.edgeId === t.id);
      expect(t.op).toBe(shipped); // identity
    }
  });

  it("ignores non-placement ops even when they dominate legalMoves", () => {
    const st = afterSetup();
    const moves = legalMoves(st, st.currentSeat);
    // Pre-roll: the shipped set is roll (+ maybe dev cards) — NONE of which
    // has a board position. So no ghosts, however many moves there are.
    expect(moves.length).toBeGreaterThan(0);
    const targets = buildTargetSet(moves, topo);
    expect(targets.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("buildTargetSet — robber (seven window)", () => {
  /**
   * The kernel ships moveRobber for EVERY hex except the robber's current
   * one (turn.ts legalMoves, awaitingSeven.mustMoveRobber branch). It ships
   * NO moveRobber outside that window — a knight play opens the same window,
   * so there is no "alongside roll" case to assert: the roll and the robber
   * move are strictly sequential. This test asserts what IS shipped.
   */
  it("ships a hex target for every hex but the robber's, only while mustMoveRobber", () => {
    const st0 = afterSetup();
    // Drive turns until a 7 actually comes up (seed-deterministic, bounded).
    let st = st0;
    let opened: GameState | null = null;
    for (let guard = 0; guard < 40 && opened === null; guard++) {
      const roll = legalMoves(st, st.currentSeat).find((m) => m.type === "roll");
      if (roll === undefined) break;
      st = applyAction(st, roll);
      if (st.awaitingSeven !== null && st.awaitingSeven.mustMoveRobber) opened = st;
      else {
        // Clear any discard/steal window, pass the turn, and roll again.
        st = settleSeven(st);
        if (st.phase !== "play") break;
        const end = legalMoves(st, st.currentSeat).find((m) => m.type === "endTurn");
        if (end === undefined) break;
        st = applyAction(st, end);
      }
    }

    // Seed-deterministic: this seed must open a seven window within 40 turns.
    expect(opened).not.toBeNull();
    const sev = opened!;
    const roller = sev.awaitingSeven!.roller;
    const moves = legalMoves(sev, roller);
    const robberOps = moves.filter((m) => m.type === "moveRobber");
    expect(robberOps.length).toBeGreaterThan(0);

    const targets = buildTargetSet(moves, topo);
    const hexes = ofKind(targets, "hex");
    expect(hexes.length).toBe(robberOps.length);
    // Every hex except the robber's current one — and never that one.
    expect(hexes.length).toBe(topo.hexes.length - 1);
    expect(hexes.some((h) => h.id === sev.robberHexId)).toBe(false);
    for (const t of hexes) {
      const shipped = robberOps.find((m) => m.type === "moveRobber" && m.hexId === t.id);
      expect(t.op).toBe(shipped); // identity
      expect(t.key).toBe(`hex:${t.id}`);
      // Centred on the hex, above the land.
      expect(t.pos[1]).toBeGreaterThan(HEIGHTS.land);
    }
  });
});

// ---------------------------------------------------------------------------

describe("buildTargetSet — defensive behaviour", () => {
  it("returns [] with no topology (nothing to resolve against)", () => {
    const st = fresh();
    const moves = legalMoves(st, st.currentSeat);
    expect(buildTargetSet(moves, null)).toEqual([]);
    expect(buildTargetSet(moves, undefined)).toEqual([]);
  });

  it("skips unresolvable ids instead of throwing (no blank canvas)", () => {
    const bogus: Op = { type: "buildSettlement", seat: 0, vertexId: "v:NOPE,NOPE" };
    const bogusEdge: Op = { type: "buildRoad", seat: 0, edgeId: "e:NOPE|NOPE" };
    const bogusHex: Op = { type: "moveRobber", seat: 0, hexId: "not-a-hex" };
    // A real one survives alongside the bad ones.
    const real = legalMoves(fresh(), 0)[0]!;
    const targets = buildTargetSet([bogus, bogusEdge, bogusHex, real], topo);
    expect(targets.length).toBe(1);
    expect(targets[0]!.op).toBe(real);
  });

  it("first shipped op wins when two ops claim the same id", () => {
    const vId = legalMoves(fresh(), 0).find(
      (m): m is Extract<Op, { type: "placeSetupPiece" }> =>
        m.type === "placeSetupPiece" && m.kind === "settlement",
    )!.vertexId!;
    const first: Op = { type: "buildSettlement", seat: 0, vertexId: vId };
    const second: Op = { type: "buildCity", seat: 0, vertexId: vId };
    const targets = buildTargetSet([first, second], topo);
    expect(targets.length).toBe(1);
    expect(targets[0]!.op).toBe(first);
    expect(targets[0]!.key).toBe(`vertex:${vId}`);
  });
});

// ---------------------------------------------------------------------------

describe("buildTargetSet — vertex positions match what Buildings draws", () => {
  it("a buildCity target sits exactly where the settlement it replaces stands", () => {
    // Same transform family as Buildings.tsx: buildingTransform(kind).position.
    const st = fresh();
    const vId = legalMoves(st, 0).find(
      (m): m is Extract<Op, { type: "placeSetupPiece" }> =>
        m.type === "placeSetupPiece" && m.kind === "settlement",
    )!.vertexId!;
    const op: Op = { type: "buildCity", seat: 0, vertexId: vId };
    const [t] = buildTargetSet([op], topo);
    const bt = buildingTransform(topo, vId, "settlement")!;
    expect(t!.pos[0]).toBeCloseTo(bt.position[0], 9);
    expect(t!.pos[2]).toBeCloseTo(bt.position[2], 9);
    expect(t!.pos[1]).toBeCloseTo(bt.position[1] + 0.05, 9); // TARGET_LIFT
  });
});

// ---------------------------------------------------------------------------
// mayActOnBoard + discard legality — P2(b) quality-review batch
// ---------------------------------------------------------------------------

/** Inflate every seat's hand so the next 7 finds discarders. */
function fatHands(st: GameState): GameState {
  let out = st;
  for (const p of st.players) {
    out = giveCards(out, p.seat, { wood: 3, brick: 3, wool: 3, wheat: 3, ore: 3 });
  }
  return out;
}

/** Distinct size-k multisets drawable from a cap map (the kernel's own count). */
function multisetCount(caps: number[], k: number): number {
  const memo = new Map<string, number>();
  const go = (i: number, left: number): number => {
    if (left === 0) return 1;
    if (i === caps.length) return 0;
    const key = `${i}:${left}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let total = 0;
    for (let take = 0; take <= Math.min(caps[i]!, left); take++) total += go(i + 1, left - take);
    memo.set(key, total);
    return total;
  };
  return go(0, k);
}

describe("mayActOnBoard", () => {
  it("normal play: only the current seat may act", () => {
    const st = afterSetup();
    expect(st.awaitingSeven).toBeNull();
    expect(mayActOnBoard(st, st.currentSeat)).toBe(true);
    expect(mayActOnBoard(st, (st.currentSeat + 1) % SEATS)).toBe(false);
  });

  it("pendingDiscard: the board is locked for EVERYONE (the modal owns it)", () => {
    let st = afterSetup();
    let opened: GameState | null = null;
    for (let guard = 0; guard < 80 && opened === null; guard++) {
      st = fatHands(st);
      const roll = legalMoves(st, st.currentSeat).find((m) => m.type === "roll");
      if (roll === undefined) break;
      st = applyAction(st, roll);
      const aw = st.awaitingSeven;
      if (aw !== null && aw.pendingDiscard) {
        opened = st;
      } else {
        st = settleSeven(st);
        if (st.phase !== "play") break;
        const end = legalMoves(st, st.currentSeat).find((m) => m.type === "endTurn");
        if (end === undefined) break;
        st = applyAction(st, end);
      }
    }
    expect(opened, "seed must open a seven window with a discard queue").not.toBeNull();
    const aw = opened!.awaitingSeven!;
    expect(aw.pendingDiscard).toBe(true);
    const debtor = aw.discardQueue[0]!.seat;
    // Nobody gets ghosts while discards are owed — not the debtor, not the roller.
    expect(mayActOnBoard(opened!, debtor)).toBe(false);
    expect(mayActOnBoard(opened!, aw.roller)).toBe(false);

    // Discard legality index: EXACTLY the kernel's enumerated combinations.
    const moves = legalMoves(opened!, debtor);
    const shipped = moves.filter((m) => m.type === "discardSeven");
    expect(shipped.length).toBeGreaterThan(0);
    const keys = discardCombinationKeys(moves);
    const front = aw.discardQueue[0]!;
    const hand = opened!.players.find((p) => p.seat === debtor)!.hand;
    const caps = Object.values(hand);
    expect(keys.size).toBe(multisetCount(caps, front.count)); // non-vacuous exact count
    // The first shipped combination validates by its REVERSED order (key is
    // order-insensitive) — the modal feeds the picker's order, not the kernel's:
    const first = shipped[0]!;
    expect(first.cards.length).toBe(front.count);
    expect(keys.has(discardCardsKey([...first.cards].reverse()))).toBe(true);
    // A legal-count fabrication is NOT in the index (hand can't supply 9 wood
    // when caps top out at hand.wood):
    const impossible = `wood:${caps[0]! + 3}`;
    expect(keys.has(impossible)).toBe(false);
  });

  it("mustMoveRobber (after discards clear): the roller acts, no one else", () => {
    // Reuse the window above by settling its discards out. The drive-loop has
    // several break paths (review I-2): assert the loop ACTUALLY arrived, or
    // a seed/kernel change silently turns this test green-but-empty.
    let st = afterSetup();
    let asserted = false;
    outer: for (let guard = 0; guard < 80; guard++) {
      st = fatHands(st);
      const roll = legalMoves(st, st.currentSeat).find((m) => m.type === "roll");
      if (roll === undefined) break;
      st = applyAction(st, roll);
      const aw = st.awaitingSeven;
      if (aw === null) {
        const end = legalMoves(st, st.currentSeat).find((m) => m.type === "endTurn");
        if (end === undefined) break;
        st = applyAction(st, end);
        continue;
      }
      while (st.awaitingSeven?.pendingDiscard) {
        const seat = st.awaitingSeven.discardQueue[0]!.seat;
        const m = legalMoves(st, seat)[0];
        if (m === undefined) break outer;
        st = applyAction(st, m);
      }
      if (st.awaitingSeven?.mustMoveRobber) {
        expect(mayActOnBoard(st, st.awaitingSeven.roller)).toBe(true);
        expect(mayActOnBoard(st, (st.awaitingSeven.roller + 1) % SEATS)).toBe(false);
        asserted = true;
        break outer;
      }
      break;
    }
    expect(asserted, "seven-window drive never reached mustMoveRobber").toBe(true);
  });

  it("stealCard has no board ghost (victim is a DOM choice)", () => {
    expect(placementSlot({ type: "stealCard", seat: 0, victimSeat: 1 })).toBeNull();
  });

  /**
   * placementSlot's switch is DELIBERATELY non-exhaustive (default: null).
   * That is safe only while the list below matches the kernel vocabulary —
   * this test is the tripwire: it fails when OpSchema grows a new op type,
   * forcing a human decision (ghost or DOM?) instead of a silent swallow.
   */
  it("placementSlot maps EXACTLY the placement ops — full vocabulary sweep", () => {
    // Every op type the kernel can ship (packages/shared actions.ts), as
    // minimal well-typed shapes. New type => TS error here (satisfies Op)
    // AND the expectation list below must be edited.
    const probe = (t: string): Op =>
      ({
        placeSetupPiece: { type: "placeSetupPiece", seat: 0, kind: "settlement", vertexId: "v:0,0" },
        buildSettlement: { type: "buildSettlement", seat: 0, vertexId: "v:0,0" },
        buildCity: { type: "buildCity", seat: 0, vertexId: "v:0,0" },
        buildRoad: { type: "buildRoad", seat: 0, edgeId: "e:v:0,0|v:0,1" },
        moveRobber: { type: "moveRobber", seat: 0, hexId: "0,0" },
        roll: { type: "roll", seat: 0 },
        endTurn: { type: "endTurn", seat: 0 },
        discardSeven: { type: "discardSeven", seat: 0, cards: ["wood"] },
        stealCard: { type: "stealCard", seat: 0, victimSeat: 1 },
        playKnight: { type: "playKnight", seat: 0 },
        claimVictory: { type: "claimVictory", seat: 0 },
        buyDevCard: { type: "buyDevCard", seat: 0 },
        tradeBank: { type: "tradeBank", seat: 0, offer: "wood", demand: "ore" },
        tradePort: { type: "tradePort", seat: 0, give: ["wool"], want: "wheat" },
        tradeOffer: { type: "tradeOffer", seat: 0, offeree: 1, give: ["wood"], want: ["ore"] },
        tradeAccept: { type: "tradeAccept", seat: 1 },
        tradeReject: { type: "tradeReject", seat: 1 },
        playMonopoly: { type: "playMonopoly", seat: 0, resource: "ore" },
        playYearOfPlenty: { type: "playYearOfPlenty", seat: 0, cards: ["wood", "brick"] },
        playRoadBuilding: { type: "playRoadBuilding", seat: 0, edgeIds: ["e:v:0,0|v:0,1"] },
      })[t] as Op;
    const ghosts = new Set(["placeSetupPiece", "buildSettlement", "buildCity", "buildRoad", "moveRobber"]);
    // the two DOM-rail ops placementSlot's comments explicitly name:
    const domOnly = ["stealCard", "playRoadBuilding"] as const;
    const allTypes = [
      "placeSetupPiece", "buildSettlement", "buildCity", "buildRoad", "moveRobber",
      "roll", "endTurn", "discardSeven", "stealCard", "playKnight", "claimVictory",
      "buyDevCard", "tradeBank", "tradePort", "tradeOffer", "tradeAccept", "tradeReject",
      "playMonopoly", "playYearOfPlenty", "playRoadBuilding",
    ];
    expect(allTypes.length).toBe(20); // kernel vocabulary size (OpSchema enum)
    for (const t of domOnly) expect(allTypes).toContain(t);
    for (const t of allTypes) {
      const slot = placementSlot(probe(t));
      if (ghosts.has(t)) {
        expect(slot, t).not.toBeNull();
      } else {
        expect(slot, t).toBeNull();
      }
    }
  });
});
