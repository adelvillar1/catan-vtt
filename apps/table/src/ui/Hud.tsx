/**
 * Hud.tsx — the P2 turn banner: whose turn, what the table is waiting on,
 * live trade offers you can answer, and your visible score.
 *
 * Every button here sends an op the SERVER shipped in legalMoves — found by
 * pickMove(type), never constructed. If the server did not ship
 * tradeAccept/tradeReject, the buttons do not render (no guessing, AC3).
 */
import type { GameState, Op } from "@catan-vtt/shared"; // type-only
import { seatColor, seatName } from "../scene/palette.js";
import { pendingTradeView, pickMove, turnBanner, visiblePoints } from "./hudLogic.js";

export interface HudProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

export function Hud({ state, seat, legalMoves, sendOp }: HudProps): React.JSX.Element {
  const banner = turnBanner(state, seat);
  const trade = pendingTradeView(state, seat);
  const accept = pickMove(legalMoves, "tradeAccept");
  const reject = pickMove(legalMoves, "tradeReject");
  const claim = pickMove(legalMoves, "claimVictory");
  const me = seat === null ? null : state.players.find((p) => p.seat === seat) ?? null;
  const lr = state.longestRoad;
  const la = state.largestArmy;

  return (
    <section className="panel" aria-label="turn hud" id="hud-panel">
      <h2>Turn</h2>

      <div className="hud-banner" id="hud-title" data-yours={banner.yours ? "1" : "0"}>
        <i className="seat-chip" style={{ background: seatColor(state.currentSeat) }} />
        <strong>{banner.title}</strong>
      </div>

      <div className="kv">
        <span>phase</span>
        <span id="hud-phase">{state.phase}</span>
      </div>
      <div className="kv">
        <span>turn #</span>
        <span>{state.rollLog.length + 1}</span>
      </div>
      {state.lastRoll !== null ? (
        <div className="kv">
          <span>last roll</span>
          <span id="hud-lastroll">{state.lastRoll}</span>
        </div>
      ) : null}

      {banner.waiting !== null ? (
        <p className="hint" id="hud-waiting">
          {banner.waiting}
        </p>
      ) : null}

      {state.awaitingSeven !== null ? (
        <p className="hud-flag" id="hud-seven">
          7 rolled — {state.awaitingSeven.pendingDiscard ? "discards pending" : "robber"}
        </p>
      ) : null}

      {lr.holder !== null ? (
        <div className="kv">
          <span>longest road</span>
          <span>
            <i className="seat-chip" style={{ background: seatColor(lr.holder) }} />
            {lr.holder} · {seatName(lr.holder)} ({lr.length})
          </span>
        </div>
      ) : null}
      {la.holder !== null ? (
        <div className="kv">
          <span>largest army</span>
          <span>
            <i className="seat-chip" style={{ background: seatColor(la.holder) }} />
            {la.holder} · {seatName(la.holder)} ({la.count})
          </span>
        </div>
      ) : null}

      {me !== null ? (
        <div className="kv">
          <span>your points</span>
          <span id="hud-vp">{visiblePoints(state, seat!)}</span>
        </div>
      ) : null}

      {trade !== null ? (
        <div className="hud-trade" id="hud-trade">
          <p className="hint">
            {trade.summary}
            {trade.actionable ? " — offered to you" : ` — waiting on seat ${trade.offeree}`}
          </p>
          {trade.actionable ? (
            <div className="hud-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={accept === null}
                title={accept === null ? "server shipped no tradeAccept" : "send tradeAccept"}
                onClick={() => {
                  if (accept !== null) sendOp(accept);
                }}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={reject === null}
                title={reject === null ? "server shipped no tradeReject" : "send tradeReject"}
                onClick={() => {
                  if (reject !== null) sendOp(reject);
                }}
              >
                Decline
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {claim !== null ? (
        <button
          type="button"
          className="btn-primary"
          id="hud-claim"
          onClick={() => sendOp(claim)}
        >
          Claim victory
        </button>
      ) : null}
    </section>
  );
}
