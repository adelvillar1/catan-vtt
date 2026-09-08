# Rules Kernel (feature doc)

> Living document for `packages/shared` — the authoritative base-game implementation.

## Rules authority
Hermes skill `catan-board-game` — especially `references/base-rules.md` (mechanics), `references/setup.md` (generators), `references/probability.md` (invariants), `references/glossary.md` (disputed rulings). Official 6th Ed is the law; 5th Ed differences noted there.

## Spec digest (what the kernel MUST enforce)
- Win: 10+ VP on your own turn, declared. Starts at 2 VP (2 settlements).
- Turn: [play ≤1 dev card, not bought this turn] → roll → production | 7-resolve (discard >7 half down; robber MUST move to different hex, desert legal; steal 1 random from occupant, robber chooses victim among multiple) → action phase (any # trades/builds, any order) → pass dice.
- Costs: road WB / settlement WBGW / city 3OW... exact: road 1 wood+1 brick; settlement 1 each W/B/wheat/wool; city 2 wheat+3 ore; dev 1 ore+1 wool+1 wheat.
- Placement: distance rule ≥2 edges from ALL buildings; connectivity via own network; can't build through opponent building; caps 15/5/4.
- Trade: domestic only with active player; no gifts/same-swap/dev cards; bank 4:1; ports 3:1/2:1 require building on port node.
- Dev deck: 14 Knight, 5 VP, 2 Monopoly, 2 Road Building, 2 Invention. Dev cards: hidden, exempt from 7-discard and robber, never traded, never return to supply.
- Bonus tiles: Longest Route ≥5 continuous (spoke-split returns tile to supply; strictly-longer transfers; tie keeps holder); Largest Army ≥3 knights played, same.
- Supply: 19/resource; exhaustion: multi-affected → nobody, single-affected → remainder.

## Coverage matrix
(Per dnd-vtt parity discipline: every op × validator × test. Kernel lands → this table is AC10.)

| Op / action | Validator | Test | Status |
|---|---|---|---|
| _(wave 1 — foundation: implementing now)_ | | | |
| Rng determinism (int/pick/shuffle/snapshot/restore) | pure xorshift replay | rng.test.ts | 🔄 wave 1 |
| Island topology (19 hexes, edge/vertex dedup, coastal flags) | buildIsland invariants | board.test.ts | 🔄 wave 1 |
| Distance-rule free-vertex predicate | distanceRuleFree | board.test.ts | 🔄 wave 1 |
| State schema validity (zod) | GameStateSchema + sub-schemas | state.test.ts | 🔄 wave 1 |
| variableSetup(seed) — discs/ports/robber/bank/deck | setup invariants + swap-repair | setup.test.ts (10k-seed property) | 🔄 wave 1 |
| _(waves 2+ — turn machine, trades, dev cards, bonus tiles, win, redaction)_ | | | ⏸ planned |
| roll + production + robber-7 resolve | turn.ts validators | turn.test.ts | ⏸ wave 2 |
| buildRoad/buildSettlement/buildCity | connectivity+caps+distance | actions.test.ts | ⏸ wave 2 |
| tradeDomestic / tradeBank / tradePort | trade legality | actions.test.ts | ⏸ wave 3 |
| buyDevCard / playDevCard (5 kinds) | deck+turn rules | actions.test.ts | ⏸ wave 3 |
| bonus tiles (Longest Route ≥5, Largest Army ≥3, breakage) | recomputation on build | bonus.test.ts | ⏸ wave 4 |
| claimVictory (≥10, own turn) | VP ledger | win.test.ts | ⏸ wave 4 |
| redactForSeat | projection purity | redact.test.ts | ⏸ wave 5 |

Legend: ✅ verified · 🔄 implementing · ⏸ planned · ❌ rejected-by-review

