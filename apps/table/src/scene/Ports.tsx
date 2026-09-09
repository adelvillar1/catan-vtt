/**
 * Ports.tsx — the 9 coastal trading posts.
 *
 * Marker sits exactly on the port's coastal vertex (layout.portTransform),
 * the label is nudged radially outward so it reads from the sea. Label text
 * comes from palette.portLabel ("3:1", "2:1 wood"…).
 */
import { Text } from "@react-three/drei";
import type { IslandTopology, Port } from "@catan-vtt/shared";
import { portTransform } from "./layout.js";
import { PORT_COLORS, portLabel } from "./palette.js";

export interface PortsProps {
  ports: readonly Port[];
  topology: IslandTopology;
}

const MARKER_RADIUS = 0.17;
const MARKER_DEPTH = 0.05;
const TEXT_SIZE = 0.26;

export function Ports({ ports, topology }: PortsProps): React.JSX.Element {
  return (
    <group name="ports">
      {ports.map((port) => {
        const t = portTransform(topology, port);
        const color = PORT_COLORS[port.type];
        return (
          <group key={port.vertexId}>
            <mesh
              position={t.markerPosition as unknown as [number, number, number]}
              rotation={[0, Math.PI / 6, 0]}
              castShadow
            >
              <cylinderGeometry args={[MARKER_RADIUS, MARKER_RADIUS, MARKER_DEPTH, 3]} />
              <meshStandardMaterial color={color} roughness={0.5} />
            </mesh>
            <Text
              position={t.labelPosition as unknown as [number, number, number]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={TEXT_SIZE}
              color={color}
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.02}
              outlineColor="#071726"
            >
              {portLabel(port.type)}
            </Text>
          </group>
        );
      })}
    </group>
  );
}
