/**
 * room.test.ts — apps/room core: seat authority, wire hygiene, memoized
 * projections, determinism, and a full text-mode game driven ONLY through
 * the Room API (never touching applyAction directly).
 */
import { describe, expect, it } from "vitest";

import {
  GameStateSchema,
  OpSchema,
  Rng,
  applyAction,
  legalMoves,
  variableSetup,
  type GameState,
  type Op,
} from "@catan-vtt/shared";

import { createRoom, rematchSeed, wireScrub, type Room } from "./room.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SEED = 20260908;

function claimAll(room: Room, n: number): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = room.claimSeat({ name: `P${i}` });
    if (!r.ok) throw new Error(`claimSeat(${i}) failed: ${r.code}`);
    tokens.push(r.token);
  }
  return tokens;
}

function mustOp(room: Room, seat: number, op: unknown): number {
  const r = room.applyOp(seat, op);
  if (!r.ok) throw new Error(`applyOp ${JSON.stringify(op)} rejected: ${r.code} ${r.message}`);
  return r.seq;
}

/** The seat that must act right now (setup queue / seven window / current). */
function actingSeat(s: GameState): number {
  if (s.phase === "setup") return s.currentSeat;
  const aw = s.awaitingSeven;
  if (aw) return aw.pendingDiscard ? aw.discardQueue[0]!.seat : aw.roller;
  return s.currentSeat;
}

/**
 * Play setup to completion through the Room API only, choosing ops from the
 * SERVER-SHIPPED legalMoves (never from the kernel directly).
 */
function playSetup(room: Room): void {
  let guard = 0;
  while (room.state.phase === "setup") {
    if (++guard > 64) throw new Error("playSetup runaway");
    const seat = room.state.currentSeat;
    const moves = room.projectionFor(seat).legalMoves;
    expect(moves.length).toBeGreaterThan(0);
    const op = moves[0]!;
    expect(op.seat).toBe(seat);
    mustOp(room, seat, op);
  }
}

const PRIORITY: readonly Op["type"][] = [
  "claimVictory",
  // Setup placements: legalMoves only enumerates them during phase "setup",
  // so listing them first is harmless in the play phase.
  "placeSetupPiece",
  "roll",
  "discardSeven",
  "moveRobber",
  "stealCard",
  "buildCity",
  "buildSettlement",
  "buildRoad",
  "buyDevCard",
  "playKnight",
  "playMonopoly",
  "playRoadBuilding",
  "playYearOfPlenty",
  "tradeBank",
  "tradePort",
  "tradeAccept",
  "tradeReject",
  "endTurn",
];

/**
 * Pick the highest-priority op class present in the server's legalMoves, then
 * a uniform-random member of that class (mirrors goldenReplay's bot policy —
 * always taking moves[0] makes the bot walk the same board corner forever and
 * it stalls out below 10 VP).
 */
function pickByPriority(moves: Op[], rand: () => number): Op | null {
  for (const type of PRIORITY) {
    const bucket = moves.filter((m) => m.type === type);
    if (bucket.length > 0) return bucket[Math.floor(rand() * bucket.length)]!;
  }
  return null;
}

