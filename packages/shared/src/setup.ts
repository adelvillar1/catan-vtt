/**
 * setup.ts — the two official setup generators.
 *
 * 1. variableSetup     — the rulebook's standard "spiral" number placement:
 *    discs in printed order along a 19-cell spiral path, desert skipped.
 *    This is the printed-order ritual ONLY; it does NOT guarantee red-number
 *    (6/8) separation and we deliberately add no swap-repair to it.
 * 2. randomDiscSetup   — the rulebook's alternative: discs shuffled onto the
 *    18 non-desert hexes, then swap-repaired until no two red numbers (6/8)
 *    share an edge.
 *
 * Everything else (terrain shuffle, ports, robber, bank, deck, players) is
 * shared. Fully deterministic: same seed → deep-equal GameState.
 *
 * RNG DESIGN (locked): each generator uses ONE continuous Rng stream seeded
 * with `seed`. The port-legality retry loop rebuilds the board (terrain
 * shuffle, discs, ports) drawing CONTINUOUSLY from that same stream — it
 * never reseeds per attempt. Therefore `state.rngCursor` is the authoritative
 * draw count of the stream seeded with `state.rngSeed`, and dice continuation
 * in applyAction MUST restore exactly
 * `Rng.restore({ seed: state.rngSeed, cursor: state.rngCursor })` to continue
 * the true stream. Reseed-per-attempt is FORBIDDEN (it makes rngCursor count
 * draws from a stream that (rngSeed) cannot restore to).
 */
import { Rng } from "./rng.js";
import {
  buildIsland,
  cornerHexes,
  cubeDistance,
  type IslandTopology,
} from "./board.js";
import {
  DECK_COMPOSITION,
  GameStateSchema,
  terrainResource,
  type DevCardType,
  type GameState,
  type PlayerState,
  type Port,
  type PortType,
  type Resource,
  type Slot,
  type Terrain,
} from "./state.js";

/** The 18 number discs in printed order. */
export const NUMBER_DISCS: readonly number[] = [
  2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12,
] as const;

const TERRAIN_COUNTS: Record<Terrain, number> = {
  forest: 4,
  hills: 3,
  pasture: 3,
  fields: 4,
  mountains: 4,
  desert: 1,
};

const PLAYER_COLORS = ["Red", "Blue", "Orange", "Brown"] as const;

export interface SetupOptions {
  playerCount?: 3 | 4;
  playerNames?: string[];
}

// ---------------------------------------------------------------------------
// Spiral path
// ---------------------------------------------------------------------------

/**
 * Build the 19-cell spiral walk used by the standard setup: start at
 * `startCornerId` (a degree-3 corner hex), walk the 12-hex outer ring
 * counter-clockwise, step inward, walk the 6-hex inner ring CCW, finish at
 * the center. Every consecutive pair shares an edge; all 19 cells distinct.
 *
 * CCW sense is derived from geometry: consecutive outer cells are ordered so
 * the board centroid lies to the LEFT of each walk step.
 */
