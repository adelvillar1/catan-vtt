/**
 * MovesList.tsx — the server's legalMoves, READ-ONLY in P1.
 *
 * The buttons are disabled on purpose: this phase proves the table can *see*
 * the authoritative move list and label it. P2 wires onClick → sendOp. The
 * `title` says so, so nobody files it as a bug tonight.
 */
import { useMemo } from "react";
import type { Op } from "@catan-vtt/shared";
import { labelMoves } from "./opLabel.js";

export interface MovesListProps {
  moves: readonly Op[];
  /** When false the list renders its empty placeholder instead. */
  connected?: boolean;
}

export function MovesList({ moves, connected = true }: MovesListProps): React.JSX.Element {
  const labeled = useMemo(() => labelMoves(moves), [moves]);
  return (
    <section className="panel" aria-label="legal moves">
      <h2>Legal moves ({labeled.length})</h2>
      {!connected ? (
        <p className="hint">Join a room to see the server's move list.</p>
      ) : labeled.length === 0 ? (
        <p className="hint">No legal moves for you right now.</p>
      ) : (
        <ul className="moves">
          {labeled.map((m) => (
            <li key={m.key}>
              <button type="button" disabled title="P2 — op sending lands next phase">
                <span>{m.label}</span>
                {m.detail !== undefined ? <span className="detail">{m.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
