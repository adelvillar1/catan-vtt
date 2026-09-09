/**
 * TradePanel.tsx — bank / port / opponent trades, built from real Op shapes.
 *
 * The form never invents an op: tradeFormToOp() (pure, unit-tested in
 * trade.test.ts against the ACTUAL OpSchema) builds it, and the panel is
 * disabled unless the server shipped the matching trade move. Server-side
 * validation still has the final say — a rejected trade shows in the ticker.
 */
import { useState } from "react";
import type { GameState, Op, Resource } from "@catan-vtt/shared"; // type-only
import { RESOURCES, RESOURCE_ABBR, tradeCapabilities, tradeFormToOp, tradeHint } from "./hudLogic.js";

export interface TradePanelProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

type Kind = "bank" | "port" | "offer";

export function TradePanel({ state, seat, legalMoves, sendOp }: TradePanelProps): React.JSX.Element {
  const caps = tradeCapabilities(legalMoves, state, seat);
  const [kind, setKind] = useState<Kind>(caps.bank ? "bank" : caps.port ? "port" : "offer");
  const [give, setGive] = useState<Resource>("wood");
  const [want, setWant] = useState<Resource>("ore");
  const [portVertexId, setPortVertexId] = useState<string>(caps.ports[0] ?? "");
  const [partner, setPartner] = useState<number>(caps.partners[0] ?? 0);

  const enabled =
    seat !== null &&
    ((kind === "bank" && caps.bank) || (kind === "port" && caps.port) || (kind === "offer" && caps.offer));

  const op = enabled && seat !== null ? tradeFormToOp({ kind, give: [give], want: [want], portVertexId, with: partner }, seat) : null;

  const submit = (): void => {
    if (op !== null) sendOp(op);
  };

  return (
    <section className="panel" aria-label="trade" id="trade-panel">
      <h2>Trade</h2>

      {seat === null ? (
        <p className="hint">Spectators cannot trade.</p>
      ) : (
        <>
          <div className="trade-tabs">
            {(["bank", "port", "offer"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={k === kind ? "tab-on" : ""}
                disabled={
                  (k === "bank" && !caps.bank) || (k === "port" && !caps.port) || (k === "offer" && !caps.offer)
                }
                onClick={() => setKind(k)}
              >
                {k === "bank" ? "Bank 4:1" : k === "port" ? "Port" : "Opponent"}
              </button>
            ))}
          </div>

          <div className="join-row">
            <div className="field">
              <label htmlFor="trade-give">Give</label>
              <select
                id="trade-give"
                value={give}
                disabled={!enabled}
                onChange={(e) => setGive(e.target.value as Resource)}
              >
                {RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_ABBR[r]} · {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="trade-want">Want</label>
              <select
                id="trade-want"
                value={want}
                disabled={!enabled}
                onChange={(e) => setWant(e.target.value as Resource)}
              >
                {RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_ABBR[r]} · {r}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {kind === "port" ? (
            <div className="field">
              <label htmlFor="trade-port">Port vertex</label>
              <select
                id="trade-port"
                value={portVertexId}
                disabled={!enabled}
                onChange={(e) => setPortVertexId(e.target.value)}
              >
                {caps.ports.length === 0 ? <option value="">none shipped</option> : null}
                {caps.ports.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {kind === "offer" ? (
            <div className="field">
              <label htmlFor="trade-with">Offer to</label>
              <select
                id="trade-with"
                value={String(partner)}
                disabled={!enabled}
                onChange={(e) => setPartner(Number(e.target.value))}
              >
                {caps.partners.length === 0 ? <option value="0">no other players</option> : null}
                {caps.partners.map((s) => (
                  <option key={s} value={String(s)}>
                    seat {s} · {state.players.find((p) => p.seat === s)?.name ?? "?"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button type="button" className="btn-primary" id="trade-submit" disabled={op === null} onClick={submit}>
            {op === null ? "No legal trade" : `Send ${op.type}`}
          </button>

          {tradeHint(caps) !== "" && !caps.bank && !caps.port && !caps.offer ? (
            <p className="hint">{tradeHint(caps)}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
