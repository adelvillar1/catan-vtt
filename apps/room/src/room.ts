/**
 * room.ts — pure room core (NO sockets; phase 3 adds transport).
 *
 * Authority model: this module is the ONLY thing that mutates game state,
 * and it does so exclusively through the kernel's applyAction (AGENTS.md
 * hard rule). A client never ships state — the server computes per-seat
 * projections from the TRUE state and ships those (plus server-computed
 * legalMoves).
 *
 * Seat identity: claimSeat() mints a random opaque token; rejoin() rotates
 * it so a captured token is single-use. Connection presence lives here, not
 * in GameState.
 *
 * Wire hygiene: wireScrub() zeroes rngSeed/rngCursor on every outbound
 * projection. redactForSeat already zeroes rngSeed, but it KEEPS
 * rngCursor — and (cursor + rollLog) is enough to brute-force the 2^32
 * xorshift stream and predict every future roll. So the cursor must not
 * cross the wire either (plan AC3).
 */
import { randomUUID } from "node:crypto";

import {
  ActionError,
  GameStateSchema,
  OpSchema,
  applyAction,
  legalMoves,
  nextU32,
  redactForSeat,
  variableSetup,
  randomDiscSetup,
  type ActionErrorCode,
  type GameState,
  type Op,
  type WireErrorCode,
} from "@catan-vtt/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Connection-level rejections — compile-time subset of the wire enum. */
export type RoomErrorCode = Extract<WireErrorCode, "inSeatTaken" | "roomFull">;

/** M3-P3(b): the fresh game's seed, returned by rematch() for the log. */
export interface RematchResult {
  ok: true;
  seed: number;
}

export interface ClaimOk {
  ok: true;
  seat: number;
  token: string;
}
export interface ClaimErr {
  ok: false;
  code: RoomErrorCode;
}
export type ClaimResult = ClaimOk | ClaimErr;

export interface RejoinOk {
  ok: true;
  seat: number;
  newToken: string;
}
export interface RejoinErr {
  ok: false;
  code: "badToken";
}
export type RejoinResult = RejoinOk | RejoinErr;

