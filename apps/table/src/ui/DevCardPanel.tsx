/**
 * DevCardPanel.tsx — buy + play development cards.
 *
 * The playable count subtracts cards bought this turn (kernel rule), but the
 * buttons themselves exist only because the server shipped play* ops.
 * playMonopoly / playYearOfPlenty enumerate one op per variant — the panel
 * renders a picker per card and sends the EXACT shipped op chosen (I-4).
 */
import { useState } from "react";
import type { GameState, Op, Resource } from "@catan-vtt/shared"; // type-only
import { RESOURCE_ABBR, devChips, pickAll, pickMove } from "./hudLogic.js";

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
  // Reviewer IMPORTANT-4: pickMove returns the FIRST shipped op, which made
  // "Play monopoly" always send resource:"wood". legalMoves enumerates EVERY
  // valid play (monopoly ×5 resources, YOP ×bank-feasible pairs), so the
  // panel renders one button per shipped op instead of one button per card.
  const monopolyOpts = pickAll(legalMoves, "playMonopoly");
  const roadBuilding = pickMove(legalMoves, "playRoadBuilding");
  const yopOpts = pickAll(legalMoves, "playYearOfPlenty");
  const [chosenMono, setChosenMono] = useState<Resource | null>(null);
  const [chosenYop, setChosenYop] = useState<string | null>(null);
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
        {monopolyOpts.length > 0 ? (
          <span className="dev-picker">
            <label htmlFor="dev-monopoly-pick" className="hint">Monopoly: take all</label>
            <select
              id="dev-monopoly-pick"
              value={chosenMono ?? ""}
              onChange={(e) => setChosenMono(e.target.value as Resource)}
            >
              <option value="" disabled>choose…</option>
              {monopolyOpts.map((m) => (
                <option key={m.resource} value={m.resource}>{RESOURCE_ABBR[m.resource]} · {m.resource}</option>
              ))}
            </select>
            {chosenMono !== null ? (
              <button type="button" id="dev-monopoly" onClick={() => {
                const m = monopolyOpts.find((o) => o.resource === chosenMono);
                if (m !== undefined) sendOp(m);
              }}>
                Play monopoly
              </button>
            ) : null}
          </span>
        ) : null}
        {roadBuilding !== null ? (
          <button type="button" id="dev-roadbuilding" onClick={() => sendOp(roadBuilding)}>
            Play road building ({roadBuilding.edgeIds.length})
          </button>
        ) : null}
        {yopOpts.length > 0 ? (
          <span className="dev-picker">
            <label htmlFor="dev-yop-pick" className="hint">Year of plenty: bank</label>
            <select
              id="dev-yop-pick"
              value={chosenYop ?? ""}
              onChange={(e) => setChosenYop(e.target.value)}
            >
              <option value="" disabled>choose…</option>
              {yopOpts.map((m) => {
                const key = `${m.cards[0]}+${m.cards[1]}`;
                return (
                  <option key={key} value={key}>
                    {RESOURCE_ABBR[m.cards[0] as Resource]} + {RESOURCE_ABBR[m.cards[1] as Resource]}
                  </option>
                );
              })}
            </select>
            {chosenYop !== null ? (
              <button type="button" id="dev-yop" onClick={() => {
                const m = yopOpts.find((o) => `${o.cards[0]}+${o.cards[1]}` === chosenYop);
                if (m !== undefined) sendOp(m);
              }}>
                Play year of plenty
              </button>
            ) : null}
          </span>
        ) : null}
      </div>

      {!any ? <p className="hint">No dev cards and none purchasable.</p> : null}
    </section>
  );
}
