#!/usr/bin/env node
/**
 * cli.ts — text-mode CATAN table client (M2 phase 4).
 *
 * Two modes, ONE wire path:
 *  - INTERACTIVE: join, render the projection, REPL (`<n>`, roll, end, hand,
 *    moves, ping, quit).
 *  - SCRIPTED: `--auto <policy>` (built-in greedy bot) or `--script file.json`
 *    (a list of steps). Both act through the same `act()` used by the REPL.
 *
 * Authority discipline (AGENTS.md hard rule + redact.ts M3 CLIENT RULE):
 *  - EVERY inbound frame is parsed with ServerMsgSchema. A frame that fails
 *    is a hard error — never a silently-tolerated shape.
 *  - The client NEVER computes legalMoves. It acts only on ops present in
 *    the legalMoves array the SERVER shipped in its own projection. Roll,
 *    steal, dev buys and trade resolution are server-authoritative.
 *  - The client never imports redactForSeat and never peeks: a projection
 *    only ever contains what this seat may see, so nothing here can leak.
 *
 * Output is plain ASCII (no ANSI escapes) so pipes/tee capture it cleanly.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import WebSocket from "ws";

import {
  GameStateSchema,
  ServerMsgSchema,
  victoryPoints,
  type GameState,
  type Op,
  type Resource,
  type ServerMsg,
} from "@catan-vtt/shared";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];

/**
 * Greedy move preference, copied verbatim (shape + order) from
 * apps/room/src/server.test.ts::PRIORITY so a CLI bot and the transport test
 * bot choose alike.
 */
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

/** Seeded LCG — deterministic bot choices (same shape as server.test.ts). */
export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x1_0000_0000;
  };
}

/** Highest-priority shipped move, uniformly random inside its bucket. */
export function pickByPriority(moves: Op[], rand: () => number): Op | null {
  for (const type of PRIORITY) {
    if (type === "discardSeven") continue; // needs exact cards; composed below
    const bucket = moves.filter((m) => m.type === type);
    if (bucket.length > 0) return bucket[Math.floor(rand() * bucket.length)]!;
  }
  return null;
}

/** Compact one-line rendering of an op (for logs / the numbered move list). */
export function renderOp(op: Op): string {
  switch (op.type) {
    case "placeSetupPiece":
      return `placeSetupPiece ${op.kind} ${op.kind === "settlement" ? op.vertexId : op.edgeId}`;
    case "roll":
      return "roll";
    case "discardSeven":
      return `discardSeven [${op.cards.join(",")}]`;
    case "moveRobber":
      return `moveRobber -> ${op.hexId}`;
    case "stealCard":
      return `stealCard from s${op.victimSeat}`;
    case "buildRoad":
      return `buildRoad ${op.edgeId}`;
    case "buildSettlement":
      return `buildSettlement ${op.vertexId}`;
    case "buildCity":
      return `buildCity ${op.vertexId}`;
    case "playKnight":
      return "playKnight";
    case "endTurn":
      return "endTurn";
    case "claimVictory":
      return "claimVictory";
    case "tradeBank":
      return `tradeBank ${op.offer}->${op.demand}`;
    case "tradePort":
      return `tradePort ${op.offer}->${op.demand} @${op.portVertexId}`;
    case "tradeOffer":
      return `tradeOffer ->s${op.with} give[${op.give.join(",")}] want[${op.want.join(",")}]`;
    case "tradeAccept":
      return "tradeAccept";
    case "tradeReject":
      return "tradeReject";
    case "buyDevCard":
      return "buyDevCard";
    case "playMonopoly":
      return `playMonopoly ${op.resource}`;
    case "playRoadBuilding":
      return `playRoadBuilding ${op.edgeIds.join("+")}`;
    case "playYearOfPlenty":
      return `playYearOfPlenty ${op.cards.join("+")}`;
    default: {
      const _exhaustive: never = op;
      return String((_exhaustive as { type: unknown }).type);
    }
  }
}

// ---------------------------------------------------------------------------
// wire — one socket, strict parsing, promise-based waits
// ---------------------------------------------------------------------------

