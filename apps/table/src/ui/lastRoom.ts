/**
 * lastRoom.ts — the browser-refresh memory for auto-rejoin.
 *
 * JoinPanel writes the last successful join here on submit; App reads it on
 * mount and, together with the seatToken stored by wire/adapter.ts, rejoins
 * the same seat WITHOUT the user touching the form. A page refresh then costs
 * nothing: you come back mid-game holding your own hand.
 *
 * KEYS ARE CASE-SENSITIVE: room codes are [A-Za-z0-9]{6} MIXED CASE and are
 * never transformed on the way in or out.
 */
export interface LastRoom {
  url: string;
  roomCode: string;
  name: string;
  /** Null = spectate (JoinPanel's "" sentinel). */
  seat: number | null;
}

const KEY = "catan.lastRoom";

export function writeLastRoom(storage: Storage, room: LastRoom): void {
  storage.setItem(KEY, JSON.stringify(room));
}

export function readLastRoom(storage: Storage): LastRoom | null {
  const raw = storage.getItem(KEY);
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.roomCode !== "string" || o.roomCode === "") return null;
    // Seats are 0..3; anything else (a hand-edited entry) becomes spectate
    // rather than a guaranteed server badSeat (review minor).
    const rawSeat = typeof o.seat === "number" && Number.isInteger(o.seat) ? o.seat : null;
    const seat = rawSeat !== null && rawSeat >= 0 && rawSeat <= 3 ? rawSeat : null;
    return {
      url: typeof o.url === "string" ? o.url : "",
      roomCode: o.roomCode, // verbatim — never toUpperCase'd
      name: typeof o.name === "string" ? o.name : "",
      seat,
    };
  } catch {
    return null; // corrupt entry: forget it rather than throw on mount
  }
}

export function clearLastRoom(storage: Storage): void {
  storage.removeItem(KEY);
}