export function spiralPath(
  topo: IslandTopology,
  startCornerId: string,
  rng: Rng,
): string[] {
  const byId = new Map(topo.hexes.map((h) => [h.id, h]));
  const centerId = "0,2";
  const center = byId.get(centerId);
  if (!center) throw new Error("spiralPath: no center hex 0,2");

  // Inner ring = center's neighbors (all distance 1); outer = the rest.
  const innerSet = new Set(center.neighbors);
  const outer = topo.hexes.filter((h) => h.id !== centerId && !innerSet.has(h.id));

  const centroid = (ids: string[]): [number, number] => {
    let x = 0;
    let y = 0;
    for (const id of ids) {
      const h = byId.get(id)!;
      x += Math.sqrt(3) * (h.q + h.r / 2);
      y += 1.5 * h.r;
    }
    return [x / ids.length, y / ids.length];
  };
  const cc = centroid(topo.hexes.map((h) => h.id));

  const ringNeighborsOf = (id: string, ring: Set<string>): string[] =>
    byId.get(id)!.neighbors.filter((n) => ring.has(n));

  /**
   * Walk a ring CCW from `startId`: at each step, of the ≤2 in-ring
   * neighbors (excluding where we came from), pick the one where the board
   * centroid lies to the LEFT of the step direction (cross product > 0).
   * `count` cells are returned. `entryNext` optionally forces the first step
   * (used when entering the inner ring — the continuation must be CCW, and
   * both in-ring neighbors are geometrically consistent candidates from a
   * fresh entry).
   */
  const walkRing = (
    startId: string,
    ring: Set<string>,
    count: number,
    entryNext?: string,
  ): string[] => {
    const path = [startId];
    let prev: string | null = null;
    let cur = startId;
    if (entryNext !== undefined) {
      if (!byId.get(cur)!.neighbors.includes(entryNext) || !ring.has(entryNext)) {
        throw new Error(
          `spiralPath: entry ${startId}->${entryNext} is not an in-ring edge`,
        );
      }
      prev = cur;
      cur = entryNext;
      path.push(cur);
    }
    while (path.length < count) {
      const cands = ringNeighborsOf(cur, ring).filter((n) => n !== prev);
      if (cands.length === 0) throw new Error("spiralPath: ring walk dead end");
      let next: string;
      if (cands.length === 1) {
        next = cands[0];
      } else {
        const hCur = byId.get(cur)!;
        const cx = Math.sqrt(3) * (hCur.q + hCur.r / 2);
        const cy = 1.5 * hCur.r;
        next = cands.find((n) => {
          const hn = byId.get(n)!;
          const nx = Math.sqrt(3) * (hn.q + hn.r / 2);
          const ny = 1.5 * hn.r;
          const cross = (nx - cx) * (cc[1] - cy) - (ny - cy) * (cc[0] - cx);
          return cross > 0;
        })!;
      }
      path.push(next);
      prev = cur;
      cur = next;
    }
    return path;
  };

  // Outer ring walk.
  const outerSet = new Set(outer.map((h) => h.id));
  if (!outerSet.has(startCornerId)) {
    throw new RangeError(`spiralPath: ${startCornerId} is not an outer corner hex`);
  }
  const outerPath = walkRing(startCornerId, outerSet, 12);
  if (new Set(outerPath).size !== 12) {
    throw new Error("spiralPath: outer walk revisited a cell");
  }

  // Step inward (LOCKED DECISION): the 12-cell outer cycle ends on an edge
  // hex with exactly two inner-ring neighbors; the entry is rng.pick over
  // those candidates — seeded, deterministic, resolves the ambiguity.
  const lastOuter = outerPath[outerPath.length - 1];
  const inwardCandidates = byId
    .get(lastOuter)!
    .neighbors.filter((n) => innerSet.has(n))
    .sort();
  if (inwardCandidates.length === 0) {
    throw new Error(`spiralPath: no inward step from ${lastOuter}`);
  }
  const innerEntry = rng.pick(inwardCandidates);

  // Continue CCW through all 6 inner cells: the entry's two in-ring
  // neighbors are CW/CCW around the center — keep the CCW successor
  // (centroid left of the step direction).
  const hEntry = byId.get(innerEntry)!;
  const ex = Math.sqrt(3) * (hEntry.q + hEntry.r / 2);
  const ey = 1.5 * hEntry.r;
  const ccwNext = ringNeighborsOf(innerEntry, innerSet).find((n) => {
    const hn = byId.get(n)!;
    const nx = Math.sqrt(3) * (hn.q + hn.r / 2);
    const ny = 1.5 * hn.r;
    const cross = (nx - ex) * (cc[1] - ey) - (ny - ey) * (cc[0] - ex);
    return cross > 0;
  });
  if (!ccwNext) throw new Error("spiralPath: no CCW inner continuation");

  const innerPath = walkRing(innerEntry, innerSet, 6, ccwNext);
  if (new Set(innerPath).size !== 6) {
    throw new Error("spiralPath: inner walk revisited a cell");
  }

  const full = [...outerPath, ...innerPath, centerId];
  if (full.length !== 19 || new Set(full).size !== 19) {
    throw new Error("spiralPath: path is not 19 distinct cells");
  }
  return full;
}

