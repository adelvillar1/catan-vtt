/**
 * Targets.tsx — the ON-CANVAS half of "click the island".
 *
 * Renders one translucent ghost per server-shipped placement op and sends
 * THAT op object back verbatim on click. No payload is ever constructed here
 * (P2(a) law: the shipped op IS the legality).
 *
 * ORBIT COEXISTENCE: OrbitControls listens on the canvas DOM node, so a
 * native click would both pick a target AND drag the camera. R3F's synthetic
 * pointer events run first for meshes under the cursor; `e.stopPropagation()`
 * in onClick/onPointerOver keeps the event from the controls' own handlers
 * for that hit, while a drag started on empty space (or on a hex that is not
 * a target) still orbits normally. Verified in the browser: orbit still works.
 *
 * The ghosts are intentionally NOT hidden when nothing is hovered — a target
 * you cannot see is not a target — but they are faint (opacity 0.30) so the
 * board stays readable, and brighten to 0.72 on hover.
 */
import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import type { Op } from "@catan-vtt/shared";
import { seatColor } from "./palette.js";
import { ROAD_TRIM, ROAD_WIDTH } from "./layout.js";
import { type Vec3 } from "./geom.js";
import type { Target } from "./targetSet.js";

export interface TargetsProps {
  targets: readonly Target[];
  /** Seat whose turn it is (drives the ghost tint, palette.ts). */
  seat: number;
  /** Called with the EXACT op object the server shipped for that ghost. */
  onPick: (op: Op) => void;
}

/** Pointer cursor while a LIVE ghost is hovered (restored on leave; the
 * parent clamps hover to this frame's targets so a ghost removed mid-hover
 * — the normal click-applies case — restores the cursor too). */
