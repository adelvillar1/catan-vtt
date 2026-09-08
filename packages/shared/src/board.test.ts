import { describe, expect, it } from "vitest";
import {
  buildIsland,
  cornerHexes,
  cubeDistance,
  distanceRuleFree,
  hexesAtVertex,
} from "./board.js";

describe("buildIsland counts", () => {
  const topo = buildIsland();

  it("has exactly 19 hexes in canonical order (r asc, then q asc)", () => {
    expect(topo.hexes).toHaveLength(19);
    const ids = topo.hexes.map((h) => h.id);
    expect(ids).toEqual([
      "0,0", "1,0", "2,0",
      "-1,1", "0,1", "1,1", "2,1",
      "-2,2", "-1,2", "0,2", "1,2", "2,2",
      "-2,3", "-1,3", "0,3", "1,3",
      "-2,4", "-1,4", "0,4",
    ]);
  });

  it("has exactly 54 unique vertices and 72 unique edges", () => {
    expect(topo.vertices).toHaveLength(54);
    expect(topo.edges).toHaveLength(72);
    expect(Object.keys(topo.vertexCoords)).toHaveLength(54);
    // IDs are unique.
    expect(new Set(topo.vertices.map((v) => v.id)).size).toBe(54);
    expect(new Set(topo.edges.map((e) => e.id)).size).toBe(72);
  });

  it("splits edges 42 interior (2 hexes) + 30 coastal (1 hex)", () => {
    const two = topo.edges.filter((e) => e.hexes.length === 2);
    const one = topo.edges.filter((e) => e.hexes.length === 1);
    expect(two).toHaveLength(42);
    expect(one).toHaveLength(30);
    expect(two.length + one.length).toBe(72);
    expect(topo.interiorEdgeCount).toBe(42);
    expect(topo.coastalEdgeCount).toBe(30);
    // Every coastal edge is flagged, no interior edge is.
    expect(two.every((e) => !e.coastal)).toBe(true);
    expect(one.every((e) => e.coastal)).toBe(true);
  });

  it("has exactly 30 coastal vertices", () => {
    expect(topo.coastalVertices).toHaveLength(30);
    // Coastal vertices are exactly those touching fewer than 3 hexes.
    const expected = topo.vertices
      .filter((v) => v.hexes.length < 3)
      .map((v) => v.id)
      .sort();
    expect(topo.coastalVertices).toEqual(expected);
  });

  it("hex neighbor-degree distribution is 6×3, 6×4, 7×6 (measured)", () => {
    // Measured by running the derivation (spec's tentative "12×4" was wrong;
    // this is ground truth): the 6 corner hexes of the outer ring have
    // degree 3, the 6 non-corner outer-ring hexes have degree 4, and the
    // center plus its 6-hex inner ring all have degree 6.
    const hist = new Map<number, number>();
    for (const h of topo.hexes) {
      hist.set(h.neighbors.length, (hist.get(h.neighbors.length) ?? 0) + 1);
    }
    expect(hist.get(3)).toBe(6);
    expect(hist.get(4)).toBe(6);
    expect(hist.get(5) ?? 0).toBe(0);
    expect(hist.get(6)).toBe(7);
    expect(topo.hexes.find((h) => h.id === "0,2")!.neighbors).toHaveLength(6);
    // Every inner-ring hex (distance 1 from center) has 6 neighbors.
    const innerRing = topo.hexes.filter(
      (h) => cubeDistance(topo, "0,2", h.id) === 1,
    );
    expect(innerRing).toHaveLength(6);
    expect(innerRing.every((h) => h.neighbors.length === 6)).toBe(true);
  });

  it("every hex has 6 vertices and 6 edges, all sorted", () => {
    for (const h of topo.hexes) {
      expect(h.vertices).toHaveLength(6);
      expect(h.edges).toHaveLength(6);
      expect(h.vertices).toEqual(h.vertices.slice().sort());
      expect(h.edges).toEqual(h.edges.slice().sort());
      expect(h.neighbors).toEqual(h.neighbors.slice().sort());
    }
  });

  it("vertex/edge cross-references are consistent", () => {
    const edgeById = new Map(topo.edges.map((e) => [e.id, e]));
    for (const v of topo.vertices) {
      // Every incident edge lists this vertex as an endpoint.
      for (const eId of v.edges) {
        const e = edgeById.get(eId)!;
        expect(e.a === v.id || e.b === v.id).toBe(true);
      }
      // Land vertices touch 1-3 hexes and 2-3 edges.
      expect(v.hexes.length).toBeGreaterThanOrEqual(1);
      expect(v.hexes.length).toBeLessThanOrEqual(3);
      expect(v.edges.length).toBeGreaterThanOrEqual(2);
      expect(v.edges.length).toBeLessThanOrEqual(3);
    }
    // Edge endpoint lexicographic ordering holds.
    for (const e of topo.edges) {
      expect(e.a < e.b).toBe(true);
      expect(e.id).toBe(`e:${e.a}|${e.b}`);
    }
  });

  it("vertex.adjacent matches edge endpoints exactly (and is symmetric)", () => {
    const edgeById = new Map(topo.edges.map((e) => [e.id, e]));
    for (const v of topo.vertices) {
      // Ground truth: other endpoints of v's incident edges.
      const expected = v.edges
        .map((eId) => {
          const e = edgeById.get(eId)!;
          return e.a === v.id ? e.b : e.a;
        })
        .sort();
      expect(v.adjacent).toEqual(expected);
      expect(v.adjacent.length).toBe(v.edges.length);
    }
    // Degree distribution measured on this board: 18 vertices with 2 edge
    // neighbors, 36 with 3.
    const hist = new Map<number, number>();
    for (const v of topo.vertices) {
      hist.set(v.adjacent.length, (hist.get(v.adjacent.length) ?? 0) + 1);
    }
    expect(hist.get(2)).toBe(18);
    expect(hist.get(3)).toBe(36);
    // Symmetry over all 72 edges: u in v.adjacent iff v in u.adjacent.
    const byId = new Map(topo.vertices.map((v) => [v.id, v]));
    for (const e of topo.edges) {
      expect(byId.get(e.a)!.adjacent).toContain(e.b);
      expect(byId.get(e.b)!.adjacent).toContain(e.a);
    }
  });

  it("two consecutive calls deep-equal (pure derivation)", () => {
    expect(buildIsland()).toEqual(buildIsland());
  });

  it("contains no Map/Set in returned objects (JSON-serializable)", () => {
    const roundTrip = JSON.parse(JSON.stringify(topo));
    expect(roundTrip).toEqual(topo);
  });
});

