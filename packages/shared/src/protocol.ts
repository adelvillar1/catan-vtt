/**
 * protocol.ts — M2 WebSocket wire contract between room server (apps/room)
 * and clients. SINGLE SOURCE OF TRUTH: both sides import these schemas.
 *
 * All messages are .strict() — unknown keys are rejected, so schema bumps
 * are loud, not silent. PROTOCOL_VERSION lets a future server reject stale
 * clients at join time.
 *
 * Authority model:
 * - The server holds the true GameState and applies ops via the kernel's
 *   ONLY mutation path (applyAction). Op legality is kernel business.
 * - Op-level failures (illegal move) ride event.kind="rejected" carrying
 *   kernel ActionError codes; connection-level failures (bad seat claim,
 *   full room) ride the top-level "error" message. The two code enums are
 *   disjoint by design.
 * - "projection" ships the seat-scoped redacted state PLUS a server-computed
 *   legalMoves list. Clients MUST NOT run legalMoves on a projection for
 *   rng-consuming ops (roll/stealCard/buyDevCard/tradeAccept) — the kernel
 *   M3 rule (see redact.ts) — hence the server computes it on the TRUE
 *   state and ships the result.
 *
 * RNG hygiene (LOCKED — see docs/features/multiplayer.md): the true
 * rngSeed/rngCursor NEVER cross the wire. The server scrubs both to 0 on
 * every projection before send (transport hygiene in apps/room, NOT a
 * kernel change; both values are already schema-legal).
 */
import { z } from "zod";
import { OpSchema } from "./actions.js";
import { GameStateSchema, PhaseSchema } from "./state.js";

export const PROTOCOL_VERSION = "1";

// 6 chars, alphanumeric only — codes are read aloud / typed by friends;
// punctuation invites typos (and confusion with the .strict() key errors).
const RoomCodeSchema = z.string().length(6).regex(/^[A-Za-z0-9]{6}$/);
const SeatIndexSchema = z.number().int().min(0).max(3);
const ServerSeqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/**
 * Join a room. seat absent = claim next free seat; present = request that
 * seat (server grants or answers error.code="inSeatTaken"). seatToken is
 * the rejoin credential returned in "welcome" — presenting a valid token
 * for a disconnected seat re-binds this connection to that seat.
 */
export const JoinMsgSchema = z
  .object({
    type: z.literal("join"),
    roomCode: RoomCodeSchema,
    seat: SeatIndexSchema.optional(),
    seatToken: z.string().optional(),
    /** Display name (seat claims only); room.ts trims + caps at 24. */
    name: z.string().min(1).max(40).optional(),
  })
  .strict();
export type JoinMsg = z.infer<typeof JoinMsgSchema>;

/**
 * A player op. The op envelope is exactly the kernel OpSchema — the server
 * re-validates state authority: op.seat must equal THIS connection's
 * claimed seat (enforced server-side in phase 2; the wire carries whatever
 * the client sent so the server can reject with full context).
 */
export const OpMsgSchema = z
  .object({ type: z.literal("op"), op: OpSchema })
  .strict();
export type OpMsg = z.infer<typeof OpMsgSchema>;

/** Liveness probe. Server mirrors t back in "pong". */
export const PingMsgSchema = z
  .object({ type: z.literal("ping"), t: z.number() })
  .strict();
export type PingMsg = z.infer<typeof PingMsgSchema>;

export const ClientMsgSchema = z.discriminatedUnion("type", [
  JoinMsgSchema,
  OpMsgSchema,
  PingMsgSchema,
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/** Public roster entry — no hand/devHand data, just identity + presence. */
export const PublicPlayerSchema = z
  .object({
    seat: z.number().int(),
    name: z.string(),
    color: z.string(),
    connected: z.boolean(),
  })
  .strict();
export type PublicPlayer = z.infer<typeof PublicPlayerSchema>;

/**
 * Sent on join acceptance. seat is null for a spectator (room full or
 * join without a free seat claim); seatToken is the rejoin credential for
 * seated players (absent for spectators).
 */
export const WelcomeMsgSchema = z
  .object({
    type: z.literal("welcome"),
    roomCode: RoomCodeSchema,
    seat: SeatIndexSchema.nullable(),
    seatToken: z.string().optional(),
    players: z.array(PublicPlayerSchema),
    phase: PhaseSchema,
  })
  .strict();
export type WelcomeMsg = z.infer<typeof WelcomeMsgSchema>;

/**
 * The seat-scoped redacted state (kernel redactForSeat + server-side
 * rngSeed/rngCursor scrub to 0) plus this seat's legal ops, computed by
 * the server on the TRUE state. serverSeq is monotone per room; a gap
 * means the client missed a frame and should rejoin to resync.
 */
export const ProjectionMsgSchema = z
  .object({
    type: z.literal("projection"),
    state: GameStateSchema,
    legalMoves: z.array(OpSchema),
    serverSeq: ServerSeqSchema,
  })
  .strict();
export type ProjectionMsg = z.infer<typeof ProjectionMsgSchema>;

export const EventKindSchema = z.enum([
  "opApplied",
  "rejected",
  "playerJoined",
  "playerLeft",
  "chat",
  "gameEnded",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

/**
 * Lightweight feed. details is OPAQUE to the wire schema BY DESIGN — the
 * payload differs per kind:
 * - opApplied: { seat, opType } (+ kernel-result summary)
 * - rejected:  { seat, opType, code: ActionErrorCode, details? } — op-level
 *              errors carry KERNEL ActionError codes, not wire codes
 * - playerJoined/playerLeft: { seat, name }
 * - chat:      { seat|null, text }
 * - gameEnded: { winner, finalPoints }
 * Clients switch on `kind`; validating each payload shape is client
 * business, not wire-schema business (v1 keeps the contract honest by
 * construction: the server only ever emits the shapes above).
 */
export const EventMsgSchema = z
  .object({
    type: z.literal("event"),
    kind: EventKindSchema,
    details: z.record(z.unknown()),
    serverSeq: ServerSeqSchema,
  })
  .strict();
export type EventMsg = z.infer<typeof EventMsgSchema>;

export const WireErrorCodeSchema = z.enum([
  "inSeatTaken",
  "roomFull",
  "roomNotFound",
  "badMessage",
  "notSeated",
  "badToken",
]);
export type WireErrorCode = z.infer<typeof WireErrorCodeSchema>;

/**
 * Connection-level errors ONLY (seat claims, room lookup, malformed
 * frames, unseated op attempts). Op-level errors never appear here — they
 * ride event.kind="rejected" with kernel ActionError codes.
 */
export const ErrorMsgSchema = z
  .object({
    type: z.literal("error"),
    code: WireErrorCodeSchema,
    message: z.string(),
  })
  .strict();
export type ErrorMsg = z.infer<typeof ErrorMsgSchema>;

export const PongMsgSchema = z
  .object({ type: z.literal("pong"), t: z.number() })
  .strict();
export type PongMsg = z.infer<typeof PongMsgSchema>;

export const ServerMsgSchema = z.discriminatedUnion("type", [
  WelcomeMsgSchema,
  ProjectionMsgSchema,
  EventMsgSchema,
  ErrorMsgSchema,
  PongMsgSchema,
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