export interface OpOk {
  ok: true;
  seq: number;
}
export interface OpErr {
  ok: false;
  code: ActionErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
export type OpResult = OpOk | OpErr;

/** What a seated client receives. legalMoves is computed on the TRUE state. */
export interface Projection {
  state: GameState;
  legalMoves: Op[];
}

export interface RoomEvent {
  seq: number;
  at: number;
  seat: number | null;
  opType: string;
  ok: boolean;
  code?: ActionErrorCode;
}

export interface RoomOptions {
  playerCount?: 3 | 4;
  hostName?: string;
  setupStyle?: "variable" | "randomDiscs";
}

// ---------------------------------------------------------------------------
// wireScrub
// ---------------------------------------------------------------------------

/**
 * Strip the replayable RNG stream from a state before it crosses the wire.
 *
 * redactForSeat already zeroes rngSeed; it deliberately keeps rngCursor so
 * draw-count invariants hold on the client. Shipping the cursor is still a
 * leak: cursor + rollLog brute-forces the 2^32 xorshift seed and predicts
 * every future roll/draw. Zero both.
 *
 * Both fields are schema-legal (min 0 / int), so the result still parses
 * under GameStateSchema — but it is NOT a state applyAction should resume
 * from.
 */
export function wireScrub(s: GameState): GameState {
  return { ...s, rngSeed: 0, rngCursor: 0 };
}

/**
 * The next game's seed, derived SERVER-SIDE from (currentSeed, serverSeq).
 *
 * M3-P3(b) AC6: no client may pick a seed. `rematch` carries no arguments on
 * the wire, so the only inputs here are values the server already owns. Two
 * rooms at the same (seed, serverSeq) derive the same next seed — which is
 * what makes the room.test determinism assertion meaningful.
 *
 * Mixing: two xorshift32 steps (kernel's own Rng primitive) over a
 * serverSeq-salted mix, finalised by a 32-bit avalanche so a +1 seq change
 * moves every bit. `>>> 0` keeps it in the uint32 space GameState.rngSeed
 * expects (schema: z.number().int()).
 */
export function rematchSeed(seed: number, serverSeq: number): number {
  let x = (seed ^ Math.imul(serverSeq >>> 0, 0x9e3779b1)) >>> 0;
  x = nextU32(x);
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  // xorshift32 is stuck at 0; the kernel's Rng substitutes a default state,
  // but a 0 seed here would also make "did the seed change?" read falsely.
  return (x || 0x6d2b79f5) >>> 0;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

const EVENT_RING_MAX = 500;

export class Room {
  seed: number;
  readonly playerCount: 3 | 4;
  readonly setupStyle: "variable" | "randomDiscs";

  /** TRUE state. Private; applyAction via applyOp is the only mutator. */
  #state: GameState;

  /** Monotone per accepted op; starts 0. Never resets (even on rematch). */
  #serverSeq = 0;

  /** seat -> { token, name, connected }. */
  readonly #seats: Map<number, { token: string; name: string; connected: boolean }>;

  /** (seat, seq) -> projection. Cleared whenever serverSeq advances. */
  #cache: Map<string, Projection> = new Map();

  /** Ring buffer of recent op outcomes. */
  readonly #events: RoomEvent[] = [];

  constructor(seed: number, opts: RoomOptions = {}) {
    this.seed = seed;
    this.playerCount = opts.playerCount ?? 3;
    this.setupStyle = opts.setupStyle ?? "variable";
    this.#seats = new Map();

    const setupFn = this.setupStyle === "randomDiscs" ? randomDiscSetup : variableSetup;
    const names =
      opts.hostName === undefined ? undefined : { playerNames: [opts.hostName] };
    this.#state = setupFn(seed, { playerCount: this.playerCount, ...names });

    // Setup pre-creates every PlayerState (all playerCount seats exist from
    // the start), so joining = CLAIMING an existing, as-yet-unclaimed slot.
    // Nothing is claimed until claimSeat(); an unclaimed seat is inert.
  }

  // -------------------------------------------------------------------------
  // State accessors
  // -------------------------------------------------------------------------

  /**
   * TRUE state (server-authoritative; NEVER ship this). Server-side + tests
   * only — the transport path is projectionFor(seat)/spectatorProjection().
   * Treat as immutable: applyOp (via applyAction) is the only mutator.
   */
  get state(): GameState {
    return this.#state;
  }

  get serverSeq(): number {
    return this.#serverSeq;
  }

  get phase(): GameState["phase"] {
    return this.#state.phase;
  }

  winner(): number | null {
    return this.#state.winner;
  }

  /** Recent events, oldest first (ring buffer, max 500). Copy: ring stays private. */
  events(): readonly RoomEvent[] {
    return this.#events.slice();
  }

  /** Public roster — identity + presence only, no hand data. */
  roster(): { seat: number; name: string; color: string; connected: boolean }[] {
    return this.#state.players.map((p) => {
      const rec = this.#seats.get(p.seat);
      return {
        seat: p.seat,
        name: rec?.name ?? p.name,
        color: p.color,
        connected: rec?.connected ?? false,
      };
    });
  }

  isConnected(seat: number): boolean {
    return this.#seats.get(seat)?.connected ?? false;
  }

  // -------------------------------------------------------------------------
  // Seat lifecycle
  // -------------------------------------------------------------------------

  /**
   * Claim a seat. seat omitted = first unclaimed seat in seat order; when
   * none is free the CALLER (transport layer) decides — v1 policy: a join
   * into a full room becomes a spectator welcome, never an error.
   * Requesting an out-of-range seat returns roomFull (the room cannot
   * accept it) — deliberately not inSeatTaken, which would leak that the
   * seat exists.
   *
   * LOBBY POLICY (parent ruling): a partially-claimed room simply WAITS in
   * its current phase — the kernel snake queue needs all seats' ops, so an
   * unclaimed seat stalls setup until someone claims it (or host starts a
   * v1 game only when all seats are filled — that gate is phase-3
   * transport UX, e.g. a "start when ready" host button). This is lobby
   * semantics, not a deadlock: later joins are the normal flow.
   * Mints a fresh opaque token (crypto.randomUUID).
   */
  claimSeat(args: { seat?: number; name?: string } = {}): ClaimResult {
    const taken = (s: number) => this.#seats.has(s);
    // Defensive: names ride every projection; cap + trim at the gate so a
    // hostile claim can't bloat the wire (phase-3 transport validates too).
    const cleanName =
      typeof args.name === "string" ? args.name.trim().slice(0, 24) : undefined;
    const name = cleanName && cleanName.length > 0 ? cleanName : undefined;

    if (args.seat !== undefined) {
      const seat = args.seat;
      if (seat < 0 || seat >= this.playerCount) return { ok: false, code: "roomFull" };
      if (taken(seat)) return { ok: false, code: "inSeatTaken" };
      return this.#bind(seat, name);
    }

    for (let s = 0; s < this.playerCount; s++) {
      if (!taken(s)) return this.#bind(s, name);
    }
    return { ok: false, code: "roomFull" };
  }

