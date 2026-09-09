/**
 * DevCardPanel.tsx — buy + play development cards.
 *
 * The playable count subtracts cards bought this turn (kernel rule), but the
 * buttons themselves exist only because the server shipped play* ops.
 * playMonopoly / playYearOfPlenty need a resource choice — P2(a) sends the
 * shipped op when one exists; a picker for them is P2(b) work (see report).
 */
import type { GameState, Op } from "@catan-vtt/shared"; // type-only
import { devChips, pickMove } from "./hudLogic.js";

export interface DevCardPanelProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

const LABELS: Record<string, string> = {
  knight: "Knight",
  victoryPoint: "VP",
  monopoly: "Monopoly",
  roadBuilding: "Road building",
  yearOfPlenty: "Year of plenty",
};

export function DevCardPanel({ state, seat, legalMoves, sendOp }: DevCardPanelProps): React.JSX.Element {
  const chips = devChips(state, seat);
  const buy = pickMove(legalMoves, "buyDevCard");
  const knight = pickMove(legalMoves, "playKnight");
  const monopoly = pickMove(legalMoves, "playMonopoly");
  const roadBuilding = pickMove(legalMoves, "playRoadBuilding");
  const yop = pickMove(legalMoves, "playYearOfPlenty");
  const any = chips.some((c) => c.count > 0) || buy !== null;

  return (
    <section className="panel" aria-label="development cards" id="dev-panel">
      <h2>Dev cards</h2>

      {seat === null ? (
        <p className="hint">Spectating — dev hands are hidden.</p>
      ) : (
        <div className="chips" id="dev-chips">
          {chips
            .filter((c) => c.count > 0)
            .map((c) => (
              <span key={c.type} className="chip" data-dev={c.type} data-count={c.count}>
                {LABELS[c.type] ?? c.type}
                <b>{c.count}</b>
                {c.playable < c.count ? <em>+{c.count - c.playable} new</em> : null}
              </span>
            ))}
          {chips.every((c) => c.count === 0) ? <span className="hint">none</span> : null}
        </div>
      )}

      <div className="hud-actions">
        {buy !== null ? (
          <button type="button" className="btn-primary" id="dev-buy" onClick={() => sendOp(buy)}>
            Buy dev card
          </button>
        ) : null}
        {knight !== null ? (
          <button type="button" id="dev-knight" onClick={() => sendOp(knight)}>
            Play knight
          </button>
        ) : null}
        {monopoly !== null ? (
          <button type="button" id="dev-monopoly" onClick={() => sendOp(monopoly)}>
            Play monopoly ({monopoly.resource})
          </button>
        ) : null}
        {roadBuilding !== null ? (
          <button type="button" id="dev-roadbuilding" onClick={() => sendOp(roadBuilding)}>
            Play road building ({roadBuilding.edgeIds.length})
          </button>
        ) : null}
        {yop !== null ? (
          <button type="button" id="dev-yop" onClick={() => sendOp(yop)}>
            Play year of plenty
          </button>
        ) : null}
      </div>

      {!any ? <p className="hint">No dev cards and none purchasable.</p> : null}
    </section>
  );
}
