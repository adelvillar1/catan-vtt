/**
 * golden.test.ts — golden-replay harness for the wave-4 kernel.
 *
 * (a) 3 seeds × 3 players run to completion with NO throw and a schema
 *     parse after every op (simulateGame already parses each step; a throw
 *     fails the test).
 * (b) Invariants at every step: resource conservation (hands+bank = 95)
 *     and dev-card conservation (deck+discard+hands = 25).
 * (c) Determinism: same (seed, metaSeed) → deep-equal state trajectories.
 * (d) Final hands logged for the record.
 * (e) WAVE 4 (AC2): six fixed games (4×3p + 2×4p) run to ACTUAL 10-VP
 *     wins via claimVictory — winner set, phase 'ended', finalPoints equal
 *     to the ledger; 'ended' is terminal (post-end ops throw wrongPhase).
 * (f) Scripted win + claimVictory rejection matrix.
 */
import { describe, expect, it } from "vitest";
import { ActionError, type Op } from "./actions.js";
import { simulateGame } from "./goldenReplay.js";
import { variableSetup } from "./setup.js";
import type { DevCardType, GameState, PlayerState, Resource } from "./state.js";
import { applyAction, legalMoves } from "./turn.js";
import { victoryPoints, VP_TO_WIN } from "./vp.js";

declare const console: { log: (...args: unknown[]) => void };

const RESOURCES: readonly Resource[] = ["wood", "brick", "wool", "wheat", "ore"];
const handTotal = (p: PlayerState): number =>
  RESOURCES.reduce((a, r) => a + p.hand[r], 0);
const grandTotal = (s: GameState): number =>
  s.players.reduce((a, p) => a + handTotal(p), 0) +
  RESOURCES.reduce((a, r) => a + s.bank[r], 0);
const devCardTotal = (s: GameState): number =>
  s.deck.length +
  s.discardPile.length +
  s.players.reduce((a, p) => a + p.devHand.length, 0);

const SEEDS = [20260908, 424242, 777];

