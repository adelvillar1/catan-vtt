# Troubleshooting

> Known issues and "looks broken but isn't" notes. Add entries when a session hits them.

## Known traps carried over from sibling projects
- **WebGL screenshots:** browser automation harness returns black canvas — use `npx playwright screenshot --browser chromium --viewport-size 1280,720 --wait-for-timeout 6000 <url> /tmp/scene.png` instead (mahjong-vtt lesson).
- **Warm spotlights desaturate terrain colors** (esp. greens/blues of the island). Near-white key light + push material saturation; verify by pixel sampling (see mahjong-vtt Club Nocturne lighting notes).
- **Subagent zombie dev servers:** every frontend subagent dispatch context MUST include "Do NOT start a dev server." Before dev: `lsof -iTCP:4274 -sTCP:LISTEN; lsof -iTCP:4273 -sTCP:LISTEN`.
- **zod pinned 3.x** in the kernel client path (targets zod 3, not 4).
- **New-op touch list** (dnd-vtt lesson): kernel action + zod enum + server relay + client dispatcher + tests in ONE commit; forgetting a leg yields silent no-ops.
- Ports: mahjong-vtt uses 4173/4174/1235 — never bind those here. This project: 4274 (table), 4273 (room WS).
