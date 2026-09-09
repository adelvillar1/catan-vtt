# Session Recap — 2026-09-08 — Project initialization

## What happened
Initialized catan-vtt from an empty directory: git repo (`develop` branch), npm-workspaces monorepo skeleton mirroring mahjong-vtt, full methodology doc set (CLAUDE.md/AGENTS.md, TECHNICAL-DOCUMENTATION.md, FUNCTIONAL-SPECIFICATIONS.md, docs/ tree), first plan (`2026-09-08-rules-kernel.md`), and a scaffold self-check script.

## Decisions (user AFK at clarify — recommended defaults taken, easily changed)
- **Rendering:** 3D hex-island table (React Three Fiber + drei, mahjong-vtt pattern) — ports later to 2D if desired.
- **Deployment:** local dev now; Railway deploy wiring deferred (no `apps/room` yet).
- **v1 scope:** base game, full fidelity, 3–4 players (robber, ports, dev cards, Longest Route & Largest Army). 5–6p and Seafarers = later plans.
- **Name:** catan-vtt; GitHub repo `adelvillar1/catan-vtt` not created yet.

## Verified (all live tool output, not assumed)
- `npm test` → 1/1 pass (vitest 2.1.9); `tsc --noEmit -p packages/shared` → clean
- `bash scripts/check-scaffold.sh` → PASS (git hygiene, doc pointers, gates, zero TODOs)
- `CLAUDE.local.md` gitignored + untracked (git check-ignore + ls-files)
- Ports 4273/4274 free (lsof), assigned in CLAUDE.md ports table
- CLAUDE.md = AGENTS.md = 112 lines ≤150 cap; draft preamble stripped (grep DRAFT = 0)

