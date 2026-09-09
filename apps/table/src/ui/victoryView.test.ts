/**
 * victoryView.test.ts — the M3-P3(a) pure banner logic.
 *
 * Fixtures: REAL kernel-built states from testFixtures.ts (kernel imports are
 * allowed in tests; AC3 governs src runtime only). Every assertion can fail:
 * pre-win nulls, post-win fields, the poisoned-sentinel redaction probe, the
 * spectator path, the defensive missing-roster path, and the e2e override.
 */
import { describe, expect, it } from "vitest";
import type { GameState } from "@catan-vtt/shared";
import {
  E2E_WIN_KEY,
  readE2eWinSeat,
  victoryInput,
  victoryView,
  type VictoryRosterEntry,
} from "./victoryView.js";
import { afterRoll, freshGame, SEATS } from "./testFixtures.js";

/** Minimal in-memory Storage — node env has none (same trick as lastRoom.test). */
function fakeStorage(value?: string): Storage {
  const map = new Map<string, string>();
  if (value !== undefined) map.set(E2E_WIN_KEY, value);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function roster(st: GameState): VictoryRosterEntry[] {
  return st.players.map((p) => ({ seat: p.seat, name: p.name, color: p.color }));
}

/** A real game where `seat` has claimed victory (kernel claimVictory path). */
function wonState(seat: number, points: number): GameState {
  const base = afterRoll();
  return { ...base, phase: "ended", winner: seat, finalPoints: points };
}

describe("victoryView — pre-win", () => {
  it("null before anyone wins (a live game shows no banner)", () => {
    const st = freshGame();
    expect(st.winner).toBeNull(); // fixture is really mid-game
    expect(victoryView(victoryInput(st, null), roster(st), 0)).toBeNull();
    expect(st.phase).toBe("setup");
  });
});

describe("victoryView — post-win fields", () => {
  it("winner seat 0: exact name/color/points, isYou for that seat only", () => {
    const st = wonState(0, 10);
    const v = victoryView(victoryInput(st, null), roster(st), 0);
    expect(v).not.toBeNull();
    expect(v!.winnerSeat).toBe(0);
    expect(v!.name).toBe(st.players[0]!.name);
    expect(v!.colorKey).toBe("Red"); // kernel PLAYER_COLORS[0]
    expect(v!.points).toBe(10);
    expect(v!.isYou).toBe(true);
    expect(v!.shout).toBe("You win!");
    expect(v!.banner).toBe("🏆 Red wins — 10 Victory Points");
    // A different seat must NOT be told it won.
    const other = victoryView(victoryInput(st, null), roster(st), 1)!;
    expect(other.isYou).toBe(false);
    expect(other.shout).toBeNull();
    expect(other.name).toBe(st.players[0]!.name); // same public winner
  });

  it("a LATER seat is not a seat-0 special case (color/name/points follow it)", () => {
    const seat = SEATS - 1; // 2 in the 3-seat fixture
    expect(seat).toBeGreaterThan(0); // non-vacuous: really not seat 0
    const st = wonState(seat, 11);
    const v = victoryView(victoryInput(st, null), roster(st), seat)!;
    expect(v.winnerSeat).toBe(seat);
    expect(v.colorKey).toBe("Orange"); // PLAYER_COLORS[2]
    expect(v.name).toBe(st.players[seat]!.name);
    expect(v.points).toBe(11); // verbatim finalPoints, never hardcoded 10
    expect(v.banner).toBe("🏆 Orange wins — 11 Victory Points");
    expect(v.isYou).toBe(true);
    // seat 0 watching seat 2 win: correct name, no "you won"
    const p0 = victoryView(victoryInput(st, null), roster(st), 0)!;
    expect(p0.winnerSeat).toBe(seat);
    expect(p0.isYou).toBe(false);
  });

  it("points are finalPoints verbatim — 13 (over-10 ledger) renders as 13", () => {
    const st = wonState(1, 13);
    expect(victoryView(victoryInput(st, null), roster(st), 1)!.points).toBe(13);
    expect(victoryView(victoryInput(st, null), roster(st), 1)!.banner).toContain(
      "13 Victory Points",
    );
  });

  it("spectator (seat null) still sees the winner, never isYou", () => {
    const st = wonState(1, 10);
    const v = victoryView(victoryInput(st, null), roster(st), null);
    expect(v).not.toBeNull(); // winner info is public — no null for spectators
    expect(v!.isYou).toBe(false);
    expect(v!.name).toBe(st.players[1]!.name);
    expect(v!.banner).toBe("🏆 Blue wins — 10 Victory Points");
  });

  it("sub-line is seat-aware now that rematch IS on the wire (P3(b))", () => {
    // Host (seat 0): the button copy path. P3(a)'s "can start a rematch soon"
    // line died with the wire deferral — this pins the REPLACEMENT contract.
    const host = victoryView(victoryInput(wonState(0, 10), null), roster(freshGame()), 0)!;
    expect(host.sub).toBe("You're the host — start a rematch when you're ready");
    expect(host.canRematch).toBe(true);
    expect(host.rematchLabel).toBe("Start rematch");
    // Guest (seat 2) and spectator (null): waiting copy, no button dangling.
    for (const seat of [1, 2, 3, null] as const) {
      const v = victoryView(victoryInput(wonState(0, 10), null), roster(freshGame()), seat)!;
      expect(v.sub, `seat ${seat}`).toBe("Waiting for the host to start a rematch…");
      expect(v.canRematch, `seat ${seat}`).toBe(false);
      expect(v.rematchLabel, `seat ${seat}`).toBeNull();
    }
    // Winner identity is orthogonal to host-ness: seat 1 winning does not
    // make seat 1's client a host.
    const win1 = victoryView(victoryInput(wonState(1, 10), null), roster(freshGame()), 1)!;
    expect(win1.canRematch).toBe(false);
    expect(win1.isYou).toBe(true);
  });
});

describe("victoryView — redaction honesty (poisoned sentinels)", () => {
  /**
   * Every field victoryView is FORBIDDEN to read is replaced with a unique
   * poisoned sentinel. If the view ever reaches past winner/finalPoints and
   * the public roster, a sentinel shows up in the output and this fails.
   * Structural: the parameter type VictoryInput admits ONLY two integers.
   */
  const POISON = "POISONED-SENTINEL-7f3a";

  it("output contains no sentinel from hands, devHands, deck or seed", () => {
    const st = afterRoll();
    const poisoned: GameState = {
      ...st,
      phase: "ended",
      winner: 1,
      finalPoints: 10,
      rngSeed: -999, // poison (not a string, but must never surface)
      rngCursor: -998,
      bank: { wood: -1, brick: -1, wool: -1, wheat: -1, ore: -1 },
      deck: ["victoryPoint", "victoryPoint", "victoryPoint"], // fake VP cards
      discardPile: ["monopoly"],
      players: st.players.map((p) => ({
        ...p,
        name: POISON,
        hand: { wood: 99, brick: 99, wool: 99, wheat: 99, ore: 99 },
        devHand: ["victoryPoint", "victoryPoint"], // would OVER-report VP
        knightsPlayed: 99,
      })),
      buildings: {
        "POISONED-VERTEX": { kind: "city", owner: 1 },
        ...st.buildings,
      },
    };

    // The roster handed to the view is the PUBLIC one (real names), so a
    // leak can only come from the state object.
    const v = victoryView(victoryInput(poisoned, null), roster(st), null);
    expect(v).not.toBeNull();

    const rendered = JSON.stringify(v);
    expect(rendered).not.toContain(POISON);
    expect(rendered).not.toContain("POISONED");
    expect(v!.name).not.toBe(POISON);
    expect(v!.name).toBe(st.players[1]!.name); // real public roster name

    // The poisoned deck/devHands would make any computed tally 2 (fake VP
    // cards) or more; the view reports finalPoints verbatim instead.
    expect(v!.points).toBe(10);
    expect(v!.winnerSeat).toBe(1);
  });

  it("a poisoned roster entry for a NON-winner never reaches the banner", () => {
    const st = afterRoll();
    const v = victoryView(
      victoryInput({ ...st, phase: "ended", winner: 0, finalPoints: 10 }, null),
      st.players.map((p) => ({ seat: p.seat, name: p.seat === 0 ? p.name : POISON, color: p.color })),
      0,
    )!;
    expect(v.name).not.toContain("POISON");
    expect(v.banner).not.toContain("POISON");
    expect(v.winnerSeat).toBe(0);
  });
});

describe("victoryView — defensive paths", () => {
  it("roster missing the winner: fallback copy, still no crash", () => {
    const st = wonState(2, 10);
    const v = victoryView(victoryInput(st, null), roster(st).filter((p) => p.seat !== 2), 2);
    expect(v).not.toBeNull();
    expect(v!.name).toBe("a player");
    expect(v!.colorKey).toBe("Seat 2");
    expect(v!.points).toBe(10);
    expect(v!.isYou).toBe(true);
    expect(v!.banner).toBe("🏆 Seat 2 wins — 10 Victory Points");
  });

  it("empty roster: still a banner (server-set winner is authoritative)", () => {
    const v = victoryView({ winner: 3, finalPoints: 12 }, [], null)!;
    expect(v.name).toBe("a player");
    expect(v.points).toBe(12);
    expect(v.isYou).toBe(false);
  });

  it("finalPoints null with a winner degrades to 0, never NaN", () => {
    const v = victoryView({ winner: 0, finalPoints: null }, [], 0)!;
    expect(v.points).toBe(0);
    expect(v.banner).toBe("🏆 Seat 0 wins — 0 Victory Points");
  });

  it("singular point copy: 1 VP reads '1 Victory Point'", () => {
    const v = victoryView({ winner: 0, finalPoints: 1 }, [{ seat: 0, name: "P1", color: "Red" }], 0)!;
    expect(v.banner).toBe("🏆 Red wins — 1 Victory Point");
  });
});

describe("catan:e2eWin (AC4)", () => {
  it("reads only seats 0..3; absent/garbage is no override", () => {
    expect(readE2eWinSeat(fakeStorage())).toBeNull();
    expect(readE2eWinSeat(fakeStorage(""))).toBeNull();
    expect(readE2eWinSeat(fakeStorage("x"))).toBeNull();
    expect(readE2eWinSeat(fakeStorage("4"))).toBeNull();
    expect(readE2eWinSeat(fakeStorage("-1"))).toBeNull();
    expect(readE2eWinSeat(fakeStorage("2.5"))).toBeNull();
    expect(readE2eWinSeat(fakeStorage("2"))).toBe(2);
    expect(readE2eWinSeat(fakeStorage("0"))).toBe(0);
  });

  it("injects a synthetic winner ONLY when the projection has none", () => {
    const live = freshGame();
    expect(live.winner).toBeNull();
    const injected = victoryInput(live, 2);
    expect(injected).toEqual({ winner: 2, finalPoints: 10 });
    const v = victoryView(injected, roster(live), null)!;
    expect(v.winnerSeat).toBe(2);
    expect(v.banner).toBe("🏆 Orange wins — 10 Victory Points");
    expect(v.isYou).toBe(false);

    // No flag → no banner on a live game.
    expect(victoryInput(live, null)).toEqual({ winner: null, finalPoints: null });
    expect(victoryView(victoryInput(live, null), roster(live), null)).toBeNull();
  });

  it("a REAL winner always beats the flag (never overrides a finished game)", () => {
    const won = wonState(1, 13);
    expect(victoryInput(won, 2)).toEqual({ winner: 1, finalPoints: 13 });
    expect(victoryView(victoryInput(won, 2), roster(won), 1)!.winnerSeat).toBe(1);
  });

  it("a disabled store throws nothing (same guard as the targets hook)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(readE2eWinSeat(hostile)).toBeNull();
  });
});
