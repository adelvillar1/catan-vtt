/**
 * road.test.ts — longest-road geometry and tile-award rules.
 */
import { describe, expect, it } from "vitest";
import { buildIsland } from "./board.js";
import {
  longestPathInComponent,
  longestRoadLengthFor,
  recomputeLongestRoad,
} from "./road.js";
import { variableSetup } from "./setup.js";
import type { GameState } from "./state.js";

const TOPO = buildIsland();

/** Strip an island path of N consecutive edges starting at vertex v0. */
function pathEdges(startVertexId: string, n: number, avoid?: ReadonlySet<string>): string[] {
  const vById = new Map(TOPO.vertices.map((v) => [v.id, v]));
  const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
  const out: string[] = [];
  let cur = startVertexId;
  const usedVerts = new Set([cur]);
  for (let i = 0; i < n; i++) {
    const next = vById
      .get(cur)!
      .edges.map((eId) => eById.get(eId)!)
      .filter((e) => !out.includes(e.id) && !(avoid?.has(e.id) ?? false))
      .map((e) => ({ e, other: e.a === cur ? e.b : e.a }))
      .find(({ other }) => !usedVerts.has(other));
    if (!next) throw new Error("test path exhausted");
    out.push(next.e.id);
    cur = next.other;
    usedVerts.add(cur);
  }
  return out;
}

/** Minimal GameState with the given roads/buildings, everyone else empty. */
function stateWith(
  roads: Record<string, { owner: number }>,
  buildings: GameState["buildings"] = {},
): GameState {
  const base = variableSetup(42);
  return { ...base, roads, buildings, longestRoad: { holder: null, length: 0 } };
}