## Environment lessons captured this session
- Global npm config `omit=dev` silently skipped devDeps → project `.npmrc` `include=dev` (`.npmrc` cannot use `omit=` empty — npm warns "invalid config" and it doesn't cancel via `npm run` chain).
- Nested `npm run` inside npm scripts hangs on this machine (re-exec loop with npm notice spam) → root scripts invoke workspace binaries directly.
- Hermes command guard blocked a giant inline one-liner → moved to `scripts/check-scaffold.sh` (reusable).
- Protected agent-instruction files: write_file reported success but files vanished; terminal cp install worked.

## Unfinished
- Nothing pending; first commit is the last step of this session. Next session: execute `docs/plans/2026-09-08-rules-kernel.md` via subagent-driven-development (kernel phases 1-10, 2-stage review).


---

# Session Recap — 2026-09-08 (part 2) — M1 Rules Kernel: ALL FIVE WAVES

## What happened
Built `packages/shared` end-to-end via subagent-driven waves with a 2-stage read-only review gate (spec-compliance + code-quality) per wave. Commits on `develop` (pushed): `3465083` wave 1 (rng/board/state/setup, 61 tests) · `468f63a` wave 2 (turn machine: applyAction + 10 ops + longest route + legalMoves, 110) · `5a392bf` wave 3 (trades + dev cards + golden replay bot, 142) · `49245a1` wave 4 (VP ledger + claimVictory + ended lockdown, 159) · `7e8d457` wave 5 (redactForSeat projection, 170) · docs-sync close-out (this commit). Plan `2026-09-08-rules-kernel.md` → status **done**, AC1–AC10 all checked.

## Verified (live tool output)
- `npm test` → **170/170** across 12 files (~8s; includes 10k-seed property sweeps); `tsc --noEmit` clean; root `npm run typecheck` clean.
- AC2 exceeded: six seeded golden games (3p×4, 4p×2) reach REAL 10-VP wins in 135–408 turns, winners spread seats 0–3; determinism double-run byte-equal; scripted claim + 4 rejection paths.
- Redaction leakage proof: states differing ONLY in hidden info project byte-identically; 8-op optimistic-UI commutativity asserted by strict JSON equality.
- M1 close-out: dead error code `pieceNotInStage` removed (32-code union; the options-iteration test self-adapts); coverage matrix names all 20 ops (AC10); TECHNICAL-DOCUMENTATION §3/§5 carry the real op table + gates + codes; FUNCTIONAL-SPECIFICATIONS §3 encodes the kernel-verified rules.

## Decisions
- **RNG contract (locked):** `Rng.restore({rngSeed,rngCursor})` is the only mid-game entry; single continuous stream per game (retries draw from it — fixes the 73%-of-seeds replay bug review caught); roll +2 / steal +1 draws; everything else zero (probed bit-exact).
- **Rules rulings adopted after primary-source verification** (each also patched into the `catan-board-game` skill): own buildings NEVER break Longest Route (opponent-only spokes); roads may run UP TO an enemy settlement (only STARTING past one is illegal); seat 0 (last round-2 placer) takes the first turn; setup second settlement pays adjacent terrain itself (no grant op); 6-road ring counts 6; claimVictory pre-roll allowed (v1 lock); `devBoughtThisTurn` per-type counter (older duplicates stay playable).
- **Deliberate v1 leak loosening (documented in redact.ts):** others' `devBoughtThisTurn` passes through projections; hidden VP-CARD count is public via squash length (count only).
- Review discipline earned its keep: every wave's reviews changed code (wave 2: 5 rules bugs; wave 1: replay blocker). Parent briefs audited twice mid-flight; the "parent digests are fallible" rule is now in the subagent-driven-development skill.

## Environment/tooling notes
- Delegation pinned `kimi-code/k3-256k` (ocx proxy :10100) per user's hy4-quota fallback ladder; one fix agent hit the 30-min ceiling at 79 calls — parent finished surgically; time-discipline blocks now standard in impl briefs.
- Reviewer subagents hit sandbox permission blocks on /tmp scratch exec — quality briefs now say: if blocked, fall back to static reads + `npm test`, never retry.

## Unfinished / next
- **M2 room server** plan to be drafted next (`docs/plans/YYYY-MM-DD-room-server.md`): WS rooms, seat tokens, OpSchema-derived relay whitelist, per-seat projections, and the rng-stream rebase (wave-5 MAJOR: rollLog+rngCursor brute-force → server must not ship the replayable stream). Ports 4273 (WS) / 4274 (table) reserved.
- No `CLAUDE.local.md` edits this session. No deploy touched (deferred by user directive).


---

# Session Recap — 2026-09-08/09 (part 3) — M2 Room Server: COMPLETE (phases 1-4)

## What happened
Built + shipped the WS multiplayer stack with per-phase 2-stage reviews. Commits on `develop` (pushed): `708f4d2` phases 1-2 (protocol.ts wire contract + room.ts pure core, 54 tests) · `eba7396` phase 3 (server.ts ws transport + 22 wire tests) · `dba6a44` spec-review batch (stale-sweep ghost seat, terminal-event race, 5 coverage tests) · `468aad2` quality batch (one-join-per-socket lobby DoS, release-every-owned-seat, wire name field, send hardening) · `571c628` phase 4 (cli.ts text-mode table client + server-main `npm start` + demo driver + evidence) · `d4b01db` plan DONE. Final: **248/248** tests, typecheck clean.

## Exit gate (AC1-AC6 all evidence-backed)
Three REAL WebSocket clients (`Hector/Brick/Wheat`) + seeded game (seed 20260908, room MQx61x) → every client independently printed `WINNER seat 2, finalPoints 10`; 602 applied ops, **0 rejections**; parent re-ran the demo driver live (port 4377, exit 0, unanimous winner). Evidence: `docs/e2e-review/m2-two-terminal/` (per-client logs + commands.sh).

## Review-earned lessons (the loops changed code every single phase)
- **Re-probe before trusting a fix**: quality review's C1 (one socket churns joins 0→1→2 → lobby DoS) was tested against the CURRENT commit before implementing — the spec batch's "replace-binding" fix looked right but was still exploitable. Final policy: one join per socket; every teardown path (close/3-strike/sweep) releases EVERY owned seat.
- **Tautology catch**: flagship WIN test asserted `["WIN","PROGRESS"].toContain(derived)` — unfalsifiable; replaced with hard `expect(ended).toBe(true)`.
- **Same-tick broadcast race** (harness, not server): server sends event+projection in one synchronous burst; waiters must arm BEFORE send and match by monotonic serverSeq (`act()`/`syncTo()` pattern, documented).
- **Strict-wire trust model**: malformed inner ops are transport `error{badMessage}` + strike (never `event{rejected}`); forged `op.seat` is wire-valid → kernel authority rejection verbatim.
- **Terminal ordering**: `gameEnded` ships BEFORE the final projection (a client syncing by serverSeq must never see `ended` before its terminal event) — documented as load-bearing.
- **Bearer-token ruling** (quality #5, NOT fixed): token rejoin while the old socket is still open succeeds in v1 — friends-only threat model, rotation fences it one-shot; rejecting would break legitimate pre-FIN recovery.

## Process notes
- Two children hit the 30-min ceiling (phase 3 with a broken harness race; both salvaged — their on-disk code was correct/complete, parent finished + reviewed). "Salvage, don't re-dispatch" worked twice.
- Parent wrote 3 gap tests directly (AC5 rejoin windows; found its own `if (!seat) continue` falsy-seat-0 bug — seat 0 is valid, always compare `=== null`).
- Provider ladder in effect: hy4-preview primary (:8787), Kimi k3 quota-capped, GLM-5.2 spare.

## Unfinished / next
M2 plan optional tail (chat plumbing, soak) — deferred, not in ACs. Next: M3 (this file, part 4).

---

# Session Recap — 2026-09-09 (part 4) — M3 P1: 3D table renders from the wire

## What happened
Plan `docs/plans/2026-09-08-3d-table.md` approved by user ("implement m3 as designed"). P1 dispatched; **two children both timed out at 30-min ceilings** — salvaged twice (foundation `1fd76d3`: geom frame + wire adapter + Hex/NumberToken/opLabel, 72 tests; finisher `dec1a8d`: Island/Buildings/Roads/Ports + overlay UI + App/main + layout.test.ts, 87 tests total). Root typecheck extended to 3 projects; **320/320** suite green.

## First-render browser evidence (docs/e2e-review/m3-p1/)
playwright-core 1.62.1 (from mahjong-vtt's node_modules — NO new install needed) + cached Chromium `chrome-mac-arm64` with `--use-angle=swiftshader --enable-unsafe-swiftshader` → WebGL2 canvas live, zero page errors. `02-spectator-island.png`: 19 hexes with terrain palette + number tokens + robber + port labels, winner's seat-colored settlements/roads on real vertices/edges, STATUS spectate/ended/serverSeq 602, wireScrub 0/0 held through the adapter. `03-orbited.png` proves OrbitControls.

## The bug only pixels could catch (`fd0f205`)
JoinPanel auto-uppercased the room code — invite codes are mixed-case `[A-Za-z0-9]{6}`, so `AH4hgi` became `AH4HGi` → `roomNotFound`. Typecheck, build, unit tests, AND the node-side wire smoke all passed while the join flow was literally impossible half the time. **M3 rule: no UI claim without a screenshot.**

## Decisions / environment
- **Stack corrected mid-flight to the sibling-proven combo** (react@19.2.8, fiber@9.7, drei@10.7, three@0.185, vite@8): fiber v9 peer-requires React 19 — my original react@18 dispatch died in ERESOLVE; steer corrected the live child, plan doc amended. Root `package.json` must carry ZERO app deps (child's accidental root `dependencies` block was the expo/peer noise source — removed).
- **The coordinate frame is the phase's real deliverable**: geom.ts copies board.ts `VERTEX_OFFSETS` byte-for-byte (pointy-top, unit hex radius, worldX/worldZ = board x/y), and geom.test.ts proves hex-center == mean of 6 vertexCoords corners at EPS 1e-6 — everything P2 draws on top inherits bit-identical kernel/scene corners.
- Command guard misreads `vite build` as a server → run via background+poll to `/tmp/p1_build.log`, or `node ./node_modules/vite/bin/vite.js` inside apps/table (workspace 8.2.2 — root's 5.4.21 is a vitest transitive, NOT the build tool).
- macOS has no `timeout(1)`; `sleep N && cmd` foreground is fine for waits ≤ guard limits.
- Bot games finish in ~6-7s on seed 20260908 — start the game BEFORE the browser capture if you want a built island to screenshot (ended is fine: pieces stay).

## Unfinished / next
P1 2-stage reviews in flight (deleg_d71349b3, spec + quality) — disposition + fixes, then **P2: click-to-play interaction** (MovesList buttons → sendOp, vertex/edge click targets for placement, robber drag, seven-window discard modal, trade + dev-card panels), each with its own review + screenshot evidence.


---

# Part 5 — P1 quality-review disposition (`6186820`)

Quality review CHANGES-REQUESTED (0 Critical / 8 Important / 9 Minor) — all taken, re-verified (337/337, typecheck 3 projects, vite@8 build, Playwright re-capture `rf-*`):
- **I-1 worst**: `ws.send()` inside a `setRoom` updater → StrictMode double-invokes updaters → P2 buttons would have sent every op TWICE. `useRoom` rewritten: ref is the source of truth, frames routed OUTSIDE React, `commit()` mirrors pure values into state. (M2's same-tick lesson, React edition.)
- **I-3/I-17**: drei `<Text>` with no `font` prop suspends the whole-island Suspense on a jsdelivr Roboto fetch → slow/blocked CDN = blank table. Bundled Rubik-Medium (OFL) at `public/fonts/`, `TABLE_FONT` on every Text, per-label Suspense. Capture now records remote requests: **NONE**.
- **I-8 vacuous test**: "every building resolves" ran on an EMPTY setup record. Fixture now drives the full kernel variable setup through `applyAction`/`legalMoves` (test-only import; AC3 src stays clean) + anti-vacuity `>=6` assertion + unknown-id → null cases.
- **I-6 white-screen**: unknown vertex/edge ids threw RangeError mid-render (client/server version skew). layout transforms return null, renderers skip, `ErrorBoundary` wraps canvas content.
- Rejected as designed: length-keyed memo on hexes (rematch-stale trap — memos dropped instead, 19 items/frame is free); client `buildIsland` (would duplicate server geom — forbidden by plan ruling); live-token-rejoin-while-connected (M2 bearer ruling holds).
- Spec reviewer #2 died at the ceiling with zero findings → re-dispatched on the fixed batch (`deleg_d89df36f`) with an explicit read-budget prompt. **Lesson: after 13 delegation ceiling-hits, review prompts must state a read budget + answer-the-questions-directly shape.**

---

# Part 6 — P2(a) playable browser table + quality batch (`100e233`, `f8d17e2`)

**P2(a) shipped and double-gated**: the table is playable from a real browser — HUD, resource
rail, trade + dev panels, enabled MovesList, auto-rejoin on refresh. Child `deleg_5c4a3377`
died at the ceiling AFTER writing all UI code, BEFORE tests/evidence (the now-customary
pattern): parent salvaged, wrote the missing test layer (hud/trade/lastRoom), ran the
browser smoke.

**The airtight proof**: bots on seats 0+1 were parked/idle, so the browser's click on a
shipped `Place settlement (setup)` button was the ONLY force that could move the game —
`serverSeq 4→5`, no rejected event; reload auto-rejoined seat 2 ("rejoined" banner + hand
intact, `rf-03-rejoined.png`). My test layer caught two of MY OWN wrong expectations first
(`afterSetup` lands in play, not mid-setup; resource abbreviation is `WOD`), and probe-locked
a kernel truth: post-roll legalMoves = tradeBank/tradePort/endTurn.

**Quality review** (`deleg_85447e1a`, hy4, COMPLETED in 14 min — the read-budget +
no-suite-rerun rules in the prompt worked; siblings had been dying at 30 min):
CHANGES-REQUESTED 0C/5I/9M. Every finding re-probed against current code before fixing
(the standing rule earned its keep — two findings needed *correct* fixes, not the suggested
ones):
- I-2's real shape was worse than reported: the kernel **deliberately never enumerates
  composed `tradeOffer`** (sole authority = `applyAction`); gating on `hasMove(tradeOffer)`
  was a dead affordance. Now a state-derived gate (own turn, play phase, rolled, no pending
  trade, no seven-window) + give∩want overlap guard.
- I-3 (StrictMode rejoin latch) — my own smoke had PASSED with the bug present (latch only
  bites when pass-1's socket is still CONNECTING at cleanup; the timing in my run dodged it).
  Fix = drop the latch (refs survive simulated unmounts — that was the bug), reconnect keyed
  on `status === "closed"`, token-guarded. **Lesson: a passing smoke does not prove a
  React-lifecycle fix is unnecessary — prove the mechanism.**
- I-1/I-4 (gating honesty): TradePanel selects + DevCardPanel buttons now build ONLY from
  server-shipped ops (`shippedTrades`/`pickAll`) and send those objects verbatim.
- Minors: lastRoom seat clamp (0..3 else spectate), two structural test tautologies replaced,
  vacuous `ports.every` deleted, favicon 404 killed with data-URI SVG.

**Evidence quirk solved honestly**: a log line said "28 remote requests" — all
`blob:http://localhost` (troika text rasters; same-origin; my probe's hostname filter
misclassified them). The lone 404 was `/favicon.ico`. Verified with a purpose-built network
probe: zero true remote, zero local 4xx.

Post-batch: root 356/356, typecheck 3 projects, workspace build exit 0, re-smoke green
(room `2Xdt3P`). Plan ledger + evidence README updated (`dcdf7bb`).

**P2(b1) dispatched** (`deleg_514348b0`): click-the-island — `buildTargetSet` (targets exist
iff an op carrying that id shipped), Targets.tsx interactive ghosts, discard modal. Pre-read
ground truth for the child's disposition: seven-window ships `discardSeven` as ENUMERATED
combinations (multisetCombinations — could be hundreds), `moveRobber` for every other hex,
`stealCard` per hand-holding victim (turn.ts:1408-1443). The discard UI must pick cards and
submit one of the shipped lists (TradePanel precedent), not fabricate.


---

## Part 7 — P2(b1): click the ISLAND (salvage #3, quality-gated, shipped)

`deleg_514348b0` (hy4) died at the 1800s ceiling with 87 API calls — the most productive
salvage yet: all code, 11 tests, tsc + build green, killed mid-browser-evidence. Parent
completed its click proof in a live stack (room `lxjT9G`): 47 ghosts, click at the projected
screen pos of a vertex ghost → `serverSeq 4→5`, `rejected=false`, orbit-drag advances nothing,
zero page errors. Vision-confirmed both stills.

Parent hardening pre-review: extracted `discardCombinationKeys`/`discardCardsKey` into pure
`targetSet.ts` (the modal's legality logic now has a tested surface), `mayActOnBoard` invariant
with a documented tripwire, dead exports removed. Caught myself labeling changes "review I-1"
when the reviewer had not reported yet — reworded; **never cite findings from a review that
hasn't landed** (the previous review dispatch `deleg_c6c322c4` had no transcript dir at all —
apparently never dispatched; lesson: verify a child is live via its transcript dir before
counting it as in-flight).

Discard-modal BROWSER proof honestly failed six stack attempts (bots swept for idleness while
the browser drove; no seat-2 seven within budget). The captured 03-discard.png showed a failed
drive, not the modal — DELETED rather than committed misleading evidence; deferred to P3's
full-game demo. The modal's logic stays unit-proven (kernel-exact multiset-count assertion).

Quality `deleg_03bb0347` (completed 1598s): CHANGES-REQUESTED, 0 Critical / 2 Important.
I-1 cursor leak — R3F's removeInteractivity drops the mesh from its hover map WITHOUT firing
onPointerOut, so the normal click-applies path left the pointer cursor stuck. Fixed by clamping
`hovered` to this frame's live targets; re-ran the browser proof — cursor asserts green (now
asserted, not printed: reviewer minor m-7). I-2 the mustMoveRobber drive had silent `break`
paths — added an `asserted` flag; reviewer's own /tmp probe confirmed the window is reached.
mayActOnBoard's roller-gate CONFIRMED sound vs turn.ts (currentSeat can differ from roller
during an unresolved 7). Minor gold: reviewer claimed the hex ghost yaw was wrong and quoted
`[-PI/2,0,0]` from the token ring — recomputed both rotations myself: Hex.tsx uses
[0, POINTY_TOP_YAW=PI/6, 0] for the same cylinder geometry, so PI/6 is the correct alignment
for a ghost over a tile. The reviewer was right that a mismatch existed, wrong about the value;
re-derive, don't copy (m-6).

Also: 20-op full-vocabulary sweep test tripwires placementSlot's default:null for future ops;
DiscardModal reset key = window identity (debtor:count, hidden=null), not just count; stack
pkill scoped to catan paths; discard script exits green ONLY if the modal was actually seen.

Shipped: 8a15665 + 374fa8c + 0101100. 372/372, typecheck 0, build 266ms, click-PASS x2.
M3 state: P1 done, P2(a) done, P2(b1) done. Remaining: P3 (robber-flow polish, full-game
setup→10VP browser demo incl. discard pixels, rematch + victory, cinematic), P4 (evidence +
docs close-out).
