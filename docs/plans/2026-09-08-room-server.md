---
status: active
created: 2026-09-08
updated: 2026-09-08
slug: room-server
---

# Plan: M2 — Room Server (apps/room)

## Context

M1 shipped a pure, deterministic, fully-tested kernel (`packages/shared` 0.5.0: `applyAction`, 20-op `OpSchema`, `legalMoves`, `redactForSeat`, golden-replay bots). M2 wraps it in a WebSocket room server so 3–4 friends can play from separate browsers. Pattern source: mahjong-vtt `apps/room` (one room per game, host invite code, seat claim tokens, host/guest split) and dnd-vtt gateway ops discipline. Ports: WS **:4273**. Deploy: local only (Railway deferred by user directive).

## Non-negotiable invariants inherited from M1

1. **Server is the sole authority**: only server applies `applyAction` to the true state. Clients send `OpSchema` frames; everything else is projection.
2. **Projections only on the wire**: each client receives `redactForSeat(state, seat)` JSON — never the full state (spectators: a "public" projection variant, or seat-less view with all hands squashed — decide in phase 1).
3. **RNG rebase (wave-5 review MAJOR, load-bearing):** the server must NEVER ship a client-replayable stream. `rollLog` + `rngCursor` + xorshift32 = minutes of brute force to recover all future rolls. Design: projections ship `rngCursor: 0` and a per-room *display seed* (constant); the server keeps the true `{rngSeed, rngCursor}` in its private state. This requires a tiny kernel-side allowance: `redactForSeat` currently keeps the cursor — M2 adds a second, wire-level scrub (server-owned function in apps/room, kernel untouched) OR a wave-5b kernel flag. **Decision in phase 1; lean: scrub lives in apps/room** (kernel purity stays, wire contract is a server concern). Server applies `roll` on true state, then re-ships projections — clients never roll locally (matches the documented commuting-set exclusion).
4. **Relay whitelist derives from `OpSchema`** (AC9) — no duplicated op list. Zod parse on receipt; reject-before-apply.

## Approach (phases, each green-committed)

1. **Protocol spec + message schemas** (`docs/features/multiplayer.md` rewrite; zod schemas for client→server `{type:"op", op}` / server→client `{type:"projection"|"legalMoves"|"event"|"joined"|"seat"|"error"}` in `packages/shared/protocol.ts` — shared package so client and server import the SAME schema; kernel untouched). AC: protocol.test.ts round-trips; `OpSchema` re-exported; spectator-view decision documented.
2. **Room core (pure, no net)**: `apps/room/src/room.ts` — Room class over kernel: create (seed via passed-in rng or crypto-throw-in — server-side, not kernel), join/claim seat (token issue), applyOp(seat, op) → recompute per-seat projections + legalMoves, action-log ring buffer, rehydrate payload. Deterministic w/ injected seed (testable). AC: headless 3-seat game driven to a real 10-VP win in a test (reuse golden bot priorities via legalMoves on true state, but ops routed THROUGH Room like a client).
3. **WS transport**: `ws` on :4273; per-connection auth (room code + seat token), message dispatch to Room, broadcast projections on state change, ping/timeout cleanup, rejoin-rehydrate by seat token. AC: integration test with two real `WebSocket` clients exchanging ops headless ("text-mode Catan" gate from AGENTS.md).
4. **Room lifecycle + invites**: create → code, host seat 0 (or empty-seat policy — decide phase 1: seats claimed join-order vs host-assigned), spectators browse, mid-game reconnect, game end keeps room (rematch = new seed, same room). AC: e2e script — 3 clients, full setup + 30 real turns + one wins; disconnect/rejoin survives; bad op gets typed error, room stable.
5. **Ops surface for M3**: `legalMoves` shipped per-seat with every projection (client renders from it — the M1 UI contract pays off here).

## Acceptance criteria

