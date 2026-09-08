/**
 * turn.ts — applyAction: the ONLY legal GameState mutator (AGENTS.md).
 *
 * CONTRACT
 * - PURE: the input state is never mutated (treated as immutable; the next
 *   state is assembled via spread copies). Callers may keep old states for
 *   undo/replay.
 * - The input state is validated with GameStateSchema.parse on every call
 *   (tests rely on this error surface); the op is validated with OpSchema.
 * - Postcondition: GameStateSchema.parse(result) never throws. This is
 *   asserted in tests rather than at runtime.
 * - Every illegal op throws ActionError with a stable code (see actions.ts).
 *
 * RNG CONTRACT (locked with wave 1): every op that draws randomness
 * (roll: TWO int calls — both dice always drawn so bias is uniform;
 * stealCard: ONE int call) restores the true stream via
 * Rng.restore({ seed: state.rngSeed, cursor: state.rngCursor }) and writes
 * the advanced cursor back into the result. Nothing else may touch the
 * stream; setup consumes no dice draws.
 *
 * AWAITING-SEVEN PROTOCOL (single resolution window, state.awaitingSeven):
 *   pendingDiscard  — discardQueue non-empty; only discardSeven (front seat)
 *   mustMoveRobber  — next: only moveRobber by the roller
 *   (neither true)  — steal pending: only stealCard by the roller, IF any
 *                     building stands on the robber hex; otherwise the
 *                     window is cleared when the robber lands.
 * Knight activation skips the discard step entirely (pendingDiscard false).
 *
 * SETUP (official 6th Ed, corrected): two snake rounds. Round 1 seats
 * 0..n-1 then round 2 reversed. Each turn: place ONE settlement, then ONE
 * road INCIDENT to that settlement (anchor-only — a road merely touching
 * the round-1 network is illegal during setup; the Almanac's Round Two
 * road must extend from the second settlement in any of its 3 directions).
 * Only the SECOND settlement pays: 1 card of each
 * different terrain type touching its vertex (desert contributes nothing),
 * paid from the bank inside the placeSetupPiece op. Round-1 settlements pay
 * nothing. When the final round-2 road lands, setup completes:
 * phase 'play', currentSeat = 0 (the STARTING PLAYER — the seat that placed
 * first in round 1 and therefore last in the reversed round 2).
 * setupStage.justPlacedVertex is ONLY the road-connection anchor.
 *
 * legalMoves(state, seat) enumerates everything `seat` may do right now —
 * the UI contract. Discard enumeration yields all distinct resource
 * multisets of the owed size: with 5 resource types and ≤⌊19/2⌋ cards the
 * multiset count C(5+k-1, k) stays in the low thousands worst case and is
 * typically <50; fine for UI rendering.
 */
import {
  ActionError,
  OpSchema,
  type Op,
  type PlaceSetupPieceOp,
  type RollOp,
  type DiscardSevenOp,
  type MoveRobberOp,
  type StealCardOp,
  type BuildRoadOp,
  type BuildSettlementOp,
  type BuildCityOp,
  type PlayKnightOp,
  type EndTurnOp,
} from "./actions.js";
import {
  buildIsland,
  distanceRuleFree,
  type IslandTopology,
} from "./board.js";
import { Rng } from "./rng.js";
import { recomputeLongestRoad } from "./road.js";
import {
  GameStateSchema,
  terrainResource,
  type GameState,
  type PlayerState,
  type Resource,
  type ResourceCounter,
  type Slot,
} from "./state.js";

// buildIsland() is pure and deterministic; cache one instance at module
// load so per-action geometry lookups never rebuild the topology. The
// topology embedded in state.config is deep-equal to this (wave-1 contract).
const TOPO: IslandTopology = buildIsland();

/** O(1) id lookups over the cached topology (ids are unique by construction). */
const vertexById = new Map(TOPO.vertices.map((v) => [v.id, v]));
const edgeById = new Map(TOPO.edges.map((e) => [e.id, e]));
const hexById = new Map(TOPO.hexes.map((h) => [h.id, h]));

const RESOURCES: readonly Resource[] = [
  "wood",
  "brick",
  "wool",
  "wheat",
  "ore",
];