interface Waiter {
  pred: (m: ServerMsg) => boolean;
  resolve: (m: ServerMsg) => void;
  reject: (e: Error) => void;
  /** Frame index this waiter may match from (waitNew pins it). */
  from: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WireOpts {
  url: string;
  roomCode: string;
  name?: string;
  seat?: number;
  /** Join without a seat claim even if one is free (watcher). */
  spectate?: boolean;
  /** Max ms to wait for any frame before declaring a stall. */
  stallMs?: number;
  log?: (line: string) => void;
}

export type ActResult =
  | { kind: "applied"; seq: number }
  | { kind: "rejected"; code: string }
  | { kind: "error"; code: string; message: string };

/** Thrown when the server hung up; carries the close reason for the report. */
export class ClosedError extends Error {}

export class Wire {
  readonly ws: WebSocket;
  readonly log: (line: string) => void;
  seat: number | null = null;
  seatToken: string | undefined;
  state: GameState | null = null;
  moves: Op[] = [];
  seq = -1;
  /** Ring of recent event lines, rendered by the REPL (no mid-prompt spam). */
  feed: string[] = [];
  readonly frames: ServerMsg[] = [];

  readonly #waiters: Waiter[] = [];
  readonly #stallMs: number;
  #closed = false;

  constructor(url: string, opts: { stallMs?: number; log?: (l: string) => void } = {}) {
    this.ws = new WebSocket(url);
    this.#stallMs = opts.stallMs ?? 15_000;
    this.log = opts.log ?? ((l: string) => console.log(l));
  }

  static async open(opts: WireOpts): Promise<Wire> {
    const w = new Wire(opts.url, { stallMs: opts.stallMs, log: opts.log });
    w.ws.on("message", (data) => w.#onMessage(typeof data === "string" ? data : data.toString()));
    w.ws.on("error", (e) => w.#die(new Error(`socket error: ${String((e as Error).message)}`)));
    w.ws.on("close", (code, reason) =>
      w.#die(new ClosedError(`closed by peer (code ${code}${reason ? `, ${reason}` : ""})`)),
    );
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    await w.join(opts);
    return w;
  }

  // -- inbound ------------------------------------------------------------

  #onMessage(text: string): void {
    // AC3 discipline: every frame the client reads is validated against the
    // shared wire schema. A violation is a bug (server or protocol), not a
    // shape to shrug at.
    const parsed = ServerMsgSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      this.#die(new Error(`server frame violates ServerMsgSchema: ${text.slice(0, 300)}`));
      return;
    }
    const msg = parsed.data;
    this.frames.push(msg);
    if (msg.type === "projection") {
      this.state = GameStateSchema.parse(msg.state);
      this.moves = msg.legalMoves;
      this.seq = msg.serverSeq;
    }
    if (msg.type === "welcome") {
      this.seat = msg.seat;
      this.seatToken = msg.seatToken;
    }
    if (msg.type === "event") this.#note(msg);
    const idx = this.frames.length - 1;
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      const w = this.#waiters[i]!;
      if (w.from > idx) continue;
      if (w.pred(msg)) {
        this.#waiters.splice(i, 1);
        if (w.timer !== undefined) clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  #note(m: Extract<ServerMsg, { type: "event" }>): void {
    const d = m.details as Record<string, unknown>;
    switch (m.kind) {
      case "opApplied":
        this.feed.push(`s${d["seat"]} ${d["opType"]} (seq ${m.serverSeq})`);
        break;
      case "rejected":
        this.feed.push(`s${d["seat"]} ${d["opType"]} REJECTED ${String(d["code"])}`);
        break;
      case "playerJoined":
        this.feed.push(`playerJoined s${d["seat"]} ${String(d["name"] ?? "")}`);
        break;
      case "playerLeft":
        this.feed.push(`playerLeft s${d["seat"]}`);
        break;
      case "gameEnded":
        this.feed.push(`gameEnded winner s${d["winner"]} points ${String(d["finalPoints"])}`);
        break;
      default:
        this.feed.push(`${m.kind}`);
    }
    if (this.feed.length > 6) this.feed.shift();
  }

  #die(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) {
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.reject(err);
    }
  }

  // -- waiting ------------------------------------------------------------

