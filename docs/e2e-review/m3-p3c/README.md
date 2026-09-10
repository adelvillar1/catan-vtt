# M3 P3(c) — AC2: a full game to 10 VP, entirely through the browser

**Date:** 2026-09-09 · **Plan:** `docs/plans/2026-09-09-m3-p3c-fullgame-demo.md`
**Stack:** `bash scripts/p3c-stack.sh` (room :4273 + Vite :4274, **no bots**)
**Driver:** `RC=<code> node scripts/m3-fullgame.mjs` (rewritten into this dir)

## AC2

> *"Full 3p game playable end-to-end through the table UI to a 10-VP winner
> (Playwright-driven or 3 manual tabs with captured evidence)."*

Three independent browser contexts (one per seat — a shared context lets tab A's
`lastRoom` auto-rejoin steal tab B's seat) join seats 0/1/2 and play to a real
winner. Every op is a **click**: a DOM button in `#moves-list` (the server's
`legalMoves`, labelled by `ui/opLabel.ts`) or an on-canvas placement ghost
(`window.__catanTargets()`, opt-in via `localStorage["catan:e2eTargets"]`).
No op object is ever constructed by the driver.

## Evidence map

| File | Claim |
| --- | --- |
| `01-setup-ghosts.png` | setup: on-canvas placement ghosts are live and clickable |
| `02-midgame.png` | play phase: island built, rail showing legal moves |
| `03-discard-modal.png` | **the P2(b1) deferred pixel** — the real seven discard modal |
| `04-robber.png` | robber hex ghost up after a 7 |
| `05-victory.png` | victory banner with a REAL winner (no injection) |
| `06-rematch-fresh.png` | after `#victory-rematch`: banner gone, phase `setup`, seq jumped |
| `fullgame.log` | seq timeline, per-seat op counts, REJECTED count, stall dumps |

## Honesty fence

* `catan:e2eTargets` = `"1"` — **allowed** (reports ghost screen coords that are
  already on screen).
* The victory-override localStorage flag read by `ui/victoryView.ts` is **not
  set, read, or even named** in `scripts/m3-fullgame.mjs` (grep-provable).
* PASS requires: a victory banner with a real winner, rematch clicked → all
  three tabs on `phase=setup` with the banner gone and a higher `serverSeq`,
  **0 rejected events**, 0 page errors, and the discard modal actually seen.

## Greedy policy (documented in-script)

setup → first canvas ghost · play → city > settlement > road > dev card > roll >
knight > road building > year of plenty > monopoly > robber hex ghost > steal >
end turn. **No trading** (P2(a)-proven; skipping keeps the win unassisted).
`roll` is clicked only when the server ships it — the server, not the driver,
decides when a roll is legal.
