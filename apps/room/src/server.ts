/**
 * server.ts — WebSocket transport binding the pure Room core to the
 * protocol.ts wire contract.
 *
 * ONE RoomServer = ONE room (v1; no multi-room lobby). The server owns the
 * dice (Room holds the seed) and the authoritative GameState; clients only
 * ever ship OPS and receive seat-scoped PROJECTIONS.
 *
 * Authority discipline (AGENTS.md hard rule + docs/features/multiplayer.md):
 * - The seat an op runs as is derived from THIS socket's binding (claim or
 *   token rejoin) — never from client-sent data. A forged `op.seat` is
 *   therefore rejected by Room (notYourTurn) and never mutates state.
 * - legalMoves are computed by the server on the TRUE state
 *   (room.projectionFor). The wire never carries a claim a client made up.
 * - RNG: rngSeed/rngCursor are scrubbed to 0 by room.wireScrub before any
 *   projection crosses the wire. The true seed never leaves the server.
 *
 * Protocol: PROTOCOL_VERSION is out-of-band in v1 (both sides ship the same
 * build); a version bump is a deploy, not a handshake.
 *
 * NOT ON THE WIRE IN v1: `chat` (no wire producer yet) and multi-room
 * lookup (one room per server process).
 *
 * HOST: the server creates the room; seat 0 is whoever claims it first, and
 * since M3-P3(b) seat 0 carries ONE real authority — starting a rematch
 * (`rematch`, host-only, phase "ended" only; refusals are error{notHost} /
 * error{badPhase}). Everything else stays symmetric.
 */
import { randomInt } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";

import {
  ClientMsgSchema,
  PROTOCOL_VERSION,
  type EventKind,
  type PublicPlayer,
  type ServerMsg,
  type WireErrorCode,
} from "@catan-vtt/shared";

import { Room, type Projection } from "./room.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoomServerOpts {
  /** TCP port. Default 4273. Pass 0 for an ephemeral port (tests). */
  port?: number;
  /**
   * Dice seed. Default: server-side crypto-random uint32 — the SERVER is the
   * dice source, so a client cannot pick or predict the game.
   */
  seed?: number;
  /** Seats in the room. Default 3. */
  playerCount?: 3 | 4;
  /**
   * Stale-connection sweep: a socket with no inbound traffic for this many
   * ms is terminated. Default 60_000. The sweep timer is unref'd (and
   * cleared on close) so it never keeps a process or a test alive.
   */
  staleMs?: number;
  /** Bind host. Default 127.0.0.1. */
  host?: string;
}

export interface RoomAddress {
  port: number;
  roomCode: string;
}

/** Per-socket transport state. Identity is the ws object itself. */
interface Conn {
  ws: WebSocket;
  /** null = spectator OR not yet joined; `bound` separates the two. */
  seat: number | null;
  /** Has completed a join (seat holder or spectator). Drives broadcasts. */
  bound: boolean;
  lastSeen: number;
  parseFails: number;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_PORT = 4273;
const DEFAULT_STALE_MS = 60_000;
// A client that cannot drain 256 KB of queued frames gets silence until it
// resyncs (serverSeq gap -> rejoin) rather than pinning server memory.
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_PARSE_FAILS = 3;

/** 6-char [A-Za-z0-9] room code, crypto-random (never Math.random). */
function makeRoomCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return out;
}

function defaultSeed(): number {
  // uint32 — the kernel's Rng is a 32-bit xorshift.
  return randomInt(0, 0x1_0000_0000);
}

function frameToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

// ---------------------------------------------------------------------------
// RoomServer
// ---------------------------------------------------------------------------

export class RoomServer {
  /** The authoritative core. Exposed for assertions/tests; never ship state. */
  readonly room: Room;
  readonly roomCode: string;
  /** Mirrors room.seed: the CURRENT game's seed (a rematch re-derives it). */
  seed: number;
  readonly protocolVersion: string = PROTOCOL_VERSION;

