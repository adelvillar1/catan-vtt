---
status: draft
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

- [ ] AC1: `npm test` green across packages incl. new protocol + room suites; tsc clean monorepo-wide.
- [ ] AC2: Two-terminal demo (gate from the milestone plan): host creates room, friend joins, both play 30+ turns text-mode, winner announced identically on both.
- [ ] AC3: No frame ever contains hidden info: assert projections parse as `redactForSeat` output AND contain no replayable rng (cursor scrubbed; grep/structural test on wire fixtures) AND hand-composition of other seats is squashed.
- [ ] AC4: Malicious-client probes: send op out of turn / fake seat / full-state-shaped payload / raw zod-injection keys → typed rejection, room keeps running, victim projection unchanged. (This is the "security later" floor — not hardening beyond it.)
- [ ] AC5: Reconnect rehydrates seat correctly mid-seven-window and mid-pending-trade (the two frozen states).
- [ ] AC6: docs/features/multiplayer.md rewritten to match what shipped; STATE-SNAPSHOT refreshed.

## Files to be touched

`apps/room/{package.json,src/*.ts,src/*.test.ts}`, `packages/shared/src/protocol.ts` (new), `docs/features/multiplayer.md`, `docs/STATE-SNAPSHOT.md`, root `package.json` workspaces/scripts, this plan.

## Out of scope

Auth accounts, persistence/DB, deploy/Railway, chat UX, turn timers, anti-cheat beyond AC3/AC4 floors, 3D table (M3), mobile.

## Verification

`npm test`, `npm run typecheck`; integration via two `WebSocket` client harness in tests; manual two-terminal walkthrough recorded under `docs/e2e-review/m2-room/` (log transcripts; no WebGL here).

## Linked artifacts

Update when done: `TECHNICAL-DOCUMENTATION.md` §5 (protocol table → real), `FUNCTIONAL-SPECIFICATIONS.md` §1/§6 (rooms/reconnection become contract), recap.
