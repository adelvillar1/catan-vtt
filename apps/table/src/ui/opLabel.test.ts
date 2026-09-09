/**
 * opLabel.test.ts — M3-P3(a) review follow-up I-1: the eventTail branches
 * (incl. the gameEnded row the victory ticker exists for) get real tests.
 * Node env (pure fns). opLabel's op-labeling had no tests before this file;
 * eventTail is the new branch P3(a) shipped, so it leads here.
 */
import { describe, expect, it } from "vitest";
import { eventTail } from "./opLabel.js";

describe("eventTail", () => {
  it("gameEnded: names winner + points (the row must never be a bare 'gameEnded')", () => {
    expect(eventTail("gameEnded", { winner: 2, finalPoints: 10 })).toBe(
      " · winner seat 2 — 10 VP",
    );
  });

  it("gameEnded without a numeric winner degrades to '' (defensive branch)", () => {
    // TODAY UNREACHABLE: phase 'ended' has exactly one writer (turn.ts
    // applyClaimVictory) which sets winner AND finalPoints together, and the
    // server only broadcasts gameEnded when phase === 'ended'. The branch is
    // for a FUTURE ended source (abandon/rematch). If this test ever matters,
    // P3(b) added one — keep both sides honest then.
    expect(eventTail("gameEnded", {})).toBe("");
    expect(eventTail("gameEnded", { winner: null, finalPoints: null })).toBe("");
    expect(eventTail("gameEnded", { winner: "2" })).toBe("");
  });

  it("gameEnded with points missing still names the winner", () => {
    expect(eventTail("gameEnded", { winner: 0 })).toBe(" · winner seat 0");
  });

  it("rejected: shows the kernel code, nothing else", () => {
    expect(eventTail("rejected", { code: "notYourTurn", seat: 1 })).toBe(" · notYourTurn");
    expect(eventTail("rejected", { seat: 1 })).toBe(""); // malformed: no dump
  });

  it("opApplied-family kinds: show opType when present", () => {
    expect(eventTail("opApplied", { opType: "roll", seat: 0, seq: 4 })).toBe(" · roll");
    expect(eventTail("opApplied", { seat: 0 })).toBe("");
  });

  it("playerJoined/playerLeft/chat/gameOver-ish kinds: no raw detail dump", () => {
    expect(eventTail("playerJoined", { seat: 1, name: "Bot" })).toBe("");
    expect(eventTail("chat", { text: "hi" })).toBe("");
  });

  it("unknown kind with junk details returns '' (opaque-details law holds)", () => {
    expect(eventTail("mystery", { anything: { nested: true } })).toBe("");
  });
});
