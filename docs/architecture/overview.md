# Architecture Overview

## The one diagram

```
┌────────────┐   WS ops    ┌────────────┐  applyAction  ┌─────────────────┐
│ apps/table │ ──────────► │ apps/room  │ ────────────► │ packages/shared │
│ (R3F UI)   │ ◄────────── │ (ws relay, │               │ rules kernel    │
│  :4274     │  redacted   │  seat auth)│               │ (source of      │
└────────────┘   state     │   :4273    │               │  truth)         │
                           └────────────┘               └─────────────────┘
```

## Principles (from mahjong-vtt / dnd-vtt, deliberate)
1. **Kernel is the single source of truth.** `applyAction(state, action)` is the only mutation. Board state is pure data, fully serializable (room persistence is trivial because of this).
2. **Server-authoritative RNG.** Dice and hidden draws happen in the server's kernel instance, seeded per room; clients never roll.
3. **Per-seat redaction.** Clients receive state with hidden information (card hands, dev cards, deck order) stripped to what that seat may see — no "face-down but present" like mahjong does for tiles; cards simply aren't in your payload.
4. **The renderer is replaceable.** A 2D UI or CLI could drive the same kernel — keep zero rendering assumptions in shared.

## V1 scope decisions
- Base game full fidelity, 3–4 players. Expansions = follow-on plans (the kernel's action/state design must make them additive, not retrofitting).
- No accounts; seat-token auth (see plan 2026-09-08-rules-kernel + later multiplayer plan).
- In-memory rooms first; Postgres later only if history/bots need it.

## Module map
| Path | Role |
|------|------|
| `packages/shared/src/state.ts` | GameState type: island graph, supply, per-player hands/pieces, bonus tiles |
| `packages/shared/src/setup.ts` | Fixed + variable setup generators (seeded), legal-placement precompute |
| `packages/shared/src/actions.ts` | ActionSchema (zod) — the op enum |
| `packages/shared/src/turn.ts` | `applyAction` — phase machine |
| `packages/shared/src/validate.ts` | Distance rule, connectivity, costs, supply, trade legality |
| `packages/shared/src/scoring.ts` | VP ledger, longest route/army transfer |
| `packages/shared/src/redact.ts` | Per-seat view projection |
| `apps/room/` | ws relay: join/seat/offer/apply/broadcast |
| `apps/table/` | Vite + R3F; net store mirrors redacted state |
| `scripts/` | `generate-*-atlas.mjs` (original CC0 art), `sim-games.mjs` (balance harness) |

Detail files as they grow: `docs/features/rules-kernel.md`, `docs/features/multiplayer.md`, `docs/architecture/*`.
