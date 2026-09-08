/**
 * turn.test.ts — applyAction + legalMoves: the wave-2 kernel suite.
 *
 * Covers: setup snake + starting resources, turn gating, roll/production
 * (incl. robber block and bank exhaustion), the 7-resolution window
 * (discard → robber → steal), builds and costs, knight + largest army,
 * endTurn rotation, purity/determinism, and the random-play simulation
 * smoke test (the kernel's integration heartbeat).
 */
import { describe, expect, it } from "vitest";
import { ActionError, type Op } from "./actions.js";
import { buildIsland, distanceRuleFree } from "./board.js";
import { Rng } from "./rng.js";
import { variableSetup } from "./setup.js";
import {
  GameStateSchema,
  terrainResource,
  type GameState,
  type PlayerState,
  type Resource,
  type ResourceCounter,
  type Slot,
} from "./state.js";
import { applyAction, legalMoves } from "./turn.js";

const TOPO = buildIsland();
const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];
const zeroCounter = (): ResourceCounter => ({
  wood: 0,
  brick: 0,
  wool: 0,
  wheat: 0,
  ore: 0,
});
const handTotal = (p: PlayerState): number =>
  RESOURCES.reduce((a, r) => a + p.hand[r], 0);
const grandTotal = (s: GameState): number =>
  s.players.reduce((a, p) => a + handTotal(p), 0) +
  RESOURCES.reduce((a, r) => a + s.bank[r], 0);

const vertexById = new Map(TOPO.vertices.map((v) => [v.id, v]));
const edgeById = new Map(TOPO.edges.map((e) => [e.id, e]));

/** Deterministically pick the first legal op of a type from legalMoves. */
function firstOfType<T extends Op["type"]>(
  state: GameState,
  seat: number,
  type: T,
): Extract<Op, { type: T }> {
  const op = legalMoves(state, seat).find((o) => o.type === type);
  if (!op) throw new Error(`no legal ${type} for seat ${seat}`);
  return op as Extract<Op, { type: T }>;
}

/** Play a full deterministic setup (always first legal move). */
function playSetup(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase === "setup") {
    if (++guard > 64) throw new Error("setup did not terminate");
    const op = legalMoves(s, s.currentSeat)[0];
    s = applyAction(s, op);
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

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ActionError) return e.code;
    throw e;
  }
  throw new Error("expected ActionError, none thrown");
}

// ---------------------------------------------------------------------------
// Setup snake
// ---------------------------------------------------------------------------