/** Empty five-key resource counter. */
const zeroCounter = (): ResourceCounter => ({
  wood: 0,
  brick: 0,
  wool: 0,
  wheat: 0,
  ore: 0,
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(
  code: ConstructorParameters<typeof ActionError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ActionError(code, message, details);
}

function handTotal(p: PlayerState): number {
  const h = p.hand;
  return h.wood + h.brick + h.wool + h.wheat + h.ore;
}

function hasCards(hand: ResourceCounter, cost: Partial<ResourceCounter>): boolean {
  return RESOURCES.every((r) => (hand[r] ?? 0) >= (cost[r] ?? 0));
}

/** Returns new hand after subtracting cost. Assumes hasCards held. */
function minus(
  hand: ResourceCounter,
  cost: Partial<ResourceCounter>,
): ResourceCounter {
  const out = { ...hand };
  for (const r of RESOURCES) out[r] -= cost[r] ?? 0;
  return out;
}

function plus(
  hand: ResourceCounter,
  gain: Partial<ResourceCounter>,
): ResourceCounter {
  const out = { ...hand };
  for (const r of RESOURCES) out[r] += gain[r] ?? 0;
  return out;
}

function replacePlayer(state: GameState, seat: number, p: PlayerState): GameState {
  const players = state.players.slice();
  players[seat] = p;
  return { ...state, players };
}

function player(state: GameState, seat: number): PlayerState {
  const p = state.players[seat];
  if (!p || p.seat !== seat) fail("badSeat", `no player at seat ${seat}`, { seat });
  return p;
}

function requireTurn(state: GameState, seat: number): void {
  if (seat !== state.currentSeat) {
    fail("notYourTurn", `seat ${seat} cannot act; current seat is ${state.currentSeat}`, {
      seat,
      currentSeat: state.currentSeat,
    });
  }
}

/** All vertices occupied by ANY building. */
function occupiedVertices(state: GameState): Set<string> {
  return new Set(Object.keys(state.buildings));
}

function slotByHex(state: GameState): Map<string, Slot> {
  return new Map(state.config.slots.map((s) => [s.hexId, s]));
}

function hexExists(hexId: string): boolean {
  return hexById.has(hexId);
}

function vertexRef(vertexId: string) {
  const v = vertexById.get(vertexId);
  if (!v) fail("badOp", `unknown vertex ${vertexId}`, { vertexId });
  return v;
}

function edgeRef(edgeId: string) {
  const e = edgeById.get(edgeId);
  if (!e) fail("noEdge", `unknown edge ${edgeId}`, { edgeId });
  return e;
}

/**
 * Vertices belonging to `seat`'s road/building network: every endpoint of
 * the seat's roads plus every vertex holding one of their buildings.
 */
function networkVertices(state: GameState, seat: number): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of Object.entries(state.roads)) {
    if (r.owner !== seat) continue;
    const e = edgeById.get(id)!;
    out.add(e.a);
    out.add(e.b);
  }
  for (const [vId, b] of Object.entries(state.buildings)) {
    if (b.owner === seat) out.add(vId);
  }
  return out;
}

/**
 * Vertices reachable from `starts` using ONLY roads owned by `seat`.
 * (Buildings — own or opponents' — do not block this traversal; it is used
 * for the setup "not connected to your first settlement" check and for
 * nothing else.)
 */
function reachableViaOwnRoads(
  state: GameState,
  seat: number,
  starts: ReadonlySet<string>,
): Set<string> {
  const vEdges = new Map(TOPO.vertices.map((v) => [v.id, v.edges]));
  const seen = new Set(starts);
  const stack = [...starts];
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const eId of vEdges.get(v) ?? []) {
      const road = state.roads[eId];
      if (!road || road.owner !== seat) continue;
      const e = edgeById.get(eId)!;
      const other = e.a === v ? e.b : e.a;
      if (!seen.has(other)) {
        seen.add(other);
        stack.push(other);
      }
    }
  }
  return seen;
}

/**
 * Road legality (setup road and buildRoad share this shape):
 * - edge exists and is empty;
 * - one endpoint is on the player's existing network (or is the given
 *   `anchor` vertex — the just-placed setup settlement);
 * - the OTHER endpoint carries no opponent building (a road may not be
 *   started past an enemy settlement/city).
 */
function roadPlacementLegal(
  state: GameState,
  seat: number,
  edgeId: string,
  anchor: string | null,
): { ok: boolean; code?: "noEdge" | "notConnected" | "roadBlocked" } {
  const e = edgeById.get(edgeId);
  if (!e) return { ok: false, code: "noEdge" };
  if (state.roads[edgeId]) return { ok: false, code: "noEdge" };
  const net = networkVertices(state, seat);
  // START points: endpoints that are on your network (or the setup anchor).
  const starts: string[] = [];
  if (e.a === anchor || net.has(e.a)) starts.push(e.a);
  if (e.b === anchor || net.has(e.b)) starts.push(e.b);
  if (starts.length === 0) return { ok: false, code: "notConnected" };
  // Official rule: you may run a road UP TO an opponent's building (their
  // settlement is a legal far ENDPOINT), but you may never START a road from
  // a vertex that carries an opponent's building — "cannot start a road on
  // the far side of an opponent's building". Own buildings never block.
  const okStart = starts.find((v) => {
    const b = state.buildings[v];
    return !b || b.owner === seat;
  });
  if (!okStart) return { ok: false, code: "roadBlocked" };
  return { ok: true };
}

