/**
 * adapter.test.ts — wire discipline, mirroring apps/room/src/cli.ts.
 *
 * Covers: frame routing for every ServerMsg variant, the parse-or-die path
 * (garbage frames are fatal, never silently ignored), outbound message
 * shapes (both must survive ClientMsgSchema), and seatToken rotation.
 *
 * Node env — no WebSocket, no DOM (Storage is faked with a tiny stub).
 */
import { describe, expect, it } from "vitest";
import {
  ClientMsgSchema,
  ServerMsgSchema,
  variableSetup,
  type GameState,
  type Op,
} from "@catan-vtt/shared";
import {
  EVENT_RING_SIZE,
  buildJoinMessage,
  buildOpMessage,
  clearSeatToken,
  encodeClientMessage,
  initialRoomState,
  readSeatToken,
  routeFrame,
  routeRawFrame,
  storeSeatToken,
  type RoomState,
} from "./adapter.js";

/** A real (kernel-produced) state so projection frames are realistic. */
const state: GameState = variableSetup(20260908, { playerCount: 3 });

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

const welcomeFrame = {
  type: "welcome",
  roomCode: "ABC123",
  seat: 0,
  seatToken: "tok-1",
  players: [{ seat: 0, name: "ada", color: "Red", connected: true }],
  phase: "setup",
} as const;

describe("routeFrame — server frame routing", () => {
  it("welcome sets seat/token/players and moves to playing", () => {
    const s0: RoomState = { ...initialRoomState(), status: "joining" };
    const s1 = routeFrame(s0, ServerMsgSchema.parse(welcomeFrame));
    expect(s1.status).toBe("playing");
    expect(s1.welcome).toEqual({
      roomCode: "ABC123",
      seat: 0,
      seatToken: "tok-1",
      players: welcomeFrame.players,
      phase: "setup",
    });
    expect(s1.error).toBeNull();
  });

  it("welcome without seatToken (spectator) leaves it undefined", () => {
    const msg = ServerMsgSchema.parse({ ...welcomeFrame, seat: null, seatToken: undefined });
    const s1 = routeFrame(initialRoomState(), msg);
    expect(s1.welcome?.seat).toBeNull();
    expect(s1.welcome?.seatToken).toBeUndefined();
  });

  it("projection stores state, legalMoves and serverSeq", () => {
    const moves = [{ type: "roll", seat: 0 }] as const;
    const msg = ServerMsgSchema.parse({
      type: "projection",
      state,
      legalMoves: [...moves],
      serverSeq: 42,
    });
    const s1 = routeFrame(initialRoomState(), msg);
    expect(s1.projection).toEqual(state);
    expect(s1.legalMoves).toEqual([...moves]);
    expect(s1.serverSeq).toBe(42);
  });

  it("projection promotes connecting/joining to playing", () => {
    const msg = ServerMsgSchema.parse({
      type: "projection",
      state,
      legalMoves: [],
      serverSeq: 1,
    });
    expect(routeFrame({ ...initialRoomState(), status: "joining" }, msg).status).toBe("playing");
    expect(routeFrame({ ...initialRoomState(), status: "connecting" }, msg).status).toBe("playing");
  });

  it("error routes to status error with the wire code", () => {
    const msg = ServerMsgSchema.parse({
      type: "error",
      code: "inSeatTaken",
      message: "seat 0 is taken",
    });
    const s1 = routeFrame(initialRoomState(), msg);
    expect(s1.status).toBe("error");
    expect(s1.error).toEqual({ code: "inSeatTaken", message: "seat 0 is taken" });
  });

  it("a transient refusal note is cleared by the next projection; a real connection error is not (P3b review I-1)", () => {
    const proj = ServerMsgSchema.parse({
      type: "projection",
      state,
      legalMoves: [],
      serverSeq: 7,
    });
    const live: RoomState = { ...initialRoomState(), status: "playing", serverSeq: 6 };
    const mk = (code: string) =>
      routeFrame(live, ServerMsgSchema.parse({ type: "error", code, message: "x" }));
    // notHost / badPhase are ONE-REQUEST answers: the table keeps running
    // (status stays "playing"), so a refusal note must not outlive the next
    // frame — the double-click rematch race otherwise displays a false
    // failure for an entire game (adapter.ts projection case).
    for (const code of ["notHost", "badPhase"]) {
      const refused = mk(code);
      expect(refused.status).toBe("playing");
      expect(refused.error?.code).toBe(code); // note IS set — just not sticky
      const after = routeFrame(refused, proj);
      expect(after.error).toBeNull();
      expect(after.serverSeq).toBe(7); // the projection itself applied normally
    }
    // A real connection error is NOT transient: only welcome/connect clears it.
    const dead = mk("badToken");
    expect(dead.status).toBe("error"); // review I-2: non-transient still forces error status
    expect(routeFrame(dead, proj).error?.code).toBe("badToken");
    // And with no error set, a projection is a no-op for the field.
    expect(routeFrame(routeFrame(initialRoomState(), proj), proj).error).toBeNull();
  });

  it("pong records t", () => {
    const s1 = routeFrame(initialRoomState(), ServerMsgSchema.parse({ type: "pong", t: 99 }));
    expect(s1.lastPong).toBe(99);
  });

  it("event records lastEvent, appends to the ring, and bumps serverSeq", () => {
    let s = initialRoomState();
    for (let i = 1; i <= 3; i++) {
      s = routeFrame(
        s,
        ServerMsgSchema.parse({
          type: "event",
          kind: "opApplied",
          details: { seat: 0, opType: "roll" },
          serverSeq: i,
        }),
      );
    }
    expect(s.events).toHaveLength(3);
    expect(s.lastEvent?.kind).toBe("opApplied");
    expect(s.lastEvent?.serverSeq).toBe(3);
    expect(s.serverSeq).toBe(3);
  });

  it(`event ring caps at ${EVENT_RING_SIZE} (newest last)`, () => {
    let s = initialRoomState();
    for (let i = 1; i <= EVENT_RING_SIZE + 5; i++) {
      s = routeFrame(
        s,
        ServerMsgSchema.parse({ type: "event", kind: "chat", details: {}, serverSeq: i }),
      );
    }
    expect(s.events).toHaveLength(EVENT_RING_SIZE);
    expect(s.events[0]?.serverSeq).toBe(6);
    expect(s.events.at(-1)?.serverSeq).toBe(EVENT_RING_SIZE + 5);
  });

  it("does not mutate the previous state (React identity)", () => {
    const s0 = initialRoomState();
    const s1 = routeFrame(s0, ServerMsgSchema.parse(welcomeFrame));
    expect(s1).not.toBe(s0);
    expect(s0.welcome).toBeNull();
  });

  it("welcome CLEARS a stale projection/legalMoves/serverSeq (review I-2 root-cause)", () => {
    // Cross-room / reconnect scenario: the adapter still holds room A's
    // projection when welcome for room B lands. If it survived, the table
    // would paint room A's game (winner banner included) until B's first
    // projection frame — seconds of a confidently wrong UI.
    const s0 = initialRoomState();
    const sA = routeFrame(s0, ServerMsgSchema.parse(welcomeFrame));
    const sPlayed = routeFrame(sA, ServerMsgSchema.parse({
      type: "projection",
      state,
      legalMoves: [],
      serverSeq: 7,
    }));
    expect(sPlayed.projection).not.toBeNull();
    expect(sPlayed.serverSeq).toBe(7);
    const sB = routeFrame(sPlayed, ServerMsgSchema.parse({ ...welcomeFrame, roomCode: "zzZZzz" }));
    expect(sB.projection).toBeNull();
    expect(sB.legalMoves).toEqual([]);
    expect(sB.serverSeq).toBe(0);
    expect(sB.events).toEqual([]);
    expect(sB.status).toBe("playing"); // status DOES advance
  });
});

