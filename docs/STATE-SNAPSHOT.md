# State Snapshot

> Replace (don't append) from live data at each refresh. Stat tables live HERE, not in topical docs.

- **2026-09-08 (M1 close):** kernel `packages/shared` **0.5.0** — waves 1–5 all reviewed + committed. `npm test` → **170/170** (12 files — `it()` counts: rng 12, board 18, state 14, setup 11, turn 28, road 15, actions 7, trade 13, devcards 17, golden 10, redact 11, vp 8; vitest reports 170 incl. parameterized cases), `tsc --noEmit` clean, `npm run typecheck` clean. Commits `3465083`→`7e8d457` on `develop`, pushed (public GitHub `adelvillar1/catan-vtt`). Plan `2026-09-08-rules-kernel` → **done**; AC1–AC10 ✅ (matrix: `docs/features/rules-kernel.md`, 20/20 ops named).
- **Kernel facts:** 20 ops in `OpSchema` (single source of truth for the M2 relay whitelist); 32-code `ActionError` union; RNG contract `Rng.restore({rngSeed,rngCursor})`, roll=2/steal=1 draws, all other ops zero; setup generators property-tested over 10k seeds; golden bots win real 10-VP games (6/6 seeds); `redactForSeat` leakage-proof + 8-op optimistic-UI commutativity.
- **npm quirk on this machine:** global config sets `omit=dev`; project `.npmrc` (`include=dev`) cancels it. Root scripts call workspace binaries directly — nested `npm run` inside an npm script hangs here (docs/TROUBLESHOOTING.md).
- **Delegation pin:** `kimi-code/k3-256k` (ocx proxy :10100) — user's fallback after hy4 stream died; 30-min ceiling per agent, split/steer/surgical-finish as needed.
- **Copyright guard:** rulebook text/art must never enter the repo (hard rule in CLAUDE.md); the `catan-board-game` skill is the rules authority (patched with this session's corrected rulings).
- Next refresh: when M2 (room server) lands a commit — record service, protocol messages, port 4273 live-check.
