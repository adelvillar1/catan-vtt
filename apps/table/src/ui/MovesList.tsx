/**
 * MovesList.tsx — the server's legalMoves, now PLAYABLE (P2).
 *
 * Each button IS the server's op object: onClick → sendOp(op) verbatim.
 * Nothing here decides legality — if the server shipped it, you can click it.
 */
import { useMemo } from "react";
import type { Op } from "@catan-vtt/shared"; // type-only
import { labelMoves } from "./opLabel.js";

export interface MovesListProps {
  moves: readonly Op[];
  /** When false the list renders its empty placeholder instead. */
  connected?: boolean;
  /** P2: sends the verbatim op from an onClick (never from an updater). */
  onSend?: ((op: Op) => boolean) | undefined;
}

export function MovesList({ moves, connected = true, onSend }: MovesListProps): React.JSX.Element {
  const labeled = useMemo(() => labelMoves(moves), [moves]);
  return (
    <section className="panel" aria-label="legal moves">
      <h2>Legal moves ({labeled.length})</h2>
      {!connected ? (
        <p className="hint">Join a room to see the server's move list.</p>
      ) : labeled.length === 0 ? (
        <p className="hint">No legal moves for you right now.</p>
      ) : (
        <ul className="moves" id="moves-list">
          {labeled.map((m) => (
            <li key={m.key}>
              <button
                type="button"
                disabled={onSend === undefined}
                title={onSend === undefined ? "not connected" : "send this op"}
                onClick={() => {
                  if (onSend !== undefined) onSend(m.op);
                }}
              >
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
