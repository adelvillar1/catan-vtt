/**
 * JoinPanel.tsx — connect + join a room.
 *
 * P1: this is the only interactive surface. It feeds useRoom().connect() and
 * then goes read-only, showing the seat the server granted, the phase and the
 * latest serverSeq. Room codes are 6 alphanumeric chars (the wire's rule), so
 * the input is filtered and capped before it can ever produce a badMessage.
 */
import { useState } from "react";
import { DEFAULT_ROOM_URL, type UseRoom } from "../wire/useRoom.js";
import { seatName } from "../scene/palette.js";

export interface JoinPanelProps {
  room: UseRoom;
}

const ROOM_CODE_RE = /^[A-Za-z0-9]{6}$/;

export function JoinPanel({ room }: JoinPanelProps): React.JSX.Element {
  const [url, setUrl] = useState(room.url || DEFAULT_ROOM_URL);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [seat, setSeat] = useState(""); // "" = spectate, "0".."3" = claim

  const busy = room.room.status === "connecting" || room.room.status === "joining";
  const joined = room.room.status === "playing";
  const codeOk = ROOM_CODE_RE.test(code);
  const canJoin = !busy && !joined && codeOk;

  const submit = (): void => {
    if (!canJoin) return;
    room.connect({
      roomCode: code,
      ...(seat === "" ? {} : { seat: Number(seat) }),
      ...(name.trim() === "" ? {} : { name: name.trim() }),
    });
  };

  return (
    <section className="panel" aria-label="join">
      <h2>Room</h2>

      <div className="field">
        <label htmlFor="join-url">Server</label>
        <input
          id="join-url"
          value={url}
          disabled={busy || joined}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={DEFAULT_ROOM_URL}
          spellCheck={false}
        />
      </div>

      <div className="join-row">
        <div className="field">
          <label htmlFor="join-code">Room code</label>
          <input
            id="join-code"
            value={code}
            disabled={busy || joined}
            maxLength={6}
            onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 6))}
            placeholder="ABC123"
            aria-invalid={code.length > 0 && !codeOk}
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="join-seat">Seat</label>
          <select
            id="join-seat"
            value={seat}
            disabled={busy || joined}
            onChange={(e) => setSeat(e.target.value)}
          >
            <option value="">spectate</option>
            {[0, 1, 2, 3].map((s) => (
              <option key={s} value={String(s)}>
                {s} · {seatName(s)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="join-name">Name</label>
        <input
          id="join-name"
          value={name}
          disabled={busy || joined}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder="optional"
          spellCheck={false}
        />
      </div>

      {joined ? (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            room.disconnect();
            setCode("");
          }}
        >
          Leave room
        </button>
      ) : (
        <button type="button" className="btn-primary" disabled={!canJoin} onClick={submit}>
          {busy ? "Joining…" : "Join"}
        </button>
      )}

      {code.length > 0 && !codeOk ? (
        <p className="hint">Room code is 6 letters/digits.</p>
      ) : null}

      {room.room.error !== null ? (
        <p className="error" role="alert">
          {room.room.error.code}: {room.room.error.message}
        </p>
      ) : null}
    </section>
  );
}
