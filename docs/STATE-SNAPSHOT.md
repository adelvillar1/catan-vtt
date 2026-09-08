# State Snapshot

> Replace (don't append) from live data at each refresh. Stat tables live HERE, not in topical docs.

- **2026-09-08 (init):** scaffold verified live: `npm test` → 1/1 pass, `tsc --noEmit` → clean, `bash scripts/check-scaffold.sh` → PASS. `CLAUDE.local.md` gitignored+untracked (verified via git).
- **npm quirk on this machine:** global config sets `omit=dev`; project `.npmrc` (`include=dev`) cancels it. Root scripts call workspace binaries directly — nested `npm run` inside an npm script hangs here (documented in docs/TROUBLESHOOTING.md).
- **Copyright guard:** rulebook text/art must never enter the repo (hard rule in CLAUDE.md); the `catan-board-game` skill is the rules authority.
- Next refresh: after the `2026-09-08-rules-kernel` plan completes (record test counts + the action-coverage matrix in `docs/features/rules-kernel.md`).
