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
| _(to be filled as phase 1-10 of the plan land)_ | | | |
