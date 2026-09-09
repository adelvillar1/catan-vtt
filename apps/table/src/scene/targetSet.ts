/**
 * targets.ts — "where may I click on the island?" — PURE, no React/three/wire.
 *
 * THE DESIGN LAW (P2(a) precedent, hudLogic.ts): the table never computes
 * legality. A clickable ghost exists IFF the server shipped an op carrying
 * that vertexId / edgeId / hexId. This module is therefore a PROJECTION of
 * `legalMoves` into 3D positions — nothing more:
 *
 *   legalMoves (Op[])  +  topology  ──►  Target[]   (Target carries its Op)
 *
 * Why a separate module instead of inlining in the component: it is pure, so
 * targets.test.ts can assert, in a NODE environment with real kernel-built
 * fixtures, that (a) the ops come out IDENTITY-EQUAL to the shipped ones
 * (the click sends the server's own object back — never a reconstruction)
 * and (b) ids the topology doesn't know are skipped rather than thrown.
 *
 * AC3: no runtime kernel import. `IslandTopology` / `Op` are type-only.
 */
import type { GameState, IslandTopology, Op, Resource } from "@catan-vtt/shared";
import { buildingTransform, roadTransform } from "./layout.js";
import { HEIGHTS, hexIdWorld, parseHexId, type Vec3 } from "./geom.js";

/** Which kind of board feature a target sits on. */
type TargetKind = "vertex" | "edge" | "hex";

/**
 * One clickable ghost. `op` is the SHIPPED op object (identity preserved) —
 * the renderer's onClick calls onPick(target.op) verbatim.
 */
export interface Target {
  /** Stable React key: `${kind}:${id}` — unique by construction. */
  key: string;
  kind: TargetKind;
  /** The topology id (vertexId / edgeId / hexId) the op names. */
  id: string;
  /** World position of the ghost mesh (already lifted to its surface). */
  pos: Vec3;
  /**
   * Yaw about +Y for edge ghosts only: the rotation that lays the slab along
   * the real edge. Vertices/hexes are rotationally symmetric (disc / hex
   * prism), so they leave it undefined.
   */
  yaw?: number;
  /** THE op the server shipped for this id. Click → sendOp(this). */
  op: Op;
}

/**
 * Warn-once set. A malformed id means a server/table version skew; spamming
 * 19 identical warnings per frame helps nobody. Module-scoped on purpose:
 * one warning per id per page life (the test asserts the skip, not the log).
 */
const warned = new Set<string>();

