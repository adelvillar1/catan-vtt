/**
 * protocol.test.ts — M2 wire contract tests.
 *
 * Ground truth is protocol.ts (frozen at M2 phase 1b); this suite only
 * asserts what it says, in two shapes:
 *   1. round-trips: one representative of EVERY message variant survives
 *      JSON.stringify → JSON.parse → schema.parse unchanged;
 *   2. rejection matrix: every way a client or a regression could violate
 *      the contract (unknown type, extra key, bad roomCode, bad op, bad
 *      enum, non-strict state) throws.
 *
 * Also pinned: the OpSchema identity wiring (protocol embeds the kernel's
 * OpSchema, it does not restate it) and the wire-scrub compatibility probe
 * (a scrubbed variableSetup state still parses as GameStateSchema).
 */
import { describe, expect, it } from "vitest";
import {
  ClientMsgSchema,
  ErrorMsgSchema,
  EventMsgSchema,
  JoinMsgSchema,
  OpMsgSchema,
  PingMsgSchema,
  PongMsgSchema,
  ProjectionMsgSchema,
  PROTOCOL_VERSION,
  RematchMsgSchema,
  ServerMsgSchema,
  WelcomeMsgSchema,
} from "./protocol.js";
import { OpSchema } from "./actions.js";
import { GameStateSchema } from "./state.js";
import { variableSetup } from "./setup.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every client→server variant, one representative each. */
const CLIENT_MSGS = [
  { type: "join", roomCode: "ABC123" },
  { type: "join", roomCode: "abc123", seat: 2 },
  { type: "join", roomCode: "zx9wv8", seat: 0, seatToken: "tok_abc" },
  { type: "op", op: { type: "roll", seat: 0 } },
  { type: "op", op: { type: "buildRoad", seat: 1, edgeId: "e1" } },
  {
    type: "op",
    op: { type: "tradeOffer", seat: 0, with: 2, give: ["wood"], want: ["ore"] },
  },
  { type: "ping", t: 1700000000000 },
  { type: "rematch" }, // M3-P3(b): host-only, no payload, no seed
] as const;

const PUBLIC_PLAYER = {
  seat: 0,
  name: "Player 1",
  color: "Red",
  connected: true,
} as const;

/** A minimal but schema-legal game state (see scrubProbe below for setup). */
function scrubbedState() {
  return {
    ...variableSetup(7, { playerCount: 3 }),
    rngSeed: 0,
    rngCursor: 0,
  };
}

/** Every server→client variant, one representative each. */
const SERVER_MSGS = [
  {
    type: "welcome",
    roomCode: "ABC123",
    seat: 0,
    seatToken: "tok_abc",
    players: [PUBLIC_PLAYER],
    phase: "setup",
  },
  {
    type: "welcome",
    roomCode: "ABC123",
    seat: null,
    players: [] as unknown[],
    phase: "play",
  },
  {
    type: "projection",
    state: scrubbedState(),
    legalMoves: [{ type: "roll", seat: 0 }],
    serverSeq: 0,
  },
  {
    type: "event",
    kind: "opApplied",
    details: { seat: 0, opType: "roll" },
    serverSeq: 4,
  },
  {
    type: "event",
    kind: "rejected",
    details: { seat: 1, opType: "buildRoad", code: "notYourTurn" },
    serverSeq: 5,
  },
  {
    type: "event",
    kind: "playerJoined",
    details: { seat: 2, name: "Player 3" },
    serverSeq: 6,
  },
  { type: "event", kind: "chat", details: { seat: null, text: "gg" }, serverSeq: 7 },
  {
    type: "event",
    kind: "gameEnded",
    details: { winner: 1, finalPoints: 10 },
    serverSeq: 8,
  },
  { type: "error", code: "inSeatTaken", message: "seat 0 is taken" },
  { type: "error", code: "notSeated", message: "spectators cannot act" },
  { type: "error", code: "notHost", message: "only the host can start a rematch" },
  { type: "error", code: "badPhase", message: "the game has not ended" },
  { type: "pong", t: 1700000000000 },
] as const;

// ---------------------------------------------------------------------------
// 1. Round-trips
// ---------------------------------------------------------------------------

