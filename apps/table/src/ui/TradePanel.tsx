/**
 * TradePanel.tsx — bank / port / opponent trades.
 *
 * Review batch (P2a quality):
 *  - IMPORTANT-1: bank/port give+want selects list ONLY the pairs the server
 *    actually shipped (shippedTrades), and submitting sends the shipped op
 *    object verbatim — the UI can no longer "compose" a maritime trade that
 *    was never legal (insufficientHand / portResourceMismatch best-case
 *    rejections are gone; the options themselves are the legality).
 *  - IMPORTANT-2: the Opponent tab gates on public state affordances
 *    (tradeCapabilities.offer) — the kernel DELIBERATELY never enumerates
 *    tradeOffer ("UI-composed by design", turn.ts JSDoc), so here the form
 *    composes give (own hand only) / want (any other resource) and the
 *    server's applyTradeOffer is the sole legality authority. Honest loop:
 *    UI composes → server accepts or rejects-by-code.
 *  - IMPORTANT-5: every select reconciles its stored choice against the
 *    CURRENT option space at render — a controlled <select> can never show a
 *    value absent from its list after legalMoves shift under it.
 */
import { useState } from "react";
import type { GameState, Op, Resource } from "@catan-vtt/shared"; // type-only
import {
  RESOURCES,
  RESOURCE_ABBR,
  handChips,
  shippedTrades,
  tradeCapabilities,
  tradeDemandsFor,
  tradeFormToOp,
  tradeHint,
  tradeOffersFor,
} from "./hudLogic.js";

export interface TradePanelProps {
  state: GameState;
  seat: number | null;
  legalMoves: readonly Op[];
  sendOp: (op: Op) => boolean;
}

type Kind = "bank" | "port" | "offer";

export function TradePanel({ state, seat, legalMoves, sendOp }: TradePanelProps): React.JSX.Element {
  const caps = tradeCapabilities(legalMoves, state, seat);
  const shipped = shippedTrades(legalMoves);
  const [kind, setKind] = useState<Kind>("bank");
  // null = "no explicit choice yet, auto-pick the first option" (never stale).
  const [give, setGive] = useState<Resource | null>(null);
  const [want, setWant] = useState<Resource | null>(null);
  const [portVertexId, setPortVertexId] = useState<string | null>(null);
  const [partner, setPartner] = useState<number | null>(null);

  // --- option spaces (I-1 for bank/port, own-hand for offer) ---
  const giveOpts: Resource[] =
    kind === "offer"
      ? handChips(state, seat).filter((c) => c.count > 0).map((c) => c.resource)
      : tradeOffersFor(shipped, kind === "port" ? "port" : "bank");
  const giveSel: Resource | null = give !== null && giveOpts.includes(give) ? give : giveOpts[0] ?? null;
  const wantOpts: Resource[] =
    kind === "offer"
      ? RESOURCES.filter((r) => r !== giveSel)
      : giveSel === null
        ? []
        : tradeDemandsFor(shipped, kind === "port" ? "port" : "bank", giveSel);
  const wantSel: Resource | null = want !== null && wantOpts.includes(want) ? want : wantOpts[0] ?? null;

  // --- I-5: reconcile selects against the current shipped option space ---
  const portSel: string =
    portVertexId !== null && caps.ports.includes(portVertexId) ? portVertexId : caps.ports[0] ?? "";
  const partnerSel: number =
    partner !== null && caps.partners.includes(partner) ? partner : caps.partners[0] ?? -1;

  const kindOk =
    kind === "bank" ? caps.bank : kind === "port" ? caps.port : caps.offer;
  const enabled = seat !== null && kindOk && giveSel !== null && wantSel !== null &&
    (kind !== "port" || portSel !== "") && (kind !== "offer" || partnerSel >= 0);

  // bank/port: the EXACT shipped op; offer: composed (kernel allows nothing else).
  const shippedPick =
    kind !== "offer" && giveSel !== null && wantSel !== null
      ? shipped.find(
          (t) =>
            t.kind === (kind === "port" ? "port" : "bank") &&
            t.offer === giveSel &&
            t.demand === wantSel &&
            (kind !== "port" || t.portVertexId === portSel),
        )
      : undefined;
  const op: Op | null =
    enabled && seat !== null
      ? kind === "offer"
        ? tradeFormToOp({ kind: "offer", give: [giveSel!], want: [wantSel!], with: partnerSel }, seat)
        : shippedPick?.op ?? null
      : null;

  const submit = (): void => {
    if (op !== null) sendOp(op);
  };

  const resOpt = (r: Resource) => (
    <option key={r} value={r}>
      {RESOURCE_ABBR[r]} · {r}
    </option>
  );

  return (
    <section className="panel" aria-label="trade" id="trade-panel">
      <h2>Trade</h2>

      {seat === null ? (
        <p className="hint">Spectators cannot trade.</p>
      ) : (
        <>
          <div className="trade-tabs" role="group" aria-label="trade kind">
            {(["bank", "port", "offer"] as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={k === kind ? "tab-on" : ""}
                aria-pressed={k === kind}
                disabled={(k === "bank" && !caps.bank) || (k === "port" && !caps.port) || (k === "offer" && !caps.offer)}
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
                value={giveSel ?? ""}
                disabled={!enabled}
                onChange={(e) => {
                  setGive(e.target.value as Resource);
                  setWant(null); // re-narrow the want list after an offer change (I-1)
                }}
              >
                {giveOpts.length === 0 ? <option value="">none legal</option> : null}
                {giveOpts.map(resOpt)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="trade-want">Want</label>
              <select
                id="trade-want"
                value={wantSel ?? ""}
                disabled={!enabled}
                onChange={(e) => setWant(e.target.value as Resource)}
              >
                {wantOpts.length === 0 ? <option value="">none</option> : null}
                {wantOpts.map(resOpt)}
              </select>
            </div>
          </div>

          {kind === "port" ? (
            <div className="field">
              <label htmlFor="trade-port">Port vertex</label>
              <select
                id="trade-port"
                value={portSel}
                disabled={!enabled}
                onChange={(e) => setPortVertexId(e.target.value)}
              >
                {caps.ports.length === 0 ? <option value="">none shipped</option> : null}
                {caps.ports.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          ) : null}

          {kind === "offer" ? (
            <div className="field">
              <label htmlFor="trade-with">Offer to</label>
              <select
                id="trade-with"
                value={String(partnerSel)}
                disabled={!enabled}
                onChange={(e) => setPartner(Number(e.target.value))}
              >
                {caps.partners.length === 0 ? <option value="-1">no other players</option> : null}
                {caps.partners.map((s) => (
                  <option key={s} value={String(s)}>
                    seat {s} · {state.players.find((p) => p.seat === s)?.name ?? "?"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button type="button" className="btn-primary" id="trade-submit" disabled={op === null} onClick={submit}>
            {op === null ? "No legal trade" : `Send ${op.type === "tradeOffer" ? "offer" : op.type}`}
          </button>

          {/* minor: hint whenever the SELECTED kind is unavailable */}
          {!kindOk ? (
            <p className="hint">{tradeHint(caps) || `${kind} trades are not legal for you right now.`}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
