/**
 * adapter.ts — the pure half of useRoom: frame routing + outbound shaping.
 *
 * Factored out of the hook so it is unit-testable in a node environment
 * (no WebSocket, no React). Discipline mirrors apps/room/src/cli.ts:
 * EVERY inbound frame goes through ServerMsgSchema.safeParse; a failure is
 * a bug, not a shape to shrug at.
 *
 * NOTHING here imports applyAction / legalMoves / redactForSeat. The client
 * never computes legality — it renders the server's legalMoves. (That is
 * plan AC3, grep-provable.)
 */
import {
  ClientMsgSchema,
  ServerMsgSchema,
  type ClientMsg,
  type GameState,
  type Op,
  type PublicPlayer,
  type ServerMsg,
  type WireErrorCode,
  type EventKind,
} from "@catan-vtt/shared";

export type RoomStatus = "idle" | "connecting" | "joining" | "playing" | "closed" | "error";

/** Mutable room state, owned by the hook and updated only via routeFrame(). */
export interface RoomState {
  status: RoomStatus;
  welcome: {
    roomCode: string;
    seat: number | null;
    seatToken?: string;
    players: PublicPlayer[];
    phase: GameState["phase"];
  } | null;
  projection: GameState | null;
  legalMoves: Op[];
  serverSeq: number;
  lastEvent: { kind: EventKind; details: Record<string, unknown>; serverSeq: number } | null;
  /** Ring buffer, newest last. */
  events: Array<{ kind: EventKind; details: Record<string, unknown>; serverSeq: number }>;
  /** Connection-level error (wire "error" frame or a socket/parse failure). */
  error: { code: WireErrorCode | "badFrame" | "socket"; message: string } | null;
  /** True once a frame failed ServerMsgSchema — the socket must be closed. */
  fatal: boolean;
  /** Latest pong payload, for latency display (unused in P1 UI). */
  lastPong: number | null;
}

export function initialRoomState(): RoomState {
  return {
    status: "idle",
    welcome: null,
    projection: null,
    legalMoves: [],
    serverSeq: -1,
    lastEvent: null,
    events: [],
    error: null,
    fatal: false,
    lastPong: null,
  };
}

/** How many events the ticker keeps. */
export const EVENT_RING_SIZE = 8;

/**
 * Route ONE parsed server frame into a new RoomState. Pure — returns a fresh
 * object (React needs identity change to re-render).
 *
 * `prev.status` is preserved except where the frame implies a transition
 * (welcome → playing).
 */
export function routeFrame(prev: RoomState, msg: ServerMsg): RoomState {
  switch (msg.type) {
    case "welcome": {
      // The handshake for a (possibly NEW) room. Any projection still held
      // belongs to the OLD connection — a different room, or a table whose
      // link dropped. Keep it and the UI paints the previous game until the
      // first frame of this one lands: stale winner banners, ghosts that
      // belong to another island. The server ships a projection immediately
      // after welcome, so the cleared window is sub-frame for everything
      // except the exact stale-data failure the clearing exists to kill.
      // (sendOp already refuses without a projection; it just waits a beat.)
      return {
        ...prev,
        status: "playing",
        projection: null,
        legalMoves: [],
        serverSeq: 0,
        events: [],
        welcome: {
          roomCode: msg.roomCode,
          seat: msg.seat,
          ...(msg.seatToken === undefined ? {} : { seatToken: msg.seatToken }),
          players: msg.players,
          phase: msg.phase,
        },
        error: null,
      };
    }
    case "projection": {
      return {
        ...prev,
        status: prev.status === "connecting" || prev.status === "joining" ? "playing" : prev.status,
        projection: msg.state,
        legalMoves: msg.legalMoves,
        serverSeq: msg.serverSeq,
      };
    }
    case "event": {
      const entry = { kind: msg.kind, details: msg.details, serverSeq: msg.serverSeq };
      const events = [...prev.events, entry].slice(-EVENT_RING_SIZE);
      return {
        ...prev,
        lastEvent: entry,
        events,
        serverSeq: Math.max(prev.serverSeq, msg.serverSeq),
      };
    }
    case "error": {
      // M3-P3(b): notHost / badPhase are REFUSALS of one request, not a dead
      // link — the socket is fine and the room keeps running. Every other
      // wire error (badToken, roomNotFound, badMessage, …) is a real
      // connection failure and still lands as status "error".
      const transient = msg.code === "notHost" || msg.code === "badPhase";
      return {
        ...prev,
        error: { code: msg.code, message: msg.message },
        status: transient ? prev.status : "error",
      };
    }
    case "pong": {
      return { ...prev, lastPong: msg.t };
    }
    default: {
      // Exhaustiveness guard — a new ServerMsg variant must be handled here.
      const _never: never = msg;
      void _never;
      return prev;
    }
  }
}

