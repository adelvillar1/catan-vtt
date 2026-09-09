# M3 P1 — 3D table first render (spectator view)

Date: 2026-09-08 (night) · Commit `dec1a8d` + JoinPanel case fix (this batch)
Game: seed 20260908, room `AH4hgi`, three `cli.ts --auto` bots (161/243/198 ops,
0 rejections, `WINNER seat 2, finalPoints 10`), spectator-joined from the real
browser UI. Server :4273 (tsx server-main), table dev :4274 (workspace vite@8.2.2).
Capture: playwright-core 1.62.1 driving cached Chromium (chrome-mac-arm64) with
SwiftShader WebGL — canvas 1440×900, webgl2 context live, zero page errors.

- `01-empty-table.png` — pre-join empty state (dim water + "Join a room" caption).
- `02-spectator-island.png` — full island from the wire projection: 19 hexes,
  terrain palette, number tokens, robber marker, port markers + ratio labels,
  seat colors on buildings/roads. STATUS shows spectate / ended / serverSeq 602,
  rngSeed/rngCursor 0/0 (wireScrub held; adapter parse-or-die never tripped).
- `03-orbited.png` — after a mouse drag: camera is live (OrbitControls).

## Bug this capture earned (before the screenshots existed)
JoinPanel auto-uppercased the room code input — invite codes are
mixed-case [A-Za-z0-9]{6} (`AH4hgi`), so the UI made joining literally
impossible half the time (`roomNotFound: no such room` — visible in an
intermediate capture). Fixed: sanitize charset + length only, preserve case.
Lesson for M3: UI evidence must be pixel-verified; typecheck+build+wire-smoke
all passed while the join flow was broken.

## Gates summary (P1 exit)
tsc -p apps/table clean · 87/87 table unit tests (geom frame 47, adapter 25,
placement layout 15) · vite@8 build exit 0 · live spectator smoke (status=
playing seq=602, 19 slots, buildings=10 roads=27) · screenshots above.
AC3: grep-proven zero legality imports in apps/table (comments only).
