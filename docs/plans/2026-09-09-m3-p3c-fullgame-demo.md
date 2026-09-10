# M3 P3(c) — the AC2 demo: a full game to 10 VP, entirely through the browser

**Date:** 2026-09-09 · **Milestone:** M3 · **Phase:** P3(c) — the exit gate
**Anchor:** M3 plan AC2: "Full 3p game playable end-to-end through the table UI to a 10-VP
winner (Playwright-driven or 3 manual tabs with captured evidence)." Every phase so far has
proven a SURFACE; this phase proves the GAME. It also collects the one deferred pixel: the
discard modal in a real seven window (P2(b1) honest deferral), and exercises P3(b)'s rematch
in anger (game 2 begins from a clicked button, not a unit test).

## What proves AC2 (evidence contract)

`scripts/m3-fullgame.mjs` — a THREE-TAB Playwright driver (one context per seat, P3(b)
lesson: shared localStorage auto-rejoins steal seats). Every seat is a real browser client:
join, watch the 3D island, act ONLY through DOM buttons and canvas ghosts, same as a human.
The run PASSES iff the room server reaches phase "ended" with a winner and the victory
banner shows a real (not e2eWin) winner — **catan:e2eWin is FORBIDDEN in this script** (its
presence would fake the outcome; the only injections allowed are catan:e2eTargets for canvas
ghost coords).

**Greedy policy per seat (documented in-script, deterministic, NO randomness of its own):**
- setup phase: click the first canvas ghost (the placement MovesList order IS the server's
  legalMoves order; ghost-first proves the 3D path under load — 15+ placements);
- own turn: prefer buildCity > buildSettlement > buildRoad > buyDevCard (click DOM button by
  opLabel text); else roll if rolls==0; else play knight if shipped (hex ghost follows);
  else endTurn. NO trading (the kernel needs no trades for a win with fair dice; trading is
  P2(a)-proven and keeps this driver honest and short);
- seven window: DiscardModal (#discard-modal) appears -> click .chip-btn resource chips
  (labels "WOD · wood" + .chip-count remaining) until #discard-submit ENABLES (the picked
  combination must match a shipped discardSeven op — the modal computes canSend; greedy:
  highest-count resource first, chip-click loop is self-correcting because a disabled chip
  means exhausted), then click #discard-submit. The pixel this captures IS the P2(b1)
  deferred evidence;
- robber move ghost -> click center; stealCard -> pick the victim DOM option, first seat;
- claimVictory button appears -> click (ends game); after end: seat 0 tab clicks
  #victory-rematch -> all three tabs must show a fresh setup projection (the rematch button
  proven for real, first time) -> play game 2 to ITS winner? NO — out of budget; the
  re-rendered setup phase + winner-null banner + ghosts-on-canvas IS the proof (the
  server.test 'game 2 gets its OWN gameEnded' covers the rest).
- watchdog: if serverSeq stalls > 120s with no modal open, dump status + fail honestly
  (never fake a pass).

**Stall analysis (why this won't die like the P2(b1) discard drive did):** there all
DECISIONS lived in one browser plus two idle bots; here three active drivers each unblock
the next seat — the M2 602-op bot game proves the game terminates; a browser-greedy policy
of the same shape terminates too. Risk graded: greedy builds can starve each other on
roads (longest-road races can't deadlock — endTurn always ships as a fallback move). The
worst honest failure is "reached seq N, not ended" — which the script REPORTS, screenshot
included, and then P4 decides whether a seed tweak is warranted (seeds are ROOM-level env,
not a client secret — ROOM_SEED stays the parent's dial).

**Evidence artifacts (docs/e2e-review/m3-p3c/):** 01-setup-ghosts.png, 02-midgame.png,
03-discard-modal.png (THE deferred pixel), 04-robber.png, 05-victory.png (real winner),
06-rematch-fresh.png (banner gone, setup phase, seq UNCHANGED — a rematch is
not an op, see P3(b)), fullgame.log (seq timeline,
per-seat op counts, rejected count — MUST be 0 for PASS), game-statistics line (total ops,
minutes). README.md states AC2 and maps each screenshot to the claim.

## Budget

Playwright budget 900s per run (M2 full games took ~602 ops; browser clicks ~300ms each
with render waits -> worst case ~10 min). Node 24, same playwright-core/EXEC constants as
the sibling harnesses.

## Files (fence)

- scripts/m3-fullgame.mjs (new)
- docs/e2e-review/m3-p3c/ (new; parent-owned, the script writes INTO it)
- scripts/p3c-stack.sh: clone of p2b-stack WITHOUT bots (three tabs claim seats) and WITH
  a ROOM_SEED env passthrough + `--timeout` note. (Existing p2b-stack.sh stays untouched —
  P2(b1) evidence tooling.)
- NO app-source changes. If the demo EXPOSES an app bug, that bug gets its own fix commit
  with a test (that is the POINT of the demo; do not paper over it in the driver).
- Selector ground truth (parent-verified THIS session, cite in the script header):
  #moves-list button text = opLabel labels; #discard-modal/.chip-btn/#discard-submit as
  above; ghost coords via window.__catanTargets() under catan:e2eTargets; #victory-heading/
  #victory-rematch; status seq via section[aria-label='status'] regex serverSeq\D+(\d+).

## Delegation shape

1 build child (hy4) writes m3-fullgame.mjs + p3c-stack.sh + runs it to green (or honest
failure) ONCE with screenshots — child owns the loop. Parent: re-runs once (fresh room),
checks the rejection count + the discard pixel + the rematch frame, reviews the driver code
for policy-honesty (no hidden op injection), commits evidence. Quality review of the DEMO
batch = same reviewer pattern (the driver IS the artifact under review: vacuity + honesty
lenses). AC2 then gets a line in the plan + STATE-SNAPSHOT: "full game through the browser,
X ops, 0 rejections, rematch button clicked in anger."

## Out of scope (P4)

cinematic polish (dice tumble, camera fly, audio) — the demo comes FIRST because it can
break anything; polish after proof. Seeds/lobby UX, chat, deploy (user-gated).
