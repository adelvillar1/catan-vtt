/**
 * Island.tsx — the whole board, derived ONLY from the server's projection.
 *
 * Nothing here computes legality or invents layout: hexes come from
 * state.config.slots, tokens from slot.numberDisc, the robber from
 * state.robberHexId, and buildings/roads/ports from their state maps — all
 * positioned through geom.ts / layout.ts, which are kernel-derived and
 * unit-tested.
 */
import { useMemo } from "react";
import type { GameState } from "@catan-vtt/shared";
import { Hex } from "./Hex.js";
import { NumberToken } from "./NumberToken.js";
import { Buildings } from "./Buildings.js";
import { Roads } from "./Roads.js";
import { Ports } from "./Ports.js";
import { boardRadius, HEX_DEPTH, hexIdWorld, parseHexId, boardCenterWorld } from "./geom.js";
import { robberTransform } from "./layout.js";
import { WATER_COLOR } from "./palette.js";

export interface IslandProps {
  state: GameState;
}

export function Island({ state }: IslandProps): React.JSX.Element {
  const { config } = state;
  const topology = config.topology;

  const hexes = useMemo(
    () =>
      config.slots.map((slot) => ({
        ...parseHexId(slot.hexId),
        terrain: slot.terrain,
        numberDisc: slot.numberDisc,
      })),
    [config.slots],
  );

  const waterSize = useMemo(() => 2 * boardRadius(topology) + 6, [topology]);
  const [cx, cz] = boardCenterWorld();

  const robber = useMemo(() => robberTransform(config.slots, state.robberHexId), [
    config.slots,
    state.robberHexId,
  ]);
  const [robberX, , robberZ] = hexIdWorld(state.robberHexId);

  return (
    <group name="island">
      {/* Water: a little wider than the island, just under the land. */}
      <mesh position={[cx, -HEX_DEPTH - 0.06, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[waterSize, waterSize]} />
        <meshStandardMaterial color={WATER_COLOR} roughness={0.25} metalness={0.35} />
      </mesh>

      <group name="hexes">
        {hexes.map(({ q, r, terrain, numberDisc }) => (
          <group key={`${q},${r}`}>
            <Hex q={q} r={r} terrain={terrain} blocked={state.robberHexId === `${q},${r}`} />
            <NumberToken q={q} r={r} disc={numberDisc} />
          </group>
        ))}
      </group>

      <Ports ports={config.ports} topology={topology} />
      <Roads state={state} topology={topology} />
      <Buildings state={state} topology={topology} />

      {/* Robber: dark cone on the blocked hex (x/z from the same helper the
          test asserts against). */}
      <mesh
        name="robber"
        position={[robberX, robber.position[1] + robber.height / 2, robberZ]}
        castShadow
      >
        <coneGeometry args={[robber.radius, robber.height, 12]} />
        <meshStandardMaterial color="#2b2b2f" roughness={0.4} metalness={0.2} />
      </mesh>
    </group>
  );
}
