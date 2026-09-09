/**
 * ResourceRail.tsx — your hand, plus the two primary turn buttons.
 *
 * Hand chips come from the server's projection for YOUR seat only (other
 * hands are redacted server-side). roll/endTurn are rendered only when the
 * server shipped those ops — the button IS the op, copied verbatim.
 */
import type { GameState, Op } from "@catan-vtt/shared"; // type-only
import { handChips, handTotal, pickMove } from "./hudLogic.js";

export interface ResourceRailProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

export function ResourceRail({ state, seat, legalMoves, sendOp }: ResourceRailProps): React.JSX.Element {
  const chips = handChips(state, seat);
  const total = handTotal(state, seat);
  const roll = pickMove(legalMoves, "roll");
  const endTurn = pickMove(legalMoves, "endTurn");
  const deck = state.deck.length;

  return (
    <section className="panel" aria-label="resources" id="rail-panel">
      <h2>Resources</h2>

      {seat === null ? (
        <p className="hint">Spectating — hands are hidden.</p>
      ) : (
        <>
          <div className="chips" id="rail-chips">
            {chips.map((c) => (
              <span
                key={c.resource}
                className="chip"
                style={{ borderColor: c.color }}
                data-resource={c.resource}
                data-count={c.count}
              >
                <i className="chip-dot" style={{ background: c.color }} />
                {c.abbr}
                <b>{c.count}</b>
              </span>
            ))}
          </div>
          <div className="kv">
            <span>total cards</span>
            <span id="rail-total">{total}</span>
          </div>
        </>
      )}

      <div className="kv">
        <span>dev deck</span>
        <span>{deck}</span>
      </div>

      <div className="hud-actions">
        {roll !== null ? (
          <button
            type="button"
            className="btn-primary"
            id="rail-roll"
            onClick={() => sendOp(roll)}
          >
            Roll dice
          </button>
        ) : null}
        {endTurn !== null ? (
          <button
            type="button"
            className="btn-primary"
            id="rail-endturn"
            onClick={() => sendOp(endTurn)}
          >
            End turn
          </button>
        ) : null}
      </div>
      {roll === null && endTurn === null ? (
        <p className="hint">No roll/end-turn move for you right now.</p>
      ) : null}
    </section>
  );
}
