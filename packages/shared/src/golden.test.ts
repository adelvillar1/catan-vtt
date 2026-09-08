/**
 * golden.test.ts — golden-replay harness for the wave-3 kernel.
 *
 * (a) 3 seeds × 3 players run to completion with NO throw and a schema
 *     parse after every op (simulateGame already parses each step; a throw
 *     fails the test).
 * (b) Invariants at every step: resource conservation (hands+bank = 95)
 *     and dev-card conservation (deck+discard+hands = 25).
 * (c) Determinism: same (seed, metaSeed) → deep-equal state trajectories.
 * (d) Final hands logged for the record.
 *
 * Victory (10 VP / claimVictory) is wave 4; the harness caps at maxTurns.
 */
import { describe, expect, it } from "vitest";
import { simulateGame } from "./goldenReplay.js";
import type { GameState, PlayerState, Resource } from "./state.js";

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
