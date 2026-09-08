---
status: done
created: 2026-09-08
updated: 2026-09-08
slug: rules-kernel
---

# Plan: Rules Kernel (packages/shared)

## Context

catan-vtt's foundation is a pure-TS rules kernel that fully implements the CATAN base game (3–4 players). Everything downstream (room server, 3D table, bots, balance sims) is a client of `applyAction`. Rules authority: the `catan-board-game` Hermes skill (`references/base-rules.md`, `references/setup.md`, `references/glossary.md` for FAQ disputes) distilled from the official 5th/6th Ed rulebooks. This mirrors mahjong-vtt's `packages/shared` referee (141 tests) — same discipline: kernel-first, UI-last.

## Approach

Single package `packages/shared`, zod 3.x, vitest. Phases, each committed when green:

1. **State model** — island graph (hexes/intersections/edges with adjacency precomputed), supply (95 resources, 25-card dev deck order hidden in state but redactable), per-player pieces/hands, bonus tiles, phase machine (setup → play → ended). Seeded RNG (splitmix/xorshift) stored in state so any game replays deterministically.
2. **Setup generators** — FixedSetup (6th Ed beginner layout) + VariableSetup (hex shuffle, spiral number-disc placement A–R skipping desert, port placement with 2:1-on-matching-terrain legality + swap procedure, robber→desert). Output validates: every hex gets exactly the disc set {2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12}.
3. **Placement validators** — Distance Rule (2-edge keep-out), road connectivity (own network only; blocked-through-opponent rule), settlement→road attach, city-only-on-own-settlement, piece caps (15/5/4).
4. **Turn machine** — playDevCard (one/turn, not-bought-this-turn), roll (server seed), production (settlement×1/city×2, supply-exhaustion rule incl. single-affected-player remainder), resolveSeven (discard >7 half-rounded-down; robber MUST move to different hex incl. desert; random steal from a building-adjacent player or none), action phase (build/trade/buy any order any count), pass dice.
5. **Trade legality** — domestic (announce give/want, no gifts, no same-resource even swaps, no dev cards, only active player as counterparty), maritime 4:1, port 3:1/2:1 requiring building on port node.
6. **Dev cards** — Knight (activate robber, no discard step), VP (hidden, reveal at claim), Monopoly (all of one type from all players), Road Building (2 roads each anchored to existing network, simultaneous placement), Invention (2 cards from supply). Deck composition 14/5/2/2/2.
7. **Bonus tiles** — Longest Route ≥5 continuous, breakage→return-to-supply, transfer on strictly-longer, tie→holder keeps; Largest Army ≥3 knights played, same transfer semantics.
8. **Win** — VP ledger (settlement 1/city 2/tiles 2/VP-cards 1), claim legal ONLY on claimant's own turn with total ≥10; reveal-set proof.
9. **Redaction** — `redactForSeat(seat)` projects hidden info (others' resource counts public, contents private; dev hands and deck order invisible).
10. **Coverage matrix** — `docs/features/rules-kernel.md` gets a table: every action/op × its tests, like the dnd-vtt parity matrix; the AC below reference it.

## Acceptance criteria

- [x] AC1: `npm test` passes with ≥120 tests covering every numbered phase above. _(170/170 at wave-5 close, 12 files)_
- [x] AC2: Deterministic replay: same seed → identical full game log; a golden test plays 3 scripted games start→10 VP to completion. _(EXCEEDED: 6 seeded bot games × 3- and 4-player all reach real 10-VP wins (135–408 turns) + determinism double-run + scripted claim; same-seed exact-replay test since wave 2)_
- [x] AC3: Setup invariants hold over 10,000 seeded variable setups (property test): correct disc multiset, desert gets no disc, robber on desert, every 2:1 port legal-or-swapped, all players can place openings.
- [x] AC4: Every illegal mutation is rejected with a typed error: illegal distance, unconnected road/build, road through opponent building, over caps, trade gift/same-swap/dev-card, bank trade off-turn, 3:1 without port, dev play off-turn / same-turn-purchased, second dev per turn, win claim off-turn, robber-not-moved-on-7, discard-count-wrong. _(all matrices green; 32-code error union — pieceNotInStage removed as dead code at M1 close)_
- [x] AC5: Supply exhaustion rule encoded + tested (multi-player shortfall → none; single affected → remainder).
- [x] AC6: Longest Route breakage test: enemy settlement spoke splits a 7-road route → tile moves/returns exactly per rules. _(incl. own-buildings-don't-break + 6-ring-counts-6, both official-FAQ-verified)_
- [x] AC7: `redactForSeat` leaks nothing: for a mid-game state, seat view JSON contains no string of any hidden resource/dev card not owned (structural test). _(stronger: byte-identical projections from states differing ONLY in hidden info; note — seed is brute-forceable from rollLog+cursor, server-side rebase deferred to M2 by design)_
- [x] AC8: `applyAction` is the only exported mutator (no state-mutation exports; lint/test guard). _(deep-freeze input fuzz across all waves; every handler returns fresh state — probes + suites)_
- [x] AC9: `OpSchema` zod discriminated union exported from shared — the future server relay whitelist derives from it (single source of truth). _(20 ops)_
- [x] AC10: Coverage matrix in `docs/features/rules-kernel.md` lists every op, its validator, its test file; no op without a test. _(20/20 ops named; redaction rows added)_

## Progress log (build-time)

- **Wave 1 (foundation) — DONE** `3465083`: rng/board/state/setup, 61 tests. Review: spec PASS / quality APPROVED + replay-blocker fix (single continuous RNG; `Rng.restore({rngSeed,rngCursor})` is the locked dice contract).
- **Wave 2 (turn machine) — DONE** `468f63a`: actions/turn/road + AwaitingSeven extensions, 110 tests. Review caught 5 rules bugs, 3 of them authored by the PARENT brief (own-buildings breaking routes; seat-1 first turn; road blocked at enemy ENDPOINT — official: up-to is legal, only starting past is not; anchor-only setup roads; closed-ring undercount). All fixed + skill `references/setup.md` patched so the KB carries the correct rulings.
- **Wave 3 (trades + dev cards) — DONE** `5a392bf`: maritime/port/domestic trades (offer/accept lifecycle, 7-freeze), buyDevCard + Monopoly/RoadBuilding/YearOfPlenty, zero-RNG verified, golden-replay bot harness (wave-4-ready). 142 tests. Review: spec PASS + quality APPROVED, zero Critical/Important; one Minor (devBoughtLast double-buy approximation) → tightened to per-type count in wave 4 (dispatched).
- **Wave 4 (win + bonus tiles + golden to 10 VP) — DONE** `49245a1`: vp.ts ledger (1/2/2/2/+cards, current-holder bonuses), claimVictory + ended lockdown, devBoughtThisTurn per-type counter (double-buy hole closed), Largest Army 4-probe. 159 tests; six seeded bot games reach REAL 10-VP wins. Review: spec PASS + quality APPROVED; one review suggestion (ended-guard before zod parses) REJECTED with rationale — fail() must run on parsed state.
- **Wave 5 (redactForSeat) — DONE** `7e8d457`: pure schema-valid seat projection (others' hands→totals-in-wood, devHands→VP-at-length, deck→knight-at-length, seed zeroed); 11 tests incl. the byte-identical leakage proof + 8-op strict-JSON commutativity (the M3 optimistic-UI property). Review: spec PASS + quality APPROVED. M2 TODO captured: rollLog+rngCursor makes the 2^32 seed brute-forceable → server rebases/never ships the replayable stream; devBoughtThisTurn pass-through documented as deliberate v1 loosening.

**M1 KERNEL ACCEPTED 2026-09-08: AC1–AC10 all green** (170 tests, tsc clean, coverage matrix 20/20 ops named). Next: M2 room-server plan (`docs/plans/2026-09-08-room-server.md`).

## Files to be touched

`packages/shared/{package.json,tsconfig.json,src/*.ts,src/*.test.ts}`, `docs/features/rules-kernel.md`, this plan, `CLAUDE.md` (Today's state), `docs/STATE-SNAPSHOT.md`.

## Out of scope

Multiplayer/WS server, any rendering, expansions (5–6p/Seafarers/C&K), bots, AI opponents, post-game stats UI, i18n. (Kernel API must make these additive — phases stay data-driven.)

## Verification

`npm test -w packages/shared`; property tests print seed; coverage matrix diff-reviewed vs `catan-board-game/references/base-rules.md` section list; AC8 via grep of exports.

## Linked artifacts

Update when done: `TECHNICAL-DOCUMENTATION.md` §3/§5 (op table), `FUNCTIONAL-SPECIFICATIONS.md` §3/§4 (behavior claims become contract), `docs/features/rules-kernel.md` (new), recap at `docs/recaps/`.
