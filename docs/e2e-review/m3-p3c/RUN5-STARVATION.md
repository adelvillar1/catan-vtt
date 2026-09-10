# AC2 status: the app is proven; the 10-VP win is a POLICY problem, not a bug

Five full-game browser runs. **Every one: 0 rejections, 0 page errors, all
three tabs in lockstep on serverSeq.** The wire + kernel + UI stack survives
unlimited unattended play. What has NOT happened yet is a 10-VP winner.

## Run history

| # | Budget | seq | Ops | Builds | Trade | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 15m | 7,360 | 7,016 | 13 roads only after seq ~500; 0 settlements/cities/devs | none (plan policy) | honest FAIL |
| 6 | 25m | 1,103 | 1,103 | 36 | 70 (ranked ABOVE roll) | honest FAIL — **regression** |
| 7 | 25m | 6,080 | — | 0 | 228 (151 wood→brick) | honest FAIL |
| 8 | — | 1,411 | — | 0 | 0 | FAIL — driver bug |
| 9 | 15m | 1,419 | 1,124 | 0 | 0 (gate never fires) | FAIL |

## What each run taught (all driver-side, none app-side)

1. **Run #5 — the plan's "no trading" policy starves.** The bank is finite
   (19 per resource = 95 cards, setup.ts:458) and builds gate on
   `hasCards(bank, COST_*)` (turn.ts:1524/1540). Once it drains (~60 rolls)
   nothing can be built. Discards DO return to supply (turn.ts:591), so this
   is not a leak — it is a closed economy with no card movement.
2. **Run #6 — ladder order is load-bearing.** With trades ranked above
   `roll`, a hand holding 4+ cards always has a legal 4:1, so the driver
   traded every turn and never rolled: 457 rolls in 24.4 min vs run #5's
   3,234 in 15. Fixed by mirroring the golden-bot priority verbatim
   (server.test.ts:1185-1195): roll before every build and trade.
3. **Run #7 — greedy 4:1 ping-pong.** 228 trades, 151 of them wood→brick,
   zero builds. Each 4:1 burns THREE cards; picking the first shipped trade
   just oscillates. Needs-driven chooser added instead.
4. **Run #8 — two of my own bugs.** (a) The chooser gated on
   `has(targetLabel)`, i.e. only traded toward a build already affordable —
   a catch-22, so it never fired. (b) Its "nothing to trade" branch ended the
   turn, producing 199 rolls / 199 endTurns and nothing else. Both fixed.
5. **Run #9 — the mechanism, measured.** 375 rolls, 375 endTurns, 168 robber
   moves, **zero discards and zero trades**: hands never reach 4 of any
   resource. With ~1.66 cards/roll and a 7 rolled ~1 in 6 (each forcing a
   discard above 7 cards), a hand cannot accumulate the 4-of-a-kind a 4:1
   needs — so the needs-driven gate cannot fire.

## Conclusion

Catan's economy only reaches 10 VP through **domestic (player-to-player)
trade**, which is also the only lossless card movement. The kernel supports it
(`tradeOffer` / `tradeAccept`, turn.ts:1025/1065) and the UI has a panel
(`#trade-panel`, `trade-give` / `trade-want` / `trade-with` / `trade-submit`).
Maritime 4:1 is a 3-card tax this table cannot afford.

**AC2 remains OPEN — next step: drive the domestic offer/accept round-trip
across the three tabs** (seat A offers its surplus for its missing card; seat B
accepts via its own `#moves-list` "Accept trade" button). That is the last
unexercised UI surface and the only path to a real 10-VP banner.

No evidence was faked: `05-victory.png` and `06-rematch-fresh.png` do not
exist because no run has won. They will be added when one does.
