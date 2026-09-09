# M3 P2(a) — playable browser table (DOM controls + auto-rejoin)

Date: 2026-09-09 · Commit `100e233` · Game: room `qlzU90`, seed 20260908, 3 seats —
bots on seats 0+1 via `cli.ts --auto`, **seat 2 left for the browser** (the game
parks on "Seat 2's turn", so no seq can advance without a human click).

## What the stills prove
- `01-joined.png` — JoinPanel with the **mixed-case** code `qlzU90` entered verbatim;
  STATUS `playing`, seat 2 · Orange, phase setup, `serverSeq 4`; TURN panel
  "Your turn"; RESOURCES chips WOD/BRK/WOL/WHT/ORE (all 0, pre-roll); TRADE panel
  present; dev deck 25. 19-hex island rendered behind.
- `02-after-click.png` — after the browser **clicked** the shipped
  `Place settlement (setup) v:-0.866025,-0.5` button: `serverSeq 5`. The smoke
  log line: `click "Place settlement (setup)…": seq 4 -> 5` with **no**
  `rejected` event → the op was APPLIED by the server. This is the P2(a) AC:
  a click on a table-rendered legalMoves button plays the game.
- `03-after-reload-rejoin.png` — page RELOADED (fresh document, same storage):
  the auto-rejoin effect (lastRoom + seatToken) landed back in seat 2 with
  `seq 5` and the rail shows "rejoined". Refresh costs nothing.

Harness: Playwright-core 1.62 (mahjong-vtt's, no install) + cached Chromium
(SwiftShader). Captured remote requests: **NONE**; page errors: **none**.

## Gate
354/354 tests (21 files) · typecheck 3 projects clean · vite@8 build exit 0 ·
AC3 grep: zero runtime kernel imports in `src/` (fixture builder is test-only).

## Known seams for P2(b)/P3
- Setup placement is currently button-driven (exact vertex ids in the label);
  click-the-island targets land in P2(b).
- Seven-window discard + robber are MovesList-button reachable, not modal/drag yet.
