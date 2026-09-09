# M3 P3(a) — victory screen on the table (projection-derived, zero protocol change)

**Date:** 2026-09-09 · **Milestone:** M3 · **Phase:** P3(a)
**Spec anchor:** M3 plan AC2 (full game through the table UI). Today, when a player
claims victory the table shows NOTHING: ghosts vanish (legalMoves empty), the HUD
keeps saying "play" — a winner is indistinguishable from a stalled table.

## Design decision (parent-locked, with the rejected alternative on record)

**REJECTED first draft:** a dedicated `gameOver` wire frame in protocol.ts + server
send sites. Rejected after probing the real code: `state.winner`/`state.finalPoints`
are PUBLIC (redact.ts:31 keeps them verbatim — that's exactly how cli.ts printed
"WINNER seat 2, finalPoints 10" in the M2 demo: `st?.winner ?? null`, cli.ts:589)
and ride EVERY projection message — unlike the one-shot `gameEnded` event (server.ts
`#endedSent` latch + tail-truncated ticker), the projection field can never be missed
by a late joiner or a rolled ticker. A new frame would duplicate a persistent signal
and add cross-package risk for zero correctness. **Decision: the overlay is pure
client-side derivation from the projection.** Zero shared/, zero room/, zero
server.ts changes. (If a P3 reviewer disagrees, the argument must beat this one.)

## Scope (apps/table only)

1. `ui/victoryView.ts` (pure): `victoryView(state, players, seat) ->
   { name, colorKey, points, isYou } | null` — null unless `state.winner !== null`.
   Name/color from the winner's own roster entry (PublicPlayer — no hidden info);
   `isYou` drives "You win!" vs "<name> wins". Defensive: winner seat not in
   roster (can't happen server-side; render fallback "a player" not a crash).
2. `ui/VictoryOverlay.tsx`: full-panel banner over the HUD layer (top z-index):
   "🏆 Orange wins — 10 Victory Points" (+ "You won!" variant), color dot from
   seatColor palette, sub-line "The host can start a rematch soon" (honest: rematch
   is NOT on the wire in v1 — server.ts:21; P3(b) ships it; text updates then).
   Non-blocking by design: the event ticker keeps streaming under it, HUD buttons
   are inert anyway (empty legalMoves). `aria-live="polite"` + focus the heading
   on appear (screen readers / keyboard users learn the outcome).
3. `App.tsx`: mount when `victoryView(...)` non-null; `table.css`: banner styles
   (consistent with HUD panel language: same surface/blur/radius tokens).
4. Tests (`victoryView.test.ts`, node env, kernel fixtures like testFixtures):
   - null pre-win; exact fields post-win for winner seat 0 AND a later seat
     (no seat-0 special case);
   - **redaction honesty: the view reads NOTHING beyond winner/finalPlayers
     roster fields — assert with a hand-built fixture whose OTHER players'
     hands are poisoned sentinels; output must not contain them**;
   - isYou for winner===mySeat; null for spectator? NO — spectator gets
     isYou=false and shows the name (winner info is public);
   - fallback when roster lacks the winner seat (defensive path exercised).
5. EventTicker: `gameEnded` event currently may render as raw details — give it
   a friendly one-line label in MovesList/opLabel territory (grep what it prints
   today; keep it one line, this is the same screen).

## Files (write fence)

- `apps/table/src/ui/victoryView.ts` + `victoryView.test.ts` (new)
- `apps/table/src/ui/VictoryOverlay.tsx` (new)
- `apps/table/src/App.tsx` (mount), `src/ui/table.css` (styles)
- `apps/table/src/ui/opLabel.ts` or wherever gameEnded tickers label (item 5)
- NOTHING in packages/shared, apps/room (parent will reject out-of-fence edits).

## Verification (child)

- `node_modules/.bin/tsc --noEmit -p apps/table/tsconfig.json`
- ONE targeted vitest: `cd apps/table && ~/Projects/catan/node_modules/.bin/vitest run src/ui/`
- NO full root suite (parent's job), NO new deps, NO commits/git-write.
- Browser: parent runs the P2(a)-style Playwright — seed a won game cheaply:
  kernel `variableSetup` fixture cannot reach 10 VP in a smoke budget; instead
  the parent mounts the overlay via a **dev-only localStorage override**
  `catan:e2eWin=<seat>` that feeds victoryView a synthetic winner ONLY when the
  flag is present (same opt-in pattern as catan:e2eTargets, documented). Child:
  implement + comment it; parent: screenshot proof it renders.

## Acceptance criteria

- AC1: overlay appears iff projection carries winner; text = color-name + "10 VP"
  (points from finalPoints, NOT hardcoded 10).
- AC2: redaction-honest test green (poisoned-sentinel fixture).
- AC3: zero files changed outside fence; typecheck + apps/table tests green.
- AC4: `catan:e2eWin` hook present, guarded by the explicit opt-in, commented
  for what it is (e2e affordance, same trust class as catan:e2eTargets).

## Out of scope (P3(b)/P3(c)/P4)

rematch wire + button (needs protocol + server + host authority decision — its own
plan), full-game Playwright demo setup→10VP incl. discard-modal pixels, cinematic
pass, spectator camera niceties, P4 evidence/docs close-out.

## Delegation shape

1 build child (hy4, leaf). Quality reviewer after commit (read-only, targeted-rerun
allowance). Spec gate parent-conducted (fence grep + AC probes).
