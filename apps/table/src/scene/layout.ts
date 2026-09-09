/**
 * layout.ts — PURE placement math for everything drawn ON TOP of the board.
 *
 * Every number here is derived from `geom.ts` (which is derived from
 * board.ts). No React, no three, no wire — so `layout.test.ts` can import it
 * in a node environment and assert that a settlement sits exactly on the
 * vertex the kernel meant, and that a road's yaw+scale reconstructs the
 * true edge endpoints.
 *
 * Vertical frame reminder (frozen Hex.tsx is the authority):
 *   hex prism spans y ∈ [-HEX_DEPTH, 0]  →  the land surface is y = 0
 *   (HEIGHTS.land). Buildings therefore stand on HEIGHTS.land, not on
 *   HEX_DEPTH — HEX_DEPTH is the prism's *thickness below* the surface.
 */
import type { IslandTopology, Port, Slot } from "@catan-vtt/shared";
import {
  boardCenterWorld,
  edgeLength,
  edgeSegment,
  hexIdWorld,
  HEIGHTS,
  segmentYaw,
  vertexWorld,
  type Vec3,
} from "./geom.js";

export type BuildingKind = "settlement" | "city";

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** Footprint (x/z) of a building, in world units. */
export const BUILDING_WIDTH: Record<BuildingKind, number> = {
  settlement: 0.28,
  city: 0.36,
};

/** Body block height (below the roof). */
export const BUILDING_BODY_HEIGHT: Record<BuildingKind, number> = {
  settlement: 0.16,
  city: 0.22,
};

/** Roof height (settlement: 4-sided cone; city: the second, taller block). */
export const BUILDING_ROOF_HEIGHT: Record<BuildingKind, number> = {
  settlement: 0.18,
  city: 0.14,
};

/** Total height of a building, base → apex. */
export function buildingHeight(kind: BuildingKind): number {
  return BUILDING_BODY_HEIGHT[kind] + BUILDING_ROOF_HEIGHT[kind];
}

/** Y of the surface a building stands on (top of the land prism). */
export function buildingBaseY(): number {
  return HEIGHTS.land;
}

export interface BuildingTransform {
  /** Group origin: exactly the vertex, lifted to the land surface. */
  position: Vec3;
  kind: BuildingKind;
  width: number;
  bodyHeight: number;
  roofHeight: number;
  /** bodyHeight + roofHeight. */
  height: number;
}

/**
 * Where a settlement/city goes. x/z come straight from the topology's
 * vertexCoords (bit-identical to the kernel's), y is the land surface.
 */
export function buildingTransform(
  topo: IslandTopology,
  vertexId: string,
  kind: BuildingKind,
): BuildingTransform {
  const [vx, , vz] = vertexWorld(topo, vertexId);
  const bodyHeight = BUILDING_BODY_HEIGHT[kind];
  const roofHeight = BUILDING_ROOF_HEIGHT[kind];
  return {
    position: [vx, buildingBaseY(), vz],
    kind,
    width: BUILDING_WIDTH[kind],
    bodyHeight,
    roofHeight,
    height: bodyHeight + roofHeight,
  };
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

/** Road slab width (across the edge) and thickness (up). */
export const ROAD_WIDTH = 0.12;
export const ROAD_THICKNESS = 0.09;
/** Trimmed off the true edge length so corners don't overlap. */
export const ROAD_TRIM = 0.12;

export interface RoadTransform {
  /** Midpoint of the edge, at slab height. */
  position: Vec3;
  /** [0, yaw, 0] — yaw that lays the box's local +X along a→b. */
  rotation: Vec3;
  /** [length, thickness, width] for a unit boxGeometry. */
  scale: Vec3;
  /** Drawn length (edge length minus the corner trim). */
  length: number;
  /** True edge length (1.0 on a unit board) — the test reconstructs with it. */
  edgeLength: number;
  /** Yaw about +Y, radians. */
  yaw: number;
  /** Endpoint a in world space (trimmed length NOT applied). */
  a: Vec3;
  b: Vec3;
}

/**
 * A road slab for one edge.
 *
 * The box is a unit cube scaled to [length, thickness, width] and yawed so
 * its local +X runs a→b. three.js rotates about +Y as
 * (x, z) → (x·cosθ + z·sinθ, −x·sinθ + z·cosθ), so a local +X vector lands
 * on (cosθ, −sinθ); `segmentYaw` is defined as atan2(−dz, dx), which is
 * exactly the θ that maps +X onto the normalized a→b direction.
 */
export function roadTransform(topo: IslandTopology, edgeId: string): RoadTransform {
  const y = HEIGHTS.road;
  const { a, b } = edgeSegment(topo, edgeId, y);
  const full = edgeLength(topo, edgeId);
  const yaw = segmentYaw(a, b);
  return {
    position: [(a[0] + b[0]) / 2, y, (a[2] + b[2]) / 2],
    rotation: [0, yaw, 0],
    scale: [full - ROAD_TRIM, ROAD_THICKNESS, ROAD_WIDTH],
    length: full - ROAD_TRIM,
    edgeLength: full,
    yaw,
    a,
    b,
  };
}

// ---------------------------------------------------------------------------
// Robber
// ---------------------------------------------------------------------------

export const ROBBER_HEIGHT = 0.35;
export const ROBBER_RADIUS = 0.16;
/** Thickness of the number-token disc (mirrors NumberToken.tsx). */
export const TOKEN_DISC_DEPTH = 0.07;

export interface RobberTransform {
  /** Base of the cone (it stands on the token when the hex has one). */
  position: Vec3;
  height: number;
  radius: number;
}

/**
 * The robber stands on the tile: on top of the number disc when the hex has
 * one (as on the physical board), otherwise flat on the land.
 */
export function robberTransform(slots: readonly Slot[], robberHexId: string): RobberTransform {
  const [x, , z] = hexIdWorld(robberHexId);
  const slot = slots.find((s) => s.hexId === robberHexId);
  const baseY =
    slot !== undefined && slot.numberDisc !== null
      ? HEIGHTS.token + TOKEN_DISC_DEPTH / 2
      : HEIGHTS.land;
  return { position: [x, baseY, z], height: ROBBER_HEIGHT, radius: ROBBER_RADIUS };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** How far the port label is nudged out to sea from its vertex. */
export const PORT_LABEL_OFFSET = 0.62;

export interface PortTransform {
  vertexId: string;
  /** Marker sits exactly on the coastal vertex. */
  markerPosition: Vec3;
  /** Label, nudged radially outward from the island center. */
  labelPosition: Vec3;
  /** Unit outward direction (x, z) used for the nudge. */
  outward: readonly [number, number];
}

/**
 * Ports live on coastal vertices; the marker is the vertex itself and the
 * text is pushed radially outward so it never covers the island.
 */
export function portTransform(topo: IslandTopology, port: Port): PortTransform {
  const [vx, , vz] = vertexWorld(topo, port.vertexId);
  const [cx, cz] = boardCenterWorld();
  const dx = vx - cx;
  const dz = vz - cz;
  const len = Math.hypot(dx, dz);
  const outward: readonly [number, number] =
    len === 0 ? [0, 1] : [dx / len, dz / len];
  return {
    vertexId: port.vertexId,
    markerPosition: [vx, HEIGHTS.port, vz],
    labelPosition: [
      vx + outward[0] * PORT_LABEL_OFFSET,
      HEIGHTS.port + 0.04,
      vz + outward[1] * PORT_LABEL_OFFSET,
    ],
    outward,
  };
}