/** Settlement legality shared by setup and buildSettlement. */
function settlementPlacementLegal(
  state: GameState,
  vertexId: string,
): { ok: boolean; code?: "vertexOccupied" | "distanceRule" | "badOp" } {
  if (!vertexById.has(vertexId)) {
    return { ok: false, code: "badOp" };
  }
  if (state.buildings[vertexId]) return { ok: false, code: "vertexOccupied" };
  if (!distanceRuleFree(TOPO, vertexId, occupiedVertices(state))) {
    return { ok: false, code: "distanceRule" };
  }
  return { ok: true };
}

/** Resolve the steal-pending / clear-window step after robber placement. */
function settleRobberWindow(state: GameState): GameState {
  const aw = state.awaitingSeven;
  if (!aw) return state;
  if (aw.pendingDiscard || aw.mustMoveRobber) return state;
  // SNAPSHOT INVARIANT: discardQueue counts and steal-victim eligibility are
  // computed at roll/robber-landing time from the state AT THAT MOMENT. No
  // op can interleave inside the seven window today (every handler gates on
  // awaitingSeven), so the snapshot cannot go stale. WAVE-3 RE-VERIFY: when
  // trades land, confirm no trade op is legal mid-window (or re-snapshot).
  const victims = victimsOnHex(state, state.robberHexId, aw.roller).filter(
    (v) => handTotal(state.players[v]) > 0,
  );
  if (victims.length === 0) return { ...state, awaitingSeven: null };
  return state; // steal pending
}

