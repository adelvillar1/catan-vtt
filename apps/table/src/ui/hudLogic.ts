/**
 * hudLogic.ts — PURE display + op-shaping logic for the P2 DOM controls.
 *
 * Why this file exists: apps/table is a client of the kernel, and its unit
 * tests run in a NODE environment (no jsdom, no React Testing Library — see
 * vitest.config.ts). Everything the HUD/rail decides is therefore extracted
 * here as pure functions over (GameState, Op[]) so it can be tested with
 * REAL kernel-built fixtures without rendering anything.
 *
 * AC3 IRON RULE: nothing in apps/table/src imports applyAction, legalMoves(),
 * redactForSeat or a setup builder at RUNTIME. Legality is never computed
 * here — `pickMove` only FINDS an op the server already shipped.
 */
import type { GameState, Op, Resource } from "@catan-vtt/shared"; // type-only

/** Canonical resource order for chips and pickers. */
export const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];

/** 3-letter chip labels (icon-free by design — no art assets, no CDN). */
export const RESOURCE_ABBR: Record<Resource, string> = {
  wood: "WOD",
  brick: "BRK",
  wool: "WOL",
  wheat: "WHT",
  ore: "ORE",
};

/** Chip colors, kept in the DOM palette family (scene/palette.ts colors). */
export const RESOURCE_COLORS: Record<Resource, string> = {
  wood: "#2f7d46",
  brick: "#a2452c",
  wool: "#8fd06f",
  wheat: "#e0b96b",
  ore: "#8a8f98",
};

// ---------------------------------------------------------------------------
// Move picking — the ONLY way the UI "knows" what is legal
// ---------------------------------------------------------------------------

/**
 * Find the first op of `type` in the server's legalMoves, optionally narrowed
 * by `match`. Returns null when the server did not ship one — the UI then
 * renders nothing (never a guessed op).
 */
export function pickMove<K extends Op["type"]>(
  moves: readonly Op[],
  type: K,
  match?: (op: Extract<Op, { type: K }>) => boolean,
): Extract<Op, { type: K }> | null {
  for (const m of moves) {
    if (m.type !== type) continue;
    const cand = m as Extract<Op, { type: K }>;
    if (match === undefined || match(cand)) return cand;
  }
  return null;
}

/** All ops of a type (e.g. every tradePort vertex, every stealCard victim). */
export function pickAll<K extends Op["type"]>(
  moves: readonly Op[],
  type: K,
): Array<Extract<Op, { type: K }>> {
  return moves.filter((m): m is Extract<Op, { type: K }> => m.type === type);
}

export function hasMove(moves: readonly Op[], type: Op["type"]): boolean {
  return moves.some((m) => m.type === type);
}

// ---------------------------------------------------------------------------
// HUD text
// ---------------------------------------------------------------------------

export interface TurnBanner {
  /** "Your turn" / "Seat 2 · Orange". */
  title: string;
  phase: string;
  /** True when it is `seat`'s turn. */
  yours: boolean;
  /** Short line of whatever the table is waiting on. */
  waiting: string | null;
}

export function playerName(state: GameState, seat: number): string {
  const p = state.players.find((pl) => pl.seat === seat);
  return p === undefined ? `Seat ${seat}` : p.name;
}

export function turnBanner(state: GameState, seat: number | null): TurnBanner {
  const yours = seat !== null && state.currentSeat === seat;
  const title = yours ? "Your turn" : `Seat ${state.currentSeat} · ${playerName(state, state.currentSeat)}`;
  let waiting: string | null = null;
  if (state.phase === "setup") waiting = "Setup: place your pieces";
  else if (state.awaitingSeven !== null) {
    waiting = state.awaitingSeven.pendingDiscard
      ? "7 rolled — discards pending"
      : state.awaitingSeven.mustMoveRobber
        ? "7 rolled — move the robber"
        : "7 rolled";
  } else if (!state.hasRolled) waiting = "Waiting for the roll";
  return { title, phase: state.phase, yours, waiting };
}

/**
 * Visible points for ONE seat, own-seat only.
 *
 * Deliberately NOT imported from the kernel's vp.ts (AC3): this is a display
 * tally over PUBLIC projection data (buildings, roads, longest-road/largest-
 * army holders) plus that seat's own devHand. It must never be shown for
 * another seat — redact() squashes other devHands to fake VP cards, so a
 * computed number for them would be a lie. Callers pass their own seat.
 */
export function visiblePoints(state: GameState, seat: number): number {
  let pts = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.owner !== seat) continue;
    pts += b.kind === "city" ? 2 : 1;
  }
  if (state.longestRoad.holder === seat && state.longestRoad.length >= 5) pts += 2;
  if (state.largestArmy.holder === seat && state.largestArmy.count >= 3) pts += 2;
  const me = state.players.find((p) => p.seat === seat);
  if (me !== undefined) {
    for (const c of me.devHand) if (c === "victoryPoint") pts += 1;
  }
  return pts;
}

export interface PendingTradeView {
  offeror: number;
  offeree: number;
  give: Resource[];
  want: Resource[];
  /** True when `seat` is the counterparty who may accept/decline. */
  actionable: boolean;
  summary: string;
}

