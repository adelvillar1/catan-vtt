# Multiplayer Protocol (M2 — shipped contract)

> Spec of record for the WS wire between `apps/room` (server) and clients.
> **Ground truth is `packages/shared/src/protocol.ts`** — this doc describes it; if the two
> disagree, the schema wins and this doc is stale. Contract tests: `packages/shared/src/protocol.test.ts`.
> Rules questions (not transport questions): consult the `catan-board-game` skill.

- **Transport:** WebSocket, one room per game. Port **:4273** (local). JSON text frames only.
- **Version:** `PROTOCOL_VERSION = "1"`. v1 carries it out-of-band only (no message field yet);
  phase 3+ may add it to `join`/`welcome` to reject stale clients at join time.
- **Authority:** the server owns the true `GameState`; the only mutator is the kernel's
  `applyAction`. Clients send ops, receive projections. **Clients never roll dice locally.**
- **Strictness:** every message is zod `.strict()`. Unknown keys are a *reject*, not a warning.

Related: `docs/architecture/overview.md`, `docs/features/rules-kernel.md`, `packages/shared/src/redact.ts`.

---

## 1. Message catalog

### 1.1 Client → Server (`ClientMsgSchema`, discriminated on `type`)

| `type` | Fields | Sent when | Server behavior |
|---|---|---|---|
| `join` | `roomCode: 6 alphanumerics ([A-Za-z0-9], mixed case)`, `seat?: 0..3`, `seatToken?: string` | Once, immediately after connect | Look up room; bind connection to a seat (see §3). Replies `welcome` on success, `error` on `roomNotFound` / `roomFull` / `inSeatTaken` |
| `op` | `op: Op` (the kernel `OpSchema`, 20 variants) | Any time the player acts | `OpSchema.parse` → **reject-before-apply** → seat-authority check → `applyAction` on the true state. Emits `event(opApplied \| rejected)` + fresh `projection` |
| `ping` | `t: number` | Client keepalive | Replies `pong{t}` verbatim |

Notes:
- `join` **without** `seat` = claim the next free seat; if the room is full the
  server answers a **spectator** `welcome` (`seat: null`), never an error (§4).
- `seatToken` is the rejoin credential handed out in `welcome` (see §3).
- `op.seat` is whatever the client sent — the server re-checks it against the connection's
  *claimed* seat, so a forged `seat` fails authority, not the schema.

### 1.2 Server → Client (`ServerMsgSchema`, discriminated on `type`)

| `type` | Fields | Sent when | Payload meaning |
|---|---|---|---|
| `welcome` | `roomCode`, `seat: number\|null`, `seatToken?: string`, `players: PublicPlayer[]`, `phase` | Once, on accepted join | `seat: null` ⇒ spectator (no `seatToken`). `players` is the roster: `{seat,name,color,connected}` — no hand data |
| `projection` | `state: GameState`, `legalMoves: Op[]`, `serverSeq: number` | After join and after every state change | `state` is the **seat-scoped, RNG-scrubbed** projection (§5, §6). `legalMoves` is server-computed on the **true** state (§6) |
| `event` | `kind`, `details: Record<string, unknown>`, `serverSeq` | Feed / op outcomes | See the kind table below |
| `error` | `code: WireErrorCode`, `message: string` | Connection-level failure only | `inSeatTaken`, `roomFull`, `roomNotFound`, `badMessage`, `notSeated`, `badToken` |
| `pong` | `t: number` | In reply to `ping` | Echo of the client's `t` |

`event.kind` values (`details` is opaque to the wire schema by design — clients switch on `kind`):

| `kind` | `details` shape | Notes |
|---|---|---|
| `opApplied` | `{ seat, opType }` (+ kernel result summary) | Op accepted by `applyAction` |
| `rejected` | `{ seat, opType, code, details? }` | `code` is a **kernel `ActionErrorCode`** (e.g. `notYourTurn`, `distanceRule`) — *not* a wire code |
| `playerJoined` | `{ seat, name }` | |
| `playerLeft` | `{ seat, name }` | Graceful leave or timeout |
| `chat` | `{ seat \| null, text }` | |
| `gameEnded` | `{ winner, finalPoints }` | |

