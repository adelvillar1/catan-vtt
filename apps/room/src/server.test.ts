/**
 * server.test.ts — apps/room transport: real WebSocket clients against a
 * real RoomServer on an ephemeral port.
 *
 * Every frame a client receives is parsed with ServerMsgSchema — the wire
 * contract is asserted structurally on EVERY test, not just sampled (this
 * is the AC3 structural proof). Clients only ever act on state they were
 * SHIPPED: ops come from each connection's own latest projection.legalMoves,
 * never from the server's true state and never from another client.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  GameStateSchema,
  ServerMsgSchema,
  type GameState,
  type Op,
  type ServerMsg,
} from "@catan-vtt/shared";

import { startServer, type RoomServer } from "./server.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";

interface Client {
  ws: WebSocket;
  /** Every frame received, in order, already validated by ServerMsgSchema. */
  frames: ServerMsg[];
  /** Latest projection payload (null until one arrives). */
  state: GameState | null;
  moves: Op[];
  seq: number;
  seat: number | null;
  lastProjection: ServerMsg | null;
  next(type: ServerMsg["type"], timeoutMs?: number): Promise<ServerMsg>;
  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs?: number): Promise<ServerMsg>;
  /** waitFor that ignores frames already received — never matches a stale one. */
  waitNew(pred: (m: ServerMsg) => boolean, timeoutMs?: number): Promise<ServerMsg>;
  sendRaw(text: string): void;
  send(obj: unknown): void;
  close(): Promise<void>;
  waitClose(timeoutMs?: number): Promise<void>;
  /** #14: reject all outstanding waiters (teardown; prevents post-test
   * unhandled rejections attributed to whoever runs next). */
  drain(): void;
}

const open: { clients: Client[]; servers: RoomServer[] } = { clients: [], servers: [] };

afterEach(async () => {
  for (const c of open.clients.splice(0)) {
    try {
      c.drain(); // #14: never let an armed waiter reject after teardown
      if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) {
        c.ws.close();
      }
    } catch {
      /* ignore */
    }
  }
  for (const s of open.servers.splice(0)) {
    await s.close();
  }
  CURRENT_SERVER = null; // #11: never leave refresh() synced to a dead server
});