export function pendingTradeView(state: GameState, seat: number | null): PendingTradeView | null {
  const t = state.pendingTrade;
  if (t === null) return null;
  const actionable = seat !== null && t.offeree === seat;
  return {
    offeror: t.offeror,
    offeree: t.offeree,
    give: [...t.give],
    want: [...t.want],
    actionable,
    summary: `${playerName(state, t.offeror)} gives ${t.give.join(", ")} → wants ${t.want.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Resource rail
// ---------------------------------------------------------------------------

export interface Chip {
  resource: Resource;
  count: number;
  abbr: string;
  color: string;
}

/** Hand chips for `seat` (own seat only — other hands are redacted). */
export function handChips(state: GameState, seat: number | null): Chip[] {
  if (seat === null) return [];
  const me = state.players.find((p) => p.seat === seat);
  if (me === undefined) return [];
  return RESOURCES.map((r) => ({
    resource: r,
    count: me.hand[r],
    abbr: RESOURCE_ABBR[r],
    color: RESOURCE_COLORS[r],
  }));
}

export function handTotal(state: GameState, seat: number | null): number {
  if (seat === null) return 0;
  const me = state.players.find((p) => p.seat === seat);
  if (me === undefined) return 0;
  return RESOURCES.reduce((a, r) => a + me.hand[r], 0);
}

// ---------------------------------------------------------------------------
// Dev cards
// ---------------------------------------------------------------------------

export interface DevChip {
  type: "knight" | "monopoly" | "roadBuilding" | "yearOfPlenty" | "victoryPoint";
  count: number;
  playable: number;
}

/**
 * Own devHand tallied with the playable count: cards BOUGHT this turn may not
 * be played this turn (kernel devBoughtThisTurn), so playable = count − bought.
 * Values are read, never derived into legality — the play buttons still come
 * from legalMoves.
 */
export function devChips(state: GameState, seat: number | null): DevChip[] {
  if (seat === null) return [];
  const me = state.players.find((p) => p.seat === seat);
  if (me === undefined) return [];
  const types: DevChip["type"][] = ["knight", "monopoly", "roadBuilding", "yearOfPlenty", "victoryPoint"];
  return types.map((t) => {
    const count = me.devHand.filter((c) => c === t).length;
    const bought = me.devBoughtThisTurn[t] ?? 0;
    return { type: t, count, playable: Math.max(0, count - bought) };
  });
}

// ---------------------------------------------------------------------------
// Trade panel
// ---------------------------------------------------------------------------

export type TradeKind = "bank" | "port" | "offer";

export interface TradeForm {
  kind: TradeKind;
  give: Resource[];
  want: Resource[];
  /** tradePort only: the coastal vertex the server said is usable. */
  portVertexId?: string | undefined;
  /** tradeOffer only: counterparty seat. */
  with?: number | undefined;
}

/**
 * Shape a trade form into the EXACT op the wire expects (OpSchema-checked on
 * send by adapter.buildOpMessage — and in tests by OpSchema itself).
 *
 * Returns null for any form the schema would reject, so the UI can disable
 * the submit button instead of shipping a badMessage.
 */
export function tradeFormToOp(form: TradeForm, seat: number): Op | null {
  if (seat < 0) return null;
  const give = form.give.filter((r): r is Resource => RESOURCES.includes(r));
  const want = form.want.filter((r): r is Resource => RESOURCES.includes(r));
  if (give.length === 0 || want.length === 0) return null;

  if (form.kind === "bank") {
    // Bank/port trades are single-resource 4:1 / 3:1 / 2:1 exchanges.
    const offer = give[0]!;
    const demand = want[0]!;
    if (offer === demand) return null; // tradeSameResource
    return { type: "tradeBank", seat, offer, demand };
  }
  if (form.kind === "port") {
    const offer = give[0]!;
    const demand = want[0]!;
    if (offer === demand) return null;
    if (form.portVertexId === undefined || form.portVertexId === "") return null;
    return { type: "tradePort", seat, portVertexId: form.portVertexId, offer, demand };
  }
  // offer — a domestic trade to another seat
  if (form.with === undefined || form.with < 0 || form.with === seat) return null;
  return { type: "tradeOffer", seat, with: form.with, give, want };
}

/** Which trade surfaces the server currently allows. */
export interface TradeCapabilities {
  bank: boolean;
  port: boolean;
  offer: boolean;
  /** Vertex ids the server shipped as tradePort-eligible (may be empty). */
  ports: string[];
  /** Seats a tradeOffer could name (any other seated player). */
  partners: number[];
}

export function tradeCapabilities(moves: readonly Op[], state: GameState, seat: number | null): TradeCapabilities {
  const portMoves = pickAll(moves, "tradePort");
  return {
    bank: hasMove(moves, "tradeBank"),
    port: portMoves.length > 0,
    offer: hasMove(moves, "tradeOffer"),
    ports: [...new Set(portMoves.map((m) => m.portVertexId))],
    partners: seat === null ? [] : state.players.filter((p) => p.seat !== seat).map((p) => p.seat),
  };
}

/** Hint text shown when a trade surface is unavailable. */
export function tradeHint(caps: TradeCapabilities): string {
  if (caps.bank || caps.port || caps.offer) return "";
  return "Trading is not legal for you right now (server shipped no trade moves).";
}