// ---------------------------------------------------------------------------
// Shared assembly helpers
// ---------------------------------------------------------------------------

/** Shuffle terrain onto the 19 canonical slot ids. */
function assembleBoard(rng: Rng, topo: IslandTopology): Slot[] {
  const terrains: Terrain[] = [];
  for (const [terrain, count] of Object.entries(TERRAIN_COUNTS) as Array<
    [Terrain, number]
  >) {
    for (let i = 0; i < count; i++) terrains.push(terrain);
  }
  const shuffled = rng.shuffle(terrains);
  return topo.hexes.map((hex, i) => ({
    hexId: hex.id,
    terrain: shuffled[i],
    numberDisc: null,
  }));
}

/** Assign discs in printed order along the spiral walk, skipping the desert. */
function placeDiscsSpiral(rng: Rng, topo: IslandTopology, slots: Slot[]): void {
  const startCorner = rng.pick(cornerHexes(topo));
  const path = spiralPath(topo, startCorner, rng);
  const byId = new Map(slots.map((s) => [s.hexId, s]));
  let di = 0;
  for (const hexId of path) {
    const slot = byId.get(hexId)!;
    if (slot.terrain === "desert") continue; // desert consumes no disc
    slot.numberDisc = NUMBER_DISCS[di++];
  }
  if (di !== NUMBER_DISCS.length) {
    throw new Error(`placeDiscsSpiral: placed ${di}/${NUMBER_DISCS.length} discs`);
  }
}

/** Shuffle discs onto non-desert hexes (no red separation). */
function placeDiscsRandom(rng: Rng, slots: Slot[]): void {
  const discs = rng.shuffle(NUMBER_DISCS);
  let di = 0;
  for (const slot of slots) {
    if (slot.terrain === "desert") continue;
    slot.numberDisc = discs[di++];
  }
}

const isRed = (d: number | null): d is number => d === 6 || d === 8;

/**
 * Swap-repair red-number adjacency: while any two hexes showing 6/8 share an
 * edge, swap one red disc with a non-red disc whose position is not adjacent
 * to any OTHER red position. Bounded at 500 iterations.
 */