  readonly #wss: WebSocketServer;
  readonly #conns: Set<Conn> = new Set();
  /**
   * seat -> the socket that currently owns it. A rejoin from elsewhere
   * overwrites this, so the OLD socket's later 'close' must not disconnect
   * the NEW owner — identity comparison is what makes rejoin safe.
   */
  readonly #seatOwner: Map<number, WebSocket> = new Map();
  readonly #staleMs: number;
  readonly #sweep: NodeJS.Timeout;
  #endedSent = false;
  #closed = false;

  /** Resolves once the socket is listening (address() is valid after). */
  readonly ready: Promise<void>;

  constructor(opts: RoomServerOpts = {}) {
    this.seed = opts.seed ?? defaultSeed();
    this.roomCode = makeRoomCode();
    this.#staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.room = new Room(this.seed, { playerCount: opts.playerCount ?? 3 });

    this.#wss = new WebSocketServer({
      port: opts.port ?? DEFAULT_PORT,
      host: opts.host ?? "127.0.0.1",
    });

    this.ready = new Promise<void>((resolve, reject) => {
      this.#wss.once("listening", () => resolve());
      this.#wss.once("error", (err) => reject(err));
    });

    this.#wss.on("connection", (ws) => this.#onConnection(ws));

    const period = Math.max(50, Math.round(this.#staleMs / 4));
    this.#sweep = setInterval(() => this.#sweepStale(), period);
    // Unref: the room server must never hold the event loop open by itself.
    this.#sweep.unref?.();
    // #8: if the port bind fails AFTER construction (ready rejects and the
    // caller never holds the server to close it), sweep the interval + wss.
    this.ready.catch(() => {
      clearInterval(this.#sweep);
      try {
        this.#wss.close();
      } catch {
        /* never opened */
      }
    });
  }

  /** Bound port + room code. Throws until `ready` has resolved. */
  address(): RoomAddress {
    const addr = this.#wss.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("RoomServer.address(): server is not listening yet (await server.ready)");
    }
    return { port: addr.port, roomCode: this.roomCode };
  }

  /** Stop the sweep, drop every socket, close the listener. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweep);
    for (const c of [...this.#conns]) {
      try {
        c.ws.terminate();
      } catch {
        /* socket already gone */
      }
    }
    this.#conns.clear();
    this.#seatOwner.clear();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // sockets
  // -------------------------------------------------------------------------

  #onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, seat: null, bound: false, lastSeen: Date.now(), parseFails: 0 };
    this.#conns.add(conn);

    ws.on("message", (data) => this.#onMessage(conn, frameToText(data)));
    ws.on("pong", () => {
      conn.lastSeen = Date.now();
    });
    ws.on("close", () => this.#onClose(conn));
    ws.on("error", () => {
      /* a dead peer is not a server error; 'close' follows and cleans up */
    });
  }

  #onClose(conn: Conn): void {
    this.#conns.delete(conn);
    // Release EVERY seat this socket owned — not just conn.seat. A socket
    // that re-joined multiple times leaves earlier bindings behind (quality
    // review C2: one connect/disconnect cycle could orphan seats forever).
    let released = false;
    for (const [seat, owner] of [...this.#seatOwner]) {
      if (owner !== conn.ws) continue;
      this.#seatOwner.delete(seat);
      if (!this.room.isConnected(seat)) continue;
      const name = this.room.roster()[seat]?.name ?? null;
      this.room.disconnect(seat);
      this.#broadcastEvent("playerLeft", { seat, name });
      released = true;
    }
    if (released) this.#broadcastProjections();
  }

  #onMessage(conn: Conn, raw: string): void {
    conn.lastSeen = Date.now();

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.#failParse(conn, "frame is not JSON");
      return;
    }
    const parsed = ClientMsgSchema.safeParse(json);
    if (!parsed.success) {
      this.#failParse(conn, "frame does not match ClientMsgSchema");
      return;
    }
    conn.parseFails = 0;

    const msg = parsed.data;
    switch (msg.type) {
      case "join":
        this.#onJoin(conn, msg.roomCode, msg.seat, msg.seatToken, msg.name);
        return;
      case "op":
        this.#onOp(conn, msg.op);
        return;
      case "ping":
        this.#send(conn, { type: "pong", t: msg.t });
        return;
      case "rematch":
        this.#onRematch(conn);
        return;
      default: {
        // Unreachable while ClientMsgSchema is exactly {join, op, ping}.
        // Loud so a union extension can never silently drop a message.
        const _exhaustive: never = msg;
        throw new Error(`unhandled ClientMsg type: ${String(_exhaustive)}`);
      }
    }
  }

  #failParse(conn: Conn, why: string): void {
    conn.parseFails++;
    this.#send(conn, { type: "error", code: "badMessage", message: why });
    if (conn.parseFails >= MAX_PARSE_FAILS) {
      // Three consecutive unparsable frames: stop talking to this peer.
      // Route through #onClose so the seat is RELEASED (hand-deleting the
      // owner entry here first would make the later #onClose early-return
      // and orphan the seat — quality review #4, probe-confirmed).
      try {
        conn.ws.close(1008, "badMessage x3");
      } catch {
        /* already closing */
      }
      this.#onClose(conn);
    }
  }

  // -------------------------------------------------------------------------
  // join / rejoin
  // -------------------------------------------------------------------------

  #onJoin(
    conn: Conn,
    roomCode: string,
    seat: number | undefined,
    token: string | undefined,
    name: string | undefined,
  ): void {
    // One join per socket: re-joining (even into the same seat) requires a
    // NEW connection. Without this, one socket can claim seat 0, then 1,
    // then 2 — each replace only disconnects, never frees the claim — then
    // close and leave a room where every seat is claimed-by-dead-tokens and
    // every fresh join is a spectator (quality review C1: one-socket lobby
    // DoS). Spectator -> seat upgrade also reconnects, same rule.
    if (conn.bound) {
      this.#send(conn, {
        type: "error",
        code: "badMessage",
        message: "this connection already joined; open a new connection to change seats",
      });
      return;
    }
    if (roomCode !== this.roomCode) {
      // v1: one room per server, so a wrong code is simply not found.
      this.#send(conn, { type: "error", code: "roomNotFound", message: "no such room" });
      return;
    }

    // One join per socket (C1 above): the binding here can never replace a
    // previous one; each socket owns at most one seat.

    // --- rejoin: token wins over an explicit seat (it IS the identity). ---
    // seatToken is a BEARER credential in v1 (friends-over-internet threat
    // model, multiplayer.md §3): whoever presents a live token owns the
    // seat; each use rotates it, so an eavesdropped token dies on first use.
    // A live victim is fenced by the owner guard, not by rejecting the
    // rejoin — rejecting while-connected would break legitimate fast
    // recovery when the server hasn't seen the FIN yet (quality C5 ruling).
    if (token !== undefined) {
      const rj = this.room.rejoin(token);
      if (!rj.ok) {
        this.#send(conn, { type: "error", code: "badToken", message: "seat token is stale or unknown" });
        return;
      }
      conn.seat = rj.seat;
      conn.bound = true;
      this.#seatOwner.set(rj.seat, conn.ws);
      this.#send(conn, this.#welcome(rj.seat, rj.newToken));
      // Presence changed -> everyone (incl. the rejoiner) gets a fresh frame.
      this.#broadcastProjections();
      return;
    }

    // --- fresh claim ---
    // name rides claims only (token rejoin keeps the seat's existing name);
    // claimSeat trims + caps at 24 (protocol pre-caps length at 40).
    const claim = this.room.claimSeat({
      ...(seat === undefined ? {} : { seat }),
      ...(name === undefined ? {} : { name }),
    });
    if (claim.ok) {
      conn.seat = claim.seat;
      conn.bound = true;
      this.#seatOwner.set(claim.seat, conn.ws);
      this.#send(conn, this.#welcome(claim.seat, claim.token));
      this.#broadcastEvent("playerJoined", {
        seat: claim.seat,
        name: this.room.roster()[claim.seat]?.name ?? null,
      });
      // Rename visibility (spec-review MINOR 7): a claim can rewrite the
      // name carried in every projection, so ship fresh frames to all.
      this.#broadcastProjections();
      return;
    }

    // inSeatTaken / roomFull — one of the two RoomErrorCode values.
    if (claim.code === "roomFull" && seat === undefined) {
      // Documented v1 policy (multiplayer.md §1.1/§4): a join into a full
      // room with no seat request becomes a SPECTATOR, never an error.
      conn.seat = null;
      conn.bound = true;
      this.#send(conn, this.#welcome(null, undefined));
      this.#broadcastProjections();
      return;
    }
    this.#send(conn, {
      type: "error",
      code: claim.code,
      message: claim.code === "inSeatTaken" ? "that seat is taken" : "the room is full",
    });
  }

  #welcome(seat: number | null, token: string | undefined): ServerMsg {
    const players: PublicPlayer[] = this.room.roster();
    return {
      type: "welcome",
      roomCode: this.roomCode,
      seat,
      ...(token === undefined ? {} : { seatToken: token }),
      players,
      phase: this.room.state.phase,
    };
  }

  /**
   * Fresh game on the same seats (M3-P3(b)).
   *
   * Authority gate, in this order:
   *   1. notHost  — the connection's claimed seat is not 0 (or it is a
   *                 spectator / unjoined connection). Lying with notSeated
   *                 would be dishonest: the peer IS seated, it is just not
   *                 the host.
   *   2. badPhase — the room is not in phase "ended". Reusing badMessage
   *                 would lie (that is the parse-failure code); a mid-game
   *                 restart is a product decision, not a wire oversight.
   *
   * Refusals change NOTHING — no state, no serverSeq, no broadcast (the
   * rejection law: a refused frame is not a game event).
   *
   * On success: the seed comes from the SERVER (rematchSeed over this
   * room's own seed + serverSeq — the client never names it), and
   * #endedSent resets so game 2 gets its OWN gameEnded (M2 quality review
   * #9, whose old count raced 2/5). One broadcastProjections() replaces
   * every seat's stale state — the fresh setup projection IS the signal
   * (no new event kind; opApplied cannot carry a non-op and a playerJoined
   * echo would be noise). The victory banner self-nulls because the new
   * projection's winner is null (P3(a) derivation, no client change).
   */
  #onRematch(conn: Conn): void {
    if (conn.seat !== 0) {
      this.#send(conn, {
        type: "error",
        code: "notHost",
        message: "only the host (seat 0) can start a rematch",
      });
      return;
    }
    // A superseded socket (rejoin elsewhere) is not the host anymore.
    if (this.#seatOwner.get(0) !== conn.ws) {
      this.#send(conn, {
        type: "error",
        code: "notHost",
        message: "this connection no longer owns seat 0",
      });
      return;
    }
    if (this.room.phase !== "ended") {
      this.#send(conn, {
        type: "error",
        code: "badPhase",
        message: `a rematch needs a finished game (phase is ${this.room.phase})`,
      });
      return;
    }

    const res = this.room.rematch(); // seed is server-derived — no argument
    this.seed = res.seed;
    // M2 quality review #9: the latch is per GAME, not per room.
    this.#endedSent = false;
    this.#broadcastProjections();
  }

  // -------------------------------------------------------------------------
  // ops
  // -------------------------------------------------------------------------

  #onOp(conn: Conn, op: unknown): void {
    if (conn.seat === null) {
      // Unseated connection or spectator: spectators may watch, not act.
      this.#send(conn, { type: "error", code: "notSeated", message: "join a seat before sending ops" });
      return;
    }
    const seat = conn.seat;
    // A socket that has been superseded by a rejoin elsewhere is not the
    // owner anymore — its ops must not reach the room.
    if (this.#seatOwner.get(seat) !== conn.ws) {
      this.#send(conn, {
        type: "error",
        code: "notSeated",
        message: "this connection no longer owns that seat",
      });
      return;
    }

    const res = this.room.applyOp(seat, op);
    if (!res.ok) {
      // Broadcast code + kernel details only. res.message may interpolate
      // CLIENT-controlled values (e.g. "op.seat 7 ..." from a forged op) —
      // keep it server-side (event ring / logs), not on the wire (#10).
      this.#broadcastEvent("rejected", {
        seat,
        opType: opTypeOf(op),
        code: res.code,
        ...("details" in res ? { details: res.details } : {}),
      });
      return;
    }

    this.#broadcastEvent("opApplied", { seat, opType: opTypeOf(op), seq: res.seq });
    if (this.room.state.phase === "ended" && !this.#endedSent) {
      // gameEnded BEFORE the final projection: a client whose refresh()
      // syncs on serverSeq can then never read state while the terminal
      // event is still in flight (review MAJOR M2 — the count raced 2/5).
      this.#endedSent = true;
      this.#broadcastEvent("gameEnded", {
        winner: this.room.state.winner,
        finalPoints: this.room.state.finalPoints,
      });
    }
    this.#broadcastProjections();
  }

  #sweepStale(): void {
    const now = Date.now();
    for (const conn of [...this.#conns]) {
      if (now - conn.lastSeen <= this.#staleMs) continue;
      try {
        conn.ws.terminate();
      } catch {
        /* already gone */
      }
      // 'close' will follow on the terminated socket and run #onClose (which
      // releases the seat). Don't rely on the event ordering though — do the
      // full cleanup now; #onClose is idempotent (double-close guard).
      // A ghost seat (terminated socket, room still says connected) would
      // stall the lobby: claimSeat returns inSeatTaken forever.
      this.#onClose(conn);
    }
  }

  // -------------------------------------------------------------------------
  // send helpers
  // -------------------------------------------------------------------------

  #send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // Backpressure: a client that can't drain its send buffer stops being
    // fed (it will resync via the serverSeq-gap rejoin path) instead of
    // pinning memory on the server. (quality review #6)
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {
      /* CLOSING/destroyed socket: drop this frame; 'close' cleans up.
         The try/catch also keeps ONE dead peer from aborting the whole
         broadcast loop and silently losing every remaining recipient. */
    }
  }

  #projectionFor(conn: Conn): Projection {
    return conn.seat === null ? this.room.spectatorProjection() : this.room.projectionFor(conn.seat);
  }

  #broadcastProjections(): void {
    for (const conn of [...this.#conns]) {
      if (!conn.bound) continue;
      const p = this.#projectionFor(conn);
      this.#send(conn, {
        type: "projection",
        state: p.state,
        legalMoves: p.legalMoves,
        serverSeq: this.room.serverSeq,
      });
    }
  }

  #broadcastEvent(kind: EventKind, details: Record<string, unknown>): void {
    for (const conn of [...this.#conns]) {
      if (!conn.bound) continue;
      this.#send(conn, { type: "event", kind, details, serverSeq: this.room.serverSeq });
    }
  }
}

function opTypeOf(op: unknown): string | null {
  return typeof op === "object" && op !== null && "type" in op
    ? String((op as { type: unknown }).type)
    : null;
}

/**
 * Test/binary helper: construct a server and await the listen.
 * `port: 0` yields an OS-assigned port — read it back from `port`.
 */
export async function startServer(
  opts: RoomServerOpts = {},
): Promise<{ server: RoomServer; port: number; roomCode: string }> {
  const server = new RoomServer(opts);
  await server.ready;
  const { port, roomCode } = server.address();
  return { server, port, roomCode };
}

export type { WireErrorCode };