function warnOnce(id: string, reason: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[targets] skipping unresolvable id ${id}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Per-op extraction: op → (kind, id) or null when the op is not a placement
// ---------------------------------------------------------------------------

interface Slot {
  kind: TargetKind;
  id: string;
}

/**
 * The id an op places on, or null when the op is not a board-placement op
 * (roll / endTurn / tradeBank / stealCard / … have no 3D target — the DOM
 * rail covers those, and MovesList stays the accessibility fallback).
 *
 * placeSetupPiece is BOTH a vertex op (kind "settlement") and an edge op
 * (kind "road"): the discriminator is its own `kind` field, not the op type.
 */
export function placementSlot(op: Op): Slot | null {
  switch (op.type) {
    case "placeSetupPiece":
      if (op.kind === "settlement") {
        return op.vertexId === undefined ? null : { kind: "vertex", id: op.vertexId };
      }
      return op.edgeId === undefined ? null : { kind: "edge", id: op.edgeId };
    case "buildSettlement":
    case "buildCity":
      return { kind: "vertex", id: op.vertexId };
    case "buildRoad":
      return { kind: "edge", id: op.edgeId };
    case "moveRobber":
      return { kind: "hex", id: op.hexId };
    case "stealCard":
      return null; // victim is chosen per-seat, DOM button — no hex ghost
    default:
      return null; // not a board placement — DOM panel territory
  }
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

/**
 * World Y for a target ghost. Ghosts float slightly ABOVE the real piece so
 * a settlement target is still clickable where the board is busy; all three
 * live under the robber/token heights so they never occlude a disc.
 */
const TARGET_LIFT = 0.05;

function resolvePos(kind: TargetKind, id: string, topo: IslandTopology): { pos: Vec3; yaw?: number } | null {
  if (kind === "vertex") {
    // Settlement-sized ghost: buildingTransform validates the id against the
    // topology and returns null for unknowns (geom throws — it catches).
    const t = buildingTransform(topo, id, "settlement");
    return t === null ? null : { pos: [t.position[0], t.position[1] + TARGET_LIFT, t.position[2]] };
  }
  if (kind === "edge") {
    const t = roadTransform(topo, id);
    return t === null
      ? null
      : { pos: [t.position[0], t.position[1] + TARGET_LIFT, t.position[2]], yaw: t.yaw };
  }
  // hex — "q,r" parse is the validity check (hexIdWorld throws on malformed).
  try {
    const [x, , z] = hexIdWorld(id, HEIGHTS.land + TARGET_LIFT);
    parseHexId(id); // explicit: an id like "desert" must not silently pass
    return { pos: [x, HEIGHTS.land + TARGET_LIFT, z] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Who may act on the board RIGHT NOW (pure — so the modal's picker can also
// be unit-tested without React)
// ---------------------------------------------------------------------------

/**
 * True iff `seat` is currently allowed to place a piece or move the robber —
 * i.e. the server's legalMoves are ITS board options right now.
 *
 * Why not just `currentSeat === seat`: reviewed against the kernel
 * (turn.ts:1443-1453 off-turn moves are ONLY tradeAccept/tradeReject; a
 * seven window cannot be escaped by endTurn), the actor is ALWAYS the
 * currentSeat in every reachable state — the wire's seat-scoped legalMoves
 * already prevents wrong ghosts. This function states the PROTOCOL actor
 * explicitly, which has two real jobs: (a) if a future kernel ever moves
 * currentSeat mid-window, ghosts fail LOUD in a unit test instead of
 * silently vanishing, and (b) during pendingDiscard it returns false for
 * everyone — cards are owed through the modal, not a board click, so a
 * roller who is also a debtor must not see hex ghosts while discarding.
 */
export function mayActOnBoard(state: GameState, seat: number): boolean {
  const aw = state.awaitingSeven;
  if (aw !== null) {
    if (aw.pendingDiscard) return false; // discard is the modal's job
    // mustMoveRobber OR steal-pending: only the roller has board ops
    // (hex ghosts for moveRobber; stealCard is DOM-side).
    return aw.roller === seat;
  }
  return state.currentSeat === seat;
}

/**
 * Canonical multiset key for a discard selection: resource-name-sorted
 * "wood:2,wool:1" — stable across card order. The modal validates its picker
 * against discardCombinationKeys, which uses THIS function, so the two sides
 * cannot drift.
 */
export function discardCardsKey(cards: readonly Resource[]): string {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([r, n]) => `${r}:${n}`)
    .join(",");
}

/**
 * The multiset keys of every shipped discardSeven op — the legality index
 * the modal validates its picker against. Extracted from the component so a
 * NODE test can assert "exactly the combinations the server shipped" without
 * React (Targets/DiscardModal themselves render, and nothing here renders).
 */
export function discardCombinationKeys(legalMoves: readonly Op[]): Set<string> {
  const keys = new Set<string>();
  for (const op of legalMoves) {
    if (op.type !== "discardSeven") continue;
    keys.add(discardCardsKey(op.cards));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// The one exported builder
// ---------------------------------------------------------------------------

/**
 * Turn the server's legalMoves into clickable board ghosts.
 *
 * Ordering follows legalMoves order (server-deterministic), and the FIRST
 * op to claim an id wins. In practice ids cannot collide (placeSetupPiece
 * settlements only appear in phase "setup"; buildSettlement only in "play"),
 * but a collision would otherwise render two meshes stacked on one vertex
 * and make the click ambiguous — so dedupe defensively.
 *
 * Ids that the topology cannot resolve are SKIPPED with a warn-once (review
 * I-6 discipline: degrade to "missing ghost", never a white screen).
 */
export function buildTargetSet(
  legalMoves: readonly Op[],
  topology: IslandTopology | null | undefined,
): Target[] {
  if (topology == null) return [];
  const out: Target[] = [];
  const claimed = new Set<string>();
  for (const op of legalMoves) {
    const slot = placementSlot(op);
    if (slot === null) continue;
    const key = `${slot.kind}:${slot.id}`;
    if (claimed.has(key)) continue; // first shipped op wins (defensive)
    const resolved = resolvePos(slot.kind, slot.id, topology);
    if (resolved === null) {
      warnOnce(slot.id, `unknown ${slot.kind} id for op ${op.type}`);
      continue;
    }
    claimed.add(key);
    out.push({ key, kind: slot.kind, id: slot.id, ...resolved, op });
  }
  return out;
}
