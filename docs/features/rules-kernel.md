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
| _(wave 1 — foundation: COMPLETE — 2-stage review PASS + fix round, 61 tests)_ | | | |
| Rng determinism (int/pick/shuffle/snapshot/restore) | pure xorshift replay, RangeError guard | rng.test.ts (12) | ✅ |
| Island topology (19 hexes, 54 vertices, 72 edges, vertex.adjacent) | exact-form √3 offsets | board.test.ts (18) | ✅ |
| Distance-rule free-vertex predicate | O(deg) via vertex.adjacent | board.test.ts | ✅ |
| State schema validity (zod) | GameStateSchema + sub-schemas, .strict() all levels | state.test.ts (15) | ✅ |
| rngSeed/rngCursor restore contract (single continuous stream — dice MUST Rng.restore({seed:rngSeed,cursor:rngCursor}); reseed-per-attempt forbidden) | JSDoc-locked invariant | setup.test.ts (seeds 0..499; min cursor 85 verified over 10k) | ✅ |
| variableSetup(seed) — spiral discs/ports/robber/bank/deck | setup invariants + port swap-repair | setup.test.ts (10k-seed property) | ✅ |
| randomDiscSetup(seed) — red 6/8 separation | swap-repair, never adjacent reds | setup.test.ts (10k-seed property) | ✅ |
| _(wave 2 — turn machine: COMPLETE — 2 reviews + fix batch + parent surgical fix; 110 tests)_ | | | |
| Op schema (10 ops, ActionError code union, noOwnSettlementThere) | z.discriminatedUnion | actions.test.ts | ✅ |
| roll + production + bank-exhaustion rules | restore({seed,cursor}) 2 draws | turn.test.ts | ✅ |
| 7-resolve: discardQueue → moveRobber → stealCard | awaitingSeven window gates | turn.test.ts matrix | ✅ |
| setup snake (round 1 + reversed round 2, 2nd settlement pays; anchor-only setup road; seat 0 starts) | placeSetupPiece | turn.test.ts | ✅ |
| builds — road runs UP TO enemy settlement (legal), not THROUGH it (roadBlocked) | start-point rule, official | turn.test.ts gate test | ✅ |
| playKnight + Largest Army award/transfer | strictly-greater, ties keep | turn.test.ts | ✅ |
| Longest Route (≥5; ONLY opponent buildings break; own pass-through; 6-ring counts 6) | DFS longest trail | road.test.ts | ✅ |
| endTurn rotation + gates (wrongPhase on ended) | hasRolled + resolved-seven | turn.test.ts | ✅ |
| legalMoves UI enumeration | bidirectional conformance | turn.test.ts sweep | ✅ |
| random-play sim (400 ops incl. knights, conservation, cursor monotonic) | integration heartbeat | turn.test.ts | ✅ |
| _(wave 3 — trades + dev cards: COMPLETE — spec PASS + quality APPROVED, zero blockers; 142 tests)_ | | | |
| tradeBank (maritime 4:1) + tradePort (3:1/2:1 own-building) | ratio + portResourceMismatch + noPortThere | trade.test.ts (13) | ✅ |
| tradeOffer/Accept/Reject (multisets, both-hands revalidation, 7-freeze, endTurn expiry) | pendingTrade lifecycle | trade.test.ts | ✅ |
| buyDevCard (cost to bank, deck top, deckEmpty) | action-phase gate | devcards.test.ts (15) | ✅ |
| playMonopoly / playRoadBuilding (no chaining) / playYearOfPlenty | production-phase gate, pre-roll ok | devcards.test.ts | ✅ |
| VP cards immune: no play op, steal/discard resource-only | structural | devcards.test.ts | ✅ |
| zero-RNG discipline for all wave-3 ops | cursor bit-identical (probed) | probes + tests | ✅ |
| goldenReplay.simulateGame (greedy bot, independent metaSeed stream, 95/25 conservation per step, determinism+divergence) | wave-4-ready (claimVictory first in priority) | golden.test.ts (4) | ✅ |
| bonus tiles (Longest Route ≥5, Largest Army ≥3, breakage) | recomputation on build | bonus.test.ts | ⏸ wave 4 |
| claimVictory (≥10, own turn) | VP ledger | win.test.ts | ⏸ wave 4 |
| redactForSeat | projection purity | redact.test.ts | ⏸ wave 5 |

Legend: ✅ verified · 🔄 implementing · ⏸ planned · ❌ rejected-by-review

