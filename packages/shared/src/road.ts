/**
 * road.ts — longest-road recomputation for the rules kernel.
 *
 * MODEL (official rules): for one player, consider the graph of THEIR road
 * edges. A vertex containing an OPPONENT's building (settlement or city)
 * breaks continuity: a path may END there but may never pass THROUGH it —
 * and it is never a DFS start (an enemy junction cannot root a route). The
 * player's OWN settlements/cities NEVER interrupt their own route — the
 * path passes straight through them.
 * The player's "longest road" is the longest simple path in this graph that
 * never revisits a vertex and never passes through an enemy-built vertex.
 *
 * IMPLEMENTATION: per player we build connected components of their road
 * edges and run an exact DFS for the longest simple path. Components are
 * tiny (a player owns ≤15 road edges), so exhaustive DFS is trivially cheap
 * — the general longest-trail problem is NP-hard, but 15 edges per player
 * bounds the search. A defensive node-expansion cap (EXPANSION_CAP) throws
 * rather than hanging if that bound is ever violated. CLOSED LOOPS: a path
 * may TERMINATE at its start vertex when it has used ≥1 edge (a 6-road ring
 * around one hex counts 6 — official FAQ), but never passes through it.
 *
 * TILE AWARD: recomputeLongestRoad returns the holder state after an award
 * pass: the tile goes to the unique seat whose length is ≥5 and STRICTLY
 * greater than every other seat's; on any tie the incumbent keeps it (and
 * if the incumbent is not among the tied-for-max, the tile returns to the
 * supply — holder null, length 0). Roads are never removed in v1, so the
 * recompute-from-scratch pass is unconditional and cheap.
 */
import type { IslandTopology } from "./board.js";
import type { GameState } from "./state.js";

export const LONGEST_ROAD_MIN = 5;

/** Defensive bound: with ≤15 edges/component this is never approached. */
const EXPANSION_CAP = 200_000;

function vertexIndex(topo: IslandTopology): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const v of topo.vertices) m.set(v.id, v.edges);
  return m;
}

/**
 * Longest simple path through `edges` (edge ids of ONE player) in the
 * topology, with enemy-built vertices breaking continuity.
 *
 * `breaks` = vertices occupied by OPPONENT buildings (and only those).
 * Such a vertex may END a path but never be INTERNAL to one; DFS starts
 * are skipped there too (starting on an enemy junction would let two
 * severed chains merge through a vertex that legally blocks both).
 */
export function longestPathInComponent(
  topo: IslandTopology,
  edgeIds: readonly string[],
  breaks: ReadonlySet<string>,
): number {
  if (edgeIds.length === 0) return 0;
  const edgeById = new Map(topo.edges.map((e) => [e.id, e]));
  // Adjacency: vertex -> [{edge, other}]
  const adj = new Map<string, Array<{ edge: string; other: string }>>();
  for (const id of edgeIds) {
    const e = edgeById.get(id);
    if (!e) throw new RangeError(`longestPathInComponent: unknown edge ${id}`);
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push({ edge: id, other: e.b });
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push({ edge: id, other: e.a });
  }

  let best = 0;
  let expansions = 0;
  const usedEdges = new Set<string>();
  const usedVerts = new Set<string>();
  let root = "";

  const dfs = (at: string, len: number): void => {
    if (++expansions > EXPANSION_CAP) {
      throw new Error(
        `longestPathInComponent: expansion cap hit (${edgeIds.length} edges)`,
      );
    }
    if (len > best) best = len;
    for (const { edge, other } of adj.get(at) ?? []) {
      if (usedEdges.has(edge)) continue;
      if (other === root && len >= 1) {
        // Closed loop (official FAQ: a ring of 6 roads around one hex counts
        // all 6). The path may TERMINATE back at its start vertex — counted
        // as one more edge — but may never pass through it, so no recursion.
        if (len + 1 > best) best = len + 1;
        continue;
      }
      if (usedVerts.has(other)) continue; // simple path: no vertex revisit
      // An enemy-built vertex is a legal path ENDPOINT (your road may run
      // up to it) but never an INTERNAL node — terminate, don't recurse.
      if (breaks.has(other)) {
        if (len + 1 > best) best = len + 1;
        continue;
      }
      usedEdges.add(edge);
      usedVerts.add(other);
      dfs(other, len + 1);
      usedVerts.delete(other);
      usedEdges.delete(edge);
    }
  };

  for (const [start] of adj) {
    if (breaks.has(start)) continue; // enemy junction: never a path member
    root = start;
    usedVerts.add(start);
    dfs(start, 0);
    usedVerts.delete(start);
  }
  return best;
}

/**
 * Longest road length for `seat`: max over the connected components of
 * their road-edge graph.
 */
export function longestRoadLengthFor(
  topo: IslandTopology,
  state: Pick<GameState, "roads" | "buildings">,
  seat: number,
): number {
  const mine = Object.entries(state.roads)
    .filter(([, r]) => r.owner === seat)
    .map(([id]) => id);
  if (mine.length === 0) return 0;
  // Per-seat break set: ONLY opponent buildings block this seat's route.
  const breaks = new Set(
    Object.entries(state.buildings)
      .filter(([, b]) => b.owner !== seat)
      .map(([vId]) => vId),
  );
  const vEdges = vertexIndex(topo);
  const edgeById = new Map(topo.edges.map((e) => [e.id, e]));

  // Connected components via vertex flood over the player's own edges.
  const edgeSet = new Set(mine);
  const seenVerts = new Set<string>();
  let best = 0;
  // Seed: vertices incident to any of the player's edges.
  const seeds: string[] = [];
  for (const id of mine) {
    const e = edgeById.get(id)!;
    seeds.push(e.a, e.b);
  }
  for (const seed of seeds) {
    if (seenVerts.has(seed)) continue;
    // Flood from seed across the player's edges.
    const compEdges: string[] = [];
    const stack = [seed];
    seenVerts.add(seed);
    while (stack.length > 0) {
      const v = stack.pop()!;
      for (const eId of vEdges.get(v) ?? []) {
        if (!edgeSet.has(eId)) continue;
        compEdges.push(eId);
        edgeSet.delete(eId);
        const e = edgeById.get(eId)!;
        const other = e.a === v ? e.b : e.a;
        if (!seenVerts.has(other)) {
          seenVerts.add(other);
          stack.push(other);
        }
      }
    }
    best = Math.max(best, longestPathInComponent(topo, compEdges, breaks));
  }
  return best;
}

/**
 * Recompute the longest-road tile from scratch. Returns the new
 * {holder, length} pair (pure — caller installs it on the next state).
 *
 * Award rule: a seat holds the tile iff its length is ≥5 and strictly
 * greater than every other seat's. Ties: the incumbent keeps the tile if
 * they are tied for the max; otherwise nobody holds it.
 */
export function recomputeLongestRoad(
  topo: IslandTopology,
  state: GameState,
): { holder: number | null; length: number } {
  const lengths = state.players.map((p) =>
    longestRoadLengthFor(topo, state, p.seat),
  );
  const max = Math.max(0, ...lengths);
  if (max < LONGEST_ROAD_MIN) return { holder: null, length: 0 };
  const tied = state.players
    .map((p, i) => ({ seat: p.seat, len: lengths[i] }))
    .filter((x) => x.len === max);
  if (tied.length === 1) return { holder: tied[0].seat, length: max };
  // Tie for the max: incumbent keeps only if they are among the tied.
  const incumbent = state.longestRoad.holder;
  if (incumbent !== null && tied.some((x) => x.seat === incumbent)) {
    return { holder: incumbent, length: max };
  }
  return { holder: null, length: 0 };
}
