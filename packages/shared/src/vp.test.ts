/**
 * vp.test.ts — the official victory-point ledger (wave 4).
 *
 * Covers: each ledger term (settlements, cities, longestRoad, largestArmy,
 * hidden victoryPoint dev cards), the full board total, and totalVpLedger.
 * State construction uses test scaffolding (direct field overrides on a
 * real setup state) — the ledger itself is a pure read.
 */
import { describe, expect, it } from "vitest";
import { variableSetup } from "./setup.js";
import type { GameState } from "./state.js";
import { totalVpLedger, victoryPoints, VP_TO_WIN } from "./vp.js";

/** Scaffold buildings/roads/devHands directly (test-only state surgery). */
function scaffold(s: GameState, patch: Partial<GameState>): GameState {
  return { ...s, ...patch };
}

describe("victoryPoints ledger", () => {
  it("VP_TO_WIN is 10", () => {
    expect(VP_TO_WIN).toBe(10);
  });

  it("settlements count 1 each; cities count 2 each", () => {
    const s = variableSetup(41);
    const b: GameState["buildings"] = {
      v1: { kind: "settlement", owner: 0 },
      v2: { kind: "settlement", owner: 0 },
      v3: { kind: "city", owner: 0 },
      v4: { kind: "settlement", owner: 1 }, // not ours
    };
    expect(victoryPoints(scaffold(s, { buildings: b }), 0)).toBe(1 + 1 + 2);
    expect(victoryPoints(scaffold(s, { buildings: b }), 1)).toBe(1);
  });

  it("longestRoad holder gets +2; non-holders get nothing", () => {
    const s = variableSetup(41);
    const withTile = scaffold(s, {
      longestRoad: { holder: 1, length: 5 },
    });
    expect(victoryPoints(withTile, 1)).toBe(2);
    expect(victoryPoints(withTile, 0)).toBe(0);
    expect(victoryPoints(withTile, 2)).toBe(0);
  });

  it("largestArmy holder gets +2; non-holders get nothing", () => {
    const s = variableSetup(41);
    const withTile = scaffold(s, {
      largestArmy: { holder: 2, count: 4 },
    });
    expect(victoryPoints(withTile, 2)).toBe(2);
    expect(victoryPoints(withTile, 0)).toBe(0);
  });

  it("victoryPoint dev cards in devHand count +1 each (hidden, unplayed)", () => {
    const s = variableSetup(41);
    const players = s.players.slice();
    players[0] = {
      ...players[0],
      devHand: ["victoryPoint", "victoryPoint", "knight"],
    };
    const s2 = scaffold(s, { players });
    expect(victoryPoints(s2, 0)).toBe(2);
    // Knights and progress cards contribute nothing.
    players[1] = { ...players[1], devHand: ["knight", "monopoly", "roadBuilding"] };
    expect(victoryPoints({ ...s2, players }, 1)).toBe(0);
  });

  it("sums all terms together; a 10-VP scaffold totals exactly 10", () => {
    const s = variableSetup(41);
    const players = s.players.slice();
    players[0] = {
      ...players[0],
      devHand: ["victoryPoint", "victoryPoint", "victoryPoint"],
    };
    const s2 = scaffold(s, {
      players,
      buildings: {
        a: { kind: "settlement", owner: 0 },
        b: { kind: "settlement", owner: 0 },
        c: { kind: "city", owner: 0 },
        d: { kind: "settlement", owner: 0 },
      },
      longestRoad: { holder: 0, length: 7 },
      largestArmy: { holder: 1, count: 3 },
    });
    // 2+1 settlements+city = 5, +2 road, +3 VP cards = 10.
    expect(victoryPoints(s2, 0)).toBe(10);
  });

  it("unknown seat returns 0 (no throw)", () => {
    const s = variableSetup(41);
    expect(victoryPoints(s, 99)).toBe(0);
  });
});

describe("totalVpLedger", () => {
  it("returns one entry per seat matching victoryPoints", () => {
    const s = variableSetup(42, { playerCount: 4 });
    const players = s.players.slice();
    players[3] = { ...players[3], devHand: ["victoryPoint"] };
    const s2 = scaffold(s, {
      players,
      buildings: { x: { kind: "city", owner: 2 } },
    });
    const ledger = totalVpLedger(s2);
    expect(Object.keys(ledger).map(Number).sort()).toEqual([0, 1, 2, 3]);
    for (const p of s2.players) {
      expect(ledger[p.seat]).toBe(victoryPoints(s2, p.seat));
    }
    expect(ledger[2]).toBe(2);
    expect(ledger[3]).toBe(1);
  });
});
