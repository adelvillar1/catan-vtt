/**
 * VictoryOverlay.tsx — the M3-P3(a) end-of-game banner.
 *
 * Pure client derivation (see ui/victoryView.ts): the projection's PUBLIC
 * winner/finalPoints fields decide everything here — there is no `gameOver`
 * wire frame and no server change. Points come from `finalPoints`, never from
 * a client tally (a redacted projection over-reports other seats' VP).
 *
 * Cinematic, not blocking. It sits ABOVE the rail (z-index 15 — the discard
 * modal's 20 still wins, and that modal cannot be up once the game has
 * ended) and never traps focus: the event ticker keeps streaming underneath
 * and the HUD is inert anyway (legalMoves is empty in phase "ended"). The
 * heading takes focus on appear and the whole panel is aria-live="polite",
 * so a screen reader or keyboard user is told the outcome.
 *
 * M3-P3(b): the host (seat 0) gets ONE control — "Start rematch". It is a
 * REQUEST: the server re-checks seat 0 + phase "ended" and answers
 * error{notHost}/error{badPhase} if either is false. Everyone else sees who
 * they are waiting for. There is still no dismiss button: nothing is being
 * blocked and there is no "later" state to return to.
 *
 * POINTER-EVENTS TRAP (plan item 5): `.victory-overlay` is pointer-events:
 * NONE (click-through, chosen in P3(a)). A button inside it is therefore
 * visible and DEAD unless it re-declares pointer-events:auto — done by the
 * `.victory-rematch` rule in table.css, not by an inline style, so the fix
 * lives with the trap that caused it.
 */
import { useEffect, useRef } from "react";
import { seatColor } from "../scene/palette.js";
import { readE2eWinSeat, victoryInput, victoryView } from "./victoryView.js";
import type { GameState } from "@catan-vtt/shared"; // type-only

export interface VictoryOverlayProps {
  state: GameState;
  seat: number | null;
  /** Sends { type: "rematch" }. Server-side authority still decides. */
  onRematch: () => void;
}

export function VictoryOverlay({
  state,
  seat,
  onRematch,
}: VictoryOverlayProps): React.JSX.Element | null {
  const heading = useRef<HTMLHeadingElement | null>(null);

  // e2e AFFORDANCE (plan AC4) — same trust class and same opt-in pattern as
  // `catan:e2eTargets` in scene/Targets.tsx: read ONCE at mount from
  // localStorage, and NOT gated on import.meta.env.DEV (that flag reads false
  // in this Vite stack even under `vite dev`). It feeds victoryView a
  // synthetic winner ONLY while the projection reports none — never room
  // state, never an op, never the wire. winner/finalPoints are public fields
  // every client already receives on every projection, so this leaks nothing.
  const e2eWin = useRef<number | null | undefined>(undefined);
  if (e2eWin.current === undefined) {
    try {
      e2eWin.current = readE2eWinSeat(window.localStorage);
    } catch {
      e2eWin.current = null; // no storage (SSR-ish / disabled) — no override
    }
  }

  const view = victoryView(victoryInput(state, e2eWin.current), state.players, seat);

  // Focus the heading once, when the banner first appears (a11y: the outcome
  // is announced instead of only being drawn). Re-focusing on every render
  // would steal focus back from whatever the user clicked afterwards.
  const shown = view !== null;
  const focused = useRef(false);
  useEffect(() => {
    if (!shown) return;
    if (focused.current) return;
    focused.current = true;
    heading.current?.focus();
  }, [shown]);

  if (view === null) return null;

  return (
    <div
      className="victory-overlay"
      id="victory-overlay"
      role="status"
      aria-live="polite"
      // Click-through: the banner is an announcement, not a wall.
      aria-label="game over"
      data-winner={String(view.winnerSeat)}
    >
      <div className="victory-card">
        <h2 ref={heading} tabIndex={-1} id="victory-heading">
          <i className="victory-dot" style={{ background: seatColor(view.winnerSeat) }} />
          {view.banner}
        </h2>
        {view.shout !== null ? (
          <p className="victory-shout" id="victory-shout">
            {view.shout}
          </p>
        ) : null}
        <p className="victory-line" id="victory-winner">
          {view.name} · seat {view.winnerSeat}
        </p>
        <p className="hint" id="victory-sub">
          {view.sub}
        </p>
        {/* Host-only affordance. The SERVER is the authority: a forged
            rematch from any other seat gets error{notHost}. */}
        {view.canRematch ? (
          <button
            type="button"
            className="btn-primary victory-rematch"
            id="victory-rematch"
            onClick={() => onRematch()}
          >
            {view.rematchLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