describe("setup snake", () => {
  it("consumes seatQueue 0,1,2 then 2,1,0 and completes to play at seat 0", () => {
    let s = variableSetup(7);
    expect(s.phase).toBe("setup");
    expect(s.setupStage).toEqual({ round: 1, seatQueue: [0, 1, 2], justPlacedVertex: null });

    const turnOrder: number[] = [];
    let guard = 0;
    while (s.phase === "setup") {
      if (++guard > 64) throw new Error("setup loop");
      turnOrder.push(s.currentSeat);
      // settlement then road from legal moves
      const settle = firstOfType(s, s.currentSeat, "placeSetupPiece");
      expect(settle.kind).toBe("settlement");
      s = applyAction(s, settle);
      const road = firstOfType(s, s.currentSeat, "placeSetupPiece");
      expect(road.kind).toBe("road");
      s = applyAction(s, road);
    }
    expect(turnOrder).toEqual([0, 1, 2, 2, 1, 0]);
    expect(s.phase).toBe("play");
    expect(s.setupStage).toBeNull();
    expect(s.currentSeat).toBe(0); // starting player = first round-1 placer
    expect(s.hasRolled).toBe(false);
    for (const p of s.players) {
      expect(p.settlementsLeft).toBe(3);
      expect(p.roadsLeft).toBe(13);
    }
    expect(Object.keys(s.buildings)).toHaveLength(6);
    expect(Object.keys(s.roads)).toHaveLength(6);
    // Distance rule respected across all placements.
    const occ = new Set(Object.keys(s.buildings));
    for (const vId of occ) {
      for (const other of vertexById.get(vId)!.adjacent) {
        expect(occ.has(other)).toBe(false);
      }
    }
    // Each setup road touches its settlement.
    // (road endpoints checked implicitly by applyAction legality)
    GameStateSchema.parse(s);
  });

  it("round-1 settlements pay nothing; round-2 settlements pay adjacent terrains", () => {
    let s = variableSetup(11);
    // Round 1: seat 0 settles.
    const before = grandTotal(s);
    const op1 = firstOfType(s, 0, "placeSetupPiece");
    const s1 = applyAction(s, op1);
    expect(handTotal(s1.players[0])).toBe(0);
    expect(grandTotal(s1)).toBe(before);

    // Fast-forward to a round-2 settlement: play round 1 fully, then the
    // first round-2 settlement (seat 2).
    s = s1;
    s = applyAction(s, firstOfType(s, 0, "placeSetupPiece")); // road
    for (const seat of [1, 2]) {
      s = applyAction(s, firstOfType(s, seat, "placeSetupPiece")); // settlement
      s = applyAction(s, firstOfType(s, seat, "placeSetupPiece")); // road
    }
    expect(s.setupStage?.round).toBe(2);
    expect(s.currentSeat).toBe(2);
    const r2 = firstOfType(s, 2, "placeSetupPiece");
    expect(r2.kind).toBe("settlement");
    if (r2.kind !== "settlement") throw new Error("unreachable");
    const slotByHex = new Map(s.config.slots.map((x) => [x.hexId, x]));
    const expected = new Set<Resource>();
    for (const hId of vertexById.get(r2.vertexId!)!.hexes) {
      const r = terrainResource(slotByHex.get(hId)!.terrain);
      if (r) expected.add(r);
    }
    const s2 = applyAction(s, r2);
    const hand = s2.players[2].hand;
    for (const r of RESOURCES) {
      expect(hand[r]).toBe(expected.has(r) ? 1 : 0);
    }
    // Coastal vertices touch 1–3 hexes; inland 3. At least one terrain.
    expect(expected.size).toBeGreaterThanOrEqual(1);
    expect(handTotal(s2.players[2])).toBe(expected.size);
    // Conservation: cards came from the bank.
    expect(grandTotal(s2)).toBe(grandTotal(s));
  });

  it("rejects out-of-turn seats, occupied/distance/connected violations", () => {
    const s = variableSetup(13);
    expect(code(() => applyAction(s, { type: "placeSetupPiece", seat: 1, kind: "settlement", vertexId: TOPO.vertices[0].id }))).toBe("notYourTurn");
    // Place seat 0's settlement, then verify seat 1 cannot take an adjacent vertex.
    const settle = firstOfType(s, 0, "placeSetupPiece");
    if (settle.kind !== "settlement") throw new Error("unreachable");
    const vId = settle.vertexId!;
    const s1 = applyAction(s, settle);
    expect(code(() => applyAction(s1, { type: "placeSetupPiece", seat: 0, kind: "settlement", vertexId: TOPO.vertices[1].id }))).toBe("illegalSetupStage");
    const adj = vertexById.get(vId)!.adjacent[0];
    const s2 = applyAction(s1, firstOfType(s1, 0, "placeSetupPiece"));
    expect(code(() => applyAction(s2, { type: "placeSetupPiece", seat: 1, kind: "settlement", vertexId: adj }))).toBe("distanceRule");
    expect(code(() => applyAction(s2, { type: "placeSetupPiece", seat: 1, kind: "settlement", vertexId: vId }))).toBe("vertexOccupied");
    // Road not anchored at the just-placed settlement.
    const anchorEdges = new Set(vertexById.get(vId)!.edges);
    const farEdge = TOPO.edges.find((e) => !anchorEdges.has(e.id))!;
    expect(code(() => applyAction(s1, { type: "placeSetupPiece", seat: 0, kind: "road", edgeId: farEdge.id }))).toBe("notConnected");
  });

  it("setup road must be INCIDENT to the just-placed settlement (anchor-only)", () => {
    // Almanac, Round Two: the second setup road extends from the second
    // settlement in any of its 3 directions — touching the round-1 network
    // is NOT enough. applyAction and legalMoves agree: only anchor-incident
    // edges are accepted/enumerated.
    let s = variableSetup(101);
    // Round 1 fully: seats 0,1,2 settle+road.
    for (const seat of [0, 1, 2]) {
      s = applyAction(s, firstOfType(s, seat, "placeSetupPiece")); // settlement
      s = applyAction(s, firstOfType(s, seat, "placeSetupPiece")); // road
    }
    // Round 2, seat 2's settlement.
    s = applyAction(s, firstOfType(s, 2, "placeSetupPiece"));
    const anchor = s.setupStage!.justPlacedVertex!;
    // Enumerated roads are exactly the anchor-incident empty edges.
    const enumerated = legalMoves(s, 2);
    expect(enumerated.length).toBeGreaterThanOrEqual(2);
    expect(
      enumerated.every(
        (m) => m.type === "placeSetupPiece" && m.kind === "road",
      ),
    ).toBe(true);
    const anchorEdges = new Set(vertexById.get(anchor)!.edges);
    for (const m of enumerated) {
      if (m.type === "placeSetupPiece") expect(anchorEdges.has(m.edgeId!)).toBe(true);
    }
    // Find an empty edge touching seat 2's round-1 road but NOT the anchor.
    const round1Road = Object.keys(s.roads).find((eId) => s.roads[eId].owner === 2)!;
    const r1e = edgeById.get(round1Road)!;
    const cheat = [r1e.a, r1e.b]
      .flatMap((vId) => vertexById.get(vId)!.edges)
      .map((eId) => edgeById.get(eId)!)
      .find((e) => e.id !== round1Road && !s.roads[e.id] && !anchorEdges.has(e.id));
    expect(cheat, "no network-touching non-anchor edge found").toBeDefined();
    expect(
      code(() =>
        applyAction(s, { type: "placeSetupPiece", seat: 2, kind: "road", edgeId: cheat!.id }),
      ),
    ).toBe("notConnected");
    // The anchor-incident road still applies cleanly (agreement).
    const ok = applyAction(s, enumerated[0]);
    GameStateSchema.parse(ok);
  });

  it("legalMoves in setup enumerates settlements then anchored roads", () => {
    const s = variableSetup(17);
    const moves = legalMoves(s, 0);
    expect(moves.length).toBeGreaterThan(20);
    expect(moves.every((m) => m.type === "placeSetupPiece" && m.kind === "settlement")).toBe(true);
    expect(legalMoves(s, 1)).toEqual([]);
    const s1 = applyAction(s, moves[0]);
    const roadMoves = legalMoves(s1, 0);
    expect(roadMoves.length).toBeGreaterThanOrEqual(2);
    expect(roadMoves.every((m) => m.type === "placeSetupPiece" && m.kind === "road")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Roll / production
// ---------------------------------------------------------------------------

describe("roll and production", () => {
  it("roll draws two ints from the restored stream and records lastRoll", () => {
    const s0 = playSetup(variableSetup(19));
    const s1 = applyAction(s0, { type: "roll", seat: s0.currentSeat });
    expect(s1.hasRolled).toBe(true);
    expect(s1.lastRoll).toBeGreaterThanOrEqual(2);
    expect(s1.lastRoll).toBeLessThanOrEqual(12);
    expect(s1.rollLog).toHaveLength(1);
    expect(s1.rngCursor).toBe(s0.rngCursor + 2);
    // Deterministic: same seed + same ops → same roll.
    const a0 = playSetup(variableSetup(19));
    const a1 = applyAction(a0, { type: "roll", seat: a0.currentSeat });
    expect(a1.lastRoll).toBe(s1.lastRoll);
    expect(a1).toEqual(s1);
    // Second roll in the same turn is illegal.
    expect(code(() => applyAction(s1, { type: "roll", seat: s1.currentSeat }))).toBe("alreadyRolled");
  });

  it("production pays buildings on matching hexes; robber hex pays nothing", () => {
    let s = playSetup(variableSetup(23));
    const seat = s.currentSeat;
    // Force a controlled roll: keep rolling/endTurning until a non-7 comes
    // up on `seat`'s turn, checking conservation each roll.
    let guard = 0;
    for (;;) {
      if (++guard > 200) throw new Error("no non-7 roll found");
      const before = grandTotal(s);
      const s1 = applyAction(s, { type: "roll", seat: s.currentSeat });
      GameStateSchema.parse(s1);
      if (s1.lastRoll === 7) {
        expect(grandTotal(s1)).toBe(before); // no production on 7
        s = resolveSeven(s1);
        s = applyAction(s, { type: "endTurn", seat: s.currentSeat });
        continue;
      }
      // Conservation across production.
      expect(grandTotal(s1)).toBe(before);
      // Robber-blocked hex paid nothing.
      const sum = s1.lastRoll!;
      const robberSlot = s.config.slots.find((x) => x.hexId === s.robberHexId)!;
      if (robberSlot.numberDisc === sum) {
        const r = terrainResource(robberSlot.terrain);
        if (r) {
          const paid = s1.players.reduce(
            (a, p, i) => a + (p.hand[r] - s.players[i].hand[r]),
            0,
          );
          expect(paid).toBe(0);
        }
      }
      break;
    }
  });

  it("bank exhaustion: all-or-nothing when several players are owed; single player takes the rest", () => {
    // Steer the die by walking the stream (same trick as forceRoll) so we
    // can pick the exact number of a target hex, with the bank nearly
    // empty of its resource. Bounded seed search: a layout with both a
    // 2-owner and a 1-owner producing hex must turn up well within 1000
    // seeds (the sim covers arbitrary layouts as well).
    let s: GameState | null = null;
    let target: Slot | null = null;
    let single: Slot | null = null;
    const ownersOf = (st: GameState, hexId: string) => [
      ...new Set(
        TOPO.hexes
          .find((h) => h.id === hexId)!
          .vertices.map((v) => st.buildings[v]?.owner)
          .filter((x): x is number => x !== undefined),
      ),
    ];
    const isProducer = (st: GameState, slot: Slot) =>
      slot.numberDisc !== null && slot.terrain !== "desert" && slot.hexId !== st.robberHexId;
    for (let seed = 0; seed < 1000 && !(s && target && single); seed++) {
      const cand = playSetup(variableSetup(seed));
      const t = cand.config.slots.find((slot) => isProducer(cand, slot) && ownersOf(cand, slot.hexId).length >= 2) ?? null;
      const g = cand.config.slots.find((slot) => isProducer(cand, slot) && ownersOf(cand, slot.hexId).length === 1) ?? null;
      if (t && g) {
        s = cand;
        target = t;
        single = g;
      }
    }
    expect(s !== null && target !== null && single !== null,
      "no seed in 0..999 yields a layout with both a 2-owner and a 1-owner hex",
    ).toBe(true);
    s = s!; target = target!; single = single!;
    const slotByHex = new Map(s.config.slots.map((x) => [x.hexId, x]));
    const r = terrainResource(slotByHex.get(target.hexId)!.terrain)!;
    const owners = ownersOf(s, target.hexId);
    const want = target.numberDisc!;
    // Bank has exactly 1 of the resource; two players are owed → nobody gets it.
    s = { ...s, bank: { ...s.bank, [r]: 1 } };
    const handsBefore = s.players.map((p) => ({ ...p.hand }));
    const s1 = forceRoll(s, want);
    expect(s1.lastRoll).toBe(want);
    for (const o of owners) {
      expect(s1.players[o].hand[r]).toBe(handsBefore[o][r]);
    }
    expect(s1.bank[r]).toBe(1);

    // Single-player case: only ONE owner on the hex → they take the bank's
    // remainder even though it is less than owed.
    const r2 = terrainResource(slotByHex.get(single.hexId)!.terrain)!;
    const owner = ownersOf(s, single.hexId)[0];
    let s2 = { ...s, bank: { ...s.bank, [r2]: 1 } };
    const before2 = s2.players[owner].hand[r2];
    s2 = forceRoll(s2, single.numberDisc!);
    expect(s2.lastRoll).toBe(single.numberDisc);
    expect(s2.players[owner].hand[r2]).toBe(before2 + 1); // min(owed, bank)
    expect(s2.bank[r2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seven resolution
// ---------------------------------------------------------------------------

/** Drive a rolled-7 state through its full resolution window. */
function resolveSeven(s: GameState): GameState {
  let guard = 0;
  while (s.awaitingSeven) {
    if (++guard > 40) throw new Error("seven did not resolve");
    const aw = s.awaitingSeven;
    const seat = aw.pendingDiscard
      ? aw.discardQueue[0].seat
      : aw.roller;
    const moves = legalMoves(s, seat);
    expect(moves.length).toBeGreaterThan(0);
    s = applyAction(s, moves[0]);
    GameStateSchema.parse(s);
  }
  return s;
}

/** Force a 7 on the current seat's roll by restoring the stream. */
function forceRoll(state: GameState, want: number): GameState {
  // Walk the stream forward until the next two draws sum to `want`.
  // We do this by crafting a state with an adjusted rngCursor (test-only
  // scaffolding; the stream contract makes this deterministic).
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

describe("seven resolution", () => {
  it("7 → discards (big hands) → robber move → steal, all gated in order", () => {
    let s = playSetup(variableSetup(31));
    // Give seat 1 a big hand so it must discard; give seat 2 some cards so
    // the robber has a victim worth stealing from.
    s = give(s, 1, { wood: 4, brick: 4 }); // 8 cards → discard 4
    s = give(s, 2, { ore: 3 });
    const before = grandTotal(s);
    const rolled = forceRoll(s, 7);
    expect(rolled.lastRoll).toBe(7);
    expect(grandTotal(rolled)).toBe(before); // no production on 7
    const aw = rolled.awaitingSeven!;
    expect(aw.roller).toBe(rolled.currentSeat);
    expect(aw.pendingDiscard).toBe(true);
    expect(aw.mustMoveRobber).toBe(true);
    expect(aw.discardQueue).toEqual([{ seat: 1, count: 4 }]);

    // Only the debtor may act, and only with a discard.
    expect(legalMoves(rolled, 0)).toEqual([]);
    expect(legalMoves(rolled, 2)).toEqual([]);
    const discards = legalMoves(rolled, 1);
    expect(discards.length).toBeGreaterThan(1);
    expect(discards.every((m) => m.type === "discardSeven" && m.cards.length === 4)).toBe(true);
    expect(code(() => applyAction(rolled, { type: "moveRobber", seat: rolled.currentSeat, hexId: "0,0" }))).toBe("awaitingSeven");
    expect(code(() => applyAction(rolled, { type: "discardSeven", seat: 2, cards: ["ore"] }))).toBe("wrongDiscardSeat");
    expect(code(() => applyAction(rolled, { type: "discardSeven", seat: 1, cards: ["wood"] }))).toBe("insufficientHand");
    expect(code(() => applyAction(rolled, { type: "discardSeven", seat: 1, cards: ["ore", "ore", "ore", "ore"] }))).toBe("insufficientHand");

    let s1 = applyAction(rolled, discards[0]);
    // Seat 1 discards exactly 4 (its total includes a round-2 setup card).
    const seat1Before = handTotal(rolled.players[1]);
    expect(handTotal(s1.players[1])).toBe(seat1Before - 4);
    // Conservation: the 4 discarded cards went back to the bank.
    expect(grandTotal(s1)).toBe(before);
    const aw1 = s1.awaitingSeven!;
    expect(aw1.pendingDiscard).toBe(false);
    expect(aw1.mustMoveRobber).toBe(true);
    // Now only the roller may move the robber.
    const robberMoves = legalMoves(s1, s1.currentSeat);
    expect(robberMoves).toHaveLength(18); // every hex except the current one
    expect(robberMoves.every((m) => m.type === "moveRobber")).toBe(true);
    expect(code(() => applyAction(s1, { type: "moveRobber", seat: s1.currentSeat, hexId: s1.robberHexId }))).toBe("robberSameHex");
    expect(code(() => applyAction(s1, { type: "endTurn", seat: s1.currentSeat }))).toBe("awaitingSeven");

    // Move the robber onto a hex where seat 2 has a building. Bounded seed
    // search: if this layout has no such hex, rebuild the whole scenario on
    // a different seed rather than silently skipping.
    let seat2Hex: Slot | undefined = s1.config.slots.find((slot) =>
      TOPO.hexes
        .find((h) => h.id === slot.hexId)!
        .vertices.some((v) => s1.buildings[v]?.owner === 2),
    );
    if (!seat2Hex) {
      for (let seed = 0; seed < 1000 && !seat2Hex; seed++) {
        let alt = playSetup(variableSetup(seed));
        alt = give(alt, 1, { wood: 4, brick: 4 });
        alt = give(alt, 2, { ore: 3 });
        const rolledAlt = forceRoll(alt, 7);
        const afterDiscard = applyAction(rolledAlt, legalMoves(rolledAlt, 1)[0]);
        const found = afterDiscard.config.slots.find((slot) =>
          TOPO.hexes
            .find((h) => h.id === slot.hexId)!
            .vertices.some((v) => afterDiscard.buildings[v]?.owner === 2),
        );
        if (found) {
          s1 = afterDiscard;
          seat2Hex = found;
        }
      }
    }
    // The primary seed always works; the fallback loop is defensive (never
    // silently skip — see the bounded-search contract in this file).
    expect(seat2Hex, "no seed in 0..999 yields a hex with a seat-2 building").toBeDefined();
    const s2 = applyAction(s1, { type: "moveRobber", seat: s1.currentSeat, hexId: seat2Hex!.hexId });
    expect(s2.robberHexId).toBe(seat2Hex!.hexId);
    const aw2 = s2.awaitingSeven!;
    // Seat 2 holds ≥1 card (ore:3 granted above), so the steal window must
    // still be open — an early close here is a kernel bug, not a skip.
    expect(aw2, "steal window closed early though seat 2 holds cards").not.toBeNull();
    expect(aw2.pendingDiscard).toBe(false);
    expect(aw2.mustMoveRobber).toBe(false);
    const steals = legalMoves(s2, s2.currentSeat);
    expect(steals.every((m) => m.type === "stealCard")).toBe(true);
    const victimCardsBefore = handTotal(s2.players[2]);
    const rollerBefore = handTotal(s2.players[s2.currentSeat]);
    const s3 = applyAction(s2, steals.find((m) => m.type === "stealCard" && m.victimSeat === 2)!);
    expect(s3.awaitingSeven).toBeNull();
    expect(handTotal(s3.players[2])).toBe(victimCardsBefore - 1);
    expect(handTotal(s3.players[s3.currentSeat])).toBe(rollerBefore + 1);
    expect(s3.rngCursor).toBe(s2.rngCursor + 1); // one steal draw
    expect(grandTotal(s3)).toBe(grandTotal(s2));
    // Window closed: normal action phase resumes.
    expect(legalMoves(s3, s3.currentSeat).some((m) => m.type === "endTurn")).toBe(true);
  });

  it("7 with everyone ≤7 cards skips discards", () => {
    const s = playSetup(variableSetup(37));
    const rolled = forceRoll(s, 7);
    expect(rolled.awaitingSeven!.pendingDiscard).toBe(false);
    expect(rolled.awaitingSeven!.discardQueue).toEqual([]);
    expect(rolled.awaitingSeven!.mustMoveRobber).toBe(true);
  });

  it("discard matrix: 7 owes nothing, 8→4, 9→4, 15→7", () => {
    const cases: Array<{ total: number; owed: number }> = [
      { total: 7, owed: 0 },
      { total: 8, owed: 4 },
      { total: 9, owed: 4 },
      { total: 15, owed: 7 },
    ];
    for (const { total, owed } of cases) {
      let s = playSetup(variableSetup(131));
      // Fill seat 1's hand to exactly `total` cards (minus whatever setup
      // already granted it).
      const seat1 = s.players[1];
      const deficit = total - handTotal(seat1);
      expect(deficit).toBeGreaterThan(0);
      s = give(s, 1, { wood: deficit });
      expect(handTotal(s.players[1])).toBe(total);
      const rolled = forceRoll(s, 7);
      const entry = rolled.awaitingSeven!.discardQueue.find((q) => q.seat === 1);
      if (owed === 0) {
        expect(entry, `total ${total} must not owe a discard`).toBeUndefined();
      } else {
        expect(entry, `total ${total} must owe ${owed}`).toEqual({ seat: 1, count: owed });
        // Every enumerated discard op for the debtor has exactly `owed` cards.
        const discards = legalMoves(rolled, 1);
        expect(discards.length).toBeGreaterThan(0);
        expect(
          discards.every((m) => m.type === "discardSeven" && m.cards.length === owed),
        ).toBe(true);
      }
    }
  });

  it("robber onto an empty hex closes the window without a steal", () => {
    let s = playSetup(variableSetup(41));
    s = give(s, 0, { wood: 2 });
    const rolled = forceRoll(s, 7);
    // Find a hex with NO buildings (hard-fail if this layout has none).
    const empty = rolled.config.slots.find((slot) =>
      TOPO.hexes
        .find((h) => h.id === slot.hexId)!
        .vertices.every((v) => !rolled.buildings[v]),
    );
    expect(empty, "no building-free hex in this layout").toBeDefined();
    const s1 = applyAction(rolled, { type: "moveRobber", seat: rolled.currentSeat, hexId: empty!.hexId });
    expect(s1.awaitingSeven).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

describe("builds", () => {
  it("buildRoad pays wood+brick, extends the network, blocks enemy endpoints", () => {
    let s = playSetup(variableSetup(43));
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 1, brick: 1 });
    s = forceRoll(s, 6); // any non-7
    expect(s.hasRolled).toBe(true);
    // Cannot build before rolling — verified by a fresh pre-roll state.
    const pre = give(playSetup(variableSetup(43)), seat, { wood: 1, brick: 1 });
    expect(code(() => {
      const m = legalMoves(pre, seat).find((x) => x.type === "buildRoad");
      if (m) applyAction(pre, m);
      else throw new ActionError("notRolledYet", "no build moves pre-roll (correct)");
    })).toBe("notRolledYet");

    const moves = legalMoves(s, seat).filter((m) => m.type === "buildRoad");
    expect(moves.length).toBeGreaterThan(0);
    const bankBefore = { ...s.bank };
    const s1 = applyAction(s, moves[0]);
    if (moves[0].type !== "buildRoad") throw new Error("unreachable");
    expect(s1.roads[moves[0].edgeId]).toEqual({ owner: seat });
    expect(s1.players[seat].roadsLeft).toBe(s.players[seat].roadsLeft - 1);
    expect(s1.players[seat].hand.wood).toBe(s.players[seat].hand.wood - 1);
    expect(s1.players[seat].hand.brick).toBe(s.players[seat].hand.brick - 1);
    expect(s1.bank.wood).toBe(bankBefore.wood + 1);
    expect(s1.bank.brick).toBe(bankBefore.brick + 1);
    // Same edge again → illegal.
    expect(code(() => applyAction(give(s1, seat, { wood: 1, brick: 1 }), moves[0]))).toBe("noEdge");
  });

  it("buildSettlement requires connection + distance rule + cost", () => {
    let s = playSetup(variableSetup(47));
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 2, brick: 2, wool: 1, wheat: 1 });
    s = forceRoll(s, 4);
    // Build a road first, then a settlement at its far end.
    const roadMoves = legalMoves(s, seat).filter((m) => m.type === "buildRoad");
    let s1: GameState | null = null;
    let target: string | null = null;
    for (const rm of roadMoves) {
      if (rm.type !== "buildRoad") continue;
      const cand = applyAction(s, rm);
      const e = edgeById.get(rm.edgeId)!;
      const t = [e.a, e.b].find((v) => {
        if (cand.buildings[v]) return false;
        return distanceRuleFree(TOPO, v, new Set(Object.keys(cand.buildings)));
      });
      if (t) {
        s1 = cand;
        target = t;
        break;
      }
    }
    expect(target, "no legal road has a buildable far end").not.toBeNull();
    const settleOp: Op = { type: "buildSettlement", seat, vertexId: target! };
    const s2 = applyAction(s1!, settleOp);
    expect(s2.buildings[target!]).toEqual({ kind: "settlement", owner: seat });
    expect(s2.players[seat].settlementsLeft).toBe(s1!.players[seat].settlementsLeft - 1);
    // Insufficient funds → insufficientHand.
    const broke = { ...s2, players: s2.players.map((p, i) => (i === seat ? { ...p, hand: zeroCounter() } : p)) };
    const anySettlement = legalMoves(s2, seat).find((m) => m.type === "buildSettlement");
    if (anySettlement) {
      expect(code(() => applyAction(broke, anySettlement))).toBe("insufficientHand");
    }
  });

  it("road runs UP TO an opponent settlement (legal) but cannot be extended THROUGH it", () => {
    // Official rule: "cannot start a road on the far side of an opponent's
    // building" — the far ENDPOINT of a road may carry an enemy building,
    // but the START vertex may not. The distance rule makes an empty vertex
    // beyond an enemy gate impossible to reach legally, so this test pins
    // the boundary: build up to the gate (legal), then the continuation
    // starting AT the gate must be rejected by BOTH applyAction (roadBlocked)
    // and legalMoves (not enumerated).
    let s = playSetup(variableSetup(113));
    const seat = s.currentSeat;
    s = give(s, seat, { wood: 9, brick: 9, wool: 2, wheat: 2 });
    s = forceRoll(s, 5); // any non-7
    // An opponent settlement from setup.
    const gate = Object.entries(s.buildings).find(([, b]) => b.owner !== seat);
    expect(gate, "no opponent building after setup").toBeDefined();
    const g = gate![0];
    // BFS from the seat's network to the gate, crossing only vertices that
    // carry no OPPONENT building; the gate itself is entered as the final
    // hop (up-to is legal).
    const net = new Set<string>();
    for (const [id, r] of Object.entries(s.roads)) {
      if (r.owner !== seat) continue;
      const e = edgeById.get(id)!;
      net.add(e.a);
      net.add(e.b);
    }
    const parent = new Map<string, string>();
    const prevEdge = new Map<string, string>();
    const queue = [...net];
    const seen = new Set(net);
    while (queue.length > 0 && !seen.has(g)) {
      const v = queue.shift()!;
      for (const eId of vertexById.get(v)!.edges) {
        const e = edgeById.get(eId)!;
        const o = e.a === v ? e.b : e.a;
        if (seen.has(o)) continue;
        if (o !== g) {
          const b = s.buildings[o];
          if (b && b.owner !== seat) continue; // cannot route through
        }
        seen.add(o);
        parent.set(o, v);
        prevEdge.set(o, eId);
        queue.push(o);
      }
    }
    expect(seen.has(g), "gate unreachable from seat network").toBe(true);
    const pathVerts: string[] = [];
    for (let cur = g; ; ) {
      pathVerts.unshift(cur);
      const p = parent.get(cur);
      if (p === undefined) break;
      cur = p;
    }
    for (let i = 1; i < pathVerts.length; i++) {
      const eId = prevEdge.get(pathVerts[i])!;
      if (s.roads[eId]) continue; // already built
      const op = legalMoves(s, seat).find(
        (m): m is Extract<Op, { type: "buildRoad" }> =>
          m.type === "buildRoad" && m.edgeId === eId,
      );
      expect(op, `path edge ${eId} not buildable`).toBeDefined();
      s = applyAction(s, op!);
    }
    // The final hop ENDED at the enemy gate — that proves "up to" is legal.
    expect(net.has(g) || Object.entries(s.roads).some(([id, r]) =>
      r.owner === seat && (edgeById.get(id)!.a === g || edgeById.get(id)!.b === g)
    )).toBe(true);
    // Continuations STARTING at the gate (far end empty) must be rejected.
    const continuations = vertexById.get(g)!.edges.filter((eId) => {
      if (s.roads[eId]) return false;
      const e = edgeById.get(eId)!;
      const far = e.a === g ? e.b : e.a;
      return !s.buildings[far];
    });
    expect(continuations.length, "gate has no continuation edge").toBeGreaterThan(0);
    for (const eId of continuations) {
      expect(
        code(() => applyAction(s, { type: "buildRoad", seat, edgeId: eId })),
        `road through gate ${eId} must be rejected`,
      ).toBe("roadBlocked");
      expect(
        legalMoves(s, seat).some((m) => m.type === "buildRoad" && m.edgeId === eId),
        "legalMoves must not enumerate roads starting at an enemy gate",
      ).toBe(false);
    }
  });

  it("buildCity replaces own settlement, returns the settlement piece", () => {
    let s = playSetup(variableSetup(53));
    const seat = s.currentSeat;
    s = give(s, seat, { wheat: 2, ore: 3 });
    s = forceRoll(s, 8);
    const mySettlement = Object.entries(s.buildings).find(
      ([, b]) => b.owner === seat && b.kind === "settlement",
    )!;
    const s1 = applyAction(s, { type: "buildCity", seat, vertexId: mySettlement[0] });
    expect(s1.buildings[mySettlement[0]]).toEqual({ kind: "city", owner: seat });
    expect(s1.players[seat].citiesLeft).toBe(3);
    expect(s1.players[seat].settlementsLeft).toBe(s.players[seat].settlementsLeft + 1);
    // Not on an empty vertex: noOwnSettlementThere (vertexOccupied is for
    // occupied buildSettlement attempts).
    const emptyVertex = TOPO.vertices.find((v) => !s.buildings[v.id])!;
    expect(code(() => applyAction(s, { type: "buildCity", seat, vertexId: emptyVertex.id }))).toBe("noOwnSettlementThere");
    const theirs = Object.entries(s.buildings).find(([, b]) => b.owner !== seat)!;
    expect(code(() => applyAction(s, { type: "buildCity", seat, vertexId: theirs[0] }))).toBe("noOwnSettlementThere");
  });
});

// ---------------------------------------------------------------------------
// Knight / largest army
// ---------------------------------------------------------------------------

describe("playKnight", () => {
  function withKnight(state: GameState, seat: number): GameState {
    const players = state.players.slice();
    players[seat] = { ...players[seat], devHand: ["knight"] };
    return { ...state, players };
  }

  it("knight activates the robber with NO discard step; one dev per turn", () => {
    let s = playSetup(variableSetup(59));
    const seat = s.currentSeat;
    s = give(s, 1, { wood: 5, ore: 5 }); // big hand — knight must NOT trigger discards
    s = withKnight(s, seat);
    const s1 = applyAction(s, { type: "playKnight", seat });
    expect(s1.players[seat].devHand).toEqual([]);
    expect(s1.players[seat].devPlayedThisTurn).toBe(true);
    expect(s1.players[seat].knightsPlayed).toBe(1);
    expect(s1.discardPile).toEqual(["knight"]);
    expect(s1.awaitingSeven).toEqual({
      roller: seat,
      pendingDiscard: false,
      mustMoveRobber: true,
      discardQueue: [],
    });
    // A second dev card this turn is illegal (window-guard fires first
    // while the robber waits; the dev-played flag is the cause).
    const s2state = withKnight(s1, seat);
    expect(["devAlreadyPlayed", "awaitingSeven"]).toContain(
      code(() => applyAction(s2state, { type: "playKnight", seat })),
    );
    // After the window resolves, the flag still blocks a second dev card.
    const resolved1 = resolveSeven(s1);
    const s3state = withKnight(resolved1, seat);
    expect(code(() => applyAction(s3state, { type: "playKnight", seat }))).toBe("devAlreadyPlayed");
    // Robber must be moved before rolling.
    expect(code(() => applyAction(s1, { type: "roll", seat }))).toBe("awaitingSeven");
    // Resolve and continue: roll still available (knight was pre-roll).
    const resolved = resolveSeven(s1);
    expect(resolved.awaitingSeven).toBeNull();
    expect(resolved.hasRolled).toBe(false);
    expect(legalMoves(resolved, seat).some((m) => m.type === "roll")).toBe(true);
  });

  it("largest army at 3 knights; strictly-greater transfers, ties keep", () => {
    let s = playSetup(variableSetup(61));
    const seatA = s.currentSeat;
    const seatB = (seatA + 1) % s.players.length;
    const setKnights = (st: GameState, seat: number, n: number): GameState => {
      const players = st.players.slice();
      players[seat] = {
        ...players[seat],
        devHand: Array(n).fill("knight"),
        knightsPlayed: 0,
      };
      return { ...st, players };
    };
    s = setKnights(s, seatA, 3);
    s = setKnights(s, seatB, 3);

    /** Play one full turn for `seat`: optional knight, roll, resolve, end. */
    const playTurn = (st: GameState, knight: boolean): GameState => {
      let x = st;
      const seat = x.currentSeat;
      if (knight) {
        x = applyAction(x, { type: "playKnight", seat });
        x = resolveSeven(x);
      }
      x = applyAction(x, { type: "roll", seat });
      if (x.awaitingSeven) x = resolveSeven(x);
      return applyAction(x, { type: "endTurn", seat });
    };

    // Three full rounds; A plays a knight on each of its turns.
    for (let round = 0; round < 3; round++) {
      for (let turn = 0; turn < s.players.length; turn++) {
        const seat = s.currentSeat;
        s = playTurn(s, seat === seatA && s.players[seatA].devHand.length > 0);
      }
    }
    expect(s.players[seatA].knightsPlayed).toBe(3);
    expect(s.players[seatB].knightsPlayed).toBe(0);
    expect(s.largestArmy).toEqual({ holder: seatA, count: 3 });

    // B reaches 3 knights → tie → A keeps the tile. B's 4th → transfers.
    s = setKnights(s, seatB, 4);
    for (let round = 0; round < 4; round++) {
      for (let turn = 0; turn < s.players.length; turn++) {
        const seat = s.currentSeat;
        const wantKnight = seat === seatB && s.players[seatB].devHand.length > 0;
        s = playTurn(s, wantKnight);
        if (seat === seatB) {
          if (round < 3) {
            // Tie at 3 — A still holds.
            if (s.players[seatB].knightsPlayed === 3) {
              expect(s.largestArmy.holder).toBe(seatA);
            }
          }
        }
      }
    }
    expect(s.players[seatB].knightsPlayed).toBe(4);
    expect(s.largestArmy).toEqual({ holder: seatB, count: 4 });
  });
});

// ---------------------------------------------------------------------------
// endTurn
// ---------------------------------------------------------------------------

describe("endTurn", () => {
  it("rotates seats, clears hasRolled and devPlayedThisTurn", () => {
    let s = playSetup(variableSetup(67));
    const seat = s.currentSeat;
    s = give(s, seat, {});
    const withK = (() => {
      const players = s.players.slice();
      players[seat] = { ...players[seat], devHand: ["knight"] };
      return { ...s, players };
    })();
    s = applyAction(withK, { type: "playKnight", seat });
    s = resolveSeven(s);
    s = applyAction(s, { type: "roll", seat });
    if (s.awaitingSeven) s = resolveSeven(s);
    const s1 = applyAction(s, { type: "endTurn", seat });
    expect(s1.currentSeat).toBe((seat + 1) % s.players.length);
    expect(s1.hasRolled).toBe(false);
    expect(s1.players[seat].devPlayedThisTurn).toBe(false);
    // Not rolled yet → endTurn illegal for the new seat.
    expect(code(() => applyAction(s1, { type: "endTurn", seat: s1.currentSeat }))).toBe("notRolledYet");
  });

  it("endTurn is illegal in 'ended' phase; legalMoves stops at ended", () => {
    // The 'ended' phase is wave-4 territory (claimVictory); the API must
    // refuse seat rotation on a finished game, and legalMoves returns
    // nothing there so the UI idles cleanly.
    const s = { ...playSetup(variableSetup(83)), phase: "ended" as const };
    GameStateSchema.parse(s);
    expect(legalMoves(s, 0)).toEqual([]);
    expect(
      code(() => applyAction(s, { type: "endTurn", seat: 0 })),
    ).toBe("wrongPhase");
  });
});

// ---------------------------------------------------------------------------
// Purity & determinism
// ---------------------------------------------------------------------------

describe("purity and determinism", () => {
  it("applyAction never mutates its input", () => {
    const s = playSetup(variableSetup(71));
    const snapshot = JSON.parse(JSON.stringify(s));
    const ops = legalMoves(s, s.currentSeat);
    for (const op of ops.slice(0, 6)) {
      try {
        applyAction(s, op);
      } catch {
        // illegal-for-other-reasons ops are fine; purity is what matters
      }
    }
    expect(s).toEqual(snapshot);
  });

  it("replay: same seed + same op sequence → identical state twice", () => {
    const run = (): GameState => {
      let s = variableSetup(73);
      const rng = Rng.create(999); // op-selection stream (not the game's)
      let guard = 0;
      while (s.phase === "setup" || s.rollLog.length < 30) {
        if (++guard > 400) throw new Error("replay runaway");
        const seat = s.phase === "setup"
          ? s.currentSeat
          : s.awaitingSeven
            ? s.awaitingSeven.pendingDiscard
              ? s.awaitingSeven.discardQueue[0].seat
              : s.awaitingSeven.roller
            : s.currentSeat;
        const moves = legalMoves(s, seat);
        if (moves.length === 0) throw new Error("dead state");
        const op = moves[rng.int(moves.length)];
        s = applyAction(s, op);
      }
      return s;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    GameStateSchema.parse(a);
  });

  it("dice stream continues the setup stream exactly (restore contract)", () => {
    const s0 = playSetup(variableSetup(79));
    const rng = Rng.restore({ seed: s0.rngSeed, cursor: s0.rngCursor });
    const d1 = 1 + rng.int(6);
    const d2 = 1 + rng.int(6);
    const s1 = applyAction(s0, { type: "roll", seat: s0.currentSeat });
    expect(s1.lastRoll).toBe(d1 + d2);
  });

  it("adversarial: negative hand counts are rejected by parse AND applyAction", () => {
    // Locks the input-validation contract: a tampered state must throw at
    // the boundary — never be silently accepted.
    const s = playSetup(variableSetup(97));
    const tampered = {
      ...s,
      players: s.players.map((p, i) =>
        i === 0 ? { ...p, hand: { ...p.hand, wood: -1 } } : p,
      ),
    };
    expect(() => GameStateSchema.parse(tampered)).toThrow();
    expect(() =>
      applyAction(tampered, { type: "roll", seat: tampered.currentSeat }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Simulation smoke test — the kernel's integration heartbeat
// ---------------------------------------------------------------------------

describe("random-play simulation", () => {
  it("3-player game survives 400 ops with all invariants intact", () => {
    let s = variableSetup(1234, { playerCount: 3 });
    // Op-selection randomness comes from the GAME stream itself: draw once
    // per op from the restored stream and write the cursor back via a
    // side-channel... NO — that would corrupt the dice stream. The picker
    // uses its own independent seed (sim driver entropy, not game entropy).
    const picker = Rng.create(0xC0FFEE);
    let ops = 0;
    let sevens = 0;
    let builds = 0;
    const t0 = Date.now();
    while (ops < 400) {
      const seat = s.phase === "setup"
        ? s.currentSeat
        : s.awaitingSeven
          ? s.awaitingSeven.pendingDiscard
            ? s.awaitingSeven.discardQueue[0].seat
            : s.awaitingSeven.roller
          : s.currentSeat;
      const moves = legalMoves(s, seat);
      expect(moves.length).toBeGreaterThan(0);
      const op = moves[picker.int(moves.length)];
      const before = JSON.parse(JSON.stringify(s));
      s = applyAction(s, op);
      expect(s).not.toBe(before);
      GameStateSchema.parse(s); // postcondition: never throws
      expect(JSON.parse(JSON.stringify(before))).toEqual(before); // sanity
      ops++;
      if (op.type === "roll" && s.lastRoll === 7) sevens++;
      if (op.type.startsWith("build")) builds++;
      // Conservation of resources.
      expect(grandTotal(s)).toBe(95);
      // Cursor monotonicity.
      expect(s.rngCursor).toBeGreaterThanOrEqual(before.rngCursor);
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(sevens).toBeGreaterThan(0); // the sim exercised the 7-window
    expect(s.rollLog.length).toBeGreaterThan(20);
    // All hands ≥0 and pieces within supply.
    for (const p of s.players) {
      for (const r of RESOURCES) expect(p.hand[r]).toBeGreaterThanOrEqual(0);
      expect(p.roadsLeft).toBeGreaterThanOrEqual(0);
      expect(p.settlementsLeft).toBeGreaterThanOrEqual(0);
      expect(p.citiesLeft).toBeGreaterThanOrEqual(0);
    }
    void builds;
  }, 20_000);

  it("sim with pre-populated knights exercises playKnight + largestArmy for 400 ops", () => {
    // Wave 2 has no buyDevCard op, so no legal flow ever puts a knight in a
    // devHand — pre-populate at sim start (test-side state construction is
    // fine; applyAction stays the only mutator thereafter).
    let s = variableSetup(4321, { playerCount: 3 });
    const players = s.players.slice();
    players[0] = { ...players[0], devHand: ["knight", "knight", "knight"] };
    players[1] = { ...players[1], devHand: ["knight", "knight"] };
    s = { ...s, players };
    GameStateSchema.parse(s);
    const picker = Rng.create(0xBEEF);
    let ops = 0;
    let knights = 0;
    while (ops < 400) {
      const seat = s.phase === "setup"
        ? s.currentSeat
        : s.awaitingSeven
          ? s.awaitingSeven.pendingDiscard
            ? s.awaitingSeven.discardQueue[0].seat
            : s.awaitingSeven.roller
          : s.currentSeat;
      const moves = legalMoves(s, seat);
      expect(moves.length).toBeGreaterThan(0);
      const op = moves[picker.int(moves.length)];
      s = applyAction(s, op);
      GameStateSchema.parse(s);
      if (op.type === "playKnight") knights++;
      expect(grandTotal(s)).toBe(95);
      ops++;
    }
    expect(knights).toBeGreaterThan(0); // playKnight was actually exercised
    // Largest army tile moved to a seat that played ≥3 knights.
    if (s.largestArmy.holder !== null) {
      expect(s.players[s.largestArmy.holder].knightsPlayed).toBe(s.largestArmy.count);
      expect(s.largestArmy.count).toBeGreaterThanOrEqual(3);
    }
  }, 20_000);

  it("legalMoves only ever yields ops that applyAction accepts", () => {
    let s = variableSetup(555);
    const picker = Rng.create(12345);
    for (let i = 0; i < 300; i++) {
      const seats =
        s.phase === "setup"
          ? [s.currentSeat]
          : s.awaitingSeven
            ? s.awaitingSeven.pendingDiscard
              ? [s.awaitingSeven.discardQueue[0].seat]
              : [s.awaitingSeven.roller]
            : s.players.map((p) => p.seat);
      for (const seat of seats) {
        for (const op of legalMoves(s, seat)) {
          // Every enumerated move must apply cleanly.
          const next = applyAction(s, op);
          GameStateSchema.parse(next);
        }
      }
      const seat = s.phase === "setup"
        ? s.currentSeat
        : s.awaitingSeven
          ? s.awaitingSeven.pendingDiscard
            ? s.awaitingSeven.discardQueue[0].seat
            : s.awaitingSeven.roller
          : s.currentSeat;
      const moves = legalMoves(s, seat);
      s = applyAction(s, moves[picker.int(moves.length)]);
    }
  }, 30_000);
});
