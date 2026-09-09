/**
 * EventTicker.tsx — the last few events the room pushed.
 *
 * Newest last (the adapter's ring buffer is newest-last too); rendered
 * reversed so the freshest line is on top. `details` is opaque on the wire,
 * so we only surface the two keys every kind carries: seat and opType.
 */
import type { RoomState } from "../wire/adapter.js";

export interface EventTickerProps {
  events: RoomState["events"];
}

function seatOf(details: Record<string, unknown>): string {
  const s = details["seat"];
  return typeof s === "number" ? `seat ${s}` : "";
}

function detailTail(kind: string, details: Record<string, unknown>): string {
  if (kind === "rejected") {
    const code = details["code"];
    return typeof code === "string" ? ` · ${code}` : "";
  }
  const opType = details["opType"];
  return typeof opType === "string" ? ` · ${opType}` : "";
}

export function EventTicker({ events }: EventTickerProps): React.JSX.Element {
  return (
    <section className="panel" aria-label="events">
      <h2>Events</h2>
      {events.length === 0 ? (
        <p className="hint">No events yet.</p>
      ) : (
        <ul className="ticker">
          {[...events].reverse().map((e, i) => (
            <li key={`${e.serverSeq}:${e.kind}:${i}`}>
              <span className="seq">[{e.serverSeq}]</span>
              {e.kind}
              {seatOf(e.details) !== "" ? ` · ${seatOf(e.details)}` : ""}
              {detailTail(e.kind, e.details)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