**Two disjoint error enums, on purpose.** Op-level failures ride `event.kind="rejected"`
with kernel codes; connection-level failures ride the top-level `error` with wire codes.
A `wireErrorCode` never appears in `rejected`, and an `ActionErrorCode` never appears in `error`.

---

## 2. Connection lifecycle

```
client                                            server (apps/room)
  |                                                     |
  |-------- ws connect -------------------------------->|
  |                                                     |
  |-------- join{roomCode, seat?, seatToken?} --------->|  zod-parse (strict)
  |                                                     |  room lookup + seat claim
  |<------- welcome{roomCode, seat|null, seatToken?, ---|      ok
  |            players[], phase}                        |
  |<------- projection{state, legalMoves, serverSeq} ---|      initial frame
  |                                                     |
  |     === steady state: projection loop ===           |
  |-------- op{op} ------------------------------------>|  reject-before-apply
  |                                                     |  seat authority check
  |                                                     |  applyAction(TRUE state)
  |<------- event{opApplied|rejected, ...} -------------|  broadcast
  |<------- projection{state, legalMoves, serverSeq} ---|  broadcast
  |                                                     |
  |-------- ping{t} ----------------------------------->|  (every 30s)
  |<------- pong{t} ------------------------------------|
  |                                                     |
  |-------- close / timeout --------------------------->|  seat kept until timeout
```

Rules:
- **Ping/pong: 30 s.** Client pings; server mirrors `t`. A connection that misses its window is
  dropped; the seat is *not* released immediately (see §3).
- **`serverSeq` is monotone per room.** A gap means the client missed a frame ⇒ **rejoin and
  resync**; never attempt to patch a diff.
- Every state change re-ships a full `projection`. v1 has no delta/patch frames.
- A malformed frame ⇒ `error{code:"badMessage"}`; the room keeps running.

---

## 3. Seats, tokens, reconnection

| Situation | What happens |
|---|---|
| First join, seat free | `welcome{seat, seatToken}` — token is the rejoin credential |
| Join requesting a taken seat | `error{code:"inSeatTaken"}`; client may re-join with another seat or as spectator |
| Room at capacity | Seat request ⇒ `error{code:"roomFull"}` (or spectator `welcome{seat:null}`) |
| Op from a spectator / unseated connection | `error{code:"notSeated"}` |
| Reconnect with a valid `seatToken` | Re-binds the connection to that seat; no state change, no auto-play |
| Reconnect **without** a token to a seat that has one | Denied; a new `seatToken` is issued only on a legitimate rejoin (the previous token is retired) |
| Mid-game disconnect | Seat is held briefly; the game **waits** rather than auto-playing for the absent seat |

**No auto-play, ever.** A disconnected seat is never simulated. Frozen states are legitimately
waited out — notably the **seven-window** (discard queue + robber move) and a **pending trade**:
the kernel gates (`awaitingSeven`, `pendingTrade`) decide what is legal, so the server simply
stops advancing until the owning seat acts or rejoins. Reconnect must therefore rehydrate
correctly *inside* those windows (kernel state is plain JSON — rehydrate is just a projection).

---

## 4. Spectator policy (v1)

| Aspect | v1 decision |
|---|---|
| Join | `join` without `seat` (or when no seat is free) ⇒ spectator |
| `welcome` | `seat: null`, no `seatToken` |
| Projection | **Public projection = `redactForSeat(state, 0)` plus a seat-0 squash** — i.e. no seat's hand is shown, *including* seat 0's. Implemented in `apps/room` (transport concern, kernel untouched) |
| `legalMoves` | Always `[]` for spectators |
| Acting | Any `op` from a spectator ⇒ `error{code:"notSeated"}` |
| Hidden info | Spectators see the same leak budget as a seated player: no hand composition, no deck order, no RNG |

