/**
 * Buildings.tsx — settlements and cities on the island's vertices.
 *
 * Placement is 100% `layout.buildingTransform()` (pure, test-covered): the
 * group origin is the topology vertex lifted to the land surface, and the
 * parts are stacked upward from there. No legality logic, no wire — the
 * server's projection is the only input.
 */
import { useMemo } from "react";
import type { Building, GameState, IslandTopology } from "@catan-vtt/shared";
import { seatColor } from "./palette.js";
import { BUILDING_WIDTH, buildingTransform } from "./layout.js";
import type { BuildingKind } from "./layout.js";

export interface BuildingsProps {
  state: GameState;
  topology: IslandTopology;
}

/** Yaw that makes a 4-segment cone's base corners line up with a box. */
const PYRAMID_YAW = Math.PI / 4;

export function Buildings({ state, topology }: BuildingsProps): React.JSX.Element {
  const entries = useMemo(() => {
    const out: Array<{ vertexId: string; kind: BuildingKind; owner: number }> = [];
    for (const [vertexId, b] of Object.entries(state.buildings) as Array<[string, Building]>) {
      out.push({ vertexId, kind: b.kind, owner: b.owner });
    }
    return out.sort((x, y) => x.vertexId.localeCompare(y.vertexId));
  }, [state.buildings]);

  return (
    <group name="buildings">
      {entries.map(({ vertexId, kind, owner }) => {
        const t = buildingTransform(topology, vertexId, kind);
        const color = seatColor(owner);
        const halfW = BUILDING_WIDTH[kind] / 2;
        return (
          <group key={vertexId} position={t.position as unknown as [number, number, number]}>
            {/* Body block: boxGeometry is centered, so lift by half its height. */}
            <mesh position={[0, t.bodyHeight / 2, 0]} castShadow>
              <boxGeometry args={[t.width, t.bodyHeight, t.width]} />
              <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />
            </mesh>
            {kind === "settlement" ? (
              // 4-sided roof; radius = half-diagonal so the pyramid edges sit
              // on the box corners (hence the 45° yaw).
              <mesh
                position={[0, t.bodyHeight + t.roofHeight / 2, 0]}
                rotation={[0, PYRAMID_YAW, 0]}
                castShadow
              >
                <coneGeometry args={[halfW * Math.SQRT2, t.roofHeight, 4]} />
                <meshStandardMaterial color={color} roughness={0.5} />
              </mesh>
            ) : (
              // City = a second, narrower block stacked on the first.
              <mesh position={[0, t.bodyHeight + t.roofHeight / 2, 0]} castShadow>
                <boxGeometry args={[t.width * 0.78, t.roofHeight, t.width * 0.78]} />
                <meshStandardMaterial color={color} roughness={0.45} metalness={0.1} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}
