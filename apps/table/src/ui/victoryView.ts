/**
 * victoryView.ts — PURE derivation of the M3-P3(a) victory banner.
 *
 * The overlay is CLIENT-SIDE derivation over the projection: `state.winner`
 * and `state.finalPoints` are PUBLIC (redact.ts:31 passes them through for
 * every seat and for the spectator broadcast) and ride EVERY projection
 * message — unlike the one-shot `gameEnded` event, they can never be missed
 * by a late joiner or a rolled ticker. So there is NO protocol change here:
 * no new wire frame, no server send site (see docs/plans/2026-09-09-m3-p3a-…).
 *
 * TWO HARD PROPERTIES, both enforced by the SIGNATURE, not by discipline:
 *
 *  1. REDACTION HONESTY. The state parameter is typed as the two-integer
 *     shape `VictoryInput` — this function structurally CANNOT read a hand,
 *     a devHand, the deck or the seed, even though callers pass a whole
 *     GameState. The `players` parameter is a minimal roster of
 *     { seat, name, color } — the public roster fields only. victoryView
 *     therefore outputs nothing the wire did not already ship.
 *
 *  2. POINTS ARE NEVER COMPUTED HERE. `points` is `finalPoints` verbatim.
 *     The kernel's ledger (vp.ts victoryPoints) over-reports other seats on
 *     a redacted projection (fake VP cards), so any client-side VP math
 *     would be a lie — the server's number is the only honest one.
 */

/** The only two state fields the view is allowed to see (see AC2). */
export interface VictoryInput {
  winner: number | null;
  finalPoints: number | null;
}

/** Public roster entry — a structural subset of the kernel's PlayerState. */
export interface VictoryRosterEntry {
  seat: number;
  name: string;
  color: string;
}

export interface VictoryView {
  /** The winning seat (from the projection). */
  winnerSeat: number;
  /** Winner's roster name ("Player 3"); "a player" if the roster lacks them. */
  name: string;
  /** Seat color name ("Orange") — public, drives the banner text. */
  colorKey: string;
  /** finalPoints verbatim — never a client-computed tally. */
  points: number;
  /** True when `seat` is the winner. Spectators (null) get false. */
  isYou: boolean;
  /** "🏆 Orange wins — 11 Victory Points". */
  banner: string;
  /** "You win!" when isYou, else null. */
  shout: string | null;
  /** Honest status line: rematch is NOT on the wire in v1 (server.ts:21). */
  sub: string;
}

const FALLBACK_NAME = "a player";
const REMATCH_COPY = "The host can start a rematch soon";

function pointsCopy(points: number): string {
  return `${points} Victory Point${points === 1 ? "" : "s"}`;
}

/**
 * The banner, or null while nobody has won.
 *
 * @param input   winner/finalPoints (a whole GameState is accepted — the
 *                narrow parameter type is what makes AC2 structural).
 * @param players public roster; only seat/name/color are ever read.
 * @param seat    this client's seat, or null for a spectator.
 */
export function victoryView(
  input: VictoryInput,
  players: readonly VictoryRosterEntry[],
  seat: number | null,
): VictoryView | null {
  const winner = input.winner;
  if (winner === null) return null;

  const entry = players.find((p) => p.seat === winner) ?? null;
  // Defensive: the server can only end the game for a seated player, but a
  // roster/winner mismatch must degrade to copy, never to a crash.
  const name = entry === null ? FALLBACK_NAME : entry.name;
  const colorKey = entry === null ? `Seat ${winner}` : entry.color;
  const points = input.finalPoints ?? 0; // kernel always sets both together
  const isYou = seat !== null && seat === winner;

  return {
    winnerSeat: winner,
    name,
    colorKey,
    points,
    isYou,
    banner: `🏆 ${colorKey} wins — ${pointsCopy(points)}`,
    shout: isYou ? "You win!" : null,
    sub: REMATCH_COPY,
  };
}

// ---------------------------------------------------------------------------
// e2e affordance — localStorage `catan:e2eWin=<seat 0..3>` (plan AC4)
// ---------------------------------------------------------------------------

/**
 * SAME TRUST CLASS AS `catan:e2eTargets` (scene/Targets.tsx): an opt-in read
 * of localStorage, consulted only when the page asked for it. It is NOT an
 * `import.meta.env.DEV` gate — that flag is unreliable in this Vite stack
 * (it reads false even under `vite dev`, which silently disabled the targets
 * hook). What it injects is no new information either: winner/finalPoints are
 * public fields every client already receives on every projection.
 *
 * The synthetic winner is fed to `victoryView` ONLY — never into room state,
 * never into an op, never into anything sent on the wire. It exists because a
 * kernel game cannot be played to 10 VP inside a browser-smoke budget, and
 * the P3(a) proof needs to see the overlay render.
 */
export const E2E_WIN_KEY = "catan:e2eWin";

/** Points the synthetic e2e winner reports (kernel VP_TO_WIN — not imported:
 *  apps/table/src makes no runtime kernel imports). */
export const E2E_WIN_POINTS = 10;

/** Seats 0..3 only; anything else (absent, empty, "9", "x") is no override. */
export function readE2eWinSeat(storage: Storage): number | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(E2E_WIN_KEY);
  } catch {
    return null; // storage disabled — no override
  }
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
}

/**
 * The two integers `victoryView` sees. The e2e override is consulted ONLY
 * when the projection says nobody has won (`winner === null`) — a real game
 * is never overwritten by the flag.
 */
export function victoryInput<S extends VictoryInput>(state: S, e2eWinSeat: number | null): VictoryInput {
  if (state.winner !== null) return { winner: state.winner, finalPoints: state.finalPoints };
  if (e2eWinSeat === null) return { winner: null, finalPoints: null };
  return { winner: e2eWinSeat, finalPoints: E2E_WIN_POINTS };
}