function usePointerCursor(hovered: boolean): void {
  useEffect(() => {
    if (!hovered) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [hovered]);
}

// ---------------------------------------------------------------------------
// Geometry constants (kept next to the meshes they size)
// ---------------------------------------------------------------------------

/** Vertex ghost: settlement-sized disc, slightly wider than a real base. */
const VERTEX_RADIUS = 0.22;
const VERTEX_HEIGHT = 0.06;
/** Edge ghost: a slab the width of a road, but longer and taller. */
const EDGE_THICKNESS = 0.1;
/** Hex ghost: a thin slab covering the hex top (pointy-top circumradius 1). */
const HEX_RADIUS = 0.86;
const HEX_THICKNESS = 0.05;

const BASE_OPACITY = 0.3;
const HOVER_OPACITY = 0.72;
const HOVER_SCALE = 1.25;

// ---------------------------------------------------------------------------
// e2e test hook — screen-space target coords for the Playwright harness
// (opt-in via localStorage, NOT a DEV flag — see useDevTargetHook docstring)
// ---------------------------------------------------------------------------

/**
 * `window.__catanTargets()` returns every live target projected to CSS pixel
 * coordinates, so the e2e proof can click the ghost's true on-screen centre
 * instead of guessing from the default camera.
 *
 * GATE: install only when the page opted in (localStorage
 * `catan:e2eTargets` = "1"), which the Playwright harness sets before
 * joining. `import.meta.env.DEV` is UNRELIABLE here — this Vite instance
 * serves DEV:false even in `vite dev`, so a DEV guard silently disabled the
 * hook and the proof could not find the ghosts. An explicit opt-in is also
 * safer in principle: nothing is exposed unless a test asked for it.
 *
 * The opt-in is read ONCE per mount (harnesses set the flag, then reload),
 * and the hook ships in production builds — it exposes only this client's
 * own seat-scoped ops to page JS, which the client already has in its React
 * state, so it adds no new reach. Acceptable; revisit if the projection ever
 * carries anything seat-sensitive beyond the client's own view.
 */
function useDevTargetHook(
  targets: readonly Target[],
  camera: unknown,
  size: { width: number; height: number },
): void {
  useEffect(() => {
    let optedIn = false;
    try {
      optedIn = window.localStorage.getItem("catan:e2eTargets") === "1";
    } catch {
      optedIn = false;
    }
    if (!optedIn) return;
    const w = window as unknown as Record<string, unknown>;
    w["__catanTargets"] = (): unknown => {
      const cam = camera as unknown as {
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      return targets.map((t) => {
        const v = { x: t.pos[0], y: t.pos[1], z: t.pos[2], w: 1 };
        // Manual project: three's Vector3.project is unavailable without
        // importing three here (this file stays R3F-only).
        const mv = multiply(cam.matrixWorldInverse.elements, v);
        const p = multiply(cam.projectionMatrix.elements, mv);
        const ndcX = p.w === 0 ? 0 : p.x / p.w;
        const ndcY = p.w === 0 ? 0 : p.y / p.w;
        return {
          key: t.key,
          kind: t.kind,
          id: t.id,
          op: t.op,
          x: Math.round(((ndcX + 1) / 2) * size.width),
          y: Math.round(((1 - ndcY) / 2) * size.height),
        };
      });
    };
    return () => {
      delete w["__catanTargets"];
    };
  }, [targets, camera, size]);
}

/** Column-major 4x4 · vec4 (three's Matrix4 element order). */
function multiply(m: ArrayLike<number>, v: { x: number; y: number; z: number; w: number }): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  return {
    x: m[0]! * v.x + m[4]! * v.y + m[8]! * v.z + m[12]! * v.w,
    y: m[1]! * v.x + m[5]! * v.y + m[9]! * v.z + m[13]! * v.w,
    z: m[2]! * v.x + m[6]! * v.y + m[10]! * v.z + m[14]! * v.w,
    w: m[3]! * v.x + m[7]! * v.y + m[11]! * v.z + m[15]! * v.w,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Targets({ targets, seat, onPick }: TargetsProps): React.JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useDevTargetHook(targets, camera, size);

  // Clamp hover to LIVE ghosts (review I-1): R3F's removeInteractivity
  // deletes a mesh from its hovered set WITHOUT firing onPointerOut, so
  // clicking a ghost (op applies -> that ghost is gone next frame) left
  // `hovered` pointing at a dead key and the body cursor stuck on "pointer"
  // until some other ghost was hovered AND left. A hovered key absent from
  // this frame's targets is treated as no-longer-hovered everywhere.
  const live = hovered !== null && targets.some((t) => t.key === hovered) ? hovered : null;
  usePointerCursor(live !== null);
  const color = seatColor(seat);

  if (targets.length === 0) return null;

  return (
    <group name="targets">
      {targets.map((t) => (
        <TargetMesh
          key={t.key}
          target={t}
          color={color}
          hovered={live === t.key}
          onHover={(on) => setHovered(on ? t.key : null)}
          onPick={onPick}
        />
      ))}
    </group>
  );
}

interface TargetMeshProps {
  target: Target;
  color: string;
  hovered: boolean;
  onHover: (on: boolean) => void;
  onPick: (op: Op) => void;
}

/**
 * One ghost. The hover state is owned by the parent so a re-render on hover
 * cannot remount the mesh (which would drop the pointer and flicker).
 *
 * `topology` is intentionally absent: Targets.tsx is given finished world
 * positions, so no geometry math runs on hover — only scale/opacity change.
 */
function TargetMesh({ target, color, hovered, onHover, onPick }: TargetMeshProps): React.JSX.Element {
  const pos = target.pos as unknown as [number, number, number];
  const opacity = hovered ? HOVER_OPACITY : BASE_OPACITY;
  const scale = hovered ? HOVER_SCALE : 1;

  // stopPropagation on BOTH over and click: the over handler stops the ray
  // from also reporting the mesh behind it, the click handler stops Orbit's
  // canvas-level listener from treating the tap as a drag start.
  const common = {
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onHover(true);
    },
    onPointerOut: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onHover(false);
    },
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onPick(target.op); // THE shipped op, verbatim — never a reconstruction
    },
  } as const;

  if (target.kind === "vertex") {
    return (
      <mesh position={pos} scale={scale} {...common}>
        <cylinderGeometry args={[VERTEX_RADIUS, VERTEX_RADIUS, VERTEX_HEIGHT, 16]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={opacity}
          emissive={color}
          emissiveIntensity={hovered ? 0.6 : 0.15}
          depthWrite={false}
        />
      </mesh>
    );
  }

  if (target.kind === "edge") {
    return (
      <mesh
        position={pos}
        rotation={[0, target.yaw ?? 0, 0]}
        scale={[scale, scale, scale]}
        {...common}
      >
        {/* Local +X runs a→b (the yaw from roadTransform); ROAD_TRIM keeps
            the ghost inside the real road's footprint. */}
        <boxGeometry args={[1 - ROAD_TRIM, EDGE_THICKNESS, ROAD_WIDTH * 1.6]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={opacity}
          emissive={color}
          emissiveIntensity={hovered ? 0.6 : 0.15}
          depthWrite={false}
        />
      </mesh>
    );
  }

  // hex (moveRobber) — a flat slab over the tile top, so a blocked hex reads
  // as "click me to move the robber here". PI/6 yaw matches POINTY_TOP_YAW in
  // Hex.tsx — without it the 6-gon sits 30 degrees off the tile beneath.
  return (
    <mesh position={pos} rotation={[0, Math.PI / 6, 0]} scale={scale} {...common}>
      <cylinderGeometry args={[HEX_RADIUS, HEX_RADIUS, HEX_THICKNESS, 6]} />
      <meshStandardMaterial
        color={color}
        transparent
        opacity={opacity}
        emissive={color}
        emissiveIntensity={hovered ? 0.6 : 0.15}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Vector helper re-export so tests can compare positions without three. */
export type TargetVec3 = Vec3;