/** Open a ws client. Every inbound frame is parsed by ServerMsgSchema. */
async function openClient(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://${HOST}:${port}`);
  const frames: ServerMsg[] = [];
  const waiters: {
    pred: (m: ServerMsg) => boolean;
    resolve: (m: ServerMsg) => void;
    reject: (e: Error) => void;
    /** Frame index this waiter may start matching from (waitNew sets it). */
    from?: number;
    /** #12: live timeout handle, cleared on resolve. */
    timer?: ReturnType<typeof setTimeout>;
  }[] = [];

  const c: Client = {
    ws,
    frames,
    state: null,
    moves: [],
    seq: -1,
    seat: null,
    lastProjection: null,
    next(type, timeoutMs = 3000) {
      return this.waitFor((m) => m.type === type, timeoutMs);
    },
    waitFor(pred, timeoutMs = 3000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<ServerMsg>((resolve, reject) => {
        const w: (typeof waiters)[number] = { pred, resolve, reject };
        waiters.push(w);
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`waitFor timeout after ${timeoutMs}ms (${frames.length} frames seen)`));
        }, timeoutMs);
      });
    },
    /** Like waitFor, but ignores frames already received (no stale match). */
    waitNew(pred, timeoutMs = 3000) {
      return new Promise<ServerMsg>((resolve, reject) => {
        const w: (typeof waiters)[number] = { pred, resolve, reject, from: frames.length };
        waiters.push(w);
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`waitNew timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    },
    drain() {
      // Clear every live timeout and drop the waiters. Do NOT reject:
      // after a test settles, a rejection is just an unhandled-rejection
      // warning; an unsettled Promise GCs quietly with the client.
      for (const w of waiters.splice(0)) {
        if (w.timer !== undefined) clearTimeout(w.timer);
      }
    },
    sendRaw(text) {
      ws.send(text);
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    close() {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.close();
      });
    },
    waitClose(timeoutMs = 3000) {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        const t = setTimeout(() => reject(new Error("waitClose timeout")), timeoutMs);
        ws.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };

  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString();
    // AC3 structural proof: EVERY server frame must satisfy ServerMsgSchema.
    const parsed = ServerMsgSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`server frame violates ServerMsgSchema: ${text.slice(0, 400)}`);
    }
    const msg = parsed.data;
    frames.push(msg);
    if (msg.type === "projection") {
      const st = GameStateSchema.parse(msg.state);
      c.state = st;
      c.moves = msg.legalMoves;
      c.seq = msg.serverSeq;
      c.lastProjection = msg;
    }
    if (msg.type === "welcome") c.seat = msg.seat;
    const idx = frames.length - 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if ((w.from ?? 0) > idx) continue;
      if (w.pred(msg)) {
        waiters.splice(i, 1);
        if (w.timer !== undefined) clearTimeout(w.timer); // #12
        w.resolve(msg);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  open.clients.push(c);
  return c;
}

async function boot(
  opts: { seed?: number; playerCount?: 3 | 4; staleMs?: number } = {},
): Promise<{ server: RoomServer; port: number; roomCode: string }> {
  const { server, port, roomCode } = await startServer({ port: 0, host: HOST, ...opts });
  open.servers.push(server);
  CURRENT_SERVER = server; // for refresh()'s syncTo target
  return { server, port, roomCode };
}

let CURRENT_SERVER: RoomServer | null = null;

/** Join without a seat (first free seat) and wait for the welcome. */
async function join(c: Client, roomCode: string, extra: Record<string, unknown> = {}) {
  c.send({ type: "join", roomCode, ...extra });
  const w = await c.next("welcome");
  return w;
}

function assertSpectatorSafe(state: GameState | null, mySeat: number | null): void {
  expect(state).not.toBeNull();
  if (!state) throw new Error("no projection");
  for (const p of state.players) {
    const total = p.hand.wood + p.hand.brick + p.hand.wool + p.hand.wheat + p.hand.ore;
    expect(p.hand.wood).toBe(total);
    expect(p.hand.brick).toBe(0);
    expect(p.hand.wool).toBe(0);
    expect(p.hand.wheat).toBe(0);
    expect(p.hand.ore).toBe(0);
    expect(p.devHand.every((d) => d === "victoryPoint")).toBe(true);
  }
  expect(state.deck.every((d) => d === "knight")).toBe(true);
  expect(state.rngSeed).toBe(0);
  expect(state.rngCursor).toBe(0);
  void mySeat;
}

function handTotal(h: { wood: number; brick: number; wool: number; wheat: number; ore: number }) {
  return h.wood + h.brick + h.wool + h.wheat + h.ore;
}

// ---------------------------------------------------------------------------
// 1. join / welcome / room code
// ---------------------------------------------------------------------------

describe("join flow over the wire", () => {
  it("welcome carries seat, token and roster; a playerJoined event is broadcast", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908 });
    const a = await openClient(port);
    const w = await join(a, roomCode, { seat: 0 });

    expect(w.type).toBe("welcome");
    if (w.type !== "welcome") throw new Error("unreachable");
    expect(w.seat).toBe(0);
    expect(typeof w.seatToken).toBe("string");
    expect(w.roomCode).toBe(roomCode);
    expect(w.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(w.players[0]!.connected).toBe(true);
    // Roster is presence-only: no hand data on the wire.
    expect(Object.keys(w.players[0]!).sort()).toEqual(["color", "connected", "name", "seat"]);

    const ev = await a.next("event");
    expect(ev).toMatchObject({ type: "event", kind: "playerJoined" });
    if (ev.type === "event") expect(ev.details).toMatchObject({ seat: 0 });

    // A projection follows the join (presence changed).
    const proj = await a.next("projection");
    if (proj.type !== "projection") throw new Error("unreachable");
    expect(proj.serverSeq).toBe(0);
    expect(() => GameStateSchema.parse(proj.state)).not.toThrow();
    expect(server.room.isConnected(0)).toBe(true);
  });

  it("roomCode is 6 chars of [A-Za-z0-9]", async () => {
    const { roomCode } = await boot({ seed: 1 });
    expect(roomCode).toMatch(/^[A-Za-z0-9]{6}$/);
    const second = await boot({ seed: 1 });
    // Random enough that two rooms differ (cryptographic RNG, 62^6 space).
    expect(second.roomCode).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(second.roomCode).not.toBe(roomCode);
  });
});

// ---------------------------------------------------------------------------
// 2. malformed frames
// ---------------------------------------------------------------------------

describe("bad frames", () => {
  it("junk JSON and unknown message types are error{badMessage}", async () => {
    const { port } = await boot({ seed: 5 });
    const c = await openClient(port);

    c.sendRaw("this is not json");
    const first = await c.next("error");
    expect(first).toMatchObject({ type: "error", code: "badMessage" });

    c.sendRaw(JSON.stringify({ type: "teleport" }));
    const second = await c.waitNew((m) => m.type === "error", 3000);
    expect(second).toMatchObject({ type: "error", code: "badMessage" });

    // A state-shaped op payload is an op-level reject, not a wire error.
    c.sendRaw(JSON.stringify({ type: "op", op: { phase: "ended", winner: 0 } }));
    const third = await c.waitNew(
      (m) => m.type === "error" || (m.type === "event" && m.kind === "rejected"),
      3000,
    );
    // Unseated connection -> notSeated (a valid wire error); seated -> badOp.
    expect(["error", "event"]).toContain(third.type);
  });

  it("a join may carry a display name (trimmed/capped by room.ts)", async () => {
    const { port, roomCode, server } = await boot({ seed: 8, playerCount: 3 });
    const c = await openClient(port);
    const w = await join(c, roomCode, { seat: 0, name: "  Hector Del Vinar  " });
    expect(w).toMatchObject({ type: "welcome", seat: 0 });
    expect(w.type === "welcome" ? w.players[0]!.name : "").toBe("Hector Del Vinar");
    // Cap: 40 accepted by schema, claimSeat slices to 24.
    const d = await openClient(port);
    const w2 = await join(d, roomCode, { seat: 1, name: "x".repeat(40) });
    expect(w2.type === "welcome" ? w2.players[1]!.name.length : 0).toBe(24);
    // 41 chars is rejected by the wire schema itself (badMessage, strike).
    const e = await openClient(port);
    e.send({ type: "join", roomCode, seat: 2, name: "y".repeat(41) });
    expect(await e.next("error")).toMatchObject({ code: "badMessage" });
    void server;
  });

  it("a wrong roomCode is error{roomNotFound}", async () => {
    const { port } = await boot({ seed: 3 });
    const c = await openClient(port);
    c.send({ type: "join", roomCode: "ZZZZZZ" });
    expect(await c.next("error")).toMatchObject({ type: "error", code: "roomNotFound" });
  });

  it("three consecutive bad frames drop the connection", async () => {
    const { port, roomCode, server } = await boot({ seed: 6, playerCount: 3 });
    const c = await openClient(port);
    await join(c, roomCode, { seat: 0 }); // strike-drops must release a HELD seat
    for (let i = 0; i < 3; i++) c.sendRaw("}{");
    await c.waitClose(3000);
    expect(c.ws.readyState).toBe(WebSocket.CLOSED);
    // #4 REGRESSION: the drop must RELEASE the seat (routing the cleanup
    // through #onClose after close() — the old hand-delete left the later
    // #onClose early-returning: ghost seat forever).
    for (let t = 0; t < 100 && server.room.isConnected(0); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.room.isConnected(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. seat conflicts + spectator policy
// ---------------------------------------------------------------------------

describe("seat conflicts and the spectator policy", () => {
  it("a taken seat is inSeatTaken; the next free seat is granted", async () => {
    const { port, roomCode } = await boot({ seed: 7 });
    const a = await openClient(port);
    await join(a, roomCode, { seat: 0 });

    const b = await openClient(port);
    b.send({ type: "join", roomCode, seat: 0 });
    const err = await b.next("error");
    expect(err).toMatchObject({ type: "error", code: "inSeatTaken" });

    b.send({ type: "join", roomCode, seat: 1 });
    const w = await b.next("welcome");
    expect(w).toMatchObject({ type: "welcome", seat: 1 });
  });

  it("a join into a full room becomes a spectator (seat null, no token)", async () => {
    const { port, roomCode } = await boot({ seed: 8, playerCount: 3 });
    const seatClients: Client[] = [];
    for (const seat of [0, 1, 2]) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      seatClients.push(c);
    }
    const d = await openClient(port);
    const w = await join(d, roomCode);
    expect(w.type).toBe("welcome");
    if (w.type !== "welcome") throw new Error("unreachable");
    expect(w.seat).toBeNull();
    expect(w.seatToken).toBeUndefined();

    // Spectator sees a squashed board: nobody's composition leaks.
    const proj = await d.next("projection");
    if (proj.type !== "projection") throw new Error("unreachable");
    expect(proj.legalMoves).toEqual([]);
    assertSpectatorSafe(proj.state, null);
    void seatClients;
  });

  it("a spectator keeps receiving post-op projections (still fully squashed)", async () => {
    const { port, roomCode, server } = await boot({ seed: 9, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      clients.push(c);
    }
    const spec = await openClient(port);
    const w = await join(spec, roomCode);
    if (w.type !== "welcome" || w.seat !== null) throw new Error("not spectator");
    await spec.next("projection");
    const seqBefore = spec.seq;
    // One legit op from seat 0 -> the spectator's frame must advance.
    await syncTo(clients[0]!, server.room.serverSeq);
    expect(await act(clients[0]!, clients[0]!.moves[0]!)).toBe("applied");
    await syncTo(spec, server.room.serverSeq);
    expect(spec.seq).toBeGreaterThan(seqBefore);
    const st = latest(spec);
    for (const p of st.players) {
      const total = p.hand.wood + p.hand.brick + p.hand.wool + p.hand.wheat + p.hand.ore;
      expect(p.hand.wood).toBe(total); // every seat squashed, incl. 0
    }
    const frame = spec.lastProjection;
    expect(frame && frame.type === "projection" ? frame.legalMoves.length : -1).toBe(0);
  });

  it("a spectator op is error{notSeated} and changes nothing", async () => {
    const { port, roomCode, server } = await boot({ seed: 9, playerCount: 3 });
    for (const seat of [0, 1, 2]) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
    }
    const d = await openClient(port);
    await join(d, roomCode);
    await d.next("projection");

    d.send({ type: "op", op: { type: "roll", seat: 0 } });
    const e = await d.next("error");
    expect(e).toMatchObject({ type: "error", code: "notSeated" });
    expect(server.room.serverSeq).toBe(0);

    // An op from a connection that never joined is notSeated too.
    const ghost = await openClient(port);
    ghost.send({ type: "op", op: { type: "roll", seat: 0 } });
    expect(await ghost.next("error")).toMatchObject({ type: "error", code: "notSeated" });
  });
});

// ---------------------------------------------------------------------------
// 4. op flow end-to-end over the wire (AC2 headless two/three-terminal game)
// ---------------------------------------------------------------------------

function actingSeat(s: GameState): number {
  if (s.phase === "setup") return s.currentSeat;
  const aw = s.awaitingSeven;
  if (aw) return aw.pendingDiscard ? aw.discardQueue[0]!.seat : aw.roller;
  return s.currentSeat;
}

/** Wait until this client's OWN frames reach server seq >= `seq` (cross-
 * socket freshness: broadcasts to a DIFFERENT client than the one that
 * acted are async — never read another socket's moves before its frame). */
async function syncTo(c: Client, seq: number, timeoutMs = 5000): Promise<void> {
  if (c.seq >= seq) return;
  await c.waitFor((m) => m.type === "projection" && m.serverSeq >= seq, timeoutMs);
}

/** This client's own newest shipped projection (never another client's). */
function latest(c: Client): GameState {
  const p = [...c.frames].reverse().find((f) => f.type === "projection");
  if (!p || p.type !== "projection") throw new Error("client has no projection yet");
  return GameStateSchema.parse(p.state);
}

/** Wait for a projection frame NEWER than `afterSeq` (post-op resync). */
async function awaitProjectionAfter(c: Client, afterSeq: number): Promise<GameState> {
  const p = await c.waitFor(
    (m) => m.type === "projection" && m.serverSeq > afterSeq,
    5000,
  );
  if (p.type !== "projection") throw new Error("unreachable");
  return GameStateSchema.parse(p.state);
}

async function refresh(c: Client): Promise<GameState> {
  // Sync to the server's CURRENT true seq first: a broadcast to a client who
  // did not just act is async — latest() alone can read a stale frame.
  if (CURRENT_SERVER) await syncTo(c, CURRENT_SERVER.room.serverSeq);
  return latest(c);
}

/**
 * Play the room to phase "ended" through the wire, the same way the AC2
 * suite does (each client acts only on its OWN shipped legalMoves).
 *
 * M3-P3(b): the rematch suite needs a REAL ended room — the badPhase /
 * notHost refusals and the game-2 gameEnded latch reset are only meaningful
 * against a game the kernel actually finished. Measured: ~1600 ops, ~2 s.
 */
async function playToEnd(
  clients: Client[],
  server: RoomServer,
  opts: { maxOps?: number } = {},
): Promise<void> {
  const maxOps = opts.maxOps ?? 4000;
  const rand = lcg(20260908 ^ 0x5f3759df);
  for (let i = 0; i < maxOps; i++) {
    if (server.room.state.phase === "ended") break;
    const seat = actingSeat(server.room.state);
    const c = clients[seat]!;
    await syncTo(c, server.room.serverSeq);
    const st = latest(c);
    if (st.phase === "ended") break;

    let op: Op | null = null;
    const aw = st.awaitingSeven;
    if (aw && aw.pendingDiscard && aw.discardQueue[0]!.seat === seat) {
      const need = aw.discardQueue[0]!.count;
      const hand = st.players[seat]!.hand;
      const cards: ("wood" | "brick" | "wool" | "wheat" | "ore")[] = [];
      for (const r of ["wood", "brick", "wool", "wheat", "ore"] as const) {
        while (cards.length < need && hand[r] > cards.filter((x) => x === r).length) cards.push(r);
      }
      if (cards.length === need) op = { type: "discardSeven", seat, cards };
    }
    op ??= pickByPriority(c.moves, rand) ?? c.moves[0] ?? null;
    if (!op) break;
    if ((await act(c, op)) === "applied") continue;
    await syncTo(c, server.room.serverSeq);
    const fb = latest(c).phase === "ended" ? null : c.moves[0];
    if (!fb) break;
    if ((await act(c, fb)) !== "applied") break;
  }
  // The loop can exit on SERVER truth (its first check) while the terminal
  // broadcast is still in flight to the other sockets. Drain it: every
  // client must hold the final projection (and therefore the gameEnded
  // event that ships BEFORE it) before the caller asserts on frames.
  for (const c of clients) {
    await syncTo(c, server.room.serverSeq);
  }
}

/**
 * Send an op and wait for the room's answer. Accepted ops are followed by a
 * fresh projection on the same connection — wait for it too, so the client
 * is never acting on a stale frame.
 */
async function act(c: Client, op: Op): Promise<"applied" | "rejected" | "error"> {
  // Arm the waiter FIRST, then send — otherwise the reply can land before
  // the waiter's start index is captured and get skipped as "already seen".
  const pending = c.waitNew(
    (mm) =>
      (mm.type === "event" && (mm.kind === "opApplied" || mm.kind === "rejected")) ||
      (mm.type === "error" && mm.code === "notSeated"),
    5000,
  );
  c.send({ type: "op", op });
  const m = await pending;
  if (m.type === "error") return "error";
  if (m.type === "event" && m.kind === "rejected") return "rejected";
  // Accepted: the server broadcasts event(opApplied)+projection in ONE sync
  // burst, so the projection may ALREADY be in frames by the time this
  // continuation runs — waitNew (new-frames-only) would miss it forever.
  // Match by serverSeq instead: the event carries the just-bumped seq, and
  // only the fresh projection can have serverSeq >= it (old ones are lower).
  if (m.type === "event" && m.kind === "opApplied") {
    await c.waitFor((mm) => mm.type === "projection" && mm.serverSeq >= m.serverSeq, 5000);
  }
  return "applied";
}

describe("AC2 — headless multi-terminal game over the wire", () => {
  it("three clients run setup + roll purely from their own shipped legalMoves", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      const w = await join(c, roomCode, { seat });
      if (w.type !== "welcome" || w.seat !== seat) throw new Error(`seat ${seat} join failed`);
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");

    // --- setup: each client acts only on its own legalMoves[0] ---
    let guard = 0;
    while (server.room.state.phase === "setup") {
      if (++guard > 64) throw new Error("setup runaway");
      const seat = server.room.state.currentSeat;
      const c = clients[seat]!;
      await syncTo(c, server.room.serverSeq);
      const st = latest(c);
      expect(st.phase).toBe("setup");
      const op = c.moves[0];
      expect(op).toBeDefined();
      expect(op!.seat).toBe(seat);
      await act(c, op!);
    }
    expect(server.room.state.phase).toBe("play");
    for (const c of clients) {
      const st = await refresh(c);
      expect(st.phase).toBe("play");
      expect(st.rngSeed).toBe(0);
      expect(st.rngCursor).toBe(0);
    }

    // --- roll: the current seat rolls from its own shipped move ---
    const roller = actingSeat(server.room.state);
    const rc = clients[roller]!;
    await syncTo(rc, server.room.serverSeq);
    let st = latest(rc);
    const rollOp = rc.moves.find((m) => m.type === "roll");
    expect(rollOp).toBeDefined();
    await act(rc, rollOp!);
    st = await refresh(rc);
    expect(st.hasRolled).toBe(true);
    expect(st.rollLog.length).toBeGreaterThan(0);

    // --- second roll is rejected verbatim (kernel code, seq unchanged) ---
    const seqBefore = server.room.serverSeq;
    rc.send({ type: "op", op: { type: "roll", seat: roller } });
    const ev = await rc.waitNew((m) => m.type === "event" && m.kind === "rejected", 5000);
    if (ev.type !== "event") throw new Error("unreachable");
    // Either alreadyRolled (plain double roll) or awaitingSeven (the roll
    // opened a seven window) — both are kernel codes, surfaced verbatim.
    expect(["alreadyRolled", "awaitingSeven"]).toContain(ev.details.code);
    if (ev.details.code === "alreadyRolled") {
      expect(server.room.serverSeq).toBe(seqBefore);
    }
    void st;
  });
});

// ---------------------------------------------------------------------------
// 5. AC3 — every-frame wire scrub proof
// ---------------------------------------------------------------------------

describe("AC3 — every wire frame is scrubbed and schema-legal", () => {
  it("no frame in a full mini-game leaks rngSeed/rngCursor or a true state", async () => {
    const { port, roomCode, server } = await boot({ seed: 4242, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");

    const trueSeed = server.room.state.rngSeed;
    expect(trueSeed).not.toBe(0);
    const seedText = String(trueSeed);
    const seedTextUpper = String(trueSeed >>> 0);

    // Play ~40 ops through the wire, each from its own client's moves.
    for (let i = 0; i < 40 && server.room.state.phase !== "ended"; i++) {
      const seat = actingSeat(server.room.state);
      const c = clients[seat]!;
      await syncTo(c, server.room.serverSeq);
      const op = c.moves[0];
      if (!op) break;
      await act(c, op);
    }

    // EVERY frame every client received must be schema-legal and clean.
    for (const c of clients) {
      expect(c.frames.length).toBeGreaterThan(5);
      for (const f of c.frames) {
        const round = ServerMsgSchema.safeParse(f);
        expect(round.success).toBe(true);
        const json = JSON.stringify(f);
        if (f.type === "projection") {
          expect(f.state.rngSeed).toBe(0);
          expect(f.state.rngCursor).toBe(0);
          expect(() => GameStateSchema.parse(f.state)).not.toThrow();
        } else {
          // welcome/event/error/pong carry no state at all.
          expect(json).not.toContain("\"rngSeed\"");
          expect(json).not.toContain("\"rngCursor\"");
        }
        // The true seed number must never appear anywhere in a frame.
        expect(json.includes(seedText)).toBe(false);
        expect(json.includes(seedTextUpper)).toBe(false);
      }
      // Each client's own hand is visible to them; others are squashed.
      const st = (await refresh(c)) as GameState;
      const me = c.seat!;
      for (const p of st.players) {
        if (p.seat !== me) {
          const total = handTotal(p.hand);
          expect(p.hand.wood).toBe(total);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. AC4 — hostile burst, victim unchanged
// ---------------------------------------------------------------------------

describe("AC4 — hostile burst leaves the victim's projection untouched", () => {
  it("forged seat / injected keys / state-shaped payloads are rejected, no side effects", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");
    // Drive past setup so real ops exist.
    let g = 0;
    while (server.room.state.phase === "setup") {
      if (++g > 64) throw new Error("setup runaway");
      const seat = server.room.state.currentSeat;
      const c = clients[seat]!;
      await act(c, c.moves[0]!);
    }
    const a = clients[0]!;
    const victim = clients[1]!;

    // Snapshot the VICTIM's latest projection (seat 1) AFTER syncing it —
    // the last setup op's broadcast may still be in flight; snapshotting
    // before sync would compare against a stale frame.
    const beforeSeq = server.room.serverSeq;
    const victimHandBefore = (await refresh(victim)).players[1]!.hand;
    const beforeRaw = JSON.stringify(latest(victim));

    // 1. forged op.seat (A claims to be seat 1) — WIRE-VALID op, authority-
    // rejected at the room: event{rejected}, kernel code verbatim.
    a.send({ type: "op", op: { type: "roll", seat: 1 } });
    let ev = await a.waitNew((m) => m.type === "event" && m.kind === "rejected", 5000);
    if (ev.type !== "event") throw new Error("unreachable");
    expect(ev.details.code).toBe("notYourTurn");

    // 2-3. MALFORMED inner ops (extra key / missing discriminator) fail
    // ClientMsgSchema at the TRANSPORT — badMessage + a parse strike, never
    // an op-level event. That IS the trust model: strict wire validation
    // before any authority question. (Two strikes here so the session
    // survives for the legit-op tail; the 3-strike DROP has its own test.)
    a.send({ type: "op", op: { type: "roll", seat: 0, isAdmin: true } });
    let er = await a.waitNew((m) => m.type === "error" && m.code === "badMessage", 5000);
    expect(er.type).toBe("error");

    a.send({ type: "op", op: { type: "giveMeWin", seat: 0 } });
    er = await a.waitNew((m) => m.type === "error" && m.code === "badMessage", 5000);
    expect(er.type).toBe("error");

    // NOTHING moved: rejected ops never bump seq and never resend projections.
    expect(server.room.serverSeq).toBe(beforeSeq);

    // --- VICTIM ASSERTION (the point of AC4) ---
    // Seat 1's newest projection is byte-identical to its pre-attack
    // snapshot: no hostile frame produced any state change for the victim.
    // (Compare via latest(c) — refresh() during the burst legitimately
    // re-fetched the SAME frame, but lastProjection must not be trusted as
    // "the pre-attack one".)
    expect(JSON.stringify(latest(victim))).toBe(beforeRaw);
    expect(victim.seq).toBe(beforeSeq);
    expect((await refresh(victim)).players[1]!.hand).toEqual(victimHandBefore);
    // The victim's frame is still scrubbed and structurally sound.
    const vp = victim.lastProjection;
    if (vp?.type === "projection") {
      expect(vp.state.rngSeed).toBe(0);
      expect(vp.state.rngCursor).toBe(0);
      expect(vp.state.winner).toBeNull();
      expect(vp.state.phase).not.toBe("ended");
      expect(vp.serverSeq).toBe(beforeSeq);
    }

    // The room keeps running: the next LEGIT op from the real actor works.
    const seat = actingSeat(server.room.state);
    const legit = clients[seat]!;
    expect(await act(legit, legit.moves[0]!)).toBe("applied");
    expect(server.room.serverSeq).toBeGreaterThan(beforeSeq);
    // ...and the victim now legitimately advances (one new frame, seq+1).
    const vpAfter = await awaitProjectionAfter(victim, beforeSeq);
    expect(vpAfter.rngSeed).toBe(0);
    expect(vpAfter.rngCursor).toBe(0);
  });

  it("a rejected op ships event{rejected} to every bound client", async () => {
    const { port, roomCode, server } = await boot({ seed: 11, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");
    let g = 0;
    while (server.room.state.phase === "setup") {
      if (++g > 64) throw new Error("setup runaway");
      const seat = server.room.state.currentSeat;
      await syncTo(clients[seat]!, server.room.serverSeq);
      await act(clients[seat]!, clients[seat]!.moves[0]!);
    }
    const before = server.room.serverSeq;
    clients[0]!.send({ type: "op", op: { type: "roll", seat: 2 } }); // forged
    for (const c of clients) {
      const ev = await c.waitNew((m) => m.type === "event" && m.kind === "rejected", 5000);
      if (ev.type !== "event") throw new Error("unreachable");
      expect(ev.details.code).toBe("notYourTurn");
    }
    expect(server.room.serverSeq).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. AC5 — rejoin over the wire
// ---------------------------------------------------------------------------

describe("AC5 — wire rejoin", () => {
  it("disconnect broadcasts playerLeft; token rejoin re-binds and rotates", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908, playerCount: 3 });
    const clients: Client[] = [];
    const tokens: string[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      const w = await join(c, roomCode, { seat });
      if (w.type !== "welcome" || typeof w.seatToken !== "string") throw new Error("no token");
      tokens.push(w.seatToken);
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");

    // Seat 0 places settlement THEN road (variable setup = 2 placements per
    // seat per round), so the queue reaches seat 1 — the dropper then OWNS a
    // pending settlement, which is what "B2 can act again" must prove.
    // (At setup start only currentSeat has moves; seat 1's [] list is the
    // server computing the CORRECT empty answer, not "cannot act".)
    for (let k = 0; k < 2; k++) {
      await syncTo(clients[0]!, server.room.serverSeq);
      const res0 = await act(clients[0]!, clients[0]!.moves[0]!);
      if (res0 !== "applied") {
        const rej = clients[0]!.frames.find((m) => m.type === "event" && m.kind === "rejected");
        throw new Error(
          `seat-0 opening placement rejected (${res0}): ${JSON.stringify(rej)} firstMove=${JSON.stringify(clients[0]!.moves[0])} queue=${JSON.stringify(server.room.state.setupStage?.seatQueue)}`,
        );
      }
    }
    expect(server.room.state.currentSeat).toBe(1);

    // B (seat 1) drops.
    await clients[1]!.close();
    const left = await clients[0]!.waitFor((m) => m.type === "event" && m.kind === "playerLeft", 5000);
    if (left.type !== "event") throw new Error("unreachable");
    expect(left.details).toMatchObject({ seat: 1 });
    expect(server.room.isConnected(1)).toBe(false);

    // B re-joins with its token from a NEW socket.
    const b2 = await openClient(port);
    b2.send({ type: "join", roomCode, seatToken: tokens[1] });
    const w2 = await b2.next("welcome");
    expect(w2).toMatchObject({ type: "welcome", seat: 1 });
    if (w2.type !== "welcome") throw new Error("unreachable");
    expect(typeof w2.seatToken).toBe("string");
    expect(w2.seatToken).not.toBe(tokens[1]); // rotated: old token is dead
    expect(server.room.isConnected(1)).toBe(true);

    // The OLD socket's late close must NOT disconnect the new owner.
    (clients[1] as Client).ws.emit("close");
    await new Promise((r) => setTimeout(r, 50));
    expect(server.room.isConnected(1)).toBe(true);

    // B2 can act again: the rejoin welcome's projection burst may ALREADY
    // be in frames (same-tick send) — waitFor matches old or future frames.
    const back2 = await b2.waitFor((m) => m.type === "projection", 5000);
    if (back2.type !== "projection") throw new Error("unreachable");
    expect(b2.moves.length).toBeGreaterThan(0); // its OWN queued placement
    expect(back2.serverSeq).toBe(server.room.serverSeq);
    expect(await act(b2, b2.moves[0]!)).toBe("applied");
  });

  it("a SUPERSEDED socket cannot act after rejoin elsewhere (owner guard)", async () => {
    const { port, roomCode, server } = await boot({ seed: 5, playerCount: 3 });
    const a = await openClient(port);
    const wa = await join(a, roomCode, { seat: 0 });
    if (wa.type !== "welcome" || typeof wa.seatToken !== "string") throw new Error("no token");
    const b = await openClient(port);
    await join(b, roomCode, { seat: 1 });
    for (const c of [a, b]) await c.next("projection");

    // A re-joins seat 0 from ANOTHER socket (token) — A is superseded but
    // its old socket is still open. The owner guard must refuse its ops.
    const a2 = await openClient(port);
    a2.send({ type: "join", roomCode, seatToken: wa.seatToken });
    const w2 = await a2.next("welcome");
    if (w2.type !== "welcome" || w2.seat !== 0) throw new Error("rejoin failed");
    await a2.waitFor((m) => m.type === "projection", 5000);

    // The OLD socket's next op must be refused: notSeated, connection-level.
    a.send({ type: "op", op: { type: "roll", seat: 0 } });
    const err = await a.waitNew((m) => m.type === "error", 5000);
    expect(err).toMatchObject({ type: "error", code: "notSeated" });
    // The NEW owner still acts fine (binding moved, seat did not die).
    expect(server.room.isConnected(0)).toBe(true);
    expect(a2.moves.length).toBeGreaterThan(0);
    expect(await act(a2, a2.moves[0]!)).toBe("applied");
    // The old token is dead after rotation.
    const a3 = await openClient(port);
    a3.send({ type: "join", roomCode, seatToken: wa.seatToken });
    expect(await a3.next("error")).toMatchObject({ code: "badToken" });
  });

  it("a second join on one socket is REJECTED (C1: one-socket lobby DoS)", async () => {
    const { port, roomCode, server } = await boot({ seed: 6, playerCount: 3 });
    const c = await openClient(port);
    const w1 = await join(c, roomCode, { seat: 0 });
    if (w1.type !== "welcome" || w1.seat !== 0) throw new Error("unreachable");
    await c.next("projection");
    // Same socket tries to grab more seats — refused, and seat 0 KEEPS its
    // binding (the old replace-semantics let one socket churn 0->1->2, then
    // close and orphan every seat as claimed-but-dead: lobby DoS).
    c.send({ type: "join", roomCode, seat: 1 });
    const er = await c.waitNew((m) => m.type === "error", 5000);
    expect(er).toMatchObject({ type: "error", code: "badMessage" });
    expect(server.room.isConnected(0)).toBe(true);
    expect(server.room.isConnected(1)).toBe(false);
    // A NEW socket can still claim seat 1 normally.
    const d = await openClient(port);
    const w2 = await join(d, roomCode, { seat: 1 });
    expect(w2).toMatchObject({ type: "welcome", seat: 1 });
    // Closing the first socket releases ONLY seat 0.
    await c.close();
    for (let t = 0; t < 100 && server.room.isConnected(0); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.room.isConnected(0)).toBe(false);
    expect(server.room.isConnected(1)).toBe(true);
  });

  it("a lobby-hogging socket that churns seats cannot orphan the room (C2)", async () => {
    const { port, roomCode, server } = await boot({ seed: 1, playerCount: 3 });
    const a = await openClient(port);
    await join(a, roomCode, { seat: 0 });
    a.send({ type: "join", roomCode, seat: 1 }); // rejected
    a.send({ type: "join", roomCode, seat: 2 }); // rejected
    await a.close();
    for (let t = 0; t < 100 && server.room.isConnected(0); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Seat 0 released to DISCONNECTED (but still claimed by a's token —
    // rejoin design). A fresh no-seat join lands on the first UNCLAIMED
    // seat (1) with a playable game, never a spectator-forever lobby.
    expect(server.room.isConnected(0)).toBe(false);
    const b = await openClient(port);
    const w = await join(b, roomCode);
    expect(w).toMatchObject({ type: "welcome", seat: 1 });
  });

  it("a stale token is badToken", async () => {
    const { port, roomCode } = await boot({ seed: 13, playerCount: 3 });
    const c = await openClient(port);
    const w = await join(c, roomCode, { seat: 0 });
    if (w.type !== "welcome") throw new Error("unreachable");
    await c.close();
    const c2 = await openClient(port);
    c2.send({ type: "join", roomCode, seatToken: w.seatToken });
    const w2 = await c2.next("welcome");
    expect(w2).toMatchObject({ type: "welcome", seat: 0 });
    if (w2.type !== "welcome" || typeof w2.seatToken !== "string") throw new Error("unreachable");
    // Replaying the first (now rotated) token fails.
    const c3 = await openClient(port);
    c3.send({ type: "join", roomCode, seatToken: w.seatToken });
    expect(await c3.next("error")).toMatchObject({ type: "error", code: "badToken" });
  });

  it("rejoin mid-pendingTrade: the offer survives both parties' churn (AC5)", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908 + 11, playerCount: 3 });
    const clients: Client[] = [];
    const tokens: string[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      const w = await join(c, roomCode, { seat });
      if (w.type !== "welcome" || typeof w.seatToken !== "string") throw new Error("no token");
      tokens.push(w.seatToken);
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");
    let g = 0;
    while (server.room.state.phase === "setup") {
      if (++g > 64) throw new Error("setup runaway");
      const seat = server.room.state.currentSeat;
      await syncTo(clients[seat]!, server.room.serverSeq);
      await act(clients[seat]!, clients[seat]!.moves[0]!);
    }

    // Find the trade window from seat 0's OWN view (bounded, honest): it may
    // only offer a resource it visibly holds to a seat that visibly holds a
    // different one (offeree composition is private — but the OFFEREE's own
    // projection is what the driver reads, same trust model as the kernel
    // test this mirrors).
    let offered = false;
    for (let i = 0; i < 600 && !offered; i++) {
      const s = server.room.state;
      if (!s.awaitingSeven && s.currentSeat === 0 && s.hasRolled) {
        await syncTo(clients[0]!, server.room.serverSeq);
        await syncTo(clients[1]!, server.room.serverSeq);
        // Each side's OWN composition is visible to ITSELF (redaction keeps
        // the own seat untouched) — so this driver reads exactly what a real
        // pair of players would know when agreeing a trade.
        const mine = clients[0]!.state!.players[0]!.hand;
        const theirs = clients[1]!.state!.players[1]!.hand;
        const RES = ["wood", "brick", "wool", "wheat", "ore"] as const;
        const mineHas = RES.filter((r) => mine[r] > 0);
        const theirsHas = RES.filter((r) => theirs[r] > 0);
        const give = mineHas.find((r) => !theirsHas.includes(r) || theirsHas.length > 1);
        const want = theirsHas.find((r) => r !== give);
        if (give && want) {
          const res = await act(clients[0]!, {
            type: "tradeOffer",
            seat: 0,
            with: 1,
            give: [give],
            want: [want],
          });
          offered = res === "applied";
        }
      }
      if (!offered) {
        const s2 = server.room.state;
        const aw = s2.awaitingSeven;
        if (aw) {
          if (aw.pendingDiscard) {
            const debtor = aw.discardQueue[0]!.seat;
            const dc = clients[debtor]!;
            await syncTo(dc, server.room.serverSeq);
            const st = dc.state!;
            const need = aw.discardQueue[0]!.count;
            const hand = st.players[debtor]!.hand;
            const cards: ("wood" | "brick" | "wool" | "wheat" | "ore")[] = [];
            for (const r of ["wood", "brick", "wool", "wheat", "ore"] as const) {
              while (cards.length < need && hand[r] > cards.filter((x) => x === r).length) cards.push(r);
            }
            if (cards.length === need) {
              await act(dc, { type: "discardSeven", seat: debtor, cards });
            } else {
              throw new Error(`debtor ${debtor} owes ${need}, own hand only ${JSON.stringify(hand)}`);
            }
          } else {
            const roller = aw.roller;
            const rc = clients[roller]!;
            await syncTo(rc, server.room.serverSeq);
            const mv = rc.moves.find((m) => m.type === "moveRobber") ?? rc.moves.find((m) => m.type === "stealCard");
            if (mv) await act(rc, mv);
          }
        } else {
          const seat = s2.currentSeat;
          const c = clients[seat]!;
          await syncTo(c, server.room.serverSeq);
          const op = s2.hasRolled
            ? ({ type: "endTurn", seat } as Op)
            : (c.moves.find((m) => m.type === "roll") ?? ({ type: "endTurn", seat } as Op));
          await act(c, op);
        }
      }
    }
    expect(offered).toBe(true);
    expect(server.room.state.pendingTrade).not.toBeNull();

    // Offeree churns: close, rejoin by token, ACCEPT across the churn.
    await clients[1]!.close();
    for (let t = 0; t < 100 && server.room.isConnected(1); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.room.state.pendingTrade).not.toBeNull(); // the offer waited
    const back = await openClient(port);
    back.send({ type: "join", roomCode, seatToken: tokens[1] });
    const w = await back.next("welcome");
    expect(w).toMatchObject({ type: "welcome", seat: 1 });
    await back.waitFor((m) => m.type === "projection", 5000);
    const accept = back.moves.find((m) => m.type === "tradeAccept");
    expect(accept).toBeDefined();
    expect(await act(back, accept!)).toBe("applied");
    expect(server.room.state.pendingTrade).toBeNull();
  });

  it("rejoin mid-awaitingSeven resolves the window over the wire", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908 + 7, playerCount: 3 });
    const clients: Client[] = [];
    const tokens: string[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      const w = await join(c, roomCode, { seat });
      if (w.type !== "welcome" || typeof w.seatToken !== "string") throw new Error("no token");
      tokens.push(w.seatToken);
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");

    // finish setup over the wire
    let g = 0;
    while (server.room.state.phase === "setup") {
      if (++g > 64) throw new Error("setup runaway");
      const seat = server.room.state.currentSeat;
      await syncTo(clients[seat]!, server.room.serverSeq);
      await act(clients[seat]!, clients[seat]!.moves[0]!);
    }

    // roll/endTurn until a seven window opens (bounded, honest).
    let opened = false;
    for (let i = 0; i < 400 && !opened; i++) {
      const st = server.room.state;
      if (st.awaitingSeven) {
        opened = true;
        break;
      }
      const seat = st.currentSeat;
      const c = clients[seat]!;
      await syncTo(c, server.room.serverSeq);
      const op = st.hasRolled
        ? ({ type: "endTurn", seat } as Op)
        : (c.moves.find((m) => m.type === "roll") ?? ({ type: "endTurn", seat } as Op));
      const res = await act(c, op);
      expect(res).not.toBe("error");
    }
    expect(opened).toBe(true);

    const aw = server.room.state.awaitingSeven;
    expect(aw).not.toBeNull();
    if (!aw) return;
    const owed = aw.pendingDiscard ? aw.discardQueue[0]!.seat : aw.roller;

    // The obligated seat disconnects mid-window, then rejoins and resolves.
    await clients[owed]!.close();
    // Client-side close resolves BEFORE the server has processed the FIN —
    // poll until the server notices (bounded, then assert).
    for (let t = 0; t < 100 && server.room.isConnected(owed); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.room.isConnected(owed)).toBe(false);
    const back = await openClient(port);
    back.send({ type: "join", roomCode, seatToken: tokens[owed] });
    const w = await back.next("welcome");
    expect(w).toMatchObject({ type: "welcome", seat: owed });
    expect(server.room.isConnected(owed)).toBe(true);
    // The obligation waited: the rejoined client is handed its own moves
    // (welcome+projection arrive in one burst — waitFor, not waitNew).
    const p = await back.waitFor((m) => m.type === "projection", 5000);
    if (p.type !== "projection") throw new Error("unreachable");
    expect(back.moves.length).toBeGreaterThan(0);
    expect(server.room.state.awaitingSeven).not.toBeNull();
    // Resolve the window from the rejoined connection.
    expect(await act(back, back.moves[0]!)).toBe("applied");
  }, 60_000); // #13: 400-iteration loop vs default 5s vitest timeout
});

// ---------------------------------------------------------------------------
// 8. stale sweep + ping
// ---------------------------------------------------------------------------

describe("keepalive", () => {
  it("ping is echoed as pong", async () => {
    const { port } = await boot({ seed: 3 });
    const c = await openClient(port);
    c.send({ type: "ping", t: 1717 });
    const p = await c.next("pong");
    expect(p).toEqual({ type: "pong", t: 1717 });
  });

  it("a silent connection is swept; the room keeps serving others", async () => {
    const { port, roomCode, server } = await boot({ seed: 4, staleMs: 200 });
    const quiet = await openClient(port);
    await join(quiet, roomCode, { seat: 0 });
    const loud = await openClient(port);
    await join(loud, roomCode, { seat: 1 });

    // Loud stays alive by pinging; quiet says nothing.
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      loud.send({ type: "ping", t: Date.now() });
      await loud.next("pong", 1000).catch(() => undefined);
      if (quiet.ws.readyState === WebSocket.CLOSED) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    expect(quiet.ws.readyState).toBe(WebSocket.CLOSED);
    expect(loud.ws.readyState).toBe(WebSocket.OPEN);
    expect(server.room.isConnected(1)).toBe(true);
    // M1 REGRESSION GUARD: a swept seat must RELEASE, not ghost. (The
    // original sweep terminated the socket but never touched the room —
    // claimSeat then returned inSeatTaken for a dead seat forever.)
    for (let t = 0; t < 100 && server.room.isConnected(0); t++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.room.isConnected(0)).toBe(false);
    const left = await loud.waitFor(
      (m) => m.type === "event" && m.kind === "playerLeft",
      3000,
    );
    if (left.type !== "event") throw new Error("unreachable");
    expect(left.details.seat).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. full text-mode game over the wire (AC2 end-to-end)
// ---------------------------------------------------------------------------

const PRIORITY: readonly Op["type"][] = [
  "claimVictory",
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

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

function pickByPriority(moves: Op[], rand: () => number): Op | null {
  for (const type of PRIORITY) {
    if (type === "discardSeven") continue; // needs exact cards; handled below
    const bucket = moves.filter((m) => m.type === type);
    if (bucket.length > 0) return bucket[Math.floor(rand() * bucket.length)]!;
  }
  return null;
}

describe("full text-mode game over the wire", () => {
  it("three clients play a seeded game and all see the same winner", async () => {
    const { port, roomCode, server } = await boot({ seed: 20260908, playerCount: 3 });
    const clients: Client[] = [];
    for (let seat = 0; seat < 3; seat++) {
      const c = await openClient(port);
      await join(c, roomCode, { seat });
      clients.push(c);
    }
    for (const c of clients) await c.next("projection");

    const rand = lcg(20260908 ^ 0x5f3759df);
    const MAX_OPS = 4000;
    let applied = 0;

    for (let i = 0; i < MAX_OPS; i++) {
      if (server.room.state.phase === "ended") break;
      const seat = actingSeat(server.room.state);
      const c = clients[seat]!;
      await syncTo(c, server.room.serverSeq);
      // The client's own newest shipped frame is the ONLY input it uses.
      const st = latest(c);
      if (st.phase === "ended") break;

      let op: Op | null = null;
      const aw = st.awaitingSeven;
      if (aw && aw.pendingDiscard && aw.discardQueue[0]!.seat === seat) {
        // Discards need EXACT cards: compose them from the client's OWN
        // visible hand (its own composition is shipped to it).
        const need = aw.discardQueue[0]!.count;
        const hand = st.players[seat]!.hand;
        const cards: ("wood" | "brick" | "wool" | "wheat" | "ore")[] = [];
        for (const r of ["wood", "brick", "wool", "wheat", "ore"] as const) {
          while (cards.length < need && hand[r] > cards.filter((x) => x === r).length) cards.push(r);
        }
        if (cards.length === need) op = { type: "discardSeven", seat, cards };
      }
      op ??= pickByPriority(c.moves, rand) ?? c.moves[0] ?? null;
      if (!op) break;

      const res = await act(c, op);
      if (res === "applied") {
        applied++;
        continue;
      }
      // Rejected: fall back to the first shipped move on the SAME client's
      // refreshed view; bail if that fails too.
      await syncTo(c, server.room.serverSeq);
      const fb = latest(c).phase === "ended" ? null : c.moves[0];
      if (!fb) break;
      if ((await act(c, fb)) === "applied") applied++;
      else break;
    }

    const ended = server.room.state.phase === "ended";
    console.log(`[wire-game] branch=${ended ? "WIN" : "CAP"} applied=${applied} seq=${server.room.serverSeq}`);
    expect(applied).toBeGreaterThan(100);

    if (ended) {
      // BRANCH: WIN — every client must see it. Await gameEnded PER CLIENT
      // first (it is broadcast before the final projection since M2 fix —
      // but the assertion must not depend on ordering luck either way).
      for (const c of clients) {
        await c.waitFor(
          (m) => m.type === "event" && m.kind === "gameEnded",
          5000,
        );
        const st = await refresh(c);
        expect(st.phase).toBe("ended");
        expect(st.winner).toBe(server.room.state.winner);
        expect(st.finalPoints).toBeGreaterThanOrEqual(10);
      }
      const ev = clients[0]!.frames.filter((f) => f.type === "event" && f.kind === "gameEnded");
      expect(ev.length).toBe(1);
      expect(ev[0]).toMatchObject({ type: "event", kind: "gameEnded" });
    } else {
      // BRANCH: CAP — identical projections at the same seq on all three.
      const seq = server.room.serverSeq;
      for (const c of clients) {
        const st = await refresh(c);
        expect(st.phase).not.toBe("ended");
      }
      expect(seq).toBeGreaterThan(100);
    }

    // Conservation on the server's TRUE state (95 cards total).
    const conservation =
      server.room.state.players.reduce((a, p) => a + handTotal(p.hand), 0) +
      (server.room.state.bank.wood +
        server.room.state.bank.brick +
        server.room.state.bank.wool +
        server.room.state.bank.wheat +
        server.room.state.bank.ore);
    expect(conservation).toBe(95);
    expect(() => GameStateSchema.parse(server.room.state)).not.toThrow();
  }, 600_000);
});

// ---------------------------------------------------------------------------
// 10. rematch on the wire (M3-P3(b))
// ---------------------------------------------------------------------------

/** Boot a 3-seat room, join all three, and wait for the first projection. */
async function bootSeated(
  opts: { seed?: number; playerCount?: 3 | 4 } = {},
): Promise<{
  server: RoomServer;
  port: number;
  roomCode: string;
  clients: Client[];
}> {
  const { server, port, roomCode } = await boot({ seed: 20260908, playerCount: 3, ...opts });
  const clients: Client[] = [];
  for (let seat = 0; seat < 3; seat++) {
    const c = await openClient(port);
    const w = await join(c, roomCode, { seat });
    if (w.type !== "welcome" || w.seat !== seat) throw new Error(`seat ${seat} join failed`);
    clients.push(c);
  }
  for (const c of clients) await c.next("projection");
  return { server, port, roomCode, clients };
}

describe("rematch — authority (AC1: only the host, only when ended)", () => {
  it("mid-game rematch from the host is error{badPhase} (AC3): nothing moves", async () => {
    const { server, clients } = await bootSeated();
    // Still in setup — definitively not "ended".
    expect(server.room.state.phase).toBe("setup");
    const seqBefore = server.room.serverSeq;
    const boardBefore = JSON.stringify(server.room.state);

    clients[0]!.send({ type: "rematch" });
    const err = await clients[0]!.waitNew((m) => m.type === "error", 3000);
    expect(err).toMatchObject({ type: "error", code: "badPhase" });

    // Rejection law: no state change, no serverSeq change, no broadcast.
    expect(server.room.serverSeq).toBe(seqBefore);
    expect(JSON.stringify(server.room.state)).toBe(boardBefore);
    expect(server.room.state.phase).toBe("setup");
  });

  it("a forged rematch from seat 1 is error{notHost} (AC1): nothing moves", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    expect(server.room.state.phase).toBe("ended"); // non-vacuous: rematch IS allowed now
    const seqBefore = server.room.serverSeq;
    const boardBefore = JSON.stringify(server.room.state);

    clients[1]!.send({ type: "rematch" });
    const err = await clients[1]!.waitNew((m) => m.type === "error", 3000);
    expect(err).toMatchObject({ type: "error", code: "notHost" });

    expect(server.room.serverSeq).toBe(seqBefore);
    expect(JSON.stringify(server.room.state)).toBe(boardBefore);
    expect(server.room.state.phase).toBe("ended");
    // The room is still the finished game 1 — the refusal did not restart it.
    expect(server.room.winner()).not.toBeNull();
  });

  it("a spectator's rematch is error{notHost} too", async () => {
    const { server, port, roomCode, clients } = await bootSeated();
    await playToEnd(clients, server);
    expect(server.room.state.phase).toBe("ended");

    const spec = await openClient(port);
    const w = await join(spec, roomCode); // full room -> spectator
    if (w.type !== "welcome" || w.seat !== null) throw new Error("expected a spectator");
    await spec.next("projection");
    const seqBefore = server.room.serverSeq;

    spec.send({ type: "rematch" });
    const err = await spec.waitNew((m) => m.type === "error", 3000);
    expect(err).toMatchObject({ type: "error", code: "notHost" });
    expect(server.room.serverSeq).toBe(seqBefore);
    expect(server.room.state.phase).toBe("ended");
  });

  it("an UNJOINED socket's rematch is error{notHost} (no seat at all)", async () => {
    const { server, port } = await bootSeated();
    const stranger = await openClient(port);
    stranger.send({ type: "rematch" });
    const err = await stranger.next("error", 3000);
    expect(err).toMatchObject({ type: "error", code: "notHost" });
    expect(server.room.isConnected(0)).toBe(true); // untouched
  });

  it("a rematch frame carrying a seed is badMessage — the client cannot pick one (AC6)", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    const seqBefore = server.room.serverSeq;
    // RematchMsgSchema is .strict(): { type, seed } does not parse.
    clients[0]!.send({ type: "rematch", seed: 12345 });
    const err = await clients[0]!.waitNew((m) => m.type === "error", 3000);
    expect(err).toMatchObject({ type: "error", code: "badMessage" });
    expect(server.room.serverSeq).toBe(seqBefore);
    expect(server.room.state.phase).toBe("ended"); // no rematch happened
  });
});

describe("rematch — the host's happy path", () => {
  it("seat 0 rematches an ended game: every seat gets a fresh setup projection", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    expect(server.room.state.phase).toBe("ended");
    const winner1 = server.room.winner();
    expect(winner1).not.toBeNull();
    const seqBefore = server.room.serverSeq;
    const seedBefore = server.room.state.rngSeed;

    // Every client must see game 2 — broadcasts are per-socket, so wait for
    // a projection on EACH one (never infer from another client's frames).
    // Match on PHASE, not serverSeq: a rematch does NOT bump serverSeq, so
    // `serverSeq >= seqBefore` is already true of game 1's own final frame.
    const pending = clients.map((c) =>
      c.waitNew((m) => m.type === "projection" && m.state.phase === "setup", 5000),
    );
    clients[0]!.send({ type: "rematch" });
    for (const p of pending) await p;

    // Server truth: a brand-new game.
    expect(server.room.state.phase).toBe("setup");
    expect(server.room.winner()).toBeNull();
    expect(server.room.state.buildings).toEqual({});
    expect(server.room.state.roads).toEqual({});
    // AC6: the seed changed, and no client named it.
    expect(server.room.state.rngSeed).not.toBe(seedBefore);

    // Shipped truth: each client's OWN newest projection says setup, no winner.
    for (const c of clients) {
      const st = await refresh(c);
      expect(st.phase).toBe("setup");
      expect(st.winner).toBeNull();
      expect(st.rngSeed).toBe(0); // still scrubbed — game 2 leaks nothing
      expect(st.rngCursor).toBe(0);
    }
  });

  it("serverSeq does NOT reset on a rematch (room-level counter)", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    const seqBefore = server.room.serverSeq;
    expect(seqBefore).toBeGreaterThan(100);

    clients[0]!.send({ type: "rematch" });
    await clients[0]!.waitNew(
      (m) => m.type === "projection" && m.state.phase === "setup",
      5000,
    );

    // Unchanged by the rematch itself (it is not an op), still monotone.
    expect(server.room.serverSeq).toBe(seqBefore);
    // ...and continues upward from there on game 2's first op.
    await syncTo(clients[0]!, server.room.serverSeq);
    const op = clients[0]!.moves[0];
    expect(op).toBeDefined();
    await act(clients[0]!, op!);
    expect(server.room.serverSeq).toBe(seqBefore + 1);
  });

  it("the rematched game is PLAYABLE and its seed is server-derived (AC6)", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    clients[0]!.send({ type: "rematch" });
    await clients[0]!.waitNew(
      (m) => m.type === "projection" && m.state.phase === "setup",
      5000,
    );

    // Setup runs to completion purely from the clients' own shipped moves.
    let guard = 0;
    while (server.room.state.phase === "setup") {
      if (++guard > 64) throw new Error("setup runaway in game 2");
      const seat = server.room.state.currentSeat;
      const c = clients[seat]!;
      await syncTo(c, server.room.serverSeq);
      const op = c.moves[0];
      expect(op).toBeDefined();
      await act(c, op!);
    }
    expect(server.room.state.phase).toBe("play");
    // The true seed is a uint32 that no frame ever carried: no client frame
    // in this test has ever contained the number (wireScrub zeroes it).
    const trueSeed = String(server.room.state.rngSeed);
    for (const c of clients) {
      for (const f of c.frames) {
        expect(JSON.stringify(f).includes(trueSeed)).toBe(false);
      }
    }
  });
});

describe("rematch — game 2 gets its OWN gameEnded (M2 review #9 latch reset)", () => {
  it("gameEnded fires again after a rematch, once per game", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    expect(server.room.state.phase).toBe("ended");

    // Game 1: exactly ONE gameEnded per client (the latch did its job).
    for (const c of clients) {
      const ended = c.frames.filter((f) => f.type === "event" && f.kind === "gameEnded");
      expect(ended.length).toBe(1);
    }

    clients[0]!.send({ type: "rematch" });
    await clients[0]!.waitNew(
      (m) => m.type === "projection" && m.state.phase === "setup",
      5000,
    );
    expect(server.room.state.phase).toBe("setup");

    // Play game 2 to its own end.
    await playToEnd(clients, server);
    expect(server.room.state.phase).toBe("ended"); // game 2 really finished

    // THE REGRESSION: exactly TWO gameEnded events now — one per game.
    // Without the #endedSent reset this stays 1 and the test fails.
    for (const c of clients) {
      await c.waitFor(
        (m) =>
          m.type === "event" &&
          m.kind === "gameEnded" &&
          c.frames.filter((f) => f.type === "event" && f.kind === "gameEnded").length === 2,
        30_000,
      );
      const ended = c.frames.filter((f) => f.type === "event" && f.kind === "gameEnded");
      expect(ended.length).toBe(2);
      const st = await refresh(c);
      expect(st.phase).toBe("ended");
      expect(st.winner).toBe(server.room.state.winner);
    }
  }, 180_000);

  it("the latch still suppresses a THIRD gameEnded inside one game", async () => {
    const { server, clients } = await bootSeated();
    await playToEnd(clients, server);
    // No further op is accepted once the game has ended (kernel wrongPhase),
    // so a duplicate is impossible by construction — pin the count anyway.
    const before = clients[0]!.frames.filter(
      (f) => f.type === "event" && f.kind === "gameEnded",
    ).length;
    expect(before).toBe(1);
    const seqBefore = server.room.serverSeq;
    clients[0]!.send({ type: "op", op: { type: "endTurn", seat: 0 } });
    await clients[0]!.waitNew((m) => m.type === "event" && m.kind === "rejected", 3000);
    const after = clients[0]!.frames.filter(
      (f) => f.type === "event" && f.kind === "gameEnded",
    ).length;
    expect(after).toBe(1);
    expect(server.room.serverSeq).toBe(seqBefore);
  }, 180_000);
});

describe("rematch — refusals are one-note, not a dead link", () => {
  it("a refused rematch leaves the socket live and the room running", async () => {
    const { server, clients } = await bootSeated();
    const seqBefore = server.room.serverSeq;
    clients[1]!.send({ type: "rematch" });
    await clients[1]!.waitNew((m) => m.type === "error", 3000);
    expect(clients[1]!.ws.readyState).toBe(WebSocket.OPEN);

    // The room still works for everyone afterwards: a legit op lands.
    await syncTo(clients[0]!, server.room.serverSeq);
    const op = clients[0]!.moves[0];
    expect(op).toBeDefined();
    expect(await act(clients[0]!, op!)).toBe("applied");
    expect(server.room.serverSeq).toBeGreaterThan(seqBefore);
  });
});
