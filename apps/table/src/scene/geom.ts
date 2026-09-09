/**
 * geom.ts — the ONE coordinate frame shared by the kernel and the scene.
 *
 * DERIVED FROM packages/shared/src/board.ts (read it before touching this):
 *
 *   hexCenter(q, r) = [ √3 * (q + r/2), 1.5 * r ]        <-- POINTY-TOP
 *   hex vertex k    = center + VERTEX_OFFSETS[k], offsets at (60k - 30)°
 *   vertexCoords[id] = [x, y] quantized to 1e-6
 *
 * Units: 1.0 == the hex "radius" (center→corner == 1, edge length == 1,
 * center→edge-midpoint == √3/2). The whole island therefore spans
 * x ∈ [-3.46, 3.46], y ∈ [-0.5, 6.5] and is centered at hex (0,2) → world
 * (1.732, 3.0).
 *
 * Scene mapping (locked, do not drift):
 *   worldX =  vertexCoords[id][0]
 *   worldZ =  vertexCoords[id][1]      (board's "y" is the ground plane's Z)
 *   worldY =  HEIGHTS.*               (up; three.js Y-up)
 *
 * Everything P2 draws on top — roads, buildings, ports, click targets —
 * goes through `vertexWorld()` / `edgeSegment()` / `hexWorld()`. Nothing in
 * this file may invent its own trig: VERTEX_OFFSETS is copied byte-for-byte
 * from board.ts so scene corners and kernel corners are the same real
 * numbers, not merely close ones. geom.test.ts proves that.
 */
import type { IslandTopology } from "@catan-vtt/shared";

const SQRT3 = Math.sqrt(3);

/**
 * The six unit-circle offsets for angle (60k - 30)°. COPIED EXACTLY from
 * board.ts VERTEX_OFFSETS — sqrt-derived, not trig-derived, so corners are
 * bit-identical to the kernel's.
 */
export const VERTEX_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [SQRT3 / 2, 1 / 2],
  [0, 1],
  [-SQRT3 / 2, 1 / 2],
  [-SQRT3 / 2, -1 / 2],
  [0, -1],
  [SQRT3 / 2, -1 / 2],
];

/** Vertical layout heights (world Y). */
export const HEIGHTS = {
  /** Water plane sits just under the land. */
  water: -0.28,
  /** Hex top surface. */
  land: 0,
  /** Number-token disc, resting on the land. */
  token: 0.11,
  /** Road slab. */
  road: 0.13,
  /** Building base plate. */
  building: 0.12,
  /** Robber body. */
  robber: 0.24,
  /** Port marker. */
  port: 0.1,
} as const;

/** Land hex extrude depth (cylinder height). */
export const HEX_DEPTH = 0.22;

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/**
 * Board coordinates (topology frame) of a hex center — the same formula as
 * board.ts hexCenter(). Pointy-top.
 */
export function axialToXY(q: number, r: number): Vec2 {
  return [SQRT3 * (q + r / 2), 1.5 * r];
}

/** World-space position of a hex center (Y = `y`). */
export function hexWorld(q: number, r: number, y = 0): Vec3 {
  const [x, z] = axialToXY(q, r);
  return [x, y, z];
}

/** Parse a hex id ("q,r") into axial coords. Throws on malformed input. */
export function parseHexId(hexId: string): { q: number; r: number } {
  const parts = hexId.split(",");
  if (parts.length !== 2) throw new RangeError(`parseHexId: malformed hex id ${hexId}`);
  const q = Number(parts[0]);
  const r = Number(parts[1]);
  if (!Number.isInteger(q) || !Number.isInteger(r)) {
    throw new RangeError(`parseHexId: malformed hex id ${hexId}`);
  }
  return { q, r };
}

/** World-space position of a hex center, by hex id. */
export function hexIdWorld(hexId: string, y = 0): Vec3 {
  const { q, r } = parseHexId(hexId);
  return hexWorld(q, r, y);
}

