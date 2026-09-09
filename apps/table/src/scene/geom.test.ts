/**
 * geom.test.ts — THE PHASE'S MOST IMPORTANT TEST.
 *
 * Proves the scene's coordinate frame IS the kernel's:
 *  1. every hex's scene center == mean of its 6 corner positions taken from
 *     topology.vertexCoords (i.e. axialToXY is the right frame, not a
 *     near-miss pointy/flat-top mixup);
 *  2. every hex corner derived from hexCorners() lands exactly on the
 *     topology vertex the kernel says is that corner;
 *  3. adjacent hexes share exactly 2 vertices and their shared edge's
 *     endpoints are the same ids (→ same coords) from both sides;
 *  4. every edge measured through geom is length 1 (unit hex radius);
 *  5. vertexWorld mapping is board.y → world Z (not Y).
 *
 * If any of these fail, everything P2 draws on top of the board is wrong.
 */
import { describe, expect, it } from "vitest";
import { buildIsland } from "@catan-vtt/shared";
import {
  axialToXY,
  boardRadius,
  edgeLength,
  edgeSegment,
  hexCenterFromTopology,
  hexCorners,
  hexWorld,
  parseHexId,
  planarDistance,
  segmentYaw,
  vertexWorld,
} from "./geom.js";

/** Quantization used by board.ts (1e-6); our agreement must beat it. */
const EPS = 1e-6;

const topo = buildIsland();

describe("board topology invariants (sanity on the source of truth)", () => {
  it("has 19 hexes, 72 edges, 54 vertices", () => {
    expect(topo.hexes).toHaveLength(19);
    expect(topo.edges).toHaveLength(72);
    expect(topo.vertices).toHaveLength(54);
  });
});

describe("hex center alignment — scene frame == vertexCoords frame", () => {
  it.each(topo.hexes.map((h) => [h.id, h.q, h.r] as const))(
    "hex %s center is the mean of its 6 vertexCoords corners",
    (id, q, r) => {
      const [mx, my] = hexCenterFromTopology(topo, id);
      const [sx, sy] = axialToXY(q, r);
      expect(Math.abs(mx - sx)).toBeLessThan(EPS);
      expect(Math.abs(my - sy)).toBeLessThan(EPS);
    },
  );

  it.each(topo.hexes.map((h) => [h.id, h.q, h.r] as const))(
    "hex %s corners derived from hexCorners() match its topology vertices",
    (id, q, r) => {
      const corners = hexCorners(q, r);
      const topoSet = topo.hexes.find((h) => h.id === id)!.vertices.map((vid) => {
        const c = topo.vertexCoords[vid]!;
        // board (x, y) → world (x, z)
        return [c[0], c[1]] as const;
      });
      // Same multiset, within quantization.
      for (const [cx, cy] of corners) {
        const hit = topoSet.find(
          ([tx, ty]) => Math.abs(tx - cx) < EPS && Math.abs(ty - cy) < EPS,
        );
        expect(hit, `corner (${cx}, ${cy}) of ${id} not found in vertexCoords`).toBeDefined();
      }
      expect(corners).toHaveLength(6);
      expect(topoSet).toHaveLength(6);
    },
  );

  it("hexWorld() puts the center at (boardX, y, boardY)", () => {
    const [wx, wy, wz] = hexWorld(0, 2, 0.5);
    expect(wx).toBeCloseTo(Math.sqrt(3) * (0 + 2 / 2), 12); // 1.7320508
    expect(wz).toBeCloseTo(3, 12); // 1.5 * 2
    expect(wy).toBe(0.5);
  });
});

describe("shared edges — adjacency is real in coordinate space", () => {
  it("every pair of neighbor hexes shares exactly 2 vertices, with identical coords", () => {
    for (const hex of topo.hexes) {
      for (const nId of hex.neighbors) {
        const n = topo.hexes.find((h) => h.id === nId)!;
        const shared = hex.vertices.filter((v) => n.vertices.includes(v));
        expect(shared, `${hex.id} / ${nId}`).toHaveLength(2);
        // The same vertex id must resolve to the same coords from either hex.
        for (const vid of shared) {
          const c = topo.vertexCoords[vid]!;
          const [vx, vy, vz] = vertexWorld(topo, vid);
          expect(vx).toBe(c[0]);
          expect(vz).toBe(c[1]);
          expect(vy).toBe(0);
        }
      }
    }
  });

  it("a shared edge id resolves to the same segment from both hexes", () => {
    for (const hex of topo.hexes) {
      for (const nId of hex.neighbors) {
        const n = topo.hexes.find((h) => h.id === nId)!;
        const sharedEdges = hex.edges.filter((e) => n.edges.includes(e));
        expect(sharedEdges, `${hex.id} / ${nId}`).toHaveLength(1);
        const seg = edgeSegment(topo, sharedEdges[0]!);
        // Both endpoints are corner vertices of BOTH hexes.
        for (const hexRef of [hex, n]) {
          expect(hexRef.vertices).toContain(topo.edges.find((e) => e.id === sharedEdges[0])!.a);
          expect(hexRef.vertices).toContain(topo.edges.find((e) => e.id === sharedEdges[0])!.b);
        }
        expect(seg.a).toHaveLength(3);
      }
    }
  });
});

describe("edge geometry", () => {
  it("all 72 edges have world length 1 (unit hex radius)", () => {
    // Tolerance is 1e-5: board.ts quantizes vertexCoords to 1e-6, so a
    // two-coordinate subtraction can drift up to ~2e-6 per endpoint. Well
    // under any visible misalignment (edges are ~1 unit long).
    for (const e of topo.edges) {
      expect(edgeLength(topo, e.id)).toBeCloseTo(1, 5);
    }
  });

  it("edgeSegment midpoint is the average of endpoint world positions", () => {
    const e = topo.edges[0]!;
    const { a, b } = edgeSegment(topo, e.id, 0.13);
    expect(a[1]).toBe(0.13);
    expect(b[1]).toBe(0.13);
    const mid: readonly [number, number, number] = [(a[0] + b[0]) / 2, 0.13, (a[2] + b[2]) / 2];
    expect(planarDistance(a, mid)).toBeCloseTo(0.5, 6);
  });

  it("segmentYaw rotates +X onto the a→b direction", () => {
    // A horizontal edge along +X must have yaw 0.
    const flat = segmentYaw([0, 0, 0], [1, 0, 0]);
    expect(flat).toBeCloseTo(0, 12);
    // Rotating a unit +X vector by the yaw must land on the normalized segment.
    const a = [-1.2, 0, 0.4] as const;
    const b = [0.8, 0, 2.9] as const;
    const yaw = segmentYaw(a, b);
    const len = planarDistance(a, b);
    const rx = Math.cos(yaw) * len;
    const rz = -Math.sin(yaw) * len; // board y → world z, yaw measured about +Y
    expect(a[0] + rx).toBeCloseTo(b[0], 9);
    expect(a[2] + rz).toBeCloseTo(b[2], 9);
  });
});

describe("parseHexId / board framing", () => {
  it("round-trips hex ids", () => {
    expect(parseHexId("0,2")).toEqual({ q: 0, r: 2 });
    expect(parseHexId("-2,3")).toEqual({ q: -2, r: 3 });
    expect(() => parseHexId("nope")).toThrow(RangeError);
  });

  it("board radius covers the outermost vertices", () => {
    const r = boardRadius(topo);
    // Center hex (0,2) → outermost corner vertex is ~3.6 units away.
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThan(4.5);
  });
});
