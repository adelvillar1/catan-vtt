/**
 * StatusLine.tsx — connection + turn state at a glance.
 *
 * Everything shown is server-reported: the seat from welcome, the phase and
 * serverSeq from the projection, the roster from welcome.players.
 */
import type { UseRoom } from "../wire/useRoom.js";
import { seatColor, seatName } from "../scene/palette.js";

export interface StatusLineProps {
  room: UseRoom;
}

function statusClass(status: string): string {
  if (status === "playing") return "status-ok";
  if (status === "error") return "status-bad";
  if (status === "idle" || status === "closed") return "status-warn";
  return "";
}

export function StatusLine({ room }: StatusLineProps): React.JSX.Element {
  const { room: r, state, seat } = room;
  return (
    <section className="panel" aria-label="status">
      <h2>Status</h2>
      <div className="kv">
        <span>link</span>
        <span className={statusClass(r.status)}>{r.status}</span>
      </div>
      <div className="kv">
        <span>seat</span>
        <span>
          {seat === null ? (
            "spectator"
          ) : (
            <>
              <i className="seat-chip" style={{ background: seatColor(seat) }} />
              {seat} · {seatName(seat)}
            </>
          )}
        </span>
      </div>
      <div className="kv">
        <span>phase</span>
        <span>{state?.phase ?? r.welcome?.phase ?? "—"}</span>
      </div>
      <div className="kv">
        <span>turn</span>
        <span>{state === null ? "—" : `seat ${state.currentSeat}`}</span>
      </div>
      <div className="kv">
        <span>serverSeq</span>
        <span>{r.serverSeq < 0 ? "—" : r.serverSeq}</span>
      </div>
      {state?.winner !== null && state?.winner !== undefined ? (
        <div className="kv">
          <span>winner</span>
          <span className="status-ok">
            seat {state.winner} · {state.finalPoints} VP
          </span>
        </div>
      ) : null}
    </section>
  );
}