describe("wire round-trips", () => {
  it("round-trips every ClientMsg variant through JSON", () => {
    for (const msg of CLIENT_MSGS) {
      const raw = JSON.parse(JSON.stringify(msg));
      expect(ClientMsgSchema.parse(raw)).toEqual(msg);
      expect(raw).toEqual(msg);
    }
  });

  it("round-trips every ServerMsg variant through JSON", () => {
    for (const msg of SERVER_MSGS) {
      const raw = JSON.parse(JSON.stringify(msg));
      expect(ServerMsgSchema.parse(raw)).toEqual(msg);
      expect(raw).toEqual(msg);
    }
  });

  it("round-trips a projection whose state is a scrubbed setup", () => {
    const msg = {
      type: "projection",
      state: scrubbedState(),
      legalMoves: [] as unknown[],
      serverSeq: 12,
    };
    const back = ProjectionMsgSchema.parse(JSON.parse(JSON.stringify(msg)));
    expect(back).toEqual(msg);
    expect(back.state.rngSeed).toBe(0);
    expect(back.state.rngCursor).toBe(0);
    expect(back.serverSeq).toBe(12);
  });

  it("keeps PROTOCOL_VERSION pinned at 1", () => {
    expect(PROTOCOL_VERSION).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 2. Rejection matrix
// ---------------------------------------------------------------------------

describe("rejection matrix", () => {
  it("rejects an unknown message type in both directions", () => {
    expect(ClientMsgSchema.safeParse({ type: "hello" }).success).toBe(false);
    expect(ClientMsgSchema.safeParse({ type: "pong", t: 1 }).success).toBe(false);
    expect(ServerMsgSchema.safeParse({ type: "state" }).success).toBe(false);
    expect(ServerMsgSchema.safeParse({ type: "welcome" }).success).toBe(false);
  });

  it("rejects an EXTRA top-level key (every message is .strict())", () => {
    expect(
      JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC123", hax: 1 }).success,
    ).toBe(false);
    expect(
      OpMsgSchema.safeParse({ type: "op", op: { type: "roll", seat: 0 }, hax: 1 })
        .success,
    ).toBe(false);
    expect(PingMsgSchema.safeParse({ type: "ping", t: 1, hax: 1 }).success).toBe(
      false,
    );
    expect(
      PongMsgSchema.safeParse({ type: "pong", t: 1, hax: 1 }).success,
    ).toBe(false);
    expect(
      ErrorMsgSchema.safeParse({
        type: "error",
        code: "roomFull",
        message: "x",
        retryIn: 5,
      }).success,
    ).toBe(false);
    expect(
      EventMsgSchema.safeParse({
        type: "event",
        kind: "chat",
        details: {},
        serverSeq: 1,
        ts: 1,
      }).success,
    ).toBe(false);
    expect(
      WelcomeMsgSchema.safeParse({
        type: "welcome",
        roomCode: "ABC123",
        seat: 0,
        players: [],
        phase: "setup",
        isHost: true,
      }).success,
    ).toBe(false);
    expect(
      ProjectionMsgSchema.safeParse({
        type: "projection",
        state: scrubbedState(),
        legalMoves: [],
        serverSeq: 1,
        version: PROTOCOL_VERSION,
      }).success,
    ).toBe(false);
  });

  it("accepts a 6-char roomCode and rejects 5 and 7", () => {
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC12" }).success).toBe(
      false,
    );
    expect(
      JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC1234" }).success,
    ).toBe(false);
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC123" }).success).toBe(
      true,
    );
    // RoomCodeSchema: 6 alphanumerics (mixed case OK); punctuation rejected —
    // codes are typed/read by friends (parent tightening post-v1 draft).
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: "aB3-_." }).success).toBe(
      false,
    );
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: "aB3x9_" }).success).toBe(
      false,
    );
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: "aB3x9Z" }).success).toBe(
      true,
    );
    expect(JoinMsgSchema.safeParse({ type: "join", roomCode: 123456 }).success).toBe(
      false,
    );
  });

  it("rejects ping.t as a string (t is a number, not an epoch label)", () => {
    expect(PingMsgSchema.safeParse({ type: "ping", t: "1" }).success).toBe(false);
    expect(PingMsgSchema.safeParse({ type: "ping", t: "now" }).success).toBe(false);
    expect(PingMsgSchema.safeParse({ type: "ping" }).success).toBe(false);
    expect(PingMsgSchema.safeParse({ type: "ping", t: 0 }).success).toBe(true);
    expect(PongMsgSchema.safeParse({ type: "pong", t: "1" }).success).toBe(false);
  });

  it("rejects welcome without players", () => {
    expect(
      WelcomeMsgSchema.safeParse({
        type: "welcome",
        roomCode: "ABC123",
        seat: 0,
        phase: "setup",
      }).success,
    ).toBe(false);
    // and a player entry missing fields
    expect(
      WelcomeMsgSchema.safeParse({
        type: "welcome",
        roomCode: "ABC123",
        seat: 0,
        players: [{ seat: 0, name: "P1" }],
        phase: "setup",
      }).success,
    ).toBe(false);
  });

  it("rejects an op outside the 20-op union in legalMoves and in an op msg", () => {
    const bogus = { type: "stealSomething", seat: 0 };
    expect(
      ProjectionMsgSchema.safeParse({
        type: "projection",
        state: scrubbedState(),
        legalMoves: [bogus],
        serverSeq: 0,
      }).success,
    ).toBe(false);
    expect(OpMsgSchema.safeParse({ type: "op", op: bogus }).success).toBe(false);
    expect(ClientMsgSchema.safeParse({ type: "op", op: bogus }).success).toBe(false);
  });

  it("rejects an event kind outside the enum", () => {
    expect(
      EventMsgSchema.safeParse({
        type: "event",
        kind: "turnStarted",
        details: {},
        serverSeq: 1,
      }).success,
    ).toBe(false);
    // op-level failures ride event.kind="rejected", NOT a wire error code
    expect(
      EventMsgSchema.safeParse({
        type: "event",
        kind: "notYourTurn",
        details: {},
        serverSeq: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an error code outside the enum", () => {
    for (const code of ["notYourTurn", "badSeat", "unknown", ""]) {
      expect(
        ErrorMsgSchema.safeParse({ type: "error", code, message: "x" }).success,
      ).toBe(false);
    }
    for (const code of [
      "inSeatTaken",
      "roomFull",
      "roomNotFound",
      "badMessage",
      "notSeated",
      "badToken",
      // M3-P3(b): the two rematch refusal codes.
      "notHost",
      "badPhase",
    ]) {
      expect(
        ErrorMsgSchema.safeParse({ type: "error", code, message: "x" }).success,
      ).toBe(true);
    }
  });

  it("rematch carries NO seed (the server derives game 2's own)", () => {
    // AC6, structural: the frame is a bare discriminator. A seed key is not
    // merely ignored — .strict() rejects it, so a client cannot even SEND one.
    expect(RematchMsgSchema.parse({ type: "rematch" })).toEqual({ type: "rematch" });
    expect(ClientMsgSchema.parse({ type: "rematch" })).toEqual({ type: "rematch" });
    expect(RematchMsgSchema.safeParse({ type: "rematch", seed: 1 }).success).toBe(false);
    expect(ClientMsgSchema.safeParse({ type: "rematch", seed: 1 }).success).toBe(false);
    expect(ClientMsgSchema.safeParse({ type: "rematch", seat: 0 }).success).toBe(false);
    // Not a server message — clients never receive one.
    expect(ServerMsgSchema.safeParse({ type: "rematch" }).success).toBe(false);
  });

  it("rejects a projection state carrying a bogus field (strict GameState)", () => {
    const state = { ...scrubbedState(), godMode: true };
    expect(
      ProjectionMsgSchema.safeParse({
        type: "projection",
        state,
        legalMoves: [],
        serverSeq: 0,
      }).success,
    ).toBe(false);
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Seat / spectator joins
// ---------------------------------------------------------------------------

describe("join semantics", () => {
  it("treats a join without a seat as a spectator join (valid)", () => {
    const msg = JoinMsgSchema.parse({ type: "join", roomCode: "ABC123" });
    expect(msg.seat).toBeUndefined();
    expect(msg.seatToken).toBeUndefined();
    expect(ClientMsgSchema.parse(msg)).toEqual(msg);
  });

  it("accepts a join carrying a seatToken (rejoin credential)", () => {
    const msg = JoinMsgSchema.parse({
      type: "join",
      roomCode: "ABC123",
      seat: 0,
      seatToken: "tok_abc",
    });
    expect(msg).toEqual({
      type: "join",
      roomCode: "ABC123",
      seat: 0,
      seatToken: "tok_abc",
    });
  });

  it("rejects a seat outside 0..3", () => {
    expect(
      JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC123", seat: 4 }).success,
    ).toBe(false);
    expect(
      JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC123", seat: -1 }).success,
    ).toBe(false);
    expect(
      JoinMsgSchema.safeParse({ type: "join", roomCode: "ABC123", seat: 1.5 }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. OpSchema identity wiring
// ---------------------------------------------------------------------------

describe("OpSchema delegation", () => {
  it("OpMsgSchema embeds the kernel OpSchema (same instance, not a restatement)", () => {
    expect(OpMsgSchema.shape.op).toBe(OpSchema);
  });

  it("accepts a legal op and rejects via the embedded schema's strictness", () => {
    expect(
      OpMsgSchema.safeParse({ type: "op", op: { type: "roll", seat: 0 } }).success,
    ).toBe(true);
    // The extra key is on the OP, not the envelope: the rejection comes from
    // OpSchema itself, proving delegation rather than a duplicated shape.
    const res = OpMsgSchema.safeParse({
      type: "op",
      op: { type: "roll", seat: 0, hax: 1 },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "op")).toBe(true);
    }
    // Same op rejected by OpSchema directly — the two agree.
    expect(OpSchema.safeParse({ type: "roll", seat: 0, hax: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. GameState wire-scrub compatibility probe
// ---------------------------------------------------------------------------

describe("wire scrub compatibility", () => {
  it("a scrubbed variableSetup state parses as GameStateSchema", () => {
    // This is the exact shape apps/room ships in a projection:
    // redactForSeat (rngSeed → 0) + wireScrub (rngCursor → 0).
    const scrubbed = scrubbedState();
    const parsed = GameStateSchema.parse(scrubbed);
    expect(parsed.rngSeed).toBe(0);
    expect(parsed.rngCursor).toBe(0);
    // Scrubbing changes nothing else about the state.
    const { rngSeed: _s, rngCursor: _c, ...rest } = parsed;
    expect(rest).toEqual(
      (({ rngSeed: _a, rngCursor: _b, ...r }) => r)(variableSetup(7, { playerCount: 3 })),
    );
  });

  it("the un-scrubbed setup state also parses (scrub is transport, not kernel)", () => {
    const state = variableSetup(7, { playerCount: 3 });
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    // Documenting the leak this scrub exists to close: the true seed is
    // non-zero and would otherwise cross the wire.
    expect(state.rngSeed).not.toBe(0);
  });
});