function victimsOnHex(state: GameState, hexId: string, roller: number): number[] {
  const seats = new Set<number>();
  for (const vId of hexById.get(hexId)?.vertices ?? []) {
    const b = state.buildings[vId];
    if (b && b.owner !== roller) seats.add(b.owner);
  }
  return [...seats].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Op handlers — each takes the validated state + op, returns the next state
// ---------------------------------------------------------------------------

function applyPlaceSetupPiece(state: GameState, op: PlaceSetupPieceOp): GameState {
  if (state.phase !== "setup" || !state.setupStage) {
    fail("wrongPhase", "placeSetupPiece is only legal during setup");
  }
  requireTurn(state, op.seat);
  const st = state.setupStage;
  const p = player(state, op.seat);
  const awaitingRoadFor = st.justPlacedVertex !== null;

  if (op.kind === "settlement") {
    if (awaitingRoadFor) {
      fail("illegalSetupStage", "a road is owed for the previous settlement before another settlement");
    }
    if (!op.vertexId) fail("badOp", "settlement requires vertexId");
    const vertexId = op.vertexId;
    const leg = settlementPlacementLegal(state, vertexId);
    if (!leg.ok) {
      fail(leg.code!, `setup settlement illegal at ${vertexId}`, { vertexId, code: leg.code });
    }
    // Round 2: must not be connected via OWN roads to your round-1 network.
    if (st.round === 2) {
      const reach = reachableViaOwnRoads(state, op.seat, networkVertices(state, op.seat));
      if (reach.has(vertexId)) {
        fail("notConnected", "second setup settlement must not connect to your first via your roads", {
          vertexId,
        });
      }
    }
    if (p.settlementsLeft <= 0) fail("noSettlementsLeft", "no settlements remaining");

    // Starting resources: ONLY the round-2 settlement pays — one card per
    // DIFFERENT terrain type touching the vertex (desert contributes
    // nothing), straight from the bank inside this op.
    let hand = p.hand;
    let bank = state.bank;
    if (st.round === 2) {
      const slots = slotByHex(state);
      const gained = new Set<Resource>();
      for (const hId of vertexRef(vertexId).hexes) {
        const r = terrainResource(slots.get(hId)!.terrain);
        if (r) gained.add(r);
      }
      for (const r of gained) {
        if (bank[r] < 1) fail("insufficientBank", `bank empty of ${r} during setup grant`);
      }
      const gain: Partial<ResourceCounter> = {};
      for (const r of gained) gain[r] = 1;
      hand = plus(hand, gain);
      bank = minus(bank, gain);
    }

    const next = replacePlayer(state, op.seat, {
      ...p,
      hand,
      settlementsLeft: p.settlementsLeft - 1,
    });
    return {
      ...next,
      bank,
      buildings: {
        ...state.buildings,
        [vertexId]: { kind: "settlement" as const, owner: op.seat },
      },
      setupStage: { ...st, justPlacedVertex: vertexId },
    };
  }

  // kind === 'road'
  if (!awaitingRoadFor) {
    fail("illegalSetupStage", "place a settlement before its attached road");
  }
  if (!op.edgeId) fail("badOp", "road requires edgeId");
  if (p.roadsLeft <= 0) fail("noRoadsLeft", "no roads remaining");
  // ANCHOR-ONLY (Almanac, Round Two): a setup road must be INCIDENT to the
  // just-placed settlement. Merely touching the round-1 network is illegal
  // during setup — legalMoves enumerates exactly the same anchor-incident
  // edges, so applyAction and legalMoves stay in agreement.
  const anchorEdge = edgeById.get(op.edgeId);
  if (
    !anchorEdge ||
    (anchorEdge.a !== st.justPlacedVertex && anchorEdge.b !== st.justPlacedVertex)
  ) {
    fail("notConnected", "setup road must attach to the just-placed settlement", {
      edgeId: op.edgeId,
      anchor: st.justPlacedVertex,
    });
  }
  const leg = roadPlacementLegal(state, op.seat, op.edgeId, st.justPlacedVertex);
  if (!leg.ok) {
    fail(leg.code!, `setup road illegal at ${op.edgeId}`, { edgeId: op.edgeId, code: leg.code });
  }

  const queue = st.seatQueue.slice(1);
  const lastPlacement = st.round === 2 && queue.length === 0;
  const next = replacePlayer(state, op.seat, { ...p, roadsLeft: p.roadsLeft - 1 });
  const withRoad: GameState = {
    ...next,
    roads: { ...state.roads, [op.edgeId]: { owner: op.seat } },
  };
  if (lastPlacement) {
    // Setup complete: the first regular turn belongs to the STARTING PLAYER
    // — the seat that placed first in round 1 (and hence last in round 2).
    return {
      ...withRoad,
      phase: "play",
      setupStage: null,
      currentSeat: 0,
      hasRolled: false,
      longestRoad: recomputeLongestRoad(TOPO, withRoad),
    };
  }
  const nextStage =
    queue.length === 0
      ? {
          round: 2 as const,
          // Snake: round 2 consumes seats in reverse order.
          seatQueue: state.players.map((x) => x.seat).reverse(),
          justPlacedVertex: null,
        }
      : { ...st, seatQueue: queue, justPlacedVertex: null };
  return {
    ...withRoad,
    currentSeat: nextStage.seatQueue[0],
    setupStage: nextStage,
  };
}

function applyRoll(state: GameState, op: RollOp): GameState {
  if (state.phase !== "play") fail("wrongPhase", "roll requires play phase");
  requireTurn(state, op.seat);
  if (state.awaitingSeven) fail("awaitingSeven", "resolve the seven before rolling");
  if (state.hasRolled) fail("alreadyRolled", "already rolled this turn");

  // LOCKED: restore the true stream; BOTH dice drawn (uniform bias); the
  // advanced cursor is written back below.
  const rng = Rng.restore({ seed: state.rngSeed, cursor: state.rngCursor });
  const d1 = 1 + rng.int(6);
  const d2 = 1 + rng.int(6);
  const sum = d1 + d2;
  const cursor = rng.snapshot().cursor;

  const base: GameState = {
    ...state,
    hasRolled: true,
    lastRoll: sum,
    rollLog: [...state.rollLog, sum],
    rngCursor: cursor,
  };

  if (sum === 7) {
    // No production. Build the discard queue in seat order: hands > 7 cards
    // discard floor(total/2). Players at ≤7 owe nothing.
    const queue = state.players
      .map((p) => ({ seat: p.seat, total: handTotal(p) }))
      .filter((x) => x.total > 7)
      .map((x) => ({ seat: x.seat, count: Math.floor(x.total / 2) }));
    return {
      ...base,
      awaitingSeven: {
        roller: op.seat,
        pendingDiscard: queue.length > 0,
        mustMoveRobber: true,
        discardQueue: queue,
      },
    };
  }

  // Production payout. First pass: what each (player, resource) is owed.
  const owed = new Map<number, ResourceCounter>();
  const bump = (seat: number, r: Resource, n: number) => {
    const c = owed.get(seat) ?? zeroCounter();
    c[r] += n;
    owed.set(seat, c);
  };
  for (const slot of state.config.slots) {
    if (slot.numberDisc !== sum) continue;
    if (slot.hexId === state.robberHexId) continue; // robber blocks
    const r = terrainResource(slot.terrain);
    if (!r) continue; // desert
    for (const vId of hexById.get(slot.hexId)!.vertices) {
      const b = state.buildings[vId];
      if (!b) continue;
      bump(b.owner, r, b.kind === "city" ? 2 : 1);
    }
  }

  // Second pass: bank exhaustion — official all-or-nothing per resource,
  // unless exactly one player is owed that resource (they take the rest).
  const players = base.players.map((p) => ({ ...p, hand: { ...p.hand } }));
  let bank = { ...base.bank };
  for (const r of RESOURCES) {
    let needed = 0;
    const owedBy = new Map<number, number>();
    for (const [seat, c] of owed) {
      if (c[r] > 0) {
        needed += c[r];
        owedBy.set(seat, c[r]);
      }
    }
    if (needed === 0) continue;
    if (bank[r] >= needed) {
      for (const [seat, n] of owedBy) players[seat].hand[r] += n;
      bank = { ...bank, [r]: bank[r] - needed };
    } else if (owedBy.size === 1) {
      const [seat, n] = [...owedBy.entries()][0];
      const give = Math.min(n, bank[r]);
      players[seat].hand[r] += give;
      bank = { ...bank, [r]: bank[r] - give };
    }
    // else: resource produces nothing for anyone this roll.
  }
  return { ...base, players, bank };
}

function applyDiscardSeven(state: GameState, op: DiscardSevenOp): GameState {
  if (state.phase !== "play") fail("wrongPhase", "discardSeven requires play phase");
  const aw = state.awaitingSeven;
  if (!aw || !aw.pendingDiscard || aw.discardQueue.length === 0) {
    fail("awaitingSeven", "no discard is owed");
  }
  const front = aw.discardQueue[0];
  if (op.seat !== front.seat) {
    fail("wrongDiscardSeat", `seat ${front.seat} must discard first`, {
      expected: front.seat,
      got: op.seat,
    });
  }
  if (op.cards.length !== front.count) {
    fail("insufficientHand", `must discard exactly ${front.count} cards`, {
      count: front.count,
      got: op.cards.length,
    });
  }
  const p = player(state, op.seat);
  const cost: Partial<ResourceCounter> = {};
  for (const c of op.cards) cost[c] = (cost[c] ?? 0) + 1;
  if (!hasCards(p.hand, cost)) {
    fail("insufficientHand", "discarded cards are not in hand", { cards: op.cards });
  }
  const queue = aw.discardQueue.slice(1);
  const next = replacePlayer(state, op.seat, {
    ...p,
    hand: minus(p.hand, cost),
  });
  // Counts were snapshotted into discardQueue at roll time (see the
  // SNAPSHOT INVARIANT on settleRobberWindow); this op consumes the front
  // entry exactly — nothing may interleave inside the window.
  const awNext = { ...aw, pendingDiscard: queue.length > 0, discardQueue: queue };
  return settleRobberWindow({ ...next, bank: plus(state.bank, cost), awaitingSeven: awNext });
}

function applyMoveRobber(state: GameState, op: MoveRobberOp): GameState {
  if (state.phase !== "play") fail("wrongPhase", "moveRobber requires play phase");
  const aw = state.awaitingSeven;
  if (!aw || aw.pendingDiscard || !aw.mustMoveRobber) {
    fail("awaitingSeven", "the robber is not waiting to move");
  }
  if (op.seat !== aw.roller) {
    fail("notYourTurn", "only the roller moves the robber", { roller: aw.roller });
  }
  if (!hexExists(op.hexId)) fail("badOp", `unknown hex ${op.hexId}`, { hexId: op.hexId });
  if (op.hexId === state.robberHexId) {
    fail("robberSameHex", "the robber must move to a different hex", { hexId: op.hexId });
  }
  const awNext = { ...aw, mustMoveRobber: false };
  return settleRobberWindow({
    ...state,
    robberHexId: op.hexId,
    awaitingSeven: awNext,
  });
}

function applyStealCard(state: GameState, op: StealCardOp): GameState {
  if (state.phase !== "play") fail("wrongPhase", "stealCard requires play phase");
  const aw = state.awaitingSeven;
  if (!aw || aw.pendingDiscard || aw.mustMoveRobber) {
    fail("awaitingSeven", "no steal is pending");
  }
  if (op.seat !== aw.roller) {
    fail("notYourTurn", "only the roller steals", { roller: aw.roller });
  }
  if (op.victimSeat === op.seat) fail("noVictim", "cannot steal from yourself");
  const victim = player(state, op.victimSeat);
  if (!victimsOnHex(state, state.robberHexId, aw.roller).includes(op.victimSeat)) {
    fail("noVictim", "victim has no building on the robber hex", {
      victimSeat: op.victimSeat,
      robberHexId: state.robberHexId,
    });
  }
  const total = handTotal(victim);
  if (total === 0) fail("noVictim", "victim's hand is empty");

  // Blind uniform draw over the victim's expanded hand multiset — ONE int
  // call on the restored stream; cursor written back below.
  const expanded: Resource[] = [];
  for (const r of RESOURCES) for (let i = 0; i < victim.hand[r]; i++) expanded.push(r);
  const rng = Rng.restore({ seed: state.rngSeed, cursor: state.rngCursor });
  const stolen = expanded[rng.int(total)];
  const cursor = rng.snapshot().cursor;

  const roller = player(state, op.seat);
  const players = state.players.slice();
  players[op.victimSeat] = {
    ...victim,
    hand: minus(victim.hand, { [stolen]: 1 }),
  };
  players[op.seat] = { ...roller, hand: plus(roller.hand, { [stolen]: 1 }) };
  return { ...state, players, awaitingSeven: null, rngCursor: cursor };
}

const COST_ROAD: Partial<ResourceCounter> = { wood: 1, brick: 1 };
const COST_SETTLEMENT: Partial<ResourceCounter> = {
  wood: 1,
  brick: 1,
  wool: 1,
  wheat: 1,
};
const COST_CITY: Partial<ResourceCounter> = { wheat: 2, ore: 3 };

function requireBuildable(state: GameState, seat: number): PlayerState {
  if (state.phase !== "play") fail("wrongPhase", "building requires play phase");
  requireTurn(state, seat);
  if (state.awaitingSeven) fail("awaitingSeven", "resolve the seven first");
  if (!state.hasRolled) fail("notRolledYet", "roll before building");
  return player(state, seat);
}

function payCost(
  state: GameState,
  seat: number,
  p: PlayerState,
  cost: Partial<ResourceCounter>,
): GameState {
  if (!hasCards(p.hand, cost)) {
    fail("insufficientHand", "cannot afford", { cost });
  }
  if (!hasCards(state.bank, cost)) {
    fail("insufficientBank", "bank cannot cover", { cost });
  }
  const next = replacePlayer(state, seat, { ...p, hand: minus(p.hand, cost) });
  return { ...next, bank: plus(state.bank, cost) };
}

function applyBuildRoad(state: GameState, op: BuildRoadOp): GameState {
  const p = requireBuildable(state, op.seat);
  edgeRef(op.edgeId);
  if (p.roadsLeft <= 0) fail("noRoadsLeft", "no roads remaining");
  const leg = roadPlacementLegal(state, op.seat, op.edgeId, null);
  if (!leg.ok) {
    fail(leg.code!, `road illegal at ${op.edgeId}`, { edgeId: op.edgeId, code: leg.code });
  }
  let next = payCost(state, op.seat, p, COST_ROAD);
  next = replacePlayer(next, op.seat, {
    ...player(next, op.seat),
    roadsLeft: p.roadsLeft - 1,
  });
  next = { ...next, roads: { ...next.roads, [op.edgeId]: { owner: op.seat } } };
  return { ...next, longestRoad: recomputeLongestRoad(TOPO, next) };
}

function applyBuildSettlement(state: GameState, op: BuildSettlementOp): GameState {
  const p = requireBuildable(state, op.seat);
  vertexRef(op.vertexId);
  if (p.settlementsLeft <= 0) fail("noSettlementsLeft", "no settlements remaining");
  const leg = settlementPlacementLegal(state, op.vertexId);
  if (!leg.ok) {
    fail(leg.code!, `settlement illegal at ${op.vertexId}`, { vertexId: op.vertexId, code: leg.code });
  }
  // Must connect to your network through an unblocked route: the vertex is
  // either on your network directly, or reachable via your roads without
  // passing an opponent's building.
  if (!settlementConnected(state, op.seat, op.vertexId)) {
    fail("notConnected", "settlement must connect to your road network", {
      vertexId: op.vertexId,
    });
  }
  let next = payCost(state, op.seat, p, COST_SETTLEMENT);
  next = replacePlayer(next, op.seat, {
    ...player(next, op.seat),
    settlementsLeft: p.settlementsLeft - 1,
  });
  next = {
    ...next,
    buildings: {
      ...next.buildings,
      [op.vertexId]: { kind: "settlement" as const, owner: op.seat },
    },
  };
  return { ...next, longestRoad: recomputeLongestRoad(TOPO, next) };
}

/**
 * Settlement connectivity: the vertex is on your network AND reachable from
 * a network seed via your roads without crossing an opponent's building.
 * (Own buildings do not block your own expansion.)
 */
function settlementConnected(state: GameState, seat: number, vertexId: string): boolean {
  const net = networkVertices(state, seat);
  if (!net.has(vertexId)) return false;
  // Flood from network seeds that carry no opponent building.
  const seeds = [...net].filter((v) => {
    const b = state.buildings[v];
    return !b || b.owner === seat;
  });
  const seen = new Set(seeds);
  const stack = [...seeds];
  const vEdges = new Map(TOPO.vertices.map((v) => [v.id, v.edges]));
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const eId of vEdges.get(v) ?? []) {
      const road = state.roads[eId];
      if (!road || road.owner !== seat) continue;
      const e = edgeById.get(eId)!;
      const other = e.a === v ? e.b : e.a;
      if (seen.has(other)) continue;
      const b = state.buildings[other];
      if (b && b.owner !== seat) continue; // opponent blocks passage
      seen.add(other);
      stack.push(other);
    }
  }
  return seen.has(vertexId);
}