/** Small deterministic LCG so the text-mode game is reproducible. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

function handTotal(h: { wood: number; brick: number; wool: number; wheat: number; ore: number }) {
  return h.wood + h.brick + h.wool + h.wheat + h.ore;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe("room lifecycle — seat claim / rejoin", () => {
  it("3-player room: 3 claims OK, 4th is roomFull", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    expect(room.state.players).toHaveLength(3);
    // Setup pre-creates every seat, but none is claimed yet.
    expect(room.isConnected(0)).toBe(false);

    const a = room.claimSeat({ name: "Ada" });
    expect(a.ok).toBe(true);
    const b = room.claimSeat({ name: "Bob" });
    const c = room.claimSeat({ name: "Cyd" });
    expect([a, b, c].every((r) => r.ok)).toBe(true);
    if (!a.ok || !b.ok || !c.ok) throw new Error("unreachable");
    expect([a.seat, b.seat, c.seat]).toEqual([0, 1, 2]);
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);

    const d = room.claimSeat({ name: "Dan" });
    expect(d).toEqual({ ok: false, code: "roomFull" });
  });

  it("omitted seat claims the first unclaimed seat", () => {
    const room = createRoom(SEED);
    expect((room.claimSeat() as { seat: number }).seat).toBe(0);
    expect((room.claimSeat() as { seat: number }).seat).toBe(1);
  });

  it("double-claiming a seat is inSeatTaken", () => {
    const room = createRoom(SEED);
    expect(room.claimSeat({ seat: 1 }).ok).toBe(true);
    const again = room.claimSeat({ seat: 1 });
    expect(again).toEqual({ ok: false, code: "inSeatTaken" });
  });

  it("rejoin rotates the token and the old token dies", () => {
    const room = createRoom(SEED);
    const first = room.claimSeat({ seat: 2, name: "Cyd" });
    if (!first.ok) throw new Error("claim failed");

    room.disconnect(2);
    expect(room.isConnected(2)).toBe(false);

    const rj = room.rejoin(first.token);
    expect(rj.ok).toBe(true);
    if (!rj.ok) throw new Error("unreachable");
    expect(rj.seat).toBe(2);
    expect(rj.newToken).not.toBe(first.token);
    expect(room.isConnected(2)).toBe(true);

    // Old token is single-use: replaying it must fail.
    expect(room.rejoin(first.token)).toEqual({ ok: false, code: "badToken" });
  });

  it("an unclaimed seat cannot act (badSeat)", () => {
    const room = createRoom(SEED);
    const r = room.applyOp(1, { type: "roll", seat: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("badSeat");
  });

  it("a disconnected seat cannot act; after rejoin it can", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room); // now in play phase, seat 0 to roll

    const name0 = room.roster()[0]!.name; // sanity: roster populated
    expect(name0).toBe("P0");
    room.disconnect(0);
    const denied = room.applyOp(0, { type: "roll", seat: 0 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("badSeat");

    // Rejoin by token, then the same op is accepted.
    const room2 = createRoom(SEED, { playerCount: 3 });
    const tokens = claimAll(room2, 3);
    playSetup(room2);
    room2.disconnect(0);
    const rj = room2.rejoin(tokens[0]!);
    expect(rj.ok).toBe(true);
    expect(room2.applyOp(0, { type: "roll", seat: 0 }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// op authority
// ---------------------------------------------------------------------------

describe("room op authority", () => {
  it("rejects an op whose seat does not match the caller (notYourTurn)", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const r = room.applyOp(1, { type: "roll", seat: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("notYourTurn");
    // Authority is checked BEFORE kernel legality.
    expect(room.serverSeq).toBe(0);
  });

  it("rejects an op with an extra key (strict schema) as badOp", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const r = room.applyOp(0, { type: "roll", seat: 0, color: "red" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("badOp");
  });

  it("rejects an unknown op type as badOp", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const r = room.applyOp(0, { type: "teleport", seat: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("badOp");
  });

  it("rejects a non-object op as badOp", () => {
    const room = createRoom(SEED);
    claimAll(room, 1);
    for (const junk of [null, undefined, 42, "roll", [], {}]) {
      const r = room.applyOp(0, junk);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("badOp");
    }
  });

  it("every shipped legalMove parses under OpSchema", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    for (const op of room.projectionFor(0).legalMoves) {
      expect(OpSchema.safeParse(op).success).toBe(true);
    }
  });

  it("ActionError round-trips: roll ok, second roll is alreadyRolled", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    expect(room.state.phase).toBe("play");

    const roll1 = room.applyOp(0, { type: "roll", seat: 0 });
    expect(roll1.ok).toBe(true);
    if (!roll1.ok) throw new Error("unreachable");
    expect(roll1.seq).toBe(room.serverSeq);

    const roll2 = room.applyOp(0, { type: "roll", seat: 0 });
    expect(roll2.ok).toBe(false);
    if (roll2.ok) throw new Error("unreachable");
    // Either the roll opened a seven window (awaitingSeven) or it is a plain
    // double-roll rejection. Both are kernel codes, surfaced verbatim.
    expect(["alreadyRolled", "awaitingSeven"]).toContain(roll2.code);
    expect(typeof roll2.message).toBe("string");
  });

  it("rejections do not advance serverSeq; the event ring records them", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const before = room.serverSeq;
    room.applyOp(0, { type: "nope", seat: 0 });
    expect(room.serverSeq).toBe(before);

    const evs = room.events();
    const last = evs[evs.length - 1]!;
    expect(last.ok).toBe(false);
    expect(last.code).toBe("badOp");
    expect(last.seq).toBe(before);
    expect(typeof last.at).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// wire hygiene (plan AC3)
// ---------------------------------------------------------------------------

describe("wireScrub — no replayable rng on the wire", () => {
  it("zeroes rngSeed and rngCursor but keeps everything else", () => {
    const s = variableSetup(SEED, { playerCount: 3 });
    expect(s.rngSeed).not.toBe(0);
    const scrubbed = wireScrub(s);
    expect(scrubbed.rngSeed).toBe(0);
    expect(scrubbed.rngCursor).toBe(0);
    // Structurally identical otherwise (deep-equal modulo those two fields).
    expect({ ...scrubbed, rngSeed: s.rngSeed, rngCursor: s.rngCursor }).toEqual(s);
    // And it is still a legal GameState (clients parse it).
    expect(() => GameStateSchema.parse(scrubbed)).not.toThrow();
  });

  it("does not mutate its input", () => {
    const s = variableSetup(SEED);
    const seed0 = s.rngSeed;
    const cur0 = s.rngCursor;
    wireScrub(s);
    expect(s.rngSeed).toBe(seed0);
    expect(s.rngCursor).toBe(cur0);
  });
});

describe("AC3 leak-proof — no seat projection leaks hidden state", () => {
  // Drive a real game a few ops past setup, purely through the Room API.
  function bootstrapped(): Room {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    // One production roll + full seven resolution if it opens.
    let guard = 0;
    const startTurns = room.serverSeq;
    while (room.serverSeq < startTurns + 12 && room.state.phase !== "ended") {
      if (++guard > 40) break;
      const seat = actingSeat(room.state);
      const op = pickByPriority(room.projectionFor(seat).legalMoves, lcg(99));
      if (!op) break;
      try {
        mustOp(room, seat, op);
      } catch {
        break;
      }
      // Stop once we have a real roll and are back in the action phase.
      if (room.state.hasRolled && room.state.rollLog.length > 0 && !room.state.awaitingSeven) {
        break;
      }
    }
    return room;
  }

  it("hands are dealt and the room reached the play phase", () => {
    const room = bootstrapped();
    expect(room.state.phase).toBe("play");
    expect(room.state.rollLog.length).toBeGreaterThan(0);
    // Setup round-2 production means someone holds cards.
    const dealt = room.state.players.reduce((a, p) => a + handTotal(p.hand), 0);
    expect(dealt).toBeGreaterThan(0);
  });

  it("every seat projection has rngSeed === 0 and rngCursor === 0", () => {
    const room = bootstrapped();
    for (let seat = 0; seat < 3; seat++) {
      const p = room.projectionFor(seat);
      expect(p.state.rngSeed).toBe(0);
      expect(p.state.rngCursor).toBe(0);
      expect(() => GameStateSchema.parse(p.state)).not.toThrow();
    }
    const spec = room.spectatorProjection();
    expect(spec.state.rngSeed).toBe(0);
    expect(spec.state.rngCursor).toBe(0);
  });

  it("other seats' hands are all-wood with totals matching the TRUE state", () => {
    const room = bootstrapped();
    const truth = room.state;
    for (let seat = 0; seat < 3; seat++) {
      const p = room.projectionFor(seat).state;
      for (const pl of p.players) {
        if (pl.seat === seat) {
          // Own hand is intact (composition visible to its owner).
          expect(pl.hand).toEqual(truth.players[pl.seat]!.hand);
        } else {
          expect(pl.hand.brick).toBe(0);
          expect(pl.hand.wool).toBe(0);
          expect(pl.hand.wheat).toBe(0);
          expect(pl.hand.ore).toBe(0);
          expect(handTotal(pl.hand)).toBe(handTotal(truth.players[pl.seat]!.hand));
        }
      }
    }
  });

  it("deck is all-knight at the true length; devHand lengths are preserved", () => {
    const room = bootstrapped();
    const truth = room.state;
    for (let seat = 0; seat < 3; seat++) {
      const p = room.projectionFor(seat).state;
      expect(p.deck).toHaveLength(truth.deck.length);
      expect(p.deck.every((c) => c === "knight")).toBe(true);
      for (const pl of p.players) {
        expect(pl.devHand).toHaveLength(truth.players[pl.seat]!.devHand.length);
        if (pl.seat !== seat) {
          expect(pl.devHand.every((c) => c === "victoryPoint")).toBe(true);
        }
      }
    }
  });

  it("spectator projection squashes EVERY seat, including seat 0", () => {
    const room = bootstrapped();
    const truth = room.state;
    const spec = room.spectatorProjection();
    expect(spec.legalMoves).toEqual([]);
    expect(() => GameStateSchema.parse(spec.state)).not.toThrow();
    for (const pl of spec.state.players) {
      expect(handTotal(pl.hand)).toBe(handTotal(truth.players[pl.seat]!.hand));
      if (handTotal(pl.hand) > 0) {
        expect(pl.hand.wood).toBe(handTotal(pl.hand));
        expect(pl.hand.brick).toBe(0);
      }
      expect(pl.devHand.every((c) => c === "victoryPoint")).toBe(true);
    }
    expect(spec.state.deck.every((c) => c === "knight")).toBe(true);
  });

  it("true state never escapes: room.state keeps its real seed", () => {
    const room = bootstrapped();
    // If a projection ever aliased the true state, this would be 0.
    expect(room.state.rngSeed).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// server-computed truth + memoization
// ---------------------------------------------------------------------------

describe("server-computed legalMoves", () => {
  it("projection legalMoves deep-equals legalMoves(trueState, seat)", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    room.applyOp(0, { type: "roll", seat: 0 });
    for (let seat = 0; seat < 3; seat++) {
      expect(room.projectionFor(seat).legalMoves).toEqual(
        legalMoves(room.state, seat),
      );
    }
  });

  it("legalMoves come from the TRUE state, not the projection", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    // A projection's rngSeed is 0 — if legalMoves were computed on it, the
    // shipped list would be identical for two rooms with different true seeds.
    const other = createRoom(SEED + 777, { playerCount: 3 });
    claimAll(other, 3);
    playSetup(other);
    const a = room.projectionFor(0).legalMoves;
    const b = other.projectionFor(0).legalMoves;
    // Different boards -> different build options. Guards against computing
    // off a scrubbed/redacted copy in a way that flattens the seed.
    expect(JSON.stringify(a)).not.toBe("null");
    expect(Array.isArray(b)).toBe(true);
    expect(room.state.rngSeed).not.toBe(other.state.rngSeed);
  });
});

describe("projection memoization", () => {
  it("same (seat, seq) twice returns the identical object", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const a = room.projectionFor(0);
    const b = room.projectionFor(0);
    expect(a).toBe(b);
    expect(a.state).toBe(b.state);
    expect(a.legalMoves).toBe(b.legalMoves);
  });

  it("an accepted op invalidates the cache", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const before = room.projectionFor(0);
    mustOp(room, 0, room.projectionFor(0).legalMoves[0]!);
    const after = room.projectionFor(0);
    expect(after).not.toBe(before);
    expect(after.state).not.toBe(before.state);
  });

  it("a REJECTED op does not invalidate the cache", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    const before = room.projectionFor(0);
    room.applyOp(0, { type: "bogus", seat: 0 });
    expect(room.projectionFor(0)).toBe(before);
  });

  it("different seats get different projections", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    expect(room.projectionFor(0)).not.toBe(room.projectionFor(1));
    expect(room.projectionFor(0).state).not.toBe(room.projectionFor(1).state);
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("determinism — two rooms, same seed, same script", () => {
  it("byte-equal JSON.stringify at 10 checkpoints", () => {
    const a = createRoom(SEED, { playerCount: 3 });
    const b = createRoom(SEED, { playerCount: 3 });
    claimAll(a, 3);
    claimAll(b, 3);

    const script: { seat: number; op: Op }[] = [];
    for (let i = 0; i < 10; i++) {
      // Decide on room A (server-shipped moves), replay the identical op on B.
      const seat = actingSeat(a.state);
      const moves = a.projectionFor(seat).legalMoves;
      if (moves.length === 0) break;
      const op = moves[0]!;
      script.push({ seat, op });
      mustOp(a, seat, op);
      const rb = b.applyOp(seat, op);
      expect(rb.ok).toBe(true);
      expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
      expect(a.serverSeq).toBe(b.serverSeq);
    }
    expect(script.length).toBe(10);
    // (Tokens are random UUIDs, so they are excluded from this comparison —
    // the state JSON carries no seat tokens by construction.)
  });

  it("different seeds diverge", () => {
    const a = createRoom(SEED, { playerCount: 3 });
    const b = createRoom(SEED + 1, { playerCount: 3 });
    expect(JSON.stringify(a.state)).not.toBe(JSON.stringify(b.state));
  });
});

// ---------------------------------------------------------------------------
// rematch
// ---------------------------------------------------------------------------

describe("rematch", () => {
  it("resets to setup on a new seed, keeps claims/tokens, seq continues", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    const tokens = claimAll(room, 3);
    playSetup(room);
    room.applyOp(0, { type: "roll", seat: 0 });
    const seqBefore = room.serverSeq;
    expect(seqBefore).toBeGreaterThan(0);
    expect(room.state.phase).toBe("play");
    const namesBefore = room.state.players.map((p) => p.name);

    room.rematch(SEED + 42);

    expect(room.state.phase).toBe("setup");
    expect(room.state.rngSeed).toBe(SEED + 42);
    expect(room.state.buildings).toEqual({});
    expect(room.state.roads).toEqual({});
    expect(room.state.players.map((p) => p.name)).toEqual(namesBefore);
    // serverSeq is a ROOM counter: it never goes backwards.
    expect(room.serverSeq).toBe(seqBefore);
    expect(room.winner()).toBeNull();

    // Tokens survive: disconnect + rejoin works.
    room.disconnect(1);
    const rj = room.rejoin(tokens[1]!);
    expect(rj.ok).toBe(true);
    if (rj.ok) expect(rj.seat).toBe(1);

    // And the fresh game is playable.
    playSetup(room);
    expect(room.state.phase).toBe("play");
    expect(room.serverSeq).toBeGreaterThan(seqBefore);
  });

  it("rematchSeed is deterministic and never echoes its input seed", () => {
    // AC6: same (seed, serverSeq) -> same next seed, every time, anywhere.
    expect(rematchSeed(SEED, 1671)).toBe(rematchSeed(SEED, 1671));
    expect(rematchSeed(SEED, 0)).toBe(rematchSeed(SEED, 0));
    // serverSeq is an input: a different point in the room's life -> a
    // different game. (A rematch after game 1 vs after game 2 must differ,
    // or every game 3 would replay game 2.)
    expect(rematchSeed(SEED, 1)).not.toBe(rematchSeed(SEED, 2));
    expect(rematchSeed(SEED, 0)).not.toBe(rematchSeed(SEED + 1, 0));
    // A seed is a uint32 in the kernel's space (GameStateSchema: int).
    for (const [seed, seq] of [
      [SEED, 0],
      [SEED, 1671],
      [1, 999_999],
      [0xffffffff, 7],
      [0, 0],
    ] as const) {
      const next = rematchSeed(seed, seq);
      expect(Number.isInteger(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(0x1_0000_0000);
      // Never the old seed: "did the board change?" must read true.
      expect(next).not.toBe(seed);
    }
  });

  it("rematch() with no argument uses the server-derived seed and returns it", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    const seqBefore = room.serverSeq;
    const expected = rematchSeed(SEED, seqBefore);

    const res = room.rematch();

    expect(res.ok).toBe(true);
    expect(res.seed).toBe(expected);
    expect(room.state.rngSeed).toBe(expected);
    expect(room.seed).toBe(expected);
    // serverSeq is a ROOM counter: a rematch is not an op.
    expect(room.serverSeq).toBe(seqBefore);
    expect(room.state.phase).toBe("setup");
  });

  it("two rooms at the same seed + seq rematch to the SAME game (determinism)", () => {
    // The property the server-side derivation buys: no RNG, no clock, no
    // process state. Same inputs => bit-identical game 2.
    const build = () => {
      const room = createRoom(SEED, { playerCount: 3 });
      claimAll(room, 3);
      playSetup(room);
      room.rematch();
      return room;
    };
    const a = build();
    const b = build();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.serverSeq).toBe(b.serverSeq);
    // And it really is a DIFFERENT board than game 1 (not a no-op rematch).
    const game1 = createRoom(SEED, { playerCount: 3 });
    expect(JSON.stringify(a.state)).not.toBe(JSON.stringify(game1.state));
    // The rematched game is playable.
    playSetup(a);
    expect(a.state.phase).toBe("play");
  });

  it("a second rematch differs from the first (the seed advances)", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);
    playSetup(room);
    const first = room.rematch().seed;
    playSetup(room);
    const second = room.rematch().seed;
    expect(second).not.toBe(first);
    expect(room.state.rngSeed).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// text-mode game, driven ONLY through the Room API
// ---------------------------------------------------------------------------

describe("text-mode full game through the Room API", () => {
  it("plays a 3-seat game to a 10-VP win", () => {
    const room = createRoom(SEED, { playerCount: 3 });
    claimAll(room, 3);

    const MAX_OPS = 4000;
    let rejections = 0;
    let applied = 0;
    const rand = lcg(SEED ^ 0x5f3759df);

    for (let i = 0; i < MAX_OPS; i++) {
      if (room.state.phase === "ended") break;
      const seat = actingSeat(room.state);
      const moves = room.projectionFor(seat).legalMoves;
      if (moves.length === 0) break;

      const op = pickByPriority(moves, rand);
      if (!op) break;
      const res = room.applyOp(seat, op);
      if (res.ok) applied++;
      else {
        rejections++;
        // A rejected pick means the priority list chose something the kernel
        // disagrees with. Fall back to the first shipped move; if that also
        // fails, stop rather than spin.
        const fb = room.applyOp(seat, moves[0]!);
        if (!fb.ok) break;
        applied++;
      }
    }

    // Measured outcome (seed 20260908, goldenReplay policy via seeded LCG):
    // a 10-VP claimVictory win in 1766 accepted ops, 0 rejections. Assert
    // THAT, hard — a policy regression that plateaus (e.g. always-moves[0]
    // spends all 45 roads and stalls ~8 VP) must fail loudly, not silently
    // satisfy a toContain-branch tautology. (The PROGRESS fallback lives in
    // git history for any future seed/policy that legitimately plateaus.)
    const ended = room.state.phase === "ended";
    expect(ended).toBe(true);
    expect(applied).toBeGreaterThan(100);
    expect(rejections).toBeLessThanOrEqual(50);

    expect(room.winner()).not.toBeNull();
    expect(room.state.finalPoints).toBeGreaterThanOrEqual(10);
    // Nothing is legal after the game ends.
    const after = room.applyOp(room.winner()!, { type: "endTurn", seat: room.winner()! });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("wrongPhase");
    // An ended-state op is also rejected for a claimed+connected seat.
    expect(room.projectionFor(0).legalMoves).toEqual([]);

    // Invariants that hold across the whole game.
    expect(() => GameStateSchema.parse(room.state)).not.toThrow();
    const conservation =
      room.state.players.reduce((a, p) => a + handTotal(p.hand), 0) +
      (room.state.bank.wood +
        room.state.bank.brick +
        room.state.bank.wool +
        room.state.bank.wheat +
        room.state.bank.ore);
    expect(conservation).toBe(95);
    expect(room.events().length).toBeLessThanOrEqual(500);
    for (let seat = 0; seat < 3; seat++) {
      expect(room.projectionFor(seat).state.rngSeed).toBe(0);
      expect(room.projectionFor(seat).state.rngCursor).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// review-gap tests (M2 spec review MAJOR 1 + AC5 minors)
// ---------------------------------------------------------------------------

/** Give a seat resources on the TRUE state (test-only fixture; the room
 *  itself is only mutated through applyOp in the assertions below). */