/**
 * Parse-and-route, the cli.ts discipline in one call:
 * - JSON.parse failure          → fatal badFrame
 * - ServerMsgSchema failure     → fatal badFrame
 * - otherwise                   → routeFrame
 *
 * The hook closes the socket whenever `fatal` comes back true.
 */
export function routeRawFrame(prev: RoomState, raw: string): RoomState {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return {
      ...prev,
      fatal: true,
      status: "error",
      error: { code: "badFrame", message: `non-JSON frame: ${raw.slice(0, 300)}` },
    };
  }
  const parsed = ServerMsgSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ...prev,
      fatal: true,
      status: "error",
      error: {
        code: "badFrame",
        message: `server frame violates ServerMsgSchema: ${raw.slice(0, 300)}`,
      },
    };
  }
  return routeFrame(prev, parsed.data);
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface JoinRequest {
  roomCode: string;
  seat?: number;
  name?: string;
  seatToken?: string;
}

/**
 * Build a join message. Spectator = omit `seat` (server assigns next free
 * seat, or spectates when full). Validated against ClientMsgSchema — the
 * client refuses to emit a frame the server would reject as badMessage.
 */
export function buildJoinMessage(req: JoinRequest): ClientMsg {
  const msg: ClientMsg = {
    type: "join",
    roomCode: req.roomCode,
    ...(req.seat === undefined ? {} : { seat: req.seat }),
    ...(req.name === undefined ? {} : { name: req.name }),
    ...(req.seatToken === undefined ? {} : { seatToken: req.seatToken }),
  };
  const parsed = ClientMsgSchema.safeParse(msg);
  if (!parsed.success) {
    throw new Error(`buildJoinMessage: illegal join frame — ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Build an op message. The wire envelope is exactly { type: "op", op } — see
 * OpMsgSchema in protocol.ts (op is the kernel OpSchema verbatim).
 */
export function buildOpMessage(op: Op): ClientMsg {
  const parsed = ClientMsgSchema.safeParse({ type: "op", op });
  if (!parsed.success) {
    throw new Error(`buildOpMessage: illegal op frame — ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Build a rematch request (M3-P3(b)). The frame carries NO seed: the next
 * game's seed is derived server-side from (seed, serverSeq) — a client that
 * could name it could name every dice roll in game 2.
 */
export function buildRematchMessage(): ClientMsg {
  const parsed = ClientMsgSchema.safeParse({ type: "rematch" });
  if (!parsed.success) {
    throw new Error(`buildRematchMessage: illegal rematch frame — ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Serialize a client frame (the only thing ever passed to ws.send). */
export function encodeClientMessage(msg: ClientMsg): string {
  return JSON.stringify(msg);
}

// ---------------------------------------------------------------------------
// seatToken persistence (rotation-aware)
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "catan.seatToken.";

/**
 * Store the token under the room code. Called on EVERY welcome: the server
 * ships a fresh token per join/rejoin, so overwriting is the whole point —
 * a stale token would be rejected with badToken on reconnect.
 */
export function storeSeatToken(storage: Storage, roomCode: string, token: string): void {
  storage.setItem(TOKEN_PREFIX + roomCode, token);
}

export function readSeatToken(storage: Storage, roomCode: string): string | null {
  return storage.getItem(TOKEN_PREFIX + roomCode);
}

export function clearSeatToken(storage: Storage, roomCode: string): void {
  storage.removeItem(TOKEN_PREFIX + roomCode);
}
