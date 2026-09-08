/**
 * goldenReplay.ts — deterministic greedy-bot game simulation harness.
 *
 * Drives full games from a seed through applyAction + legalMoves only (the
 * public kernel surface), producing the complete state trajectory for
 * golden-replay testing: invariants at every step, and bit-exact
 * determinism for a given (seed, metaSeed) pair.
 *
 * TWO INDEPENDENT RNG STREAMS (locked design):
 * - the GAME stream (state.rngSeed/rngCursor) — dice and robber steals,
 *   consumed only inside applyAction;
 * - the BOT stream (Rng seeded with metaSeed) — op selection ONLY. It never
 *   touches the game stream, so swapping bot policies cannot perturb the
 *   dice a replay would produce... it CAN perturb them via different op
 *   sequences (a different number of rolls consumes different draws); the
 *   guarantee here is per-(seed, metaSeed) determinism, not cross-policy
 *   dice stability.
 *
 * Bot policy: at each step, among legalMoves(state, actingSeat), pick the
 * highest-priority available type, then a uniform random member of that
 * class via the bot stream. The acting seat is the current seat, or the
 * seven-window debtor/roller when a window is open. The bot never composes
 * domestic offers (tradeOffer is UI-composed by design; legalMoves does not
 * enumerate it). When wave 4 lands claimVictory, the priority list already
 * has it first — no refactor needed here.
 */
import { Rng } from "./rng.js";
import { variableSetup } from "./setup.js";
import { GameStateSchema, type GameState } from "./state.js";
import { applyAction, legalMoves } from "./turn.js";
import type { Op } from "./actions.js";

export interface SimulateOptions {
  playerCount?: 3 | 4;
  /** Seed for the BOT's op-selection stream (independent of the dice). */
  metaSeed?: number;
  /** Turn cap — victory logic (10 VP) lands in wave 4. Default 300. */
  maxTurns?: number;
}

export interface SimResult {
  /** Every state from setup start through the final state (inclusive). */
  states: GameState[];
  winner: number | null;
  /** Number of endTurn ops applied (completed turns). */
  turns: number;
}

/**
 * Op-type priority, highest first. Within a type, uniform pick via the bot
 * stream. claimVictory is listed first so the wave-4 op is picked
 * automatically once legalMoves enumerates it.
 */
const PRIORITY: readonly Op["type"][] = [
  "claimVictory" as Op["type"], // wave 4 — harmless until then
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

function pickOp(moves: Op[], bot: Rng): Op {
  for (const type of PRIORITY) {
    const bucket = moves.filter((m) => m.type === type);
    if (bucket.length > 0) return bucket[bot.int(bucket.length)];
  }
  // Unknown future op type: fall back to uniform over everything.
  return moves[bot.int(moves.length)];
}

/**
 * Simulate a game. Never throws on legal play — any ActionError escapes as
 * a kernel bug (the golden suite treats a throw as a failure).
 */
export function simulateGame(seed: number, opts?: SimulateOptions): SimResult {
  const playerCount = opts?.playerCount ?? 3;
  const metaSeed = opts?.metaSeed ?? seed * 0x9e3779b1 + 1;
  const maxTurns = opts?.maxTurns ?? 300;

  const bot = Rng.create(metaSeed);
  const states: GameState[] = [];
  let s = variableSetup(seed, { playerCount });
  states.push(s);
  let turns = 0;
  let guard = 0;

  while (s.phase !== "ended" && turns < maxTurns) {
    if (++guard > maxTurns * 60) {
      throw new Error(`simulateGame runaway (seed=${seed})`);
    }
    const seat =
      s.phase === "setup"
        ? s.currentSeat
        : s.awaitingSeven
          ? s.awaitingSeven.pendingDiscard
            ? s.awaitingSeven.discardQueue[0].seat
            : s.awaitingSeven.roller
          : s.currentSeat;
    const moves = legalMoves(s, seat);
    if (moves.length === 0) {
      throw new Error(`simulateGame dead state (seed=${seed}, seat=${seat})`);
    }
    const op = pickOp(moves, bot);
    s = applyAction(s, op);
    GameStateSchema.parse(s); // postcondition asserted at every step
    states.push(s);
    if (op.type === "endTurn") turns++;
  }

  return { states, winner: s.winner, turns };
}
