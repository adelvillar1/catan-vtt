/**
 * Roads.tsx — one slab per owned edge.
 *
 * Geometry comes from `layout.roadTransform()` (pure, test-covered): midpoint
 * position, yaw about +Y, and a unit-box scale of [length, thickness, width].
 * The trim keeps consecutive roads from overlapping at a shared vertex.
 */
import { useMemo } from "react";
import type { GameState, IslandTopology } from "@catan-vtt/shared";
import { seatColor } from "./palette.js";
import { roadTransform } from "./layout.js";

export interface RoadsProps {
  state: GameState;
  topology: IslandTopology;
}

export function Roads({ state, topology }: RoadsProps): React.JSX.Element {
  const entries = useMemo(() => {
    const out: Array<{ edgeId: string; owner: number }> = [];
    for (const [edgeId, r] of Object.entries(state.roads)) out.push({ edgeId, owner: r.owner });
    return out.sort((x, y) => x.edgeId.localeCompare(y.edgeId));
  }, [state.roads]);

  return (
    <group name="roads">
      {entries.map(({ edgeId, owner }) => {
        const t = roadTransform(topology, edgeId);
        if (t === null) return null; // defensive skip (review I-6)
        return (
          <mesh
            key={edgeId}
            position={t.position as unknown as [number, number, number]}
            rotation={t.rotation as unknown as [number, number, number]}
            scale={t.scale as unknown as [number, number, number]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={seatColor(owner)} roughness={0.6} metalness={0.05} />
          </mesh>
        );
      })}
    </group>
  );
}