function repairRedAdjacency(
  rng: Rng,
  topo: IslandTopology,
  slots: Slot[],
  seed: number,
): void {
  const byId = new Map(slots.map((s) => [s.hexId, s]));
  const hexById = new Map(topo.hexes.map((h) => [h.id, h]));

  const violatingPair = (): [Slot, Slot] | null => {
    for (const h of topo.hexes) {
      const s = byId.get(h.id)!;
      if (!isRed(s.numberDisc)) continue;
      for (const nId of h.neighbors) {
        const ns = byId.get(nId)!;
        if (isRed(ns.numberDisc) && h.id < nId) return [s, ns];
      }
    }
    return null;
  };

  let iter = 0;
  let pair = violatingPair();
  while (pair) {
    if (++iter > 500) {
      throw new Error(`randomDiscSetup: no repair path seed=${seed}`);
    }
    const redPositions = slots.filter((s) => isRed(s.numberDisc));
    const redsInPair = new Set([pair[0].hexId, pair[1].hexId]);
    // Candidate non-red slots adjacent to no red OUTSIDE the violating pair:
    // reds inside the pair are about to move, so their current adjacency
    // must not disqualify the target (otherwise a fully red-surrounded
    // non-red can never receive the disc and the loop deadlocks).
    const candidates = slots.filter((s) => {
      if (isRed(s.numberDisc) || s.numberDisc === null) return false;
      const hex = hexById.get(s.hexId)!;
      return redPositions.every(
        (rp) => redsInPair.has(rp.hexId) || !hex.neighbors.includes(rp.hexId),
      );
    });
    if (candidates.length === 0) {
      throw new Error(`randomDiscSetup: no repair path seed=${seed}`);
    }
    const redSlot = pair[0];
    const swapWith = rng.pick(candidates);
    const tmp = redSlot.numberDisc;
    redSlot.numberDisc = swapWith.numberDisc;
    swapWith.numberDisc = tmp;
    pair = violatingPair();
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

const PORT_TYPES: PortType[] = [
  "wood",
  "brick",
  "wool",
  "wheat",
  "ore",
  "generic",
  "generic",
  "generic",
  "generic",
];

/**
 * Place the 9 ports on distinct coastal vertices. A 2:1 port must touch ≥1
 * hex of its resource; violations are repaired by swapping with the nearest
 * generic port that is legal there. If no generic is available, throws and
 * the caller retries the whole board.
 *
 * Lookups (coastal set, vertex-by-id, terrain-by-hex) are hoisted: built ONCE
 * per call, not per vertex/port.
 */
function placePorts(rng: Rng, topo: IslandTopology, slots: Slot[]): Port[] {
  const coastalSet = new Set(topo.coastalVertices);
  const vertexById = new Map(topo.vertices.map((v) => [v.id, v]));
  const terrainByHex = new Map(slots.map((s) => [s.hexId, s.terrain]));

  const portLegal = (vertexId: string, type: PortType): boolean => {
    if (type === "generic") return true;
    const v = vertexById.get(vertexId)!;
    return v.hexes.some(
      (hId) => terrainResource(terrainByHex.get(hId)!) === (type as Resource),
    );
  };

  const coastal = topo.vertices.map((v) => v.id).filter((id) => coastalSet.has(id));
  if (coastal.length < 9) throw new Error("placePorts: <9 coastal vertices");
  const chosen = rng.shuffle(coastal).slice(0, 9);
  const types = rng.shuffle(PORT_TYPES);
  const ports: Port[] = chosen.map((vertexId, i) => ({
    vertexId,
    type: types[i],
  }));

  // Repair: for each illegal 2:1, swap with the nearest legal generic.
  for (let i = 0; i < ports.length; i++) {
    const p = ports[i];
    if (p.type === "generic") continue;
    if (portLegal(p.vertexId, p.type)) continue;
    const generics = ports
      .map((g, j) => ({ g, j }))
      .filter(({ g }) => g.type === "generic")
      .filter(({ g }) => portLegal(g.vertexId, p.type));
    if (generics.length === 0) {
      throw new Error("placePorts: no generic available for repair");
    }
    // Nearest by hex distance between the hexes the two vertices share
    // (min over hex pairs touching each vertex).
    const dist = (a: string, b: string): number => {
      let best = Infinity;
      for (const ha of vertexById.get(a)!.hexes) {
        for (const hb of vertexById.get(b)!.hexes) {
          best = Math.min(best, cubeDistance(topo, ha, hb));
        }
      }
      return best;
    };
    generics.sort((x, y) => {
      const d = dist(p.vertexId, x.g.vertexId) - dist(p.vertexId, y.g.vertexId);
      return d !== 0 ? d : x.g.vertexId.localeCompare(y.g.vertexId);
    });
    const { j } = generics[0];
    ports[j] = { ...ports[j], type: p.type };
    ports[i] = { ...p, type: "generic" };
  }
  return ports;
}

// ---------------------------------------------------------------------------
// GameState assembly
// ---------------------------------------------------------------------------

function buildDeck(rng: Rng): DevCardType[] {
  const deck: DevCardType[] = [];
  for (const [type, count] of Object.entries(DECK_COMPOSITION) as Array<
    [DevCardType, number]
  >) {
    for (let i = 0; i < count; i++) deck.push(type);
  }
  return rng.shuffle(deck);
}

function buildPlayers(opts?: SetupOptions): PlayerState[] {
  const n = opts?.playerCount ?? 3;
  if (n !== 3 && n !== 4) throw new RangeError(`playerCount must be 3 or 4, got ${n}`);
  const names = opts?.playerNames ?? [];
  return Array.from({ length: n }, (_, seat) => ({
    seat,
    name: names[seat] ?? `Player ${seat + 1}`,
    color: PLAYER_COLORS[seat],
    hand: { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 },
    devHand: [],
    devPlayedThisTurn: false,
    devBoughtThisTurn: {
      knight: 0,
      victoryPoint: 0,
      monopoly: 0,
      roadBuilding: 0,
      yearOfPlenty: 0,
    },
    roadsLeft: 15,
    settlementsLeft: 5,
    citiesLeft: 4,
    knightsPlayed: 0,
  }));
}

function finalize(
  rng: Rng,
  seed: number,
  topo: IslandTopology,
  slots: Slot[],
  ports: Port[],
  opts?: SetupOptions,
): GameState {
  const players = buildPlayers(opts);
  const desert = slots.find((s) => s.terrain === "desert");
  if (!desert) throw new Error("finalize: no desert slot");
  const state: GameState = {
    config: { slots, ports, topology: topo },
    phase: "setup",
    players,
    currentSeat: 0,
    setupStage: {
      round: 1,
      seatQueue: players.map((p) => p.seat),
      justPlacedVertex: null,
    },
    bank: { wood: 19, brick: 19, wool: 19, wheat: 19, ore: 19 },
    deck: buildDeck(rng),
    discardPile: [],
    robberHexId: desert.hexId,
    buildings: {},
    roads: {},
    longestRoad: { holder: null, length: 0 },
    largestArmy: { holder: null, count: 0 },
    hasRolled: false,
    pendingTrade: null,
    awaitingSeven: null,
    lastRoll: null,
    rollLog: [],
    winner: null,
    finalPoints: null,
    rngSeed: seed,
    rngCursor: rng.snapshot().cursor,
    version: 1,
  };
  // Fail loud if our assembly ever drifts from the schema.
  return GameStateSchema.parse(state);
}

/**
 * Standard setup: spiral (printed-order) number placement.
 *
 * Single continuous RNG (see module JSDoc): one stream seeded with `seed`;
 * each port-repair retry rebuilds the board drawing fresh entropy from the
 * SAME stream, so rngSeed/rngCursor always restore to a live position.
 */
export function variableSetup(seed: number, opts?: SetupOptions): GameState {
  const rng = Rng.create(seed);
  const topo = buildIsland();
  for (let attempt = 0; attempt < 1000; attempt++) {
    const slots = assembleBoard(rng, topo);
    placeDiscsSpiral(rng, topo, slots);
    try {
      const ports = placePorts(rng, topo, slots);
      return finalize(rng, seed, topo, slots, ports, opts);
    } catch {
      // Port repair exhausted its generics — retry with fresh entropy from
      // the same stream (never a reseed).
    }
  }
  throw new Error(`variableSetup: port legality repair exhausted seed=${seed}`);
}

/**
 * Rulebook alternative: shuffled discs + red-number (6/8) separation repair.
 *
 * Same single-continuous-RNG design as variableSetup.
 */
export function randomDiscSetup(seed: number, opts?: SetupOptions): GameState {
  const rng = Rng.create(seed);
  const topo = buildIsland();
  for (let attempt = 0; attempt < 1000; attempt++) {
    const slots = assembleBoard(rng, topo);
    placeDiscsRandom(rng, slots);
    repairRedAdjacency(rng, topo, slots, seed);
    try {
      const ports = placePorts(rng, topo, slots);
      return finalize(rng, seed, topo, slots, ports, opts);
    } catch {
      // see variableSetup
    }
  }
  throw new Error(`randomDiscSetup: port legality repair exhausted seed=${seed}`);
}