function applyBuildCity(state: GameState, op: BuildCityOp): GameState {
  const p = requireBuildable(state, op.seat);
  vertexRef(op.vertexId);
  const existing = state.buildings[op.vertexId];
  // Distinct code for "no own settlement there" (empty vertex, or a
  // building owned by someone else): vertexOccupied stays reserved for
  // genuinely-occupied buildSettlement attempts.
  if (!existing || existing.owner !== op.seat || existing.kind !== "settlement") {
    fail("noOwnSettlementThere", "a city replaces your own settlement", {
      vertexId: op.vertexId,
    });
  }
  if (p.citiesLeft <= 0) fail("noCitiesLeft", "no cities remaining");
  let next = payCost(state, op.seat, p, COST_CITY);
  next = replacePlayer(next, op.seat, {
    ...player(next, op.seat),
    citiesLeft: p.citiesLeft - 1,
    settlementsLeft: p.settlementsLeft + 1,
  });
  // Upgrading to a city changes no roads and — under the corrected rule —
  // your OWN building never interrupts your route, so no per-seat route
  // length can change here; the longest-road tile cannot move — no recompute
  // needed.
  return {
    ...next,
    buildings: {
      ...next.buildings,
      [op.vertexId]: { kind: "city" as const, owner: op.seat },
    },
  };
}

