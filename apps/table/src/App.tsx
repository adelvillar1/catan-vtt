/**
 * App.tsx — the table: a full-viewport R3F canvas + a DOM overlay rail.
 *
 * The canvas is DERIVED STATE ONLY: it renders `room.state` (the server's
 * seat-scoped projection) through <Island>. With no projection it shows the
 * empty table (dim water + caption). The overlay reads the same hook and
 * never computes legality — the move list is the server's, verbatim.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { IslandTopology } from "@catan-vtt/shared";
import { Island } from "./scene/Island.js";
import { Targets } from "./scene/Targets.js";
import { buildTargetSet, mayActOnBoard } from "./scene/targetSet.js";
import { boardCenterWorld, boardRadius, HEX_DEPTH, HEIGHTS } from "./scene/geom.js";
import { TABLE_BG, WATER_COLOR } from "./scene/palette.js";
import { useRoom } from "./wire/useRoom.js";
import { JoinPanel } from "./ui/JoinPanel.js";
import { DiscardModal } from "./ui/DiscardModal.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { StatusLine } from "./ui/StatusLine.js";
import { MovesList } from "./ui/MovesList.js";
import { EventTicker } from "./ui/EventTicker.js";
import { Hud } from "./ui/Hud.js";
import { ResourceRail } from "./ui/ResourceRail.js";
import { TradePanel } from "./ui/TradePanel.js";
import { DevCardPanel } from "./ui/DevCardPanel.js";
import { VictoryOverlay } from "./ui/VictoryOverlay.js";
import { readLastRoom } from "./ui/lastRoom.js";
import { readSeatToken } from "./wire/adapter.js";

/** Fallback radius used before any projection arrives (unit board ≈ 3.6). */
const EMPTY_RADIUS = 3.6;