describe("longestPathInComponent", () => {
  /**
   * A straight n-edge path from `startVertexId`, its break vertex (between
   * segments of sizes `pre` and n-pre), and both segments.
   */
  function splitPath(startVertexId: string, n: number, pre: number) {
    const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
    const edges = pathEdges(startVertexId, n);
    let cur = startVertexId;
    for (let i = 0; i < pre; i++) {
      const e = eById.get(edges[i])!;
      cur = e.a === cur ? e.b : e.a;
    }
    return { edges, breakAt: cur, first: edges.slice(0, pre), second: edges.slice(pre) };
  }

  it("straight path of n edges = n", () => {
    const edges = pathEdges(TOPO.vertices[0].id, 7);
    expect(longestPathInComponent(TOPO, edges, new Set())).toBe(7);
  });

  it("an own settlement mid-path does NOT split the count", () => {
    // Corrected rule: your own buildings never interrupt your own route —
    // for the route owner the break set is empty.
    const { edges } = splitPath(TOPO.vertices[0].id, 6, 3);
    expect(longestPathInComponent(TOPO, edges, new Set())).toBe(6);
  });

  it("an opponent settlement mid-path DOES split the count", () => {
    // 6-edge path broken at walk-index 2 → segments of 2 and 4 edges. The
    // broken vertex is a legal path ENDPOINT (roads run up to it) but never
    // an internal node — the two segments cannot merge through it, so the
    // answer is the longer segment alone: 4.
    const { edges, breakAt, first, second } = splitPath(TOPO.vertices[0].id, 6, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(4);
    const breaks = new Set([breakAt]);
    expect(longestPathInComponent(TOPO, edges, breaks)).toBe(4);
    // Sanity: each segment alone is intact and scores its own length.
    expect(longestPathInComponent(TOPO, first, breaks)).toBe(2);
    expect(longestPathInComponent(TOPO, second, breaks)).toBe(4);
    // Endpoint role: a single edge touching the broken vertex still counts.
    expect(longestPathInComponent(TOPO, [edges[1]], breaks)).toBe(1);
  });

  it("a branch does not inflate the path (no vertex revisits)", () => {
    // Take a 4-edge path, then add a spur off the middle vertex.
    const vById = new Map(TOPO.vertices.map((v) => [v.id, v]));
    const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
    const edges = pathEdges(TOPO.vertices[10].id, 4);
    let cur = TOPO.vertices[10].id;
    const walk = [cur];
    for (const eId of edges) {
      const e = eById.get(eId)!;
      cur = e.a === cur ? e.b : e.a;
      walk.push(cur);
    }
    const mid = walk[2];
    const spur = vById
      .get(mid)!
      .edges.map((eId) => eById.get(eId)!)
      .filter((e) => !edges.includes(e.id))
      .map((e) => ({ e, other: e.a === mid ? e.b : e.a }))
      .find(({ other }) => !walk.includes(other));
    expect(spur, "no spur geometry found at a mid vertex").toBeDefined();
    // Correct answer is 4: the main path is already 4 edges, and any route
    // using the spur must give up one side of the branch (a simple path
    // cannot pass through the mid vertex twice). A naive edge-counting
    // algorithm would say 5 — that is exactly the bug this test guards.
    const best = longestPathInComponent(TOPO, [...edges, spur!.e.id], new Set());
    expect(best).toBe(4);
  });

  it("a closed ring of 6 roads around one hex counts 6 (official FAQ)", () => {
    // Find any hex whose 6 boundary edges form a simple cycle.
    const hex = TOPO.hexes.find((h) => new Set(h.edges).size === 6);
    expect(hex, "no 6-edge hex in topology").toBeDefined();
    const ring = [...new Set(hex!.edges)];
    expect(ring).toHaveLength(6);
    expect(longestPathInComponent(TOPO, ring, new Set())).toBe(6);
  });

  it("a 5-edge open chain still counts 5 (loop exemption is not +1)", () => {
    const edges = pathEdges(TOPO.vertices[3].id, 5);
    expect(longestPathInComponent(TOPO, edges, new Set())).toBe(5);
  });
});

describe("recomputeLongestRoad", () => {
  it("nobody holds the tile below 5", () => {
    const edges = pathEdges(TOPO.vertices[0].id, 4);
    const s = stateWith(Object.fromEntries(edges.map((e) => [e, { owner: 0 }])));
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: null, length: 0 });
  });

  it("first to 5 takes the tile", () => {
    const edges = pathEdges(TOPO.vertices[0].id, 5);
    const s = stateWith(Object.fromEntries(edges.map((e) => [e, { owner: 0 }])));
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: 0, length: 5 });
  });

  it("tie keeps the incumbent", () => {
    const a = pathEdges(TOPO.vertices[0].id, 5);
    const b = pathEdges(TOPO.vertices[27].id, 5, new Set(a));
    const roads: Record<string, { owner: number }> = {};
    for (const e of a) roads[e] = { owner: 0 };
    for (const e of b) roads[e] = { owner: 1 };
    const s = stateWith(roads);
    const withIncumbent = { ...s, longestRoad: { holder: 0, length: 5 } };
    expect(recomputeLongestRoad(TOPO, withIncumbent)).toEqual({
      holder: 0,
      length: 5,
    });
  });

  it("tie without incumbent returns the tile to the supply", () => {
    const a = pathEdges(TOPO.vertices[0].id, 5);
    const b = pathEdges(TOPO.vertices[27].id, 5, new Set(a));
    const roads: Record<string, { owner: number }> = {};
    for (const e of a) roads[e] = { owner: 0 };
    for (const e of b) roads[e] = { owner: 1 };
    const s = stateWith(roads);
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: null, length: 0 });
  });

  it("strictly longer road steals the tile", () => {
    const a = pathEdges(TOPO.vertices[0].id, 5);
    const b = pathEdges(TOPO.vertices[27].id, 6, new Set(a));
    const roads: Record<string, { owner: number }> = {};
    for (const e of a) roads[e] = { owner: 0 };
    for (const e of b) roads[e] = { owner: 1 };
    const s = stateWith(roads);
    const withIncumbent = { ...s, longestRoad: { holder: 0, length: 5 } };
    const res = recomputeLongestRoad(TOPO, withIncumbent);
    expect(res.holder).toBe(1);
    expect(res.length).toBe(6);
  });

  it("an opponent's settlement breaks the road", () => {
    const edges = pathEdges(TOPO.vertices[0].id, 6);
    // Seat 0 owns all 6 edges; seat 1 builds at walk-index 2 → segments of
    // 2 and 4 edges. The broken vertex is fully excluded from the route.
    const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
    let cur = TOPO.vertices[0].id;
    for (let i = 0; i < 2; i++) {
      const e = eById.get(edges[i])!;
      cur = e.a === cur ? e.b : e.a;
    }
    const s = stateWith(
      Object.fromEntries(edges.map((e) => [e, { owner: 0 }])),
      { [cur]: { kind: "settlement", owner: 1 } },
    );
    // Longer segment is 4 edges — below the tile threshold.
    expect(longestRoadLengthFor(TOPO, s, 0)).toBe(4);
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: null, length: 0 });
  });

  it("your OWN settlement mid-path never breaks your road", () => {
    // Corrected rule: only OPPONENT buildings interrupt. Same geometry as
    // the opponent case above, but the mid-path building belongs to the
    // road owner — the full 6-edge route counts and takes the tile.
    const edges = pathEdges(TOPO.vertices[0].id, 6);
    const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
    let cur = TOPO.vertices[0].id;
    for (let i = 0; i < 2; i++) {
      const e = eById.get(edges[i])!;
      cur = e.a === cur ? e.b : e.a;
    }
    const s = stateWith(
      Object.fromEntries(edges.map((e) => [e, { owner: 0 }])),
      { [cur]: { kind: "settlement", owner: 0 } },
    );
    expect(longestRoadLengthFor(TOPO, s, 0)).toBe(6);
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: 0, length: 6 });
  });

  it("an opponent junction shared by two chains yields the longer chain, not the sum", () => {
    // Two 4-edge chains meeting ONLY at a vertex holding an opponent
    // settlement: the junction is unreachable for the route, so the answer
    // is 4 (one chain) — never 8. (DFS-start hygiene regression test.)
    let geom: { e1: string[]; e2: string[]; j: string } | null = null;
    for (let i = 0; i < TOPO.vertices.length && !geom; i++) {
      try {
        const e1 = pathEdges(TOPO.vertices[i].id, 4);
        const eById = new Map(TOPO.edges.map((e) => [e.id, e]));
        let j = TOPO.vertices[i].id;
        for (const eId of e1) {
          const e = eById.get(eId)!;
          j = e.a === j ? e.b : e.a;
        }
        const e2 = pathEdges(j, 4, new Set(e1));
        geom = { e1, e2, j };
      } catch {
        // vertex has no room for a 4-edge chain; try the next seed
      }
    }
    expect(geom, "no seed vertex in 0..53 yields the two-chain geometry").not.toBeNull();
    const { e1, e2, j } = geom!;
    const roads: Record<string, { owner: number }> = {};
    for (const e of [...e1, ...e2]) roads[e] = { owner: 0 };
    const opp = stateWith(roads, { [j]: { kind: "settlement", owner: 1 } });
    expect(recomputeLongestRoad(TOPO, opp)).toEqual({ holder: null, length: 0 }); // max 4 < 5
    // Same geometry with YOUR OWN settlement at the junction: the route
    // continues straight through — 8 edges, tile awarded.
    const own = stateWith(roads, { [j]: { kind: "settlement", owner: 0 } });
    expect(recomputeLongestRoad(TOPO, own)).toEqual({ holder: 0, length: 8 });
  });

  it("a 6-road ring awards the tile at 6 (cyclic component)", () => {
    const hex = TOPO.hexes.find((h) => new Set(h.edges).size === 6);
    expect(hex, "no 6-edge hex in topology").toBeDefined();
    const ring = [...new Set(hex!.edges)];
    const s = stateWith(Object.fromEntries(ring.map((e) => [e, { owner: 0 }])));
    expect(recomputeLongestRoad(TOPO, s)).toEqual({ holder: 0, length: 6 });
  });
});