  #bind(seat: number, name?: string): ClaimOk {
    const existingName = this.#state.players[seat]?.name ?? `Player ${seat + 1}`;
    const finalName = name ?? existingName;
    this.#seats.set(seat, { token: randomUUID(), name: finalName, connected: true });
    if (this.#state.players[seat] && this.#state.players[seat]!.name !== finalName) {
      // Names are cosmetic (not rules data) but must round-trip in the
      // projection AND survive rematch (which re-reads #state names), so
      // rewrite them on the true state here. EXCEPTION to the memo rule:
      // serverSeq does NOT bump (this is not an op), but the cache clears —
      // "same seq ⇒ same identity" holds between claims, not across them.
      // Phase 3: every claim broadcasts `event(playerJoined)`, so all seats
      // refetch projections anyway and no client caches across the rename.
      this.#state = {
        ...this.#state,
        players: this.#state.players.map((p) =>
          p.seat === seat ? { ...p, name: finalName } : p,
        ),
      };
      this.#cache.clear();
    }
    return { ok: true, seat, token: this.#seats.get(seat)!.token };
  }

  /** Mark a seat disconnected. Its token stays valid until used by rejoin. */
  disconnect(seat: number): void {
    const rec = this.#seats.get(seat);
    if (!rec) return;
    rec.connected = false;
  }

  /**
   * Re-bind a disconnected seat with its token. Rotates the token: the old
   * one dies immediately, so a leaked token is single-use.
   */
  rejoin(token: string): RejoinResult {
    for (const [seat, rec] of this.#seats) {
      if (rec.token === token) {
        const newToken = randomUUID();
        rec.token = newToken;
        rec.connected = true;
        // NOTE: no cache clear — rejoin changes NO state; projections are
        // per-(seat,serverSeq) and none of those inputs moved.
        return { ok: true, seat, newToken };
      }
    }
    return { ok: false, code: "badToken" };
  }

  // -------------------------------------------------------------------------
  // Op authority
  // -------------------------------------------------------------------------

  /**
   * Apply an op on behalf of `seat`. Checks run in a FIXED order so the
   * returned code is deterministic:
   *   1. OpSchema strict parse        -> badOp
   *   2. op.seat === seat             -> notYourTurn
   *   3. seat in range                -> badSeat
   *   4. seat claimed                 -> badSeat
   *   5. seat connected               -> badSeat
   *   6. phase !== "ended"            -> wrongPhase
   *   7. applyAction                  -> kernel ActionError (verbatim)
   * On success serverSeq++ and the projection cache is invalidated.
   */
  applyOp(seat: number, op: unknown): OpResult {
    const parsed = OpSchema.safeParse(op);
    if (!parsed.success) {
      return this.#reject(seat, "<unparsable>", "badOp", "malformed op", {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    const p = parsed.data;

    if (typeof p.seat !== "number" || p.seat !== seat) {
      return this.#reject(
        seat,
        p.type,
        "notYourTurn",
        `op.seat ${String((p as { seat?: unknown }).seat)} does not belong to caller ${seat}`,
      );
    }
    if (seat < 0 || seat >= this.playerCount) {
      return this.#reject(seat, p.type, "badSeat", `seat ${seat} is out of range`);
    }
    const rec = this.#seats.get(seat);
    if (!rec) {
      return this.#reject(seat, p.type, "badSeat", `seat ${seat} is unclaimed`);
    }
    if (!rec.connected) {
      return this.#reject(seat, p.type, "badSeat", `seat ${seat} is disconnected`);
    }
    if (this.#state.phase === "ended") {
      return this.#reject(seat, p.type, "wrongPhase", "the game has ended", {
        winner: this.#state.winner,
      });
    }

    try {
      this.#state = applyAction(this.#state, p);
    } catch (err) {
      if (err instanceof ActionError) {
        return this.#reject(seat, p.type, err.code, err.message, err.details);
      }
      throw err;
    }

    this.#serverSeq++;
    this.#cache.clear();
    this.#events.push({
      seq: this.#serverSeq,
      at: Date.now(),
      seat,
      opType: p.type,
      ok: true,
    });
    if (this.#events.length > EVENT_RING_MAX) this.#events.shift();
    return { ok: true, seq: this.#serverSeq };
  }

  #reject(
    seat: number,
    opType: string,
    code: ActionErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): OpErr {
    // Rejections do NOT bump serverSeq: it counts accepted ops only.
    const ev: RoomEvent = { seq: this.#serverSeq, at: Date.now(), seat, opType, ok: false, code };
    this.#events.push(ev);
    if (this.#events.length > EVENT_RING_MAX) this.#events.shift();
    return { ok: false, code, message, ...(details ? { details } : {}) };
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  /**
   * Seat-scoped projection: redacted + rng-scrubbed state, plus legalMoves
   * computed on the TRUE state (a projection's fake deck / zeroed rng would
   * make roll/steal/buyDevCard diverge — see redact.ts M3 client rule).
   *
   * Memoized by (seat, serverSeq): two calls at the same seq return the SAME
   * object identity; an accepted op invalidates.
   */
  projectionFor(seat: number): Projection {
    // SERVER-INTERNAL: the transport must derive `seat` from the socket's
    // claimed token — never from client-sent data (phase 3). An unclaimed
    // seat here is a server bug, not a user error; the wire never calls it
    // that way.
    const key = `${seat}:${this.#serverSeq}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;

    const proj: Projection = {
      state: wireScrub(redactForSeat(this.#state, seat)),
      legalMoves: legalMoves(this.#state, seat),
    };
    this.#cache.set(key, proj);
    return proj;
  }

  /**
   * Spectator projection: everything public, plus seat 0's hidden data
   * squashed too (a spectator sees no one's hand). legalMoves is empty —
   * spectators cannot act.
   */
  spectatorProjection(): Projection {
    const key = `spectator:${this.#serverSeq}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;

    const redacted = redactForSeat(this.#state, 0);
    // Squash seat 0 as well (by SEAT, not array position): same encoding
    // redactForSeat applies to others.
    const totalOf = (p: (typeof redacted.players)[number]) =>
      p.hand.wood + p.hand.brick + p.hand.wool + p.hand.wheat + p.hand.ore;
    const players = redacted.players.map((p) =>
      p.seat === 0
        ? {
            ...p,
            hand: { wood: totalOf(p), brick: 0, wool: 0, wheat: 0, ore: 0 },
            devHand: Array<"victoryPoint">(p.devHand.length).fill("victoryPoint"),
          }
        : p,
    );
    // Must still be a valid GameState (clients feed it to the kernel's
    // read-only helpers), so assert it on the way out.
    const state = GameStateSchema.parse(wireScrub({ ...redacted, players }));
    const out: Projection = { state, legalMoves: [] };
    this.#cache.set(key, out);
    return out;
  }

  // -------------------------------------------------------------------------
  // Rematch
  // -------------------------------------------------------------------------

  /**
   * Fresh game on a new seed. Seat claims, tokens and names SURVIVE;
   * serverSeq keeps counting upward (it is a room-level monotonic counter).
   *
   * ARITY CHANGE (M3-P3(b)): `newSeed` is now the DEFAULT, and it is
   * SERVER-DERIVED (see rematchSeed) — it is never a number the client
   * picked, because the seed is the whole dice story (multiplayer.md §5).
   * The parameter is still honoured (tests pin determinism directly, and a
   * future "replay this seed" tool needs it), but the transport must call
   * `rematch()` with no argument.
   */
  rematch(newSeed: number = rematchSeed(this.seed, this.#serverSeq)): RematchResult {
    const setupFn = this.setupStyle === "randomDiscs" ? randomDiscSetup : variableSetup;
    const names = this.#state.players.map((p) => {
      const rec = this.#seats.get(p.seat);
      return rec?.name ?? p.name;
    });
    this.#state = setupFn(newSeed, {
      playerCount: this.playerCount,
      playerNames: names,
    });
    this.seed = newSeed;
    this.#cache.clear();
    return { ok: true, seed: newSeed };
  }
}

/** Factory (matches the plan's `createRoom` surface). */
export function createRoom(seed: number, opts?: RoomOptions): Room {
  return new Room(seed, opts);
}