- [x] AC1: `npm test` green across packages incl. new protocol + room suites; tsc clean monorepo-wide.
- [x] AC2: Multi-terminal game over real sockets (headless proof): 3 clients, seeded text-mode game, WIN branch — 1671 ops ≫ 30 turns, identical winner + finalPoints on every client (`server.test.ts` "three clients play a seeded game"; logged `[wire-game] branch=WIN`; 5/5 isolated runs green). Manual two-terminal demo ships with phase 4's `npm run start`.
- [x] AC3: Every inbound frame in every wire test is parsed by `ServerMsgSchema` (structural), every projection has rngSeed/rngCursor=0 + GameStateSchema re-parse, others' hands all-wood-squashed at true totals; full mini-game frame capture asserts the TRUE seed integer appears in no frame (`server.test.ts` AC3 block).
- [x] AC4: Forged seat → kernel `notYourTurn` via event{rejected}; malformed inner ops → transport error{badMessage} + 3-strike drop (its own test); victim projection BYTE-IDENTICAL across the burst; room serves the next legit op. (`server.test.ts` AC4 block; trust model documented in multiplayer.md §8.)
- [x] AC5: Over the wire: disconnect→playerLeft→token rejoin→rotation→old-socket-close-cannot-evict, rejoin mid-awaitingSeven resolves the window, rejoin mid-pendingTrade survives both parties' churn (offer stands, accept after rejoin). Superseded-socket op guard + second-join-replace tested.
- [x] AC6: docs/features/multiplayer.md rewritten to match what shipped; STATE-SNAPSHOT refreshed.

## Files to be touched

`apps/room/{package.json,src/*.ts,src/*.test.ts}`, `packages/shared/src/protocol.ts` (new), `docs/features/multiplayer.md`, `docs/STATE-SNAPSHOT.md`, root `package.json` workspaces/scripts, this plan.

## Out of scope

Auth accounts, persistence/DB, deploy/Railway, chat UX, turn timers, anti-cheat beyond AC3/AC4 floors, 3D table (M3), mobile.

## Verification

`npm test`, `npm run typecheck`; integration via two `WebSocket` client harness in tests; manual two-terminal walkthrough recorded under `docs/e2e-review/m2-room/` (log transcripts; no WebGL here).

## Linked artifacts

Update when done: `TECHNICAL-DOCUMENTATION.md` §5 (protocol table → real), `FUNCTIONAL-SPECIFICATIONS.md` §1/§6 (rooms/reconnection become contract), recap.

## Progress log

- **2026-09-08 phases 1+2 — DONE (this commit).** protocol.ts wire contract (parent-tightened roomCode to [A-Za-z0-9]{6}, added badToken wire code) + 20 round-trip/rejection tests; apps/room core (room.ts 455L: claim/rejoin token rotation, 7-step applyOp authority, wireScrub rngSeed+rngCursor, memoized projections, spectator squash, event ring, rematch) + 34 tests incl. full text-mode game to a hard-asserted 10-VP WIN (1766 ops, 0 rejections) and AC5 rejoin-mid-seven / rejoin-mid-trade. 2-stage review (deleg_6b8fdab6 spec PASS, deleg_269d9117 quality CHANGES-REQUESTED->all 15 fixed/ruled): events() slice, tautology assertion, seat-by-value squash, Extract<> code link, lobby-policy doc (partial-claim room WAITS, not deadlocks), name cap 24, VP-over-report quirk note in redact.ts, roster carries color. AC1 ✅ AC6 ✅; AC2 needs phase 3 sockets; AC3/AC4 partial (core-proven, wire pending).

- **2026-09-08 phase 3 — DONE (commit `eba7396` + this fix batch).** `server.ts` ws transport + 22 wire tests. SPEC review FAIL → both MAJORs fixed: sweep now releases seats (ghost-seat lobby stall), gameEnded ships BEFORE the terminal projection (AC2 assertion was racy 2/5 — now 5/5 green isolated). Minors taken: roomNotFound test, wire-pendingTrade AC5 closure, superseded-socket guard test, second-join-replace test (bound kept), spectator-post-op broadcast test, opTypeOf dedup. Snapshot refreshed (246/246). Phases 4-6 remain (start script + two-terminal demo, chat plumbing, soak).
