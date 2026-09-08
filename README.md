# catan-vtt

A CATAN virtual tabletop you can actually play with friends: a full-fidelity rules
kernel (base game: robber, ports, development cards, Longest Route & Largest Army),
a cinematic 3D island table (Vite + React + react-three-fiber), and WebSocket rooms
for 3–4 players — invite link and seat, like [mahjong-vtt](https://github.com/adelvillar1/mahjong-vtt).

**Unofficial fan project.** CATAN is a trademark of Catan GmbH; this repo ships no
official art, text, or logos — all visuals are original/CC0 and the rules live as
our own code.

## Status

🚧 Initializing (2026-09-08). Architecture and methodology are scaffolded; the
rules kernel is the first build target. See `docs/plans/`.

## Layout

```
packages/shared/   the referee kernel — pure rules, applyAction, zero UI (source of truth)
apps/table/        3D table client (Vite + React 19 + R3F)
apps/room/         WebSocket room server (auth-lite seats, relay, game persistence)
docs/              architecture, features, plans (pre-work contracts), recaps, e2e evidence
scripts/           asset generators (original hex/board art), dev tools
```

## Dev quickstart (once code lands)

```bash
npm install
npm test                        # kernel rules tests
npm run dev -w apps/table       # table client → http://localhost:4274
npm run start -w apps/room      # WS room   → ws://localhost:4273
```

Read `CLAUDE.md` for the project's hard rules and workflow.
