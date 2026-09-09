/**
 * NumberToken.tsx — the pip disc on a producing hex.
 *
 * Desert (and any hex with numberDisc === null) renders nothing. Pips 6 and 8
 * are drawn in red, as on the physical board.
 */
import { Text } from "@react-three/drei";
import { HEIGHTS, hexWorld, type Vec3 } from "./geom.js";
import { numberTokenColor } from "./palette.js";

export interface NumberTokenProps {
  q: number;
  r: number;
  /** null on the desert → no token at all. */
  disc: number | null;
}

const DISC_RADIUS = 0.34;
const DISC_DEPTH = 0.07;

export function NumberToken({ q, r, disc }: NumberTokenProps): React.JSX.Element | null {
  if (disc === null) return null;
  const [x, , z] = hexWorld(q, r);
  const y = HEIGHTS.token;
  return (
    <group position={[x, y, z]}>
      <mesh castShadow>
        <cylinderGeometry args={[DISC_RADIUS, DISC_RADIUS, DISC_DEPTH, 24]} />
        <meshStandardMaterial color="#f2ead9" roughness={0.6} />
      </mesh>
      <Text
        position={[0, DISC_DEPTH / 2 + 0.005, 0] as unknown as Vec3}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.36}
        color={numberTokenColor(disc)}
        anchorX="center"
        anchorY="middle"
      >
        {String(disc)}
      </Text>
    </group>
  );
}