/**
 * World-space position of a topology vertex, straight out of
 * `topology.vertexCoords`. Y defaults to the land surface.
 */
export function vertexWorld(topo: IslandTopology, vertexId: string, y = 0): Vec3 {
  const c = topo.vertexCoords[vertexId];
  if (!c) throw new RangeError(`vertexWorld: unknown vertex ${vertexId}`);
  return [c[0], y, c[1]];
}

/**
 * The 6 corner offsets of a pointy-top hex, as world deltas.
 * Index k matches board.ts's winding (60k - 30°).
 */
export function hexCornerOffsets(): ReadonlyArray<Vec2> {
  return VERTEX_OFFSETS;
}

/**
 * World-space corners of a hex, derived from the SAME formula board.ts uses
 * to build vertexCoords. geom.test.ts asserts these equal the topology's
 * own coordinates for that hex's corner vertices — that is the alignment
 * proof for the whole phase.
 */
export function hexCorners(q: number, r: number): Vec2[] {
  const [cx, cy] = axialToXY(q, r);
  return VERTEX_OFFSETS.map(([ox, oy]) => [cx + ox, cy + oy] as Vec2);
}

/**
 * Mean of a hex's 6 corner positions AS THE TOPOLOGY SEES THEM. Used by the
 * alignment test: if the scene's hex center formula agrees with the kernel's
 * vertexCoords, this is exactly axialToXY(q, r).
 */
export function hexCenterFromTopology(topo: IslandTopology, hexId: string): Vec2 {
  const hex = topo.hexes.find((h) => h.id === hexId);
  if (!hex) throw new RangeError(`hexCenterFromTopology: unknown hex ${hexId}`);
  let sx = 0;
  let sy = 0;
  for (const vid of hex.vertices) {
    const c = topo.vertexCoords[vid];
    if (!c) throw new RangeError(`hexCenterFromTopology: unknown vertex ${vid}`);
    sx += c[0];
    sy += c[1];
  }
  return [sx / hex.vertices.length, sy / hex.vertices.length];
}

/** Endpoint world positions of an edge, from topology.vertexCoords. */
export function edgeSegment(
  topo: IslandTopology,
  edgeId: string,
  y = 0,
): { a: Vec3; b: Vec3 } {
  const edge = topo.edges.find((e) => e.id === edgeId);
  if (!edge) throw new RangeError(`edgeSegment: unknown edge ${edgeId}`);
  return { a: vertexWorld(topo, edge.a, y), b: vertexWorld(topo, edge.b, y) };
}

/** Midpoint of an edge in world space. */
export function edgeMidpoint(topo: IslandTopology, edgeId: string, y = 0): Vec3 {
  const { a, b } = edgeSegment(topo, edgeId, y);
  return [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
}

/** Length of an edge in world units (should be 1.0 for every Catan edge). */
export function edgeLength(topo: IslandTopology, edgeId: string): number {
  const { a, b } = edgeSegment(topo, edgeId);
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/**
 * Yaw (rotation about world Y) that points +X down the a→b direction.
 * A box of length L laid along +X, rotated by this yaw, spans a..b.
 */
export function segmentYaw(a: Vec3, b: Vec3): number {
  return Math.atan2(-(b[2] - a[2]), b[0] - a[0]);
}

/** Distance between two world points on the ground plane. */
export function planarDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/** Board-space center of the island (world XZ), for camera framing. */
export function boardCenterWorld(): Vec2 {
  return axialToXY(0, 2);
}

/** Board-space radius (center → outermost corner) used to frame the camera. */
export function boardRadius(topo: IslandTopology): number {
  const [cx, cy] = boardCenterWorld();
  let max = 0;
  for (const c of Object.values(topo.vertexCoords)) {
    max = Math.max(max, Math.hypot(c[0] - cx, c[1] - cy));
  }
  return max;
}
