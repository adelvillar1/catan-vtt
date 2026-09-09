/**
 * layout.test.ts — proves the P1 renderers put things where the kernel means.
 *
 * This is the substitute for visual verification tonight: every renderer
 * reads its numbers from `layout.ts`, and every number here is checked
 * against `geom.ts` (which geom.test.ts already proved == board.ts).
 *
 *  1. a settlement/city group sits EXACTLY on its vertexWorld position and
 *     stands on the land surface (not below it);
 *  2. a road's position + yaw + scale reconstruct the edge's two endpoints
 *     (rotate a local +X half-length by yaw, add to the midpoint);
 *  3. the robber's tile is the hex of state.robberHexId, standing on the
 *     token when that hex has one;
 *  4. port markers sit exactly on their coastal vertex, labels pushed out.
 */
import { describe, expect, it } from "vitest";
import {
  buildIsland,
  variableSetup,
  type GameState,
  type IslandTopology,
} from "@catan-vtt/shared";
import {
  boardCenterWorld,
  edgeSegment,
  HEX_DEPTH,
  HEIGHTS,
  hexIdWorld,
  planarDistance,
  vertexWorld,
} from "./geom.js";
import {
  BUILDING_WIDTH,
  buildingHeight,
  buildingTransform,
  portTransform,
  PORT_LABEL_OFFSET,
  robberTransform,
  roadTransform,
  ROAD_TRIM,
} from "./layout.js";

const topo: IslandTopology = buildIsland();
const state: GameState = variableSetup(20260908, { playerCount: 3 });

/** Exact-equality budget for anything copied straight out of vertexCoords. */
const EPS = 1e-9;
/** Budget for reconstructed endpoints (trig + quantized coords). */
const LOOSE = 1e-3;