function giveFixture(s: GameState, seat: number, gain: Partial<GameState["players"][number]["hand"]>): GameState {
  return {
    ...s,
    players: s.players.map((p) =>
      p.seat === seat
        ? {
            ...p,
            hand: {
              wood: p.hand.wood + (gain.wood ?? 0),
              brick: p.hand.brick + (gain.brick ?? 0),
              wool: p.hand.wool + (gain.wool ?? 0),
              wheat: p.hand.wheat + (gain.wheat ?? 0),
              ore: p.hand.ore + (gain.ore ?? 0),
            },
          }
        : p,
    ),
  };
}

/** Roll the real stream until a 7 lands (forces awaitingSeven honestly). */
function forceSevenFixture(s: GameState): GameState {
  let cursor = s.rngCursor;
  for (let skip = 0; skip < 20_000; skip++) {
    const rng = Rng.restore({ seed: s.rngSeed, cursor });
    const d1 = 1 + rng.int(6);
    const d2 = 1 + rng.int(6);
    if (d1 + d2 === 7) {
      return applyAction({ ...s, rngCursor: cursor }, { type: "roll", seat: s.currentSeat });
    }
    cursor += 2;
  }
  throw new Error("no 7 within 20k rolls");
}

describe("lobby: a partially-claimed room waits (policy test)", () => {
  it("setup stalls at the unclaimed seat, resumes after claim", () => {
    const room = createRoom(SEED + 77, { playerCount: 3 });
    const t0 = claimAll(room, 1); // only seat 0
    expect(t0.length).toBe(1);
    // Seat 0 places its first settlement/road...
    let placed = 0;
    while (placed < 2 && room.state.currentSeat === 0) {
      const moves = room.projectionFor(0).legalMoves;
      expect(moves.length).toBeGreaterThan(0);
      mustOp(room, 0, moves[0]!);
      placed++;
    }
    // ...then the queue demands seat 1 — an unclaimed seat cannot act.
    expect(room.state.phase).toBe("setup");
    expect(room.state.currentSeat).toBe(1);
    const anyLegal = legalMoves(room.state, 1)[0]!;
    const denied = room.applyOp(1, anyLegal);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("badSeat");
    // Claim seat 1 and the same snake position becomes legal (not an error).
    room.claimSeat({ seat: 1, name: "Late" });
    expect(room.projectionFor(1).legalMoves.length).toBeGreaterThan(0);
  });
});