describe("routeRawFrame — parse or die (cli.ts discipline)", () => {
  it("accepts a valid JSON frame", () => {
    const s1 = routeRawFrame(initialRoomState(), JSON.stringify(welcomeFrame));
    expect(s1.welcome?.seat).toBe(0);
    expect(s1.fatal).toBe(false);
  });

  it("treats non-JSON as a fatal badFrame", () => {
    const s1 = routeRawFrame(initialRoomState(), "not json at all");
    expect(s1.fatal).toBe(true);
    expect(s1.status).toBe("error");
    expect(s1.error?.code).toBe("badFrame");
  });

  it("treats a schema violation as fatal (unknown message type)", () => {
    const s1 = routeRawFrame(initialRoomState(), JSON.stringify({ type: "hacked" }));
    expect(s1.fatal).toBe(true);
    expect(s1.error?.message).toContain("violates ServerMsgSchema");
  });

  it("treats a missing discriminator as fatal", () => {
    const s1 = routeRawFrame(initialRoomState(), JSON.stringify({ seat: 0 }));
    expect(s1.fatal).toBe(true);
  });

  it("rejects strict-schema violations (extra key on welcome)", () => {
    const s1 = routeRawFrame(
      initialRoomState(),
      JSON.stringify({ ...welcomeFrame, extraKey: 1 }),
    );
    expect(s1.fatal).toBe(true);
  });

  it("cross-check: ServerMsgSchema itself rejects garbage", () => {
    for (const bad of [null, 42, "nope", [], { type: "welcome" }]) {
      expect(ServerMsgSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("outbound message shapes", () => {
  it("join with seat + name round-trips ClientMsgSchema", () => {
    const msg = buildJoinMessage({ roomCode: "ABC123", seat: 2, name: "ada" });
    expect(msg).toEqual({ type: "join", roomCode: "ABC123", seat: 2, name: "ada" });
    expect(ClientMsgSchema.safeParse(JSON.parse(encodeClientMessage(msg))).success).toBe(true);
  });

  it("join without seat (spectator / next free seat) omits the key", () => {
    const msg = buildJoinMessage({ roomCode: "ABC123" });
    expect(msg).toEqual({ type: "join", roomCode: "ABC123" });
    expect("seat" in msg).toBe(false);
  });

  it("join carries the stored seatToken on rejoin", () => {
    const msg = buildJoinMessage({ roomCode: "ABC123", seat: 1, seatToken: "tok-9" });
    expect(msg).toEqual({ type: "join", roomCode: "ABC123", seat: 1, seatToken: "tok-9" });
  });

  it("rejects a malformed room code (6 alphanumerics)", () => {
    expect(() => buildJoinMessage({ roomCode: "ab" })).toThrow(/illegal join frame/);
  });

  it("op envelope is exactly { type: 'op', op }", () => {
    const op = { type: "buildRoad", seat: 0, edgeId: "e:v:1,1|v:2,1" } as const;
    const msg = buildOpMessage(op);
    expect(msg).toEqual({ type: "op", op });
    const reparsed = ClientMsgSchema.safeParse(JSON.parse(encodeClientMessage(msg)));
    expect(reparsed.success).toBe(true);
  });

  it("rejects an op the kernel schema would refuse", () => {
    // @ts-expect-error deliberately malformed op to exercise the guard
    expect(() => buildOpMessage({ type: "buildRoad" })).toThrow(/illegal op frame/);
  });

  it("every op type survives encode → ClientMsgSchema (server would accept)", () => {
    const ops: Op[] = [
      { type: "roll", seat: 0 },
      { type: "endTurn", seat: 0 },
      { type: "buildSettlement", seat: 1, vertexId: "v:0,0" },
      { type: "buildCity", seat: 1, vertexId: "v:0,0" },
      { type: "buildRoad", seat: 1, edgeId: "e:a|b" },
      { type: "buyDevCard", seat: 2 },
      { type: "playKnight", seat: 2 },
      { type: "claimVictory", seat: 0 },
      { type: "moveRobber", seat: 0, hexId: "0,2" },
      { type: "stealCard", seat: 0, victimSeat: 1 },
      { type: "discardSeven", seat: 0, cards: ["wood", "wood"] },
      { type: "tradeBank", seat: 0, offer: "wood", demand: "ore" },
      { type: "tradePort", seat: 0, portVertexId: "v:0,0", offer: "wood", demand: "ore" },
      { type: "tradeOffer", seat: 0, with: 1, give: ["wood"], want: ["ore"] },
      { type: "tradeAccept", seat: 1 },
      { type: "tradeReject", seat: 1 },
      { type: "playMonopoly", seat: 0, resource: "ore" },
      { type: "playRoadBuilding", seat: 0, edgeIds: ["e:a|b"] },
      { type: "playYearOfPlenty", seat: 0, cards: ["wood", "ore"] },
      { type: "placeSetupPiece", seat: 0, kind: "settlement", vertexId: "v:0,0" },
    ] as const;
    for (const op of ops) {
      const json = encodeClientMessage(buildOpMessage(op));
      expect(ClientMsgSchema.safeParse(JSON.parse(json)).success, op.type).toBe(true);
    }
  });
});

describe("seatToken persistence (rotation-aware)", () => {
  it("stores, reads, clears per room code", () => {
    const s = memStorage();
    storeSeatToken(s, "ABC123", "tok-1");
    expect(readSeatToken(s, "ABC123")).toBe("tok-1");
    expect(readSeatToken(s, "XYZ999")).toBeNull();
    clearSeatToken(s, "ABC123");
    expect(readSeatToken(s, "ABC123")).toBeNull();
  });

  it("a rejoin overwrites the old token (server rotates on every welcome)", () => {
    const s = memStorage();
    storeSeatToken(s, "ABC123", "tok-old");
    storeSeatToken(s, "ABC123", "tok-new");
    expect(readSeatToken(s, "ABC123")).toBe("tok-new");
  });

  it("the rejoin frame actually ships the newest stored token", () => {
    const s = memStorage();
    storeSeatToken(s, "ABC123", "tok-old");
    storeSeatToken(s, "ABC123", "tok-new");
    const token = readSeatToken(s, "ABC123");
    const msg = buildJoinMessage({
      roomCode: "ABC123",
      seat: 0,
      ...(token === null ? {} : { seatToken: token }),
    });
    expect(msg).toMatchObject({ type: "join", seatToken: "tok-new" });
  });
});
