# M3 P2(a) — playable browser table (DOM controls + auto-rejoin)

Date: 2026-09-09 · Commits `100e233` (P2a) + `c04f29d`-range (quality batch — see git log) ·
Games: `qlzU90` (first proof) and `2Xdt3P` (post-review-fix re-smoke), seed 20260908, 3 seats —
bots on seats 0+1 via `cli.ts --auto --timeout 900000`, **seat 2 = the browser**.

## What this proves

The table is PLAYABLE from a real browser: the human's clicks are the only force that can move
the game, and a refresh rejoins into the same seat.

| Evidence | File |
|---|---|
| Joined as seat 2, "Your turn" banner, full HUD + trade panel | `01-joined.png` |
| Click on a shipped `Place settlement (setup)` button — **serverSeq 4 → 5** | `02-after-click.png` |
| **Reload → auto-rejoin**: "rejoined" banner, seat 2 intact, seq 5 | `03-after-reload-rejoin.png` |
| Post-fix re-smoke: same proof after the quality batch (below) | `rf-01-joined.png`, `rf-02-after-click.png`, `rf-03-rejoined.png` |

Why the click proof is airtight: both bots were parked on seats 0+1 waiting for seat 2
(`stalled: no frame` / idle), so **no other client could have sent the op** that bumped seq.
Rejection path verified too — nothing the UI fabricates gets past `room.applyOp`
(OpSchema → seat ownership → `applyAction`), so a dishonest button degrades to a `rejected`
event, never a corrupted state.

## Quality-review batch (disposition: all 5 Important + minors fixed, parent-implemented)

Review verdict: CHANGES-REQUESTED (0 Critical / 5 Important / 9 Minor) — full report in the
delegation cache. Re-probed each against current code before fixing:

1. **TradePanel bank/port selects listed unrestricted resources** → selects now list ONLY the
   pairs the server shipped (`shippedTrades`/`tradeOffersFor`/`tradeDemandsFor` in `hudLogic.ts`);
   the UI sends the shipped op object verbatim. (`turn.ts` already enumerates every legal pair.)
2. **`caps.offer` gated on `hasMove(moves,"tradeOffer")` — dead affordance** (kernel deliberately
   never enumerates composed offers; `applyAction` is sole authority) → now a state affordance:
   own turn + play phase + rolled + no pending trade + no seven-window. Overlap guard added to
   `tradeFormToOp` (give ∩ want → null).
3. **Auto-rejoin latch broke under StrictMode** (`retried` ref survives the simulated unmount;
   pass-2 early-return left dev with a dead socket) → latch removed; reconnect keyed on
   `room.status === "closed"`, token-guarded. `rf-03-rejoined.png` is the fix's proof: rejoin
   banner + seat 2 + seq 5 in the dev build.
4. **DevCardPanel sent the FIRST `playMonopoly`/`playYearOfPlenty` op** regardless of intent →
   per-resource monopoly buttons + two-select YOP picker, options from `pickAll` of shipped ops;
   submit sends the chosen shipped op verbatim.
5. **Select values could disagree with caps at render** → selection derived per render with
   fallback to the first available option.

Minors: hud.test structural assertions tightened (chip-sum == total); trade.test vacuous
`ports.every` removed + probe comment corrected (the kernel doesn't enumerate offers at all);
lastRoom seat clamped to 0..3 (a `-1`/`99` claim degrades to spectate instead of a server
`badSeat` round-trip); HUD turn counter labelled as the server-derived value it is; CSS
`focus-visible` ring added; `.moves` nested scroll removed; inline SVG favicon (the lone 404).

Post-fix verification: root **356/356**, typecheck 3 projects clean, workspace vite build exit 0,
browser re-smoke green (`rf-*` shots), zero non-localhost network requests (the 28 "remote"
requests in one log line were `blob:` text-texture rasters — same-origin, misclassified by the
probe's hostname filter).

## Zero-remote-requests note

All text on the island uses the bundled OFL Rubik font (`public/fonts/Rubik-Medium.ttf`) via
`TABLE_FONT`; drei's default CDN fetch path is not reachable from any `<Text>` call site.
