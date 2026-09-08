
# catan-vtt

> CATAN virtual tabletop — full-fidelity base-game rules kernel, cinematic 3D island table, WS multiplayer for 3–4 friends.
> Sibling of `~/Projects/mahjong-vtt` and `~/Projects/dnd-vtt`. Same methodology, same architecture pattern.
> Repo: https://github.com/adelvillar1/catan-vtt (not created yet)

**Environment URLs and env var names live in `CLAUDE.local.md` (gitignored).** Secrets belong in `.env` / the host dashboard, never in tracked files.

---

## Hard rules (non-negotiable)

- **Default deploy/operation target is `staging`.** Production (`main`) requires explicit approval *in the current turn*.
- **Work on `develop`.** Flow: `develop` (local) → `staging` → `main`.
- Never work directly on a remote database. No remote DB exists yet — do not invent URLs.
- Destructive ops (`DELETE`, `TRUNCATE`, `DROP`, force-push) need approval in the current turn.
- **Never `railway up`.** When deployment exists, deploy = git push only (lesson from mahjong-vtt/dnd-vtt). Confirm via `railway deployment list` `meta.branch` + SHA.
- **Rules live in `packages/shared`, not in UI copy.** Setup validation, production, robber, distance rule, trade legality, dev cards, VP counting, longest route/army are unit-tested kernel code. The table is a client of that package. `applyAction` is the ONLY mutation path (mahjong-vtt pattern).
- **Official Catan rules text and art are copyrighted (Catan GmbH).** The kernel implements rules as our own code + prose (mechanics aren't copyrightable; expression is). Do NOT copy rulebook text, images, card art, or board art into the repo. Assets: CC0/MIT originals or procedurally generated only. No official logos.
- **Do not invent house rules.** Ambiguous rules question → check the `catan-board-game` skill (`references/base-rules.md` + `references/glossary.md` FAQ); if still ambiguous, stop and ask.
- **Non-trivial work:** warmup → plan → `delegate_task` (2-stage review) → recap → wrapup. Trivial (≤15 min, ≤2 files) may be direct + recap.
- **Done means seen working.** Evidence under `docs/e2e-review/<slug>/` (Playwright shots — browser harness can't screenshot WebGL).

---

## Branch → environment topology

```
develop ──► staging ──► main
(local)     (Railway)   (Railway production)
```

| Branch | Environment | Auto-deploy | Notes |
|--------|-------------|-------------|-------|
| `develop` | local | no | `npm run dev` Vite :4274 + WS room :4273 |
| `staging` | Railway `staging` | on push to `staging` | default deploy (once created) |
| `main` | Railway `production` | on push to `main` | explicit approval |

No Railway services exist yet. When they do, put names/URLs in `CLAUDE.local.md`.

---

## Where to find things

**Architecture**
- Stack & layout → `docs/architecture/overview.md`
- Rules kernel design → `docs/features/rules-kernel.md`
- Multiplayer protocol → `docs/features/multiplayer.md`

**Domain knowledge (Hermes skill — `skill_view`)**
- `catan-board-game` — rules, setup, probability, strategy, tournaments, FAQ. Load before writing ANY rules code or ruling on a dispute.

**Reference**
- Business context → `docs/BUSINESS-CONTEXT.md`
- Troubleshooting → `docs/TROUBLESHOOTING.md`
- State snapshot → `docs/STATE-SNAPSHOT.md`
- Plans → `docs/plans/` · Recaps → `docs/recaps/` · E2E evidence → `docs/e2e-review/`

**Sibling projects (patterns to follow, not code to copy blindly)**
- `~/Projects/mahjong-vtt` — kernel/render split (apps/table), WS rooms, host/guest invites, Railway topology
- `~/Projects/dnd-vtt` — gateway ops discipline, shared zod schemas

---

## Contracts

| Contract | Location | Purpose |
|----------|----------|---------|
| Plans | `docs/plans/YYYY-MM-DD-<slug>.md` | Pre-work: ACs, files, out of scope |
| Recaps | `docs/recaps/SESSION-RECAP-YYYY-MM-DD.md` | Post-work journal |
| Technical | `TECHNICAL-DOCUMENTATION.md` | Architecture, schema, protocol, deploy |
| Functional | `FUNCTIONAL-SPECIFICATIONS.md` | Player flows, rules behavior, edge cases |

---

## Common commands

```bash
npm install                    # root workspaces
npm test                       # kernel tests (packages/shared, vitest)
npm run typecheck              # all workspaces
# table (Vite + R3F):  cd apps/table && npm run dev     → http://localhost:4274
# room server (WS):    cd apps/room  && npm run start   → ws://localhost:4273
```

---

## Today's state

- **2026-09-08: project initialized.** Structure + methodology scaffolded; no code yet. First plan: `docs/plans/2026-09-08-rules-kernel.md` (draft, awaiting user approval).
- Ports reserved: table **:4274**, WS room **:4273** (mahjong owns 4174/1235/4173).
- Assumed defaults (clarify form timed out — user may revise): 3D R3F renderer, Railway-deployable, base-game-only v1, name `catan-vtt`.
- Profile: default Hermes, cwd `~/Projects/catan`.

## Housekeeping protocol — keeps the docs tree from rotting

**You are responsible for keeping the docs tree current.** After every session that changes something material:

1. Identify which doc the change touched. Update it inline — recaps are not the source of truth.
2. Stat tables go in `docs/STATE-SNAPSHOT.md`, not topical docs.
3. **This file only** when a hard rule, topology, pointer, or Today's state changes. No narrative changelogs.
4. `CLAUDE.local.md` edits must be mentioned in the recap (names only, never secrets).
5. Contract docs stay in sync with code. Don't mark a feature done while they are stale.
6. Drift check: `wc -l` of this file ≤ ~300; `git status` must not show `CLAUDE.local.md`; every `docs/*.md` pointer exists.

## Session protocol

**Start:** `/warmup` — this file, latest recap, active plans.
**End:** `/wrapup` — recap exists, Today's state, uncommitted disposition, plan status, drift.

Cycle: `warmup → plan → build → recap → wrapup`. Non-trivial build uses `delegate_task` + 2-stage review.
