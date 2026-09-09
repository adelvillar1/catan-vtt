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
 * No dismiss button ON PURPOSE: nothing is being blocked and there is no
 * "later" state to return to — the table is finished until the host starts a
 * rematch (not on the wire in v1; P3(b) ships it and updates the sub-line).
 */
import { useEffect, useRef } from "react";
import { seatColor } from "../scene/palette.js";
import { readE2eWinSeat, victoryInput, victoryView } from "./victoryView.js";
import type { GameState } from "@catan-vtt/shared"; // type-only

export interface VictoryOverlayProps {
  state: GameState;
  seat: number | null;
}

export function VictoryOverlay({ state, seat }: VictoryOverlayProps): React.JSX.Element | null {
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
      </div>
    </div>
  );
}
