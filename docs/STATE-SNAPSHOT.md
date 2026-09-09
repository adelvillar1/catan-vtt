# State Snapshot

> Replace (don't append) from live data at each refresh. Stat tables live HERE, not in topical docs.

- **2026-09-08 (M2 phases 1-2):** room core `apps/room` (seat claim/tokens, ordered op authority, wireScrubbed memoized projections, spectator squash, event ring, rematch) + `packages/shared/protocol.ts` wire contract. `npm test` -> **224/224** (14 files: kernel 170 + protocol 20 + room 34); full text-mode game through the Room API wins at 10 VP. WS transport (phase 3) NOT yet built.
- **2026-09-08 (M1 close):** kernel `packages/shared` **0.5.0** — waves 1–5 all reviewed + committed. `npm test` → **170/170** (12 files — `it()` counts: rng 12, board 18, state 14, setup 11, turn 28, road 15, actions 7, trade 13, devcards 17, golden 10, redact 11, vp 8; vitest reports 170 incl. parameterized cases), `tsc --noEmit` clean, `npm run typecheck` clean. Commits `3465083`→`7e8d457` on `develop`, pushed (public GitHub `adelvillar1/catan-vtt`). Plan `2026-09-08-rules-kernel` → **done**; AC1–AC10 ✅ (matrix: `docs/features/rules-kernel.md`, 20/20 ops named).
- **Kernel facts:** 20 ops in `OpSchema` (single source of truth for the M2 relay whitelist); 32-code `ActionError` union; RNG contract `Rng.restore({rngSeed,rngCursor})`, roll=2/steal=1 draws, all other ops zero; setup generators property-tested over 10k seeds; golden bots win real 10-VP games (6/6 seeds); `redactForSeat` leakage-proof + 8-op optimistic-UI commutativity.
- **npm quirk on this machine:** global config sets `omit=dev`; project `.npmrc` (`include=dev`) cancels it. Root scripts call workspace binaries directly — nested `npm run` inside an npm script hangs here (docs/TROUBLESHOOTING.md).
- **Delegation pin:** `hy4-preview` (workbuddy proxy :8787) — user's PRIMARY; kimi k3 (:10100) hit a 5h quota window; GLM-5.2 (:8787) verified spare. 30-min ceiling, split/steer/surgical-finish as needed.
- **Copyright guard:** rulebook text/art must never enter the repo (hard rule in CLAUDE.md); the `catan-board-game` skill is the rules authority (patched with this session's corrected rulings).
- Next refresh: when M2 phase 3 (WS transport :4273) lands — record service + live two-terminal check.
