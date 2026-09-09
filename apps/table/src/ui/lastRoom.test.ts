/**
 * lastRoom.test.ts — the auto-rejoin memory. Room codes are mixed-case and
 * must survive the round-trip byte-identical (the P1 screenshot bug), and a
 * corrupt entry must degrade to null — never a throw on mount.
 */
import { describe, expect, it } from "vitest";
import { clearLastRoom, readLastRoom, writeLastRoom, type LastRoom } from "./lastRoom.js";

/** Minimal in-memory Storage — node env has none. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const MIXED: LastRoom = { url: "ws://h:4273", roomCode: "AH4hgi", name: "Clicker", seat: 2 };

describe("lastRoom", () => {
  it("round-trips a mixed-case room code byte-identical", () => {
    const st = fakeStorage();
    writeLastRoom(st, MIXED);
    expect(readLastRoom(st)).toEqual(MIXED); // "AH4hgi" — never uppercased
  });

  it("spectate sentinel (seat null) survives; garbage seat → null", () => {
    const st = fakeStorage();
    writeLastRoom(st, { ...MIXED, seat: null });
    expect(readLastRoom(st)!.seat).toBeNull();
    st.setItem("catan.lastRoom", JSON.stringify({ roomCode: "ABC123", seat: "2" }));
    expect(readLastRoom(st)!.seat).toBeNull(); // string "2" is not a seat
  });

  it("empty / corrupt / missing entries return null, never throw", () => {
    const st = fakeStorage();
    expect(readLastRoom(st)).toBeNull();
    st.setItem("catan.lastRoom", "{not json");
    expect(readLastRoom(st)).toBeNull();
    st.setItem("catan.lastRoom", JSON.stringify({ seat: 1 })); // no roomCode
    expect(readLastRoom(st)).toBeNull();
    clearLastRoom(st);
    expect(readLastRoom(st)).toBeNull();
  });
});