export function App(): React.JSX.Element {
  const room = useRoom();
  const { state } = room;
  const [rejoined, setRejoined] = useState<string | null>(null);

  // Auto-rejoin: a browser refresh must land you back in your own seat.
  // Requires BOTH the lastRoom entry (JoinPanel writes it on Join) and the
  // seatToken for that room code (wire/adapter.ts stores it on every welcome).
  // Runs once; StrictMode's double-invoke is harmless because connect() is a
  // no-op once a socket is live.
  useEffect(() => {
    let last: ReturnType<typeof readLastRoom> = null;
    let token: string | null = null;
    try {
      last = readLastRoom(window.localStorage);
      token = last === null ? null : readSeatToken(window.localStorage, last.roomCode);
    } catch {
      return; // storage disabled — nothing to rejoin
    }
    if (last === null || token === null) return;
    const ok = room.connect({
      roomCode: last.roomCode,
      ...(last.url !== "" ? { url: last.url } : {}),
      ...(last.seat === null ? {} : { seat: last.seat }),
      ...(last.name !== "" ? { name: last.name } : {}),
      seatToken: token,
    });
    if (ok) setRejoined(`rejoined ${last.roomCode}`);
    // Reviewer IMPORTANT-3: no cross-mount "retried" latch — refs SURVIVE
    // StrictMode's simulated unmount, so the latch left pass 2 (the live
    // mount) never reconnecting after cleanup closed pass 1's socket.
    // Effect runs on mount and whenever the socket CLOSED (drop-rejoin);
    // a deliberate disconnect() forgot the seat token above, so it stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.room.status]);

  const topology: IslandTopology | null = state?.config.topology ?? null;

  // On-canvas click targets — a pure projection of the server's legalMoves
  // (targetSet.ts). Keyed on legalMoves identity, which the adapter replaces
  // exactly once per projection, so this recomputes once per server frame.
  const targets = useMemo(() => buildTargetSet(room.legalMoves, topology), [room.legalMoves, topology]);

  // Ghosts show ONLY when this client can actually act: a live projection,
  // a PLAYING socket ("open" per the task = the room's live status string),
  // a real seat (spectators get none), and it being that seat's turn. The
  // DOM MovesList stays the unconditional accessibility fallback.
  // mayActOnBoard states the seven-window actor explicitly (see targetSet
  // docstring): today it agrees with currentSeat because the wire's
  // seat-scoped legalMoves already scopes ghosts — the gate is the loud-
  // failure tripwire for that invariant (parent hardening, pre-review).
  const canAct =
    state !== null &&
    room.seat !== null &&
    room.room.status === "playing" &&
    mayActOnBoard(state, room.seat);
  const showTargets = canAct && targets.length > 0;

  // No memo: keyed on topology identity it would never hit (review I-5), and
  // buildIsland() client-side would duplicate the SERVER's geometry — the
  // radius derives from the shipped topology (54 points; per-frame is free).
  const camera = (() => {
    const r = topology === null ? EMPTY_RADIUS : boardRadius(topology);
    const [cx, cz] = boardCenterWorld();
    // 3/4 view scaled by the board radius; look-at is the island's center.
    return {
      position: [cx * 0.2, r * 2.5, cz + r * 3.0] as [number, number, number],
      target: [cx, 0, cz] as [number, number, number],
      fov: 42,
    };
  })();

  return (
    <div className="table-root">
      <Canvas
        className="table-canvas"
        shadows
        dpr={[1, 2]}
        camera={{ position: camera.position, fov: camera.fov, near: 0.1, far: 200 }}
      >
        {/* Scene failures degrade to the rail (review I-6); never a white screen. */}
        <ErrorBoundary>
        <color attach="background" args={[TABLE_BG]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[6, 12, 4]} intensity={1.1} castShadow />
        <OrbitControls target={camera.target} enableDamping maxPolarAngle={Math.PI / 2.2} />

        <Suspense fallback={null}>
          {state === null ? <EmptyTable /> : <Island state={state} />}
          {/* On-canvas placement ghosts (M3-P2(b1)). Rendered INSIDE the
              Canvas so R3F's raycaster owns the hit test; OrbitControls still
              gets every pointer event that is not on a ghost. */}
          {showTargets && room.seat !== null ? (
            <Targets targets={targets} seat={room.seat} onPick={(op) => room.sendOp(op)} />
          ) : null}
        </Suspense>
        </ErrorBoundary>
      </Canvas>

      {state === null ? (
        <div className="empty">
          <strong>Join a room</strong>
          <span>Enter the 6-character code to watch the island deal itself.</span>
        </div>
      ) : null}

      <aside className="table-rail">
        <JoinPanel room={room} />
        <StatusLine room={room} />
        {rejoined !== null ? (
          <p className="hint" id="rejoin-note">
            {rejoined}
          </p>
        ) : null}
        {state === null ? null : (
          <>
            <Hud state={state} seat={room.seat} legalMoves={room.legalMoves} sendOp={room.sendOp} />
            <ResourceRail state={state} seat={room.seat} legalMoves={room.legalMoves} sendOp={room.sendOp} />
            <TradePanel state={state} seat={room.seat} legalMoves={room.legalMoves} sendOp={room.sendOp} />
            <DevCardPanel state={state} seat={room.seat} legalMoves={room.legalMoves} sendOp={room.sendOp} />
          </>
        )}
        <MovesList moves={room.legalMoves} connected={state !== null} onSend={room.sendOp} />
        <EventTicker events={room.room.events} />
      </aside>

      {/* Seven-discard gate. Rendered ABOVE the canvas (DOM, not 3D) because
          it needs real form controls; appears iff the server says this seat
          is the one that owes cards right now. */}
      {state === null ? null : (
        <DiscardModal
          state={state}
          seat={room.seat}
          legalMoves={room.legalMoves}
          sendOp={room.sendOp}
        />
      )}

      {/* Victory banner (M3-P3(a)). Derived from the projection's PUBLIC
          winner/finalPoints — no wire change. Gated on the same liveness
          signal the board uses (status "playing", review I-2): after a win the
          socket stays OPEN so the banner persists for everyone — but a dropped
          link (status error/closed) must not keep asserting a result, and a
          join to a DIFFERENT room must not paint the old winner while the new
          room's first projection is still in flight. Auto-rejoin briefly hides
          and re-shows it; the server re-ships winner on every projection, so
          nothing is lost. */}
      {state === null || room.room.status !== "playing" ? null : (
        <VictoryOverlay state={state} seat={room.seat} onRematch={() => room.sendRematch()} />
      )}
    </div>
  );
}

/** No projection yet: a dim water plane and nothing else. */
function EmptyTable(): React.JSX.Element {
  const size = 2 * EMPTY_RADIUS + 6;
  const [cx, cz] = boardCenterWorld();
  return (
    <mesh position={[cx, -HEX_DEPTH - 0.06, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={WATER_COLOR} roughness={0.3} metalness={0.3} />
    </mesh>
  );
}

/** Re-exported for the phase report / tests: the water plane's Y. */
export const WATER_Y = HEIGHTS.water;
