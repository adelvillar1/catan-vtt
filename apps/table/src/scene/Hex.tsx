/**
 * Hex.tsx — one land hex: flat extruded hexagonal prism.
 *
 * Pointy-top (matches board.ts): a 6-segment CylinderGeometry is flat-top by
 * default, so it is yawed 30° (π/6) to put its corners on the ±Z axis, which
 * is where board.ts puts them (VERTEX_OFFSETS[1] = (0, +1) in board y → world
 * +Z). Hexes sit at hexWorld(q, r) — geom.ts proves that is the mean of the
 * hex's own corner vertices.
 */
import { useMemo } from "react";
import type { Terrain } from "@catan-vtt/shared";
import { HEX_DEPTH, hexWorld } from "./geom.js";
import { TERRAIN_COLORS } from "./palette.js";

/** Yaw that turns three.js's flat-top 6-cylinder into a pointy-top hex. */
const POINTY_TOP_YAW = Math.PI / 6;

export interface HexProps {
  q: number;
  r: number;
  terrain: Terrain;
  /** Radius in world units (1.0 = kernel unit hex). */
  radius?: number;
  /** Dimmed when the robber sits on this hex. */
  blocked?: boolean;
}

export function Hex({ q, r, terrain, radius = 1, blocked = false }: HexProps): React.JSX.Element {
  const [x, , z] = hexWorld(q, r);
  const color = TERRAIN_COLORS[terrain];
  // Inset so neighboring hexes show a hairline seam (reads as separate tiles).
  const rr = radius * 0.985;
  const args = useMemo(
    () => [rr, rr, HEX_DEPTH, 6, 1] as [number, number, number, number, number],
    [rr],
  );
  return (
    <mesh position={[x, -HEX_DEPTH / 2, z]} rotation={[0, POINTY_TOP_YAW, 0]} castShadow receiveShadow>
      <cylinderGeometry args={args} />
      <meshStandardMaterial
        color={blocked ? shade(color, -0.28) : color}
        roughness={0.85}
        metalness={0.05}
      />
    </mesh>
  );
}

/** Darken/lighten a #rrggbb hex by `amt` (-1..1). */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amt));
  const g = clamp(((n >> 8) & 255) * (1 + amt));
  const b = clamp((n & 255) * (1 + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