function applyPlayKnight(state: GameState, op: PlayKnightOp): GameState {
  if (state.phase !== "play") fail("wrongPhase", "playKnight requires play phase");
  requireTurn(state, op.seat);
  if (state.awaitingSeven) fail("awaitingSeven", "resolve the seven first");
  const p = player(state, op.seat);
  if (p.devPlayedThisTurn) fail("devAlreadyPlayed", "already played a dev card this turn");
  const idx = p.devHand.indexOf("knight");
  if (idx === -1) fail("noDevCard", "no knight in hand");

  const devHand = p.devHand.slice();
  devHand.splice(idx, 1);
  const knightsPlayed = p.knightsPlayed + 1;
  let next = replacePlayer(state, op.seat, {
    ...p,
    devHand,
    devPlayedThisTurn: true,
    knightsPlayed,
  });
  next = { ...next, discardPile: [...state.discardPile, "knight" as const] };

  // Largest army: ≥3 knights and strictly greater than the incumbent takes
  // the tile; ties keep the holder.
  if (knightsPlayed >= 3 && knightsPlayed > next.largestArmy.count) {
    next = {
      ...next,
      largestArmy: { holder: op.seat, count: knightsPlayed },
    };
  }

  // Knight activates the robber: NO discard step.
  return {
    ...next,
    awaitingSeven: {
      roller: op.seat,
      pendingDiscard: false,
      mustMoveRobber: true,
      discardQueue: [],
    },
  };
}