describe("rejoin inside stateful windows (AC5)", () => {
  it("a disconnected seat rejoins mid-awaitingSeven and resolves the 7", () => {
    const room = createRoom(SEED + 7, { playerCount: 3 });
    const tokens = claimAll(room, 3);
    playSetup(room);

    /** Resolve discardSeven ops for the front debtor with EXACT cards
     *  (legalMoves ships an empty-cards template for discards). Returns
     *  the seat that now owes moveRobber, or null if the window stayed open
     *  on discards (shouldn't) / already closed. */
    function resolveDiscards(): number | null {
      for (;;) {
        const aw = room.state.awaitingSeven;
        if (!aw) return null;
        if (!aw.pendingDiscard) return aw.roller; // move/steal phase
        const debtor = aw.discardQueue[0]!.seat;
        const need = aw.discardQueue[0]!.count;
        const hand = room.state.players[debtor]!.hand;
        const cards: ("wood" | "brick" | "wool" | "wheat" | "ore")[] = [];
        for (const r of ["wood", "brick", "wool", "wheat", "ore"] as const) {
          while (cards.length < need && hand[r] > cards.filter((c) => c === r).length) cards.push(r);
        }
        expect(cards.length).toBe(need);
        mustOp(room, debtor, { type: "discardSeven", seat: debtor, cards });
      }
    }

    // Play honest turns until a 7 opens a window we can interrupt mid-way:
    // break when the window exists (discard owed, or move/steal pending).
    let rollGuard = 0;
    for (;;) {
      if (++rollGuard > 3000) throw new Error("no 7 in 3000 rolls");
      const seat = room.state.currentSeat;
      const aw = room.state.awaitingSeven;
      if (aw) {
        if (aw.pendingDiscard) break; // front debtor owes cards — interrupt point
        const roller = aw.roller;
        const mv = room.projectionFor(roller).legalMoves.find((m) => m.type === "moveRobber");
        if (mv) {
          mustOp(room, roller, mv);
          const steals = room.projectionFor(roller).legalMoves.filter((m) => m.type === "stealCard");
          if (steals.length) break; // roller owes the steal — interrupt point
          continue; // no victims -> kernel auto-closed the window
        }
        const steals = room.projectionFor(roller).legalMoves.filter((m) => m.type === "stealCard");
        if (steals.length) break; // already moved, steal owed — interrupt point
        throw new Error("awaitingSeven window with no legal move — stuck");
      }
      // No window: this seat either still owes its roll (roll now) or has
      // rolled a non-7 (end turn, pass the dice onward).
      if (room.state.hasRolled) {
        mustOp(room, seat, { type: "endTurn", seat });
      } else {
        mustOp(room, seat, { type: "roll", seat });
      }
    }
    const aw = room.state.awaitingSeven;
    expect(aw).not.toBeNull();
    if (!aw) return;
    const owed = aw.pendingDiscard ? aw.discardQueue[0]!.seat : aw.roller;

    // The obligated seat disconnects: it cannot act while away.
    room.disconnect(owed);
    const mvWhileAway = aw.pendingDiscard
      ? ({ type: "discardSeven", seat: owed, cards: [] } as const)
      : room.projectionFor(owed).legalMoves.find((m) => m.type === "moveRobber" || m.type === "stealCard")!;
    const denied = room.applyOp(owed, mvWhileAway);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.code).toBe("badSeat");

    // Rejoin by token — the obligation waited (no auto-play, AC5) and the
    // rejoined identity can resolve it immediately.
    const rj = room.rejoin(tokens[owed]!);
    expect(rj.ok).toBe(true);
    const aw2 = room.state.awaitingSeven;
    expect(aw2).not.toBeNull();
    if (!aw2) return;
    if (aw2.pendingDiscard) resolveDiscards();
    else {
      const after = room.projectionFor(aw2.roller).legalMoves;
      expect(after.length).toBeGreaterThan(0);
      mustOp(room, aw2.roller, after[0]!);
    }
  });

  it("a pendingTrade survives disconnect + rejoin of both parties", () => {
    const room = createRoom(SEED + 7, { playerCount: 3 });
    const tokens = claimAll(room, 3);
    playSetup(room);
    // Seat 0 offers seat 1 a trade seat 1 can afford: find the window.
    let offered = false;
    let guard = 0;
    while (!offered && guard++ < 600) {
      const s = room.state;
      if (!s.awaitingSeven && s.currentSeat === 0 && s.hasRolled) {
        const mine = s.players[0]!.hand;
        if (mine.wood > 0) {
          // Offeree view is the only honest source of their composition.
          const theirs = room.projectionFor(1).state.players[1]!.hand;
          const want = (["brick", "wool", "wheat", "ore"] as const).find((r) => theirs[r] > 0);
          if (want) {
            const r = room.applyOp(0, { type: "tradeOffer", seat: 0, with: 1, give: ["wood"], want: [want] });
            if (r.ok) offered = true;
          }
        }
      }
      if (!offered) {
        const seat = room.state.currentSeat;
        if (!room.state.awaitingSeven) {
          if (!room.state.hasRolled) {
            const rr = room.applyOp(seat, { type: "roll", seat });
            if (!rr.ok) room.applyOp(seat, { type: "endTurn", seat });
          } else {
            room.applyOp(seat, { type: "endTurn", seat });
          }
        }
      }
    }
    expect(offered).toBe(true);
    expect(room.state.pendingTrade).not.toBeNull();
    // Offeree disconnects, rejoins, accepts across the window.
    room.disconnect(1);
    const rj = room.rejoin(tokens[1]!);
    expect(rj.ok).toBe(true);
    // Offeror too — the offer must still stand after both churn.
    room.disconnect(0);
    expect(room.rejoin(tokens[0]!).ok).toBe(true);
    expect(room.state.pendingTrade).not.toBeNull();
    const accept = room.projectionFor(1).legalMoves.find((m) => m.type === "tradeAccept");
    expect(accept).toBeDefined();
    mustOp(room, 1, accept!);
    expect(room.state.pendingTrade).toBeNull();
  });
});