describe("cornerHexes / cubeDistance", () => {
  const topo = buildIsland();

  it("finds exactly the 6 degree-3 corner hexes", () => {
    expect(cornerHexes(topo)).toHaveLength(6);
    expect(cornerHexes(topo)).toEqual(["-2,2", "-2,4", "0,0", "0,4", "2,0", "2,2"].sort());
  });

  it("inner ring (distance 1 from center) is exactly 6 hexes", () => {
    const ring = topo.hexes
      .map((h) => h.id)
      .filter((id) => cubeDistance(topo, "0,2", id) === 1)
      .sort();
    expect(ring).toEqual(["-1,2", "-1,3", "0,1", "0,3", "1,1", "1,2"].sort());
  });

  it("cubeDistance is a metric over the board", () => {
    expect(cubeDistance(topo, "0,2", "0,2")).toBe(0);
    expect(cubeDistance(topo, "0,0", "0,4")).toBe(4);
    expect(cubeDistance(topo, "-2,2", "2,2")).toBe(4);
    expect(cubeDistance(topo, "2,0", "-2,4")).toBe(4);
  });
});

describe("hexesAtVertex", () => {
  const topo = buildIsland();

  it("returns hexes for interior (3-hex) and coastal vertices", () => {
    // A vertex of the center hex that is shared by 3 hexes: center (0,2)
    // center is (sqrt3, 3); its top vertex is (sqrt3, 2) shared with (0,1),(1,1).
    const three = topo.vertices.find((v) => v.hexes.length === 3)!;
    expect(hexesAtVertex(topo, three.id)).toEqual(three.hexes);
    const coastal = topo.vertices.find((v) => v.hexes.length === 1)!;
    expect(hexesAtVertex(topo, coastal.id)).toHaveLength(1);
  });

  it("throws on unknown vertex", () => {
    expect(() => hexesAtVertex(topo, "v:999,999")).toThrow(RangeError);
  });
});

describe("distanceRuleFree", () => {
  const topo = buildIsland();

  it("occupied vertex itself is not free", () => {
    const v = topo.vertices[0].id;
    expect(distanceRuleFree(topo, v, new Set([v]))).toBe(false);
  });

  it("edge-adjacent occupied vertices block; corner-touch-only do not", () => {
    // Pick an interior vertex (3 edges, 3 hexes) for the richest case.
    const v = topo.vertices.find((x) => x.edges.length === 3 && x.hexes.length === 3)!;
    const edgeById = new Map(topo.edges.map((e) => [e.id, e]));
    const edgeNeighbors = v.edges.map((eId) => {
      const e = edgeById.get(eId)!;
      return e.a === v.id ? e.b : e.a;
    });

    // Occupy v: all edge-adjacent vertices must be blocked.
    for (const n of edgeNeighbors) {
      expect(distanceRuleFree(topo, n, new Set([v.id]))).toBe(false);
    }

    // Corner-touch-only vertices (share a hex with v but no edge) stay free.
    const adjacent = new Set([v.id, ...edgeNeighbors]);
    const cornerOnly = new Set<string>();
    for (const hId of v.hexes) {
      const h = topo.hexes.find((x) => x.id === hId)!;
      for (const other of h.vertices) {
        if (!adjacent.has(other)) cornerOnly.add(other);
      }
    }
    expect(cornerOnly.size).toBeGreaterThan(0);
    for (const other of cornerOnly) {
      expect(distanceRuleFree(topo, other, new Set([v.id]))).toBe(true);
    }
  });

  it("unoccupied board is free everywhere", () => {
    for (const v of topo.vertices) {
      expect(distanceRuleFree(topo, v.id, new Set())).toBe(true);
    }
  });
});