---

## 5. RNG REBASE (load-bearing — do not regress)

**The problem.** The kernel's dice are xorshift32 over `(rngSeed, rngCursor)`. `rollLog`
(past rolls) plus `rngCursor` is enough to brute-force `rngSeed` in **minutes** — and seed +
cursor predicts every future roll and every dev-card draw. A projection that ships both is a
full information leak of the remaining game.

**The decision (locked in M2 phase 1b).**

| Layer | Behavior |
|---|---|
| Kernel `redactForSeat` | Sets `rngSeed: 0`, **keeps `rngCursor`** (draw-count invariants stay true; purity preserved) |
| `apps/room` **wireScrub** | Sets BOTH `rngSeed: 0` and `rngCursor: 0` on every projection before send |
| Wire | Projections always carry `rngSeed: 0, rngCursor: 0` |
| Client | **Never rolls locally.** `roll` / `stealCard` / `buyDevCard` / `tradeAccept` are non-commuting on a projection (see `redact.ts`); the server applies them to the true state and re-ships |
| Server | Holds the true `{rngSeed, rngCursor}` in its private room state; never emits it |

Consequences:
- `rollLog` still crosses the wire (it is public table history) but is now inert: without a
  cursor it does not advance the stream, and the seed is gone.
- A client that *did* roll locally would draw from the fallback (seed 0) stream and diverge
  silently — which is exactly why `legalMoves` is shipped rather than computed client-side.
- `protocol.test.ts` pins the compatibility probe: a `variableSetup(7, {playerCount:3})` state
  with `rngSeed:0, rngCursor:0` still parses as `GameStateSchema` (the scrub cannot break the
  schema, because 0 is already legal for both fields).

---

## 6. Why `legalMoves` is in the projection message

`legalMoves` is **server-computed on the true state** and shipped alongside the projection.
Reasons, in order of weight:

1. **RNG.** Ops that consume randomness (`roll`, `stealCard`, `buyDevCard`, `tradeAccept`) do not
   commute with redaction. `legalMoves` run on a *projection* would consult the zeroed/fallback
   stream and produce a list that is valid at the table but wrong for the true state.
2. **Hidden information.** Legal-move computation for those ops depends on data a projection
   deliberately erases (deck order, opponent hand composition).
3. **No duplicated op list.** The relay whitelist *is* `OpSchema`; the server computes legal
   moves with the kernel's own `legalMoves` and ships them. There is no second hand-maintained
   op enum anywhere in the stack.

Clients render their UI from the shipped `legalMoves`. (M3 optimistic apply is restricted to the
commuting set documented in `redact.ts`: builds, own trades, own dev plays, `endTurn`,
`moveRobber`.)

---

## 7. Security posture

| Concern | Posture |
|---|---|
| Trust model | **All client input is untrusted.** Every frame is zod-parsed (`.strict()`) before it reaches the room |
| Op legality | The kernel validates everything; the server adds a seat-authority check (`op.seat` must equal the connection's claimed seat) |
| Reject-before-apply | A frame that fails schema or authority never touches the true state |
| Hidden info | Enforced by `redactForSeat` + the RNG scrub (§5); projections only |
| Malicious-client floor (AC4) | Probes — op out of turn, forged `seat`, full-state-shaped payload, zod-injection keys — all yield a **typed** rejection; the room keeps running and the victim's projection is unchanged |
| Not in scope | Rate limiting, anti-cheat beyond AC4, authentication, transport encryption at rest |

Wire-level strictness is the *floor*, not the whole defense: the kernel re-validates every op
regardless of what the wire accepted.

---

## 8. Out of scope (v1)

Auth accounts · persistence/DB · deploy/Railway · turn timers · chat UX · spectators acting ·
deltas/patch frames · reconnection across server restart · anti-cheat beyond the AC4 floor ·
3D table (M3) · mobile.
