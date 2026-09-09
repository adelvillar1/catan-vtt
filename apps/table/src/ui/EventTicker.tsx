/**
 * EventTicker.tsx — the last few events the room pushed.
 *
 * Newest last (the adapter's ring buffer is newest-last too); rendered
 * reversed so the freshest line is on top. `details` is opaque on the wire,
 * so we only surface the two keys every kind carries: seat and opType.
 */
import type { RoomState } from "../wire/adapter.js";
import { eventTail } from "./opLabel.js";

export interface EventTickerProps {
  events: RoomState["events"];
}

function seatOf(details: Record<string, unknown>): string {
  const s = details["seat"];
  return typeof s === "number" ? `seat ${s}` : "";
}

export function EventTicker({ events }: EventTickerProps): React.JSX.Element {
  return (
    <section className="panel" aria-label="events">
      <h2>Events</h2>
      {events.length === 0 ? (
        <p className="hint">No events yet.</p>
      ) : (
        <ul className="ticker">
          {[...events].reverse().map((e) => (
            // Stable key (review i-12): serverSeq is unique per event — the
            // old key included the REVERSED INDEX, so every ring shift
            // re-keyed (remounted) all rows.
            <li key={`${e.serverSeq}:${e.kind}`}>
              <span className="seq">[{e.serverSeq}]</span>
              {e.kind}
              {seatOf(e.details) !== "" ? ` · ${seatOf(e.details)}` : ""}
              {eventTail(e.kind, e.details)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