function applyEndTurn(state: GameState, op: EndTurnOp): GameState {
  // 'ended' is terminal (claimVictory retires the game in wave 4): rotating
  // seats on a finished game is illegal at the API level, not just via
  // legalMoves.
  if (state.phase !== "play") {
    fail("wrongPhase", "endTurn requires play phase");
  }
  requireTurn(state, op.seat);
  if (state.awaitingSeven) fail("awaitingSeven", "resolve the seven before ending the turn");
  if (!state.hasRolled) fail("notRolledYet", "roll before ending the turn");
  const p = player(state, op.seat);
  const players = state.players.slice();
  players[op.seat] = { ...p, devPlayedThisTurn: false };
  return {
    ...state,
    players,
    currentSeat: (op.seat + 1) % state.players.length,
    hasRolled: false,
  };
}

// ---------------------------------------------------------------------------
// applyAction — the single entry point
// ---------------------------------------------------------------------------

/**
 * Validate state + op, apply, and return the NEW state. The input is never
 * mutated. Throws ActionError on any illegality; throws zod errors on a
 * malformed state or op.
 */
export function applyAction(state: GameState, op: Op): GameState {
  const s = GameStateSchema.parse(state);
  const parsed = OpSchema.parse(op);
  switch (parsed.type) {
    case "placeSetupPiece":
      return applyPlaceSetupPiece(s, parsed);
    case "roll":
      return applyRoll(s, parsed);
    case "discardSeven":
      return applyDiscardSeven(s, parsed);
    case "moveRobber":
      return applyMoveRobber(s, parsed);
    case "stealCard":
      return applyStealCard(s, parsed);
    case "buildRoad":
      return applyBuildRoad(s, parsed);
    case "buildSettlement":
      return applyBuildSettlement(s, parsed);
    case "buildCity":
      return applyBuildCity(s, parsed);
    case "playKnight":
      return applyPlayKnight(s, parsed);
    case "endTurn":
      return applyEndTurn(s, parsed);
  }
}

// ---------------------------------------------------------------------------
// legalMoves — the UI enumeration contract
// ---------------------------------------------------------------------------

