# catan-vtt — Technical Documentation

> **For:** Developer onboarding and reference
> **Repo:** https://github.com/adelvillar1/catan-vtt
> **Production:** (none yet)

This is the developer-onboarding contract — how the system is built. Summary-style; deep dives live in `docs/`. Both layers stay in sync as part of finishing a feature (see CLAUDE.md "Housekeeping protocol").

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Database Schema](#4-database-schema)
5. [API / Protocol Reference](#5-api--protocol-reference)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [Frontend Structure](#7-frontend-structure)
8. [Rendering (3D table)](#8-rendering-3d-table)
9. [Deployment & Environments](#9-deployment--environments)
10. [Development Workflow](#10-development-workflow)
11. [Scripts Reference](#11-scripts-reference)
12. [Observability](#12-observability)

---

## 1. Project Overview

A playable 3–4 player CATAN replica: authoritative rules kernel + cinematic 3D hex-island table + WebSocket rooms with invite links. Mirrors the mahjong-vtt split: the kernel is the single source of truth; the table and the room server are clients of it.

<add-when-implemented>
- Session model: a "table" = room with 3–4 seats + optional spectators/browse
</add-when-implemented>

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Rules kernel | TypeScript + zod 3.x (pure, Node-free) in `packages/shared` |
| Table client | Vite 8 + React 19 + react-three-fiber 9 + drei + three 0.185 + zustand |
| Room server | Node + `ws` (WebSocket), JSON protocol, zod-validated ops |
| Persistence | none yet (in-memory rooms; Postgres only if accounts are needed) |
| Tests | vitest (kernel), Playwright for visual/e2e evidence |
| Hosting | Railway (staging + prod) — <add-when-implemented> |
| CI/CD | git push → Railway watch-branch <add-when-implemented> |

Rationale: [`docs/architecture/overview.md`](docs/architecture/overview.md)

## 3. Architecture

**Kernel/client split (mahjong-vtt pattern):** every game mutation goes through `applyAction(state, action) → state'` in `packages/shared` (KERNEL_VERSION 0.5.0). Illegal actions throw `ActionError(code, message, details?)` with a 32-code exhaustive union; the server is the only one who applies actions for a room; clients hold a **seat projection** (`redactForSeat(state, seat)` — still a schema-valid `GameState`) and render it. Clients optimistically apply ONLY the commuting op set (builds, own-hand trades, own dev plays, moveRobber, discardSeven, endTurn — proven strict-equal vs server in `redact.test.ts`); `roll`/`stealCard`/`buyDevCard`/`tradeAccept`/production-exposing ops are server-authoritative (they draw from the hidden rng stream or branch on hidden data).

Kernel facts (implemented + reviewed, waves 1–5):
- Deterministic seeded RNG: `Rng.restore({seed: rngSeed, cursor: rngCursor})` is the only mid-game RNG entry; roll = 2 draws, steal = 1; `legalMoves` and all wave-3/4/5 ops draw ZERO.
- `OpSchema` (z.discriminatedUnion, 20 ops, all `.strict()`) is the single source of truth — the server relay whitelist in M2 must derive from it (AC9).
- `legalMoves(state, seat)` enumerates every op `applyAction` would accept (bidirectional conformance swept in tests); documented exception: domestic `tradeOffer` is UI-composed, not enumerated.
- Setup: `variableSetup`/`randomDiscSetup(seed)` generators (10k-seed property-tested), snake placement with second-settlement terrain payment, port legality with swap-repair, seat 0 starts.
- Golden replay: `simulateGame(seed, {metaSeed})` greedy bot; six seeded games reach real 10-VP wins; conservation invariants (95 resources / 25 deck cards) asserted per step.
- **M2 TODO (from wave-5 review):** `rollLog` + exposed `rngCursor` make the 2^32 dice seed brute-forceable by any client holding a projection — the room server must NOT ship the replayable stream (rebase/hide cursor per projection, or ratchet the seed server-side).

Detail: [`docs/features/rules-kernel.md`](docs/features/rules-kernel.md), [`docs/features/multiplayer.md`](docs/features/multiplayer.md)

## 4. Database Schema

None yet. v1 rooms live in server memory. If auth/persistence lands, schema goes here + `docs/architecture/database.md`.

## 5. API / Protocol Reference

Style: WebSocket JSON frames (no HTTP API yet).

- Client→server: `{ op: <OpTypeSchema>, payload, refActionId }` — ops mirror kernel actions (see `packages/shared` actions).
- Server→client: `{ type: "state" | "joined" | "seat" | "error" | "chat", ... }`
- New-op touch list (lesson from dnd-vtt): kernel action type + zod enum + server relay whitelist + client dispatcher + tests, in ONE commit.

Full op table (kernel `packages/shared/src/actions.ts`, 20 ops; all `{type, seat}` + `.strict()`; authority: `docs/features/rules-kernel.md` matrix):

| Op | Extra fields | Primary gates | Distinct error codes |
|---|---|---|---|
| placeSetupPiece | kind(settlement\|road), vertexId\|edgeId | setup phase, snake queue, anchor-only road, distance rule | illegalSetupStage, vertexOccupied, distanceRule, roadBlocked, notConnected, noEdge |
| roll | — | own turn, !hasRolled, seven-window closed | alreadyRolled, awaitingSeven |
| discardSeven | cards[] (multiset) | queue front seat only, exact count | wrongDiscardSeat, insufficientHand, badOp |
| moveRobber | hexId | awaitingSeven, mustMoveRobber, ≠ current hex | robberSameHex, awaitingSeven |
| stealCard | victimSeat | robber hex occupants w/ handTotal>0 | noVictim, awaitingSeven |
| buildRoad | edgeId | own turn, hasRolled, wb cost, connectivity, start-past-enemy blocked | roadBlocked, notConnected, noRoadsLeft |
| buildSettlement | vertexId | wbsw cost, distance rule, connectivity | distanceRule, vertexOccupied, notConnected, noSettlementsLeft |
| buildCity | vertexId | 2 wheat+3 ore, own settlement only | noOwnSettlementThere, noCitiesLeft |
| playKnight | — | dev gate: own turn, !devPlayed, older-copy rule | noDevCard, devAlreadyPlayed |
| endTurn | — | hasRolled, seven resolved; clears pendingTrade + dev counters | awaitingSeven, notRolledYet |
| claimVictory | — | own turn, VP ledger ≥10, seven resolved | victoryInsufficient |
| tradeBank | offer, demand (resources) | own turn, hasRolled, 4:1, demand≠offer | insufficientHand, insufficientBank, tradeSameResource |
| tradePort | portVertexId, offer, demand | own building on port node; 2:1 type-locked | noPortThere, portResourceMismatch |
| tradeOffer | with, give[], want[] | proposer=currentSeat, no pending, hand covers give | tradePendingExists |
| tradeAccept | — | offeree only; both hands revalidated | noPendingTrade, notTradeCounterparty |
| tradeReject | — | offeree only; clears pending | noPendingTrade |
| buyDevCard | — | own turn, hasRolled, o+w+wh cost, deck non-empty | deckEmpty |
| playMonopoly | resource | dev gate; strips others' totals | noDevCard |
| playRoadBuilding | edgeIds[1\|2] | dev gate; each edge anchored PRE-card (no chaining) | notConnected, noRoadsLeft |
| playYearOfPlenty | cards[2] | dev gate; bank pair (same ok) | insufficientBank |

Room protocol (M2, planned): client→server `OpSchema` frames only (server relay whitelist DERIVES from the kernel union — AC9); server→client `state` (redacted per seat), `legalMoves`, `error {code}`. RNG: server never ships the replayable stream (see §3 M2 TODO).

## 6. Authentication & Authorization

<add-when-implemented>
Planned v1 (mirrors mahjong-vtt host/guest): room code + per-seat claim token; no accounts required to play. Host = who created the room. Later: passcode auth if public deploy demands it.
</add-when-implemented>

## 7. Frontend Structure

`apps/table/src/`: `scene/` (island, lighting, camera), `hex/` (terrain tiles, number discs, ports), `pieces/` (roads/settlements/cities/robber), `ui/` (HUD, hand, action bar, trade panel, modals), `net/` (WS client, state store), `interaction/` (click targeting, placement validators surfaced from kernel).

<add-when-implemented>

## 8. Rendering (3D table)

- Hex island built from instanced prisms; number-disc/ports/robber as meshes; original painted textures generated by `scripts/generate-*-atlas.mjs` (CC0 pipeline, like mahjong-vtt's atlas generator).
- Seat cameras: each player sits at their side of the island; hidden-information rendering = other players' cards never enter client state (server sends per-seat redacted state — different from mahjong's face-down backs because cards are physical-hand analog).
- WebGL screenshot rule: verify with `npx playwright screenshot`, not the browser harness (black canvas pitfall).

## 9. Deployment & Environments

| Branch | Environment | Auto-deploy | Notes |
|--------|-------------|-------------|-------|
| `develop` | local | no | Vite :4274, WS :4273 |
| `staging` | Railway staging | on push | default deploy target |
| `main` | Railway production | on push | explicit approval |

Never `railway up`. Connection strings → `CLAUDE.local.md`.

## 10. Development Workflow

plan (`docs/plans/`) → build on `develop` (kernel first, tests green) → recap (`docs/recaps/`) → update this file + `FUNCTIONAL-SPECIFICATIONS.md`. Trivial work compresses the cycle. Non-trivial → `delegate_task` with 2-stage review.

## 11. Scripts Reference

<add-when-implemented> — planned: `scripts/generate-hex-atlas.mjs` (original terrain art), `scripts/sim-games.mjs` (Monte-Carlo balance harness using kernel).

## 12. Observability

<add-when-implemented> — v1: structured console logs on server + client; no external services.