  /** Match a frame already received or a future one. */
  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = this.#stallMs): Promise<ServerMsg> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return this.#arm(pred, this.frames.length, timeoutMs);
  }

  /** Match only frames that arrive AFTER this call (never a stale one). */
  waitNew(pred: (m: ServerMsg) => boolean, timeoutMs = this.#stallMs): Promise<ServerMsg> {
    return this.#arm(pred, this.frames.length, timeoutMs);
  }

  #arm(pred: (m: ServerMsg) => boolean, from: number, timeoutMs: number): Promise<ServerMsg> {
    if (this.#closed) return Promise.reject(new ClosedError("connection already closed"));
    return new Promise<ServerMsg>((resolve, reject) => {
      const w: Waiter = { pred, resolve, reject, from };
      this.#waiters.push(w);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        w.timer = setTimeout(() => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(new Error(`stalled: no frame in ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /** Wait for a projection strictly newer than `afterSeq`. */
  async waitProjectionAfter(afterSeq: number, timeoutMs = this.#stallMs): Promise<GameState> {
    const p = await this.waitFor(
      (m) => m.type === "projection" && m.serverSeq > afterSeq,
      timeoutMs,
    );
    if (p.type !== "projection") throw new Error("unreachable");
    return GameStateSchema.parse(p.state);
  }

  // -- outbound -----------------------------------------------------------

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async join(opts: WireOpts): Promise<void> {
    const msg: Record<string, unknown> = { type: "join", roomCode: opts.roomCode };
    if (!opts.spectate && opts.seat !== undefined) msg["seat"] = opts.seat;
    if (opts.name !== undefined) msg["name"] = opts.name;
    this.send(msg);
    // welcome | error — a join failure (inSeatTaken/roomFull/roomNotFound)
    // is terminal for this client, so surface it as a thrown error.
    const m = await this.waitNew(
      (x) => x.type === "welcome" || x.type === "error",
      this.#stallMs,
    );
    if (m.type === "error") throw new Error(`${m.code}: ${m.message}`);
    // A projection follows every join (presence changed) — wait for it so the
    // caller never acts on an empty move list.
    await this.waitFor((x) => x.type === "projection", this.#stallMs);
  }

  /**
   * Ship one op and wait for the room's verdict. On success, also wait for
   * the fresh projection that follows (never act on a stale frame).
   */
  async act(op: Op): Promise<ActResult> {
    const pending = this.waitNew(
      (m) =>
        (m.type === "event" && (m.kind === "opApplied" || m.kind === "rejected")) ||
        m.type === "error",
      this.#stallMs,
    );
    this.send({ type: "op", op });
    const m = await pending;
    if (m.type === "error") return { kind: "error", code: m.code, message: m.message };
    if (m.type !== "event") throw new Error(`unexpected ${m.type} reply to an op`);
    if (m.kind === "rejected") {
      return { kind: "rejected", code: String(m.details["code"] ?? "rejected") };
    }
    // opApplied: the projection broadcast rides the same tick, so it may
    // already be in `frames` — waitFor (not waitNew) matches either.
    await this.waitFor((x) => x.type === "projection" && x.serverSeq >= m.serverSeq);
    return { kind: "applied", seq: m.serverSeq };
  }

  /** Liveness probe; resolves with the round-trip time in ms. */
  async ping(): Promise<number> {
    const t = Date.now();
    const p = this.waitNew((m) => m.type === "pong" && m.t === t, 5_000);
    this.send({ type: "ping", t });
    await p;
    return Date.now() - t;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// rendering (ASCII only)
// ---------------------------------------------------------------------------

function handTotal(h: Record<Resource, number>): number {
  return h.wood + h.brick + h.wool + h.wheat + h.ore;
}

/**
 * Unambiguous resource abbreviations — "w" alone would collide for
 * wood/wool/wheat in a hand digest you have to read at a glance.
 */
const ABBR: Record<Resource, string> = {
  wood: "wd",
  brick: "br",
  wool: "wl",
  wheat: "wh",
  ore: "or",
};

function abbrHand(h: Record<Resource, number>): string {
  return RESOURCES.map((r) => `${ABBR[r]}${h[r]}`).join(" ");
}

/** Compact board/turn digest — one screen, no hidden info invented. */
export function renderTable(w: Wire): string[] {
  const st = w.state;
  const out: string[] = [];
  if (!st) return ["(no projection yet)"];
  const you = w.seat;
  const me = you === null ? null : (st.players[you] ?? null);

  out.push(
    `seq=${w.seq} phase=${st.phase} turn=s${st.currentSeat} you=${you === null ? "spectator" : `s${you}`}` +
      ` rolled=${st.hasRolled ? "y" : "n"} lastRoll=${st.lastRoll ?? "-"}` +
      ` bank=${handTotal(st.bank)} deck=${st.deck.length}` +
      ` LR=s${st.longestRoad.holder ?? "-"}(${st.longestRoad.length})` +
      ` LA=s${st.largestArmy.holder ?? "-"}(${st.largestArmy.count})`,
  );
  if (st.phase === "ended") out.push(`GAME OVER  winner=s${st.winner} finalPoints=${st.finalPoints}`);

  if (me) {
    const vp = you === null ? 0 : victoryPoints(st, you);
    out.push(
      `you s${you} ${me.name}: ${abbrHand(me.hand)}` +
        ` | dev ${me.devHand.length} | pieces r${me.roadsLeft}/s${me.settlementsLeft}/c${me.citiesLeft}` +
        ` | knights ${me.knightsPlayed} | VP ${vp}`,
    );
  }
  // Other seats: ONLY the public total — composition is scrubbed to all-wood
  // by the server, so printing per-resource numbers would be a fabrication.
  out.push(
    "table: " +
      st.players
        .map((p) =>
          p.seat === you
            ? `s${p.seat}${p.name}(${handTotal(p.hand)})*`
            : `s${p.seat}${p.name}(${handTotal(p.hand)})`,
        )
        .join("  "),
  );

  const aw = st.awaitingSeven;
  if (aw) {
    out.push(
      `AWAITING SEVEN: roller=s${aw.roller}` +
        (aw.pendingDiscard
          ? ` discardQueue=${aw.discardQueue.map((d) => `s${d.seat}:${d.count}`).join(",")}`
          : "") +
        (aw.mustMoveRobber ? " mustMoveRobber" : "") +
        (aw.pendingDiscard
          ? ""
          : aw.mustMoveRobber
            ? ""
            : " steal pending"),
    );
  }
  const pt = st.pendingTrade;
  if (pt) {
    out.push(
      `PENDING TRADE: s${pt.offeror} -> s${pt.offeree} give[${pt.give.join(",")}] want[${pt.want.join(",")}]`,
    );
  }
  if (st.phase === "setup" && st.setupStage) {
    out.push(
      `SETUP round=${st.setupStage.round} queue=${st.setupStage.seatQueue.join(">")} justPlaced=${st.setupStage.justPlacedVertex ?? "-"}`,
    );
  }
  if (w.moves.length === 0) {
    out.push("moves: (none — not your obligation)");
  } else {
    out.push("moves:");
    const cap = 24;
    w.moves.slice(0, cap).forEach((m, i) => out.push(`  [${i}] ${renderOp(m)}`));
    if (w.moves.length > cap) out.push(`  ... ${w.moves.length - cap} more (type "moves" for all)`);
  }
  return out;
}

/** Full digest for the `hand` command. */
function renderHand(w: Wire): string[] {
  const st = w.state;
  if (!st) return ["(no projection yet)"];
  const out: string[] = [];
  for (const p of st.players) {
    if (p.seat === w.seat) {
      out.push(
        `s${p.seat} ${p.name} (YOU): ${RESOURCES.map((r) => `${r}=${p.hand[r]}`).join(" ")}` +
          ` | dev=[${p.devHand.join(",")}] | played=${p.devPlayedThisTurn}` +
          ` | boughtThisTurn=${JSON.stringify(p.devBoughtThisTurn)}` +
          ` | pieces r${p.roadsLeft}/s${p.settlementsLeft}/c${p.citiesLeft}`,
      );
    } else {
      // Composition is hidden by design — print count + pieces only.
      out.push(
        `s${p.seat} ${p.name}: hand ${handTotal(p.hand)} cards (composition hidden)` +
          ` | dev ${p.devHand.length} | knights ${p.knightsPlayed}` +
          ` | pieces r${p.roadsLeft}/s${p.settlementsLeft}/c${p.citiesLeft}`,
      );
    }
  }
  out.push(`bank: ${RESOURCES.map((r) => `${r}=${st.bank[r]}`).join(" ")}`);
  out.push(`robber=${st.robberHexId} deck=${st.deck.length} discard=${st.discardPile.length}`);
  out.push(`rollLog: ${st.rollLog.join(",") || "-"}`);
  return out;
}

// ---------------------------------------------------------------------------
// scripted / auto modes
// ---------------------------------------------------------------------------

function composeDiscard(st: GameState, seat: number, need: number): Resource[] | null {
  const hand = st.players[seat]?.hand;
  if (!hand) return null;
  const cards: Resource[] = [];
  for (const r of RESOURCES) {
    while (cards.length < need && hand[r] > cards.filter((x) => x === r).length) cards.push(r);
  }
  return cards.length === need ? cards : null;
}

export interface AutoResult {
  winner: number | null;
  finalPoints: number | null;
  applied: number;
  rejected: number;
}

/**
 * Greedy bot: acts ONLY on ops shipped in its own projection.legalMoves
 * (plus discardSeven composed from its own visible hand — the same pattern
 * as server.test.ts). Runs until gameEnded or maxOps.
 */
export async function runAuto(
  w: Wire,
  o: { seed?: number; maxOps?: number; label?: string; verbose?: boolean } = {},
): Promise<AutoResult> {
  const rand = lcg((o.seed ?? 1) ^ 0x5f3759df);
  const maxOps = o.maxOps ?? 4000;
  const tag = o.label ?? (w.seat === null ? "spec" : `s${w.seat}`);
  const verbose = o.verbose ?? false;
  let applied = 0;
  let rejected = 0;

  for (let i = 0; i < maxOps; i++) {
    const st = w.state;
    if (!st) {
      await w.waitProjectionAfter(w.seq);
      continue;
    }
    if (st.phase === "ended") break;
    if (w.seat === null || w.moves.length === 0) {
      // Not our obligation (another seat's turn / spectator): wait for the
      // next server frame rather than spinning or fabricating a move.
      await w.waitProjectionAfter(w.seq);
      continue;
    }
    const seat = w.seat;
    let op: Op | null = null;
    const aw = st.awaitingSeven;
    if (aw && aw.pendingDiscard && aw.discardQueue[0]?.seat === seat) {
      const cards = composeDiscard(st, seat, aw.discardQueue[0]!.count);
      if (cards) op = { type: "discardSeven", seat, cards };
    }
    op ??= pickByPriority(w.moves, rand) ?? w.moves[0] ?? null;
    if (!op) {
      await w.waitProjectionAfter(w.seq);
      continue;
    }

    const res = await w.act(op);
    if (verbose) for (const l of renderTable(w)) w.log(`[${tag}] | ${l}`);
    if (res.kind === "applied") {
      applied++;
      w.log(`[${tag}] + ${renderOp(op)}`);
    } else if (res.kind === "rejected") {
      rejected++;
      w.log(`[${tag}] x ${renderOp(op)} -> ${res.code}`);
      // Resync on the server's terms, then fall back to its first move.
      await w.waitProjectionAfter(w.seq).catch(() => undefined);
    } else {
      w.log(`[${tag}] ! ${renderOp(op)} -> ${res.code}: ${res.message}`);
      throw new Error(`wire error ${res.code}: ${res.message}`);
    }
  }

  const st = w.state;
  return {
    winner: st?.winner ?? null,
    finalPoints: st?.finalPoints ?? null,
    applied,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// --script: a JSON list of steps
// ---------------------------------------------------------------------------

interface Step {
  action: "move" | "pickByPriority" | "roll" | "end" | "wait";
  index?: number;
}

function parseScript(path: string): Step[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("script must be a JSON array of steps");
  return raw as Step[];
}

async function runScript(w: Wire, steps: Step[], seed: number): Promise<AutoResult> {
  const rand = lcg(seed ^ 0x5f3759df);
  let applied = 0;
  let rejected = 0;
  for (const step of steps) {
    // Wait for an obligation before each step (a step cannot act out of turn).
    let guard = 0;
    while ((w.state?.phase ?? "") !== "ended" && (w.moves.length === 0 || w.state === null)) {
      if (++guard > 600) throw new Error("script stalled waiting for a turn");
      await w.waitProjectionAfter(w.seq);
    }
    if (w.state?.phase === "ended") break;
    if (step.action === "wait") {
      await w.waitProjectionAfter(w.seq);
      continue;
    }
    const seat = w.seat!;
    let op: Op | null = null;
    if (step.action === "move") op = w.moves[step.index ?? 0] ?? null;
    else if (step.action === "pickByPriority") op = pickByPriority(w.moves, rand) ?? w.moves[0] ?? null;
    else if (step.action === "roll") op = w.moves.find((m) => m.type === "roll") ?? null;
    else op = w.moves.find((m) => m.type === "endTurn") ?? null;
    if (!op) {
      w.log(`[script] step ${JSON.stringify(step)} not legal now (skipped)`);
      continue;
    }
    const res = await w.act(op);
    if (res.kind === "applied") {
      applied++;
      w.log(`[script] + ${renderOp(op)}`);
    } else if (res.kind === "rejected") {
      rejected++;
      w.log(`[script] x ${renderOp(op)} -> ${res.code}`);
    } else throw new Error(`wire error ${res.code}: ${res.message}`);
    void seat;
  }
  return {
    winner: w.state?.winner ?? null,
    finalPoints: w.state?.finalPoints ?? null,
    applied,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// interactive REPL
// ---------------------------------------------------------------------------

const USAGE = `catan room CLI — text-mode table client

  cli.ts --url ws://127.0.0.1:4273 --room ABC123 [--name Hector] [--seat 0 | --spectate]
         [--auto [policy]] [--script steps.json] [--seed N] [--timeout Ms] [-v]

Modes:
  (default, TTY)        interactive REPL
  --auto                built-in greedy bot (plays to a winner, then exits)
  --script steps.json   [{"action":"move"|"pickByPriority"|"roll"|"end"|"wait","index":N}]

REPL commands: <number> pick that legal move · roll · end · hand · moves · ping · quit
`;

async function repl(w: Wire): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const render = (): void => {
    for (const l of w.feed.splice(0)) console.log(`> ${l}`);
    for (const l of renderTable(w)) console.log(l);
  };
  render();
  const ask = (): void => {
    rl.question("> ", async (line) => {
      const cmd = line.trim().toLowerCase();
      try {
        if (cmd === "quit" || cmd === "q" || cmd === "exit") {
          rl.close();
          w.close();
          return;
        }
        if (cmd === "hand") for (const l of renderHand(w)) console.log(l);
        else if (cmd === "moves") {
          w.moves.forEach((m, i) => console.log(`  [${i}] ${renderOp(m)}`));
          if (w.moves.length === 0) console.log("  (none)");
        } else if (cmd === "ping") console.log(`pong in ${await w.ping()}ms`);
        else if (cmd === "roll") {
          const op = w.moves.find((m) => m.type === "roll");
          if (!op) console.log("roll is not in your legal moves");
          else {
            const r = await w.act(op);
            console.log(r.kind === "applied" ? "rolled" : `${r.kind}: ${"code" in r ? r.code : ""}`);
          }
        } else if (cmd === "end") {
          const op = w.moves.find((m) => m.type === "endTurn");
          if (!op) console.log("endTurn is not in your legal moves");
          else {
            const r = await w.act(op);
            console.log(r.kind === "applied" ? "turn ended" : `${r.kind}: ${"code" in r ? r.code : ""}`);
          }
        } else if (/^\d+$/.test(cmd)) {
          const op = w.moves[Number(cmd)];
          if (!op) console.log(`no move #${cmd} (you have ${w.moves.length})`);
          else {
            const r = await w.act(op);
            console.log(
              r.kind === "applied"
                ? `applied ${renderOp(op)}`
                : `${r.kind}: ${"code" in r ? r.code : ""}`,
            );
          }
        } else if (cmd !== "") console.log("commands: <number> · roll · end · hand · moves · ping · quit");
      } catch (e) {
        console.log(`error: ${(e as Error).message}`);
      }
      if (w.state?.phase === "ended") {
        const st = w.state;
        console.log(`WINNER seat ${st.winner}, finalPoints ${st.finalPoints}`);
        rl.close();
        w.close();
        return;
      }
      render();
      ask();
    });
  };
  ask();
  await new Promise<void>((resolve) => rl.once("close", () => resolve()));
}

// ---------------------------------------------------------------------------
// argv + main
// ---------------------------------------------------------------------------

export interface CliArgs {
  url: string;
  room: string;
  name?: string;
  seat?: number;
  spectate: boolean;
  auto: boolean;
  script?: string;
  seed: number;
  timeoutMs: number;
  help: boolean;
  verbose: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    url: "ws://127.0.0.1:4273",
    room: process.env["ROOM_CODE"] ?? "",
    spectate: false,
    auto: false,
    seed: 1,
    timeoutMs: 15_000,
    help: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = (): string => argv[++i] ?? "";
    switch (k) {
      case "--url":
        a.url = next();
        break;
      case "--room":
        a.room = next();
        break;
      case "--name":
        a.name = next();
        break;
      case "--seat":
        a.seat = Number(next());
        break;
      case "--spectate":
        a.spectate = true;
        break;
      case "--auto":
        a.auto = true;
        if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) void next(); // policy name (v1: greedy)
        break;
      case "--script":
        a.script = next();
        break;
      case "--seed":
        a.seed = Number(next());
        break;
      case "--timeout":
        a.timeoutMs = Number(next());
        break;
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--verbose":
        a.verbose = true;
        break;
      default:
        throw new Error(`unknown arg ${k}`);
    }
  }
  return a;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // Piped stdin with no scripted mode: there is nobody to answer the prompt.
  if (!args.auto && args.script === undefined && !process.stdin.isTTY) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.room) {
    console.error("missing --room CODE (or ROOM_CODE env)\n" + USAGE);
    return 2;
  }
  if (args.seat !== undefined && (args.seat < 0 || args.seat > 3 || !Number.isInteger(args.seat))) {
    console.error(`--seat must be 0..3 (got ${args.seat})`);
    return 2;
  }

  // Interactive sessions have no wall-clock stall: the human is the clock.
  const stallMs = args.auto || args.script !== undefined ? args.timeoutMs : Infinity;
  let w: Wire;
  try {
    w = await Wire.open({
      url: args.url,
      roomCode: args.room,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.seat === undefined ? {} : { seat: args.seat }),
      spectate: args.spectate,
      stallMs,
    });
  } catch (e) {
    // join failures (inSeatTaken / roomFull / roomNotFound) land here.
    console.error(`join failed: ${(e as Error).message}`);
    return 1;
  }

  const label = `s${w.seat ?? "spec"}`;
  console.log(`joined room ${args.room} as ${label}${args.name ? ` (${args.name})` : ""} @ ${args.url}`);

  try {
    if (args.auto) {
      const r = await runAuto(w, { seed: args.seed, label, verbose: args.verbose });
      if (r.winner === null) {
        console.log(`no winner (applied=${r.applied} rejected=${r.rejected})`);
        w.close();
        return 1;
      }
      console.log(`WINNER seat ${r.winner}, finalPoints ${r.finalPoints}  (applied=${r.applied} rejected=${r.rejected})`);
      w.close();
      return 0;
    }
    if (args.script !== undefined) {
      const r = await runScript(w, parseScript(args.script), args.seed);
      console.log(`script done applied=${r.applied} rejected=${r.rejected} winner=${r.winner} points=${r.finalPoints}`);
      w.close();
      return 0;
    }
    await repl(w);
    return 0;
  } catch (e) {
    if (e instanceof ClosedError) {
      console.error(`connection ${e.message}`);
      return 1;
    }
    console.error(`${(e as Error).message}`);
    return 1;
  } finally {
    w.close();
  }
}

// Run only when invoked directly (so demo/ can import runAuto + Wire).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /(^|[\\/])cli\.(ts|js)$/.test(process.argv[1]!);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error((e as Error).stack ?? String(e));
      process.exit(1);
    },
  );
}