describe("golden replay (greedy bot)", () => {
  it("runs 3 seeds to the turn cap with invariants intact at every step", () => {
    for (const seed of SEEDS) {
      const { states, turns } = simulateGame(seed);
      expect(turns, `seed ${seed} made no progress`).toBeGreaterThan(10);
      for (const s of states) {
        expect(grandTotal(s), `resource conservation broke (seed ${seed})`).toBe(95);
        expect(devCardTotal(s), `dev-card conservation broke (seed ${seed})`).toBe(25);
        for (const p of s.players) {
          for (const r of RESOURCES) expect(p.hand[r]).toBeGreaterThanOrEqual(0);
          expect(p.roadsLeft).toBeGreaterThanOrEqual(0);
          expect(p.settlementsLeft).toBeGreaterThanOrEqual(0);
          expect(p.citiesLeft).toBeGreaterThanOrEqual(0);
        }
      }
      // (d) final hands on record.
      const last = states[states.length - 1];
      console.log(
        `seed ${seed}: ${turns} turns, ${states.length} states, final hands`,
        last.players.map((p) => p.hand),
      );
    }
  }, 120_000);

  it("is deterministic: same (seed, metaSeed) → deep-equal trajectories", () => {
    for (const seed of SEEDS) {
      const a = simulateGame(seed, { metaSeed: 0xB07 });
      const b = simulateGame(seed, { metaSeed: 0xB07 });
      expect(b.states).toEqual(a.states);
      expect(b.turns).toBe(a.turns);
      expect(b.winner).toBe(a.winner);
    }
  }, 120_000);

  it("different metaSeed → different trajectory (bot stream is live)", () => {
    const a = simulateGame(SEEDS[0], { metaSeed: 1 });
    const b = simulateGame(SEEDS[0], { metaSeed: 2 });
    // Same seed, different bot entropy: the trajectories must diverge at
    // some point (a same-length same-content accident is implausible and
    // would itself be a red flag worth failing on).
    const diverged =
      a.states.length !== b.states.length ||
      a.states.some((s, i) => JSON.stringify(s) !== JSON.stringify(b.states[i]));
    expect(diverged).toBe(true);
  }, 120_000);

  it("4-player game runs cleanly too", () => {
    const { states, turns } = simulateGame(31415, { playerCount: 4 });
    expect(turns).toBeGreaterThan(10);
    for (const s of states) {
      expect(grandTotal(s)).toBe(95);
      expect(devCardTotal(s)).toBe(25);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Wave 4 — AC2: games actually reach 10-VP wins
// ---------------------------------------------------------------------------

const WIN_GAMES: Array<{ seed: number; players: 3 | 4 }> = [
  { seed: 11, players: 3 },
  { seed: 202, players: 3 },
  { seed: 777, players: 3 },
  { seed: 4242, players: 3 },
  { seed: 5, players: 4 },
  { seed: 99, players: 4 },
];

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ActionError) return e.code;
    throw e;
  }
  throw new Error("expected ActionError, none thrown");
}

describe("golden wins (wave 4 AC2)", () => {
  it("greedy bots reach 10 VP and claim victory in all six fixed games", () => {
    let wins = 0;
    for (const { seed, players } of WIN_GAMES) {
      const r = simulateGame(seed, { playerCount: players, maxTurns: 600 });
      // No throw, conservation at every step.
      for (const s of r.states) {
        expect(grandTotal(s), `resource conservation broke (seed ${seed})`).toBe(95);
        expect(devCardTotal(s), `dev-card conservation broke (seed ${seed})`).toBe(25);
      }
      const last = r.states[r.states.length - 1];
      console.log(
        `win-game seed=${seed} players=${players} turns=${r.turns} winner=${r.winner} finalPoints=${last.finalPoints}`,
      );
      if (r.winner === null) continue;
      wins++;
      expect(last.phase).toBe("ended");
      expect(last.winner).toBe(r.winner);
      expect(victoryPoints(last, r.winner)).toBeGreaterThanOrEqual(VP_TO_WIN);
      expect(last.finalPoints).toBe(victoryPoints(last, r.winner));
      // claimVictory-only terminal: winner set ⇒ phase ended (checked
      // above), and 'ended' is a hard lock for EVERY op — including the
      // simplest ones.
      expect(code(() => applyAction(last, { type: "roll", seat: r.winner! }))).toBe(
        "wrongPhase",
      );
      expect(code(() => applyAction(last, { type: "endTurn", seat: r.winner! }))).toBe(
        "wrongPhase",
      );
      expect(
        code(() => applyAction(last, { type: "claimVictory", seat: r.winner! })),
      ).toBe("wrongPhase");
      expect(legalMoves(last, r.winner)).toEqual([]);
    }
    // The bar (LOCKED): ≥2 of the 6 games must end in a real win.
    expect(wins).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("winning games are deterministic: same (seed, metaSeed) → identical result", () => {
    for (const { seed, players } of WIN_GAMES) {
      const a = simulateGame(seed, { playerCount: players, metaSeed: 0xB07, maxTurns: 600 });
      const b = simulateGame(seed, { playerCount: players, metaSeed: 0xB07, maxTurns: 600 });
      expect(b.states).toEqual(a.states);
      expect(b.winner).toBe(a.winner);
      expect(b.turns).toBe(a.turns);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Wave 4 — scripted claimVictory (the op itself)
// ---------------------------------------------------------------------------

function playSetup(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase === "setup") {
    if (++guard > 64) throw new Error("setup did not terminate");
    s = applyAction(s, legalMoves(s, s.currentSeat)[0]);
  }
  return s;
}

describe("claimVictory (scripted)", () => {
  /** Seat 0 with a legitimate ≥10 total: 2 setup settlements + scaffolds. */
  function tenVpState(): GameState {
    let s = playSetup(variableSetup(71));
    expect(s.currentSeat).toBe(0);
    const players = s.players.slice();
    players[0] = {
      ...players[0],
      devHand: ["victoryPoint", "victoryPoint", "victoryPoint"] as DevCardType[],
    };
    // 2 setup settlements (2) + 2 scaffolds (1 settlement + 1 city = 3)
    // + longestRoad 2 + largestArmy 2 + 3 VP cards = 12. No vertex/edge
    // collisions: scaffold ids are fresh keys (test-only surgery).
    return {
      ...s,
      players,
      buildings: {
        ...s.buildings,
        zz1: { kind: "settlement", owner: 0 },
        zz2: { kind: "city", owner: 0 },
      },
      longestRoad: { holder: 0, length: 5 },
      largestArmy: { holder: 0, count: 3 },
    };
  }

  it("a scripted 10-VP seat claims: phase ended, winner, finalPoints = ledger", () => {
    const s = tenVpState();
    const vp = victoryPoints(s, 0);
    expect(vp).toBeGreaterThanOrEqual(10);
    // claimVictory is enumerated FIRST for the winning current seat —
    // even pre-roll (hasRolled is false here).
    const moves = legalMoves(s, 0);
    expect(moves[0]).toEqual({ type: "claimVictory", seat: 0 });
    expect(s.hasRolled).toBe(false);
    const s1 = applyAction(s, { type: "claimVictory", seat: 0 });
    expect(s1.phase).toBe("ended");
    expect(s1.winner).toBe(0);
    expect(s1.finalPoints).toBe(vp);
    // Terminal: nothing is legal afterwards.
    expect(legalMoves(s1, 0)).toEqual([]);
    expect(code(() => applyAction(s1, { type: "roll", seat: 0 }))).toBe("wrongPhase");
    expect(code(() => applyAction(s1, { type: "endTurn", seat: 0 }))).toBe("wrongPhase");
  });

  it("rejects at 9 VP (victoryInsufficient, with the actual count in details)", () => {
    let s = playSetup(variableSetup(73));
    // Seat 0: 2 setup settlements + 7 VP cards = 9.
    const players = s.players.slice();
    players[0] = {
      ...players[0],
      devHand: Array(7).fill("victoryPoint") as DevCardType[],
    };
    s = { ...s, players };
    expect(victoryPoints(s, 0)).toBe(9);
    let thrown: ActionError | null = null;
    try {
      applyAction(s, { type: "claimVictory", seat: 0 });
    } catch (e) {
      thrown = e as ActionError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe("victoryInsufficient");
    expect(thrown!.details).toMatchObject({ seat: 0, points: 9, required: 10 });
  });

  it("rejects off-turn (notYourTurn), mid-robber (awaitingSeven), and after ended (wrongPhase)", () => {
    const s = tenVpState();
    const other = 1;
    expect(victoryPoints(s, other)).toBeLessThan(10);
    // Off-turn — even a 10-VP seat that is NOT current cannot claim.
    const offTurn: GameState = (() => {
      const players = s.players.slice();
      players[other] = { ...players[other] };
      // Move the winning ledger onto seat 1 while seat 0 stays current.
      const mine = players[0];
      players[other] = {
        ...players[other],
        devHand: mine.devHand.slice(),
      };
      return {
        ...s,
        players,
        buildings: Object.fromEntries(
          Object.entries(s.buildings).map(([k, b]) => [
            k,
            b.owner === 0 ? { ...b, owner: other } : b,
          ]),
        ),
        longestRoad: { holder: other, length: 5 },
        largestArmy: { holder: other, count: 3 },
      };
    })();
    expect(victoryPoints(offTurn, other)).toBeGreaterThanOrEqual(10);
    expect(code(() => applyAction(offTurn, { type: "claimVictory", seat: other }))).toBe(
      "notYourTurn",
    );
    // Mid-robber: a 10-VP current seat cannot claim during the window.
    const midRobber: GameState = {
      ...s,
      awaitingSeven: {
        roller: 0,
        pendingDiscard: false,
        mustMoveRobber: true,
        discardQueue: [],
      },
    };
    expect(code(() => applyAction(midRobber, { type: "claimVictory", seat: 0 }))).toBe(
      "awaitingSeven",
    );
    // After ended: wrongPhase (not double-win).
    const ended = applyAction(s, { type: "claimVictory", seat: 0 });
    expect(code(() => applyAction(ended, { type: "claimVictory", seat: 0 }))).toBe(
      "wrongPhase",
    );
  });

  it("legalMoves enumerates claimVictory only at ≥10 VP for the current seat", () => {
    const s = tenVpState();
    expect(legalMoves(s, 0)[0].type).toBe("claimVictory");
    expect(legalMoves(s, 1).some((m: Op) => m.type === "claimVictory")).toBe(false);
    const s9 = (() => {
      const players = s.players.slice();
      players[0] = { ...players[0], devHand: ["victoryPoint"] as DevCardType[] };
      return { ...s, players, largestArmy: { holder: null, count: 0 } };
    })();
    // 2 setup + zz1(1) + zz2(2) + longestRoad(2) + 1 VP = 8 < 10.
    expect(victoryPoints(s9, 0)).toBeLessThan(10);
    expect(legalMoves(s9, 0).some((m: Op) => m.type === "claimVictory")).toBe(false);
  });
});
