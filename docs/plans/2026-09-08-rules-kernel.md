---
status: draft
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

- [ ] AC1: `npm test -w packages/shared` passes with ≥120 tests covering every numbered phase above.
- [ ] AC2: Deterministic replay: same seed → identical full game log; a golden test plays 3 scripted games start→10 VP to completion.
- [ ] AC3: Setup invariants hold over 10,000 seeded variable setups (property test): correct disc multiset, desert gets no disc, robber on desert, every 2:1 port legal-or-swapped, all players can place openings.
- [ ] AC4: Every illegal mutation is rejected with a typed error: illegal distance, unconnected road/build, road through opponent building, over caps, trade gift/same-swap/dev-card, bank trade off-turn, 3:1 without port, dev play off-turn / same-turn-purchased, second dev per turn, win claim off-turn, robber-not-moved-on-7, discard-count-wrong.
- [ ] AC5: Supply exhaustion rule encoded + tested (multi-player shortfall → none; single affected → remainder).
- [ ] AC6: Longest Route breakage test: enemy settlement spoke splits a 7-road route → tile moves/returns exactly per rules.
- [ ] AC7: `redactForSeat` leaks nothing: for a mid-game state, seat view JSON contains no string of any hidden resource/dev card not owned (structural test).
- [ ] AC8: `applyAction` is the only exported mutator (no state-mutation exports; lint/test guard).
- [ ] AC9: `ActionSchema` zod enum exported from shared — the future server relay whitelist derives from it (single source of truth).
- [ ] AC10: Coverage matrix in `docs/features/rules-kernel.md` lists every op, its validator, its test file; no op without a test.

## Files to be touched

`packages/shared/{package.json,tsconfig.json,src/*.ts,src/*.test.ts}`, `docs/features/rules-kernel.md`, this plan, `CLAUDE.md` (Today's state), `docs/STATE-SNAPSHOT.md`.

## Out of scope

Multiplayer/WS server, any rendering, expansions (5–6p/Seafarers/C&K), bots, AI opponents, post-game stats UI, i18n. (Kernel API must make these additive — phases stay data-driven.)

## Verification

`npm test -w packages/shared`; property tests print seed; coverage matrix diff-reviewed vs `catan-board-game/references/base-rules.md` section list; AC8 via grep of exports.

## Linked artifacts

Update when done: `TECHNICAL-DOCUMENTATION.md` §3/§5 (op table), `FUNCTIONAL-SPECIFICATIONS.md` §3/§4 (behavior claims become contract), `docs/features/rules-kernel.md` (new), recap at `docs/recaps/`.