/** All distinct multisets of size `k` drawn from `available` (with counts). */
function multisetCombinations(
  available: ResourceCounter,
  k: number,
): Resource[][] {
  const out: Resource[][] = [];
  const current: Resource[] = [];
  const rec = (ri: number, left: number): void => {
    if (left === 0) {
      out.push(current.slice());
      return;
    }
    if (ri >= RESOURCES.length) return;
    const r = RESOURCES[ri];
    const max = Math.min(available[r], left);
    for (let n = 0; n <= max; n++) {
      for (let i = 0; i < n; i++) current.push(r);
      rec(ri + 1, left - n);
      for (let i = 0; i < n; i++) current.pop();
    }
  };
  rec(0, k);
  return out;
}

function legalSetupMoves(state: GameState, seat: number): Op[] {
  const st = state.setupStage!;
  if (st.justPlacedVertex === null) {
    // Settlement placements.
    const occ = occupiedVertices(state);
    const reach =
      st.round === 2
        ? reachableViaOwnRoads(state, seat, networkVertices(state, seat))
        : null;
    const ops: Op[] = [];
    for (const v of TOPO.vertices) {
      if (occ.has(v.id)) continue;
      if (!distanceRuleFree(TOPO, v.id, occ)) continue;
      if (reach && reach.has(v.id)) continue;
      ops.push({ type: "placeSetupPiece", seat, kind: "settlement", vertexId: v.id });
    }
    return ops;
  }
  // Road placements anchored at the just-placed settlement.
  const anchor = st.justPlacedVertex;
  const v = vertexById.get(anchor)!;
  const ops: Op[] = [];
  for (const eId of v.edges) {
    if (roadPlacementLegal(state, seat, eId, anchor).ok) {
      ops.push({ type: "placeSetupPiece", seat, kind: "road", edgeId: eId });
    }
  }
  return ops;
}

/**
 * Everything `seat` may do right now. O(vertices + edges + resources) per
 * call; safe to run every frame for UI affordances.
 */
export function legalMoves(state: GameState, seat: number): Op[] {
  const s = GameStateSchema.parse(state);
  if (s.phase === "ended") return [];
  const p = s.players[seat];
  if (!p) return [];

  if (s.phase === "setup") {
    if (seat !== s.currentSeat) return [];
    return legalSetupMoves(s, seat);
  }

  // play phase — seven-resolution window overrides normal turn flow.
  const aw = s.awaitingSeven;
  if (aw) {
    if (aw.pendingDiscard) {
      const front = aw.discardQueue[0];
      if (seat !== front.seat) return [];
      const debtor = s.players[front.seat];
      return multisetCombinations(debtor.hand, front.count).map((cards) => ({
        type: "discardSeven" as const,
        seat,
        cards,
      }));
    }
    if (aw.mustMoveRobber) {
      if (seat !== aw.roller) return [];
      return TOPO.hexes
        .filter((h) => h.id !== s.robberHexId)
        .map((h) => ({ type: "moveRobber" as const, seat, hexId: h.id }));
    }
    // Steal pending.
    if (seat !== aw.roller) return [];
    return victimsOnHex(s, s.robberHexId, aw.roller)
      .filter((v) => handTotal(s.players[v]) > 0)
      .map((victimSeat) => ({ type: "stealCard" as const, seat, victimSeat }));
  }

  if (seat !== s.currentSeat) return [];

  const ops: Op[] = [];
  if (!s.hasRolled) {
    // Pre-roll: a knight may be played before rolling.
    if (!p.devPlayedThisTurn && p.devHand.includes("knight")) {
      ops.push({ type: "playKnight", seat });
    }
    ops.push({ type: "roll", seat });
    return ops;
  }

  // Action phase.
  if (!p.devPlayedThisTurn && p.devHand.includes("knight")) {
    ops.push({ type: "playKnight", seat });
  }
  if (p.roadsLeft > 0 && hasCards(p.hand, COST_ROAD) && hasCards(s.bank, COST_ROAD)) {
    for (const e of TOPO.edges) {
      if (roadPlacementLegal(s, seat, e.id, null).ok) {
        ops.push({ type: "buildRoad", seat, edgeId: e.id });
      }
    }
  }
  if (
    p.settlementsLeft > 0 &&
    hasCards(p.hand, COST_SETTLEMENT) &&
    hasCards(s.bank, COST_SETTLEMENT)
  ) {
    for (const v of TOPO.vertices) {
      if (!settlementPlacementLegal(s, v.id).ok) continue;
      if (!settlementConnected(s, seat, v.id)) continue;
      ops.push({ type: "buildSettlement", seat, vertexId: v.id });
    }
  }
  if (p.citiesLeft > 0 && hasCards(p.hand, COST_CITY) && hasCards(s.bank, COST_CITY)) {
    for (const [vId, b] of Object.entries(s.buildings)) {
      if (b.owner === seat && b.kind === "settlement") {
        ops.push({ type: "buildCity", seat, vertexId: vId });
      }
    }
  }
  ops.push({ type: "endTurn", seat });
  return ops;
}
