# AC2 status after run #5: NOT YET — the app proved, the win unproven

**Run #5 (room `B5lMnR`, seed 20260908, 15.0-min budget):** honest FAIL.

| Measure | Value |
| --- | --- |
| Clicks (ops applied) | 7,016 (s0=2336 s1=2339 s2=2341) |
| Final serverSeq | 7,360 — all three tabs in lockstep |
| REJECTED events | **0** |
| Page/console errors | **0** |
| Discard modal | opened 148x, submitted 148x (the multiset-picker fix in anger) |
| Robber | hex-ghost moves clicked (04-robber.png) |
| Winner | **none reached 10 VP** |

## Why nobody won — the no-trade ladder starves

Op census: 3,234 rolls, 13 roads, **0 settlements, 0 cities, 0 dev-card
buys, 0 trades.** After ~seq 500 no build-class move ever shipped again.

The kernel is correct (this is real Catan's bank rule): `legalMoves` gates
every build on `hasCards(state.bank, COST_*)` (turn.ts:1524/1540) and the
bank holds 19 of each; a normal roll pays out ~1.66 cards, so the bank is
functionally dry after ~55-60 rolls. From there, the only cards in the game
are in hands — and a policy that **never trades** can never move them. The
M2 golden games prove the shape: greedy bots that DO trade win in ~600 ops.

The plan's "no trading (P2(a)-proven)" line was chosen to keep the win
unassisted — but unassisted by *the app's rules* was never the point;
unassisted by *card movement* makes 10 VP arithmetically unreachable for
this table. AC2 needs a trade-aware policy. That is driver work, not app
work — and note what this run already is: the longest, cleanest
end-to-end proof of the wire+kernel+UI stack the project has (0/0 in a
7,016-op game), plus the AC2 bug the deferred pixels existed to catch.

## Evidence map for this run
- `01-setup-ghosts.png` … `04-robber.png` — as named in README.md
- `fullgame.log` — the seq timeline (flood-deduped; run #1's 5.2MB spam is
  gone). `05-victory.png` / `06-rematch-fresh.png` do NOT exist: no win, no
  rematch — and we do not fake them (P2(b1) misleading-evidence rule).