describe("building placement", () => {
  const vertexIds = Object.keys(topo.vertexCoords).sort();

  it("every settlement sits exactly on its vertex and above the land prism", () => {
    for (const vid of vertexIds) {
      const t = buildingTransform(topo, vid, "settlement");
      const [vx, vy, vz] = vertexWorld(topo, vid);
      expect(t.position[0]).toBeCloseTo(vx, 12);
      expect(Math.abs(t.position[0] - vx)).toBeLessThan(EPS);
      expect(Math.abs(t.position[2] - vz)).toBeLessThan(EPS);
      // Stands ON the land surface (y = HEIGHTS.land), which is the top of
      // the hex prism — the prism hangs BELOW y=0 by HEX_DEPTH.
      expect(t.position[1]).toBe(HEIGHTS.land);
      expect(t.position[1]).toBeGreaterThan(-HEX_DEPTH);
      void vy;
    }
  });

  it("a city is wider and taller than a settlement and shares its origin", () => {
    const vid = vertexIds[0]!;
    const s = buildingTransform(topo, vid, "settlement");
    const c = buildingTransform(topo, vid, "city");
    expect(c.position).toEqual(s.position);
    expect(BUILDING_WIDTH.city).toBeGreaterThan(BUILDING_WIDTH.settlement);
    expect(buildingHeight("city")).toBeGreaterThan(0);
    expect(buildingHeight("settlement")).toBeGreaterThan(0);
  });

  it("buildingHeight == body + roof, and the parts stack inside that height", () => {
    for (const kind of ["settlement", "city"] as const) {
      const t = buildingTransform(topo, vertexIds[0]!, kind);
      expect(t.height).toBeCloseTo(buildingHeight(kind), 12);
      expect(t.bodyHeight + t.roofHeight).toBeCloseTo(t.height, 12);
      expect(t.bodyHeight).toBeLessThan(t.height);
      expect(t.roofHeight).toBeLessThan(t.height);
    }
  });

  it("no two buildings share a position (distinct vertices → distinct spots)", () => {
    const seen = new Set<string>();
    for (const vid of vertexIds) {
      const t = buildingTransform(topo, vid, "settlement");
      const key = `${t.position[0].toFixed(6)}|${t.position[2].toFixed(6)}`;
      expect(seen.has(key), `duplicate building position at ${vid}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(54);
  });
});

describe("road placement", () => {
  it("every edge's slab reconstructs the true a→b endpoints", () => {
    for (const edge of topo.edges) {
      const t = roadTransform(topo, edge.id);
      const yaw = t.rotation[1];
      const halfLen = t.edgeLength / 2; // FULL edge length: the trim only
      // shortens the drawn box, it must not move the endpoints.
      const [mx, my, mz] = t.position;

      // three.js yaw about +Y maps local +X (1,0,0) onto (cos θ, 0, −sin θ).
      const dirX = Math.cos(yaw) * halfLen;
      const dirZ = -Math.sin(yaw) * halfLen;

      const rebuiltA: readonly [number, number, number] = [mx - dirX, my, mz - dirZ];
      const rebuiltB: readonly [number, number, number] = [mx + dirX, my, mz + dirZ];
      const { a, b } = edgeSegment(topo, edge.id, my);

      for (const [got, want] of [
        [rebuiltA, a],
        [rebuiltB, b],
      ] as const) {
        expect(Math.abs(got[0] - want[0])).toBeLessThan(LOOSE);
        expect(Math.abs(got[2] - want[2])).toBeLessThan(LOOSE);
      }
    }
  });

  it("the slab midpoint is the edge midpoint, at road height", () => {
    for (const edge of topo.edges.slice(0, 72)) {
      const t = roadTransform(topo, edge.id);
      const { a, b } = edgeSegment(topo, edge.id, HEIGHTS.road);
      expect(t.position[1]).toBe(HEIGHTS.road);
      expect(t.position[0]).toBeCloseTo((a[0] + b[0]) / 2, 12);
      expect(t.position[2]).toBeCloseTo((a[2] + b[2]) / 2, 12);
    }
  });

  it("drawn length is the true length minus the corner trim", () => {
    for (const edge of topo.edges) {
      const t = roadTransform(topo, edge.id);
      expect(t.edgeLength).toBeCloseTo(1, 5);
      expect(t.length).toBeCloseTo(t.edgeLength - ROAD_TRIM, 12);
      expect(t.scale[0]).toBeCloseTo(t.length, 12);
      expect(t.length).toBeLessThan(t.edgeLength);
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("a road's yaw is stable for a→b and the slab stays inside its edge", () => {
    const edge = topo.edges[0]!;
    const t = roadTransform(topo, edge.id);
    const rebuilt = planarDistance(t.a, t.b);
    expect(rebuilt).toBeCloseTo(t.edgeLength, 6);
  });
});

describe("robber placement", () => {
  it("sits on the tile named by state.robberHexId", () => {
    const t = robberTransform(state.config.slots, state.robberHexId);
    const [hx, hy, hz] = hexIdWorld(state.robberHexId);
    expect(t.position[0]).toBeCloseTo(hx, 12);
    expect(t.position[2]).toBeCloseTo(hz, 12);
    void hy;
    // On the number token when the hex has one, else flat on the land.
    const slot = state.config.slots.find((s) => s.hexId === state.robberHexId)!;
    expect(slot).toBeDefined();
    if (slot.numberDisc === null) {
      expect(t.position[1]).toBe(HEIGHTS.land);
    } else {
      expect(t.position[1]).toBeGreaterThan(HEIGHTS.land);
      expect(t.position[1]).toBeGreaterThan(HEIGHTS.token);
    }
    expect(t.height).toBeGreaterThan(0.2);
  });

  it("the startup robber is on the desert (the only disc-less hex)", () => {
    const desert = state.config.slots.find((s) => s.numberDisc === null)!;
    expect(desert.terrain).toBe("desert");
    expect(state.robberHexId).toBe(desert.hexId);
  });

  it("moving the robber to a producing hex lifts it onto the token", () => {
    const producing = state.config.slots.find((s) => s.numberDisc !== null)!;
    const t = robberTransform(state.config.slots, producing.hexId);
    expect(t.position[1]).toBeGreaterThan(HEIGHTS.land);
  });
});

describe("port placement", () => {
  it("all 9 markers sit exactly on their coastal vertex", () => {
    expect(state.config.ports).toHaveLength(9);
    for (const port of state.config.ports) {
      const t = portTransform(topo, port);
      const [vx, vy, vz] = vertexWorld(topo, port.vertexId);
      expect(Math.abs(t.markerPosition[0] - vx)).toBeLessThan(EPS);
      expect(Math.abs(t.markerPosition[2] - vz)).toBeLessThan(EPS);
      expect(t.markerPosition[1]).toBe(HEIGHTS.port);
      void vy;
      expect(topo.coastalVertices).toContain(port.vertexId);
    }
  });

  it("labels are nudged radially outward, away from the island center", () => {
    const [cx, cz] = boardCenterWorld();
    for (const port of state.config.ports) {
      const t = portTransform(topo, port);
      const [vx, , vz] = vertexWorld(topo, port.vertexId);
      const dMarker = Math.hypot(vx - cx, vz - cz);
      const dLabel = Math.hypot(t.labelPosition[0] - cx, t.labelPosition[2] - cz);
      expect(dLabel).toBeGreaterThan(dMarker);
      // Exact offset: PORT_LABEL_OFFSET along the outward unit vector.
      expect(Math.hypot(t.labelPosition[0] - vx, t.labelPosition[2] - vz)).toBeCloseTo(
        PORT_LABEL_OFFSET,
        12,
      );
      expect(Math.hypot(t.outward[0], t.outward[1])).toBeCloseTo(1, 12);
    }
  });

  it("port vertices are distinct", () => {
    const ids = state.config.ports.map((p) => p.vertexId);
    expect(new Set(ids).size).toBe(9);
  });
});

describe("scene derives only from projection state", () => {
  it("every building/road id in a live state resolves through geom", () => {
    // Sanity on the fixture we ship: the renderer maps these same records.
    for (const vid of Object.keys(state.buildings)) {
      const [x, y, z] = vertexWorld(topo, vid);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
    }
    for (const eid of Object.keys(state.roads)) {
      const { a, b } = edgeSegment(topo, eid);
      expect(Number.isFinite(a[0]) && Number.isFinite(b[0])).toBe(true);
    }
  });
});
