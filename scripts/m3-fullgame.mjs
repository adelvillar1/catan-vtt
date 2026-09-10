/**
 * m3-fullgame.mjs — M3-P3(c) AC2: a FULL 3-player CATAN game, played
 * entirely through three real browser tabs, to a real 10-VP winner.
 *
 * WHAT IS PROVEN HERE (docs/plans/2026-09-09-m3-p3c-fullgame-demo.md):
 *   1. three independent browser contexts claim seats 0/1/2 (one context per
 *      seat — a SHARED context lets tab A's lastRoom auto-rejoin steal tab
 *      B's seat, the P3(b) lesson);
 *   2. every op is a real click: DOM buttons in #moves-list (the server's
 *      legalMoves, labelled by ui/opLabel.ts) and on-canvas placement ghosts
 *      (window.__catanTargets(), opt-in via localStorage catan:e2eTargets);
 *   3. the seven window is served by the real DiscardModal (#discard-modal /
 *      .chip-btn / #discard-submit) — the pixel P2(b1) had to defer;
 *   4. the robber is moved by clicking a hex ghost and the steal is a DOM
 *      click;
 *   5. the victory banner shows a REAL winner (no injection) and seat 0's
 *      #victory-rematch is clicked in anger -> all three tabs repaint setup.
 *
 * INJECTION DISCIPLINE (the honesty fence):
 *   ALLOWED    — localStorage `catan:e2eTargets` = "1" (screen-space ghost
 *                coordinates; the ghosts are already on screen, the hook only
 *                reports where).
 *   FORBIDDEN  — the localStorage winner-override flag read by
 *                ui/victoryView.ts (it would synthesize the winner, which is
 *                exactly what AC2 forbids). It is not SET, not READ, and —
 *                so a one-line grep proves the absence — not even NAMED in
 *                this file.
 *   No op object is ever CONSTRUCTED here. Every click is a DOM element or a
 *   canvas pixel the app itself rendered from a server-shipped op.
 *
 * GREEDY PER-SEAT POLICY (the only randomness is WITHIN a legal-move bucket,
 * exactly like the golden bot, plus the server's own dice):
 *   setup phase    -> a UNIFORM RANDOM on-canvas ghost (placement order IS the
 *                     server's legalMoves order; ghost-first proves the 3D
 *                     path under load — 15 placements per game);
 *   own turn       -> the golden-bot ladder (goldenReplay.ts:54-73), which is
 *                     the priority that reaches 10 VP in all six fixed games:
 *                     claimVictory > roll > discardSeven > moveRobber >
 *                     stealCard > buildCity (2 VP) > buildSettlement >
 *                     buildRoad > buyDevCard > playKnight > playMonopoly >
 *                     playRoadBuilding > playYearOfPlenty > tradeBank >
 *                     tradePort > endTurn. Cities and dev cards are bought on
 *                     sight (a dev deck that is still 25 cards after 1,562 ops
 *                     is a POLICY bug, not a rules one);
 *   seven window   -> DiscardModal chips, highest remaining count first,
 *                     until #discard-submit enables, then submit;
 *   maritime trade -> only toward a build target this seat cannot yet afford,
 *                     paid with a card that target does not need (a 4:1 is a
 *                     THREE-card tax; run #7 ping-ponged 151 wood->brick and
 *                     built nothing);
 *   domestic trade -> see DOMESTIC POLICY below.
 *   "roll if rolls==0" (plan wording) is implemented as "roll when the server
 *   ships it": legalMoves only ever contains `roll` when this seat has not
 *   rolled this turn, so the server — not the driver — decides.
 *
 * DOMESTIC POLICY (runs #10-#12 — the three rules that make an offer safe):
 *   1. NEVER RE-OFFER A DECLINED PAIR. The offeror remembers the exact
 *      (partner, give, want) triple a partner declined and never sends it
 *      again. Run #11 sent the identical ore->wood offer 1,244 times and got
 *      1,244 declines: seq crawled to 2,569 and the run died.
 *   2. ONE OFFER PER TURN, THEN PROGRESS. The turn identity is the HUD's
 *      `rolls` counter (constant through a seat's action phase, unique per
 *      turn). After the partner answers — accept or decline — the offeror
 *      falls straight through to endTurn. An offer can never wedge the loop.
 *   3. THE ANSWER IS ALWAYS PAYABILITY-CHECKED. tradeAccept ships
 *      unconditionally to the offeree (turn.ts:1446-1451), so a blind accept
 *      of an unaffordable offer IS a rejection — and AC2 demands zero. The
 *      offeree reads the public offer (#hud-trade) and its own rail
 *      (#rail-chips) and declines when it cannot pay.
 *      (2-for-1 generosity is NOT reachable from the DOM: TradePanel composes
 *      exactly one give and one want — tradeFormToOp, hudLogic.ts:294 — so
 *      "give 2, want 1" cannot be expressed without editing app source.)
 *
 * COOLDOWN: after 8 consecutive declines the seat stops offering for 10 rolls,
 * so a table with nothing to trade does not spend its whole op budget on
 * diplomacy (the golden bot wins with ZERO domestic offers — this surface is
 * exercised for coverage, not because the win depends on it).
 *
 * Usage: RC=<6-char room code> node scripts/m3-fullgame.mjs
 * Stack: bash scripts/p3c-stack.sh   (room :4273 + vite :4274, no bots)
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// playwright-core is CJS here — named ESM imports fail, so go through require.
const { chromium } = createRequire(import.meta.url)(
  "/Users/alejandrodelvillar/Projects/mahjong-vtt/node_modules/playwright-core/index.js",
);
const EXEC =
  "/Users/alejandrodelvillar/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const ROOM = process.env["RC"] ?? "";
const OUT = "/Users/alejandrodelvillar/Projects/catan/docs/e2e-review/m3-p3c";
const LOG = `${OUT}/fullgame.log`;

const BUDGET_MS = 900_000; // 15 min cap (plan budget)
const STALL_MS = 120_000; // watchdog: seq stall with no modal open
const OP_WAIT_MS = 10_000; // max wait for one click to move serverSeq
const RAIL_W = 330; // the DOM rail eats this much on the right

if (!/^[A-Za-z0-9]{6}$/.test(ROOM)) {
  console.error("RC=<6-char room code> required (line 1 of scripts/p3c-stack.sh)");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(LOG, `# m3-fullgame room=${ROOM} started ${new Date().toISOString()}\n`);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);
let lastLoggedLine = null;
let repeatCount = 0;
function log(line) {
  const s = `[+${el()}s] ${line}`;
  // FLOOD DEDUP: an identical line repeated is worth ~3 mentions, not 87,790
  // (the P2(b1) evidence dir learned this the hard way; the AC2 run #1 died
  // spamming one discard line into a 5.2MB log).
  if (s === lastLoggedLine) {
    repeatCount++;
    if (repeatCount % 500 !== 0) return;
    const m = `[+${el()}s] (repeated ×${repeatCount}) ${line}`;
    console.log(m);
    appendFileSync(LOG, `${m}\n`);
    return;
  }
  lastLoggedLine = s;
  repeatCount = 0;
  console.log(s);
  appendFileSync(LOG, `${s}\n`);
}

// ---------------------------------------------------------------------------
// DOM readers (parent-verified selector ground truth)
// ---------------------------------------------------------------------------

const READ = `(() => {
  const txt = (sel) => {
    const e = document.querySelector(sel);
    return e === null ? null : (e.textContent || "").trim();
  };
  const status = document.querySelector("section[aria-label='status']");
  const statusText = status === null ? "" : (status.innerText || "");
  const m = /serverSeq\\D+(\\d+)/.exec(statusText);
  const moves = [...document.querySelectorAll("#moves-list li button")].map((b) => {
    const spans = [...b.querySelectorAll("span")];
    return {
      label: (spans[0]?.textContent || "").trim(),
      detail: (spans[1]?.textContent || "").trim(),
      disabled: b.disabled === true,
    };
  });
  const ticker = [...document.querySelectorAll("section[aria-label='events'] li")].map((li) => ({
    seq: (li.querySelector(".seq")?.textContent || "").replace(/[^0-9]/g, ""),
    text: (li.textContent || "").trim(),
  }));
  return {
    seq: m === null ? -1 : Number(m[1]),
    statusText,
    phase: txt("#hud-phase"),
    hudTitle: txt("#hud-title"),
    yours: document.querySelector("#hud-title")?.getAttribute("data-yours") === "1",
    vp: txt("#hud-vp"),
    // The HUD's rolls row (state.rollLog.length — Hud.tsx). There is no
    // turn counter in GameState, and THIS is the value that stays constant
    // through one seat's whole action phase and differs between turns, which
    // is exactly the turn identity the "one offer per turn" rule needs.
    // (Run #10 keyed the offer on serverSeq, which changes on EVERY op — so
    // it re-offered inside the same turn, forever.)
    rolls: (() => {
      const rows = [...document.querySelectorAll("#hud-panel .kv")];
      for (const r of rows) {
        const k = (r.children[0]?.textContent || "").trim();
        if (k === "rolls") return Number((r.children[1]?.textContent || "0").trim());
      }
      return -1;
    })(),
    // Own hand, straight off the rail chips (data-count is server-derived).
    // Needed by the NEEDS-DRIVEN trade chooser — a greedy "first shipped 4:1"
    // ping-pongs wood<->brick and never assembles a build hand (run #7).
    hand: (() => {
      const h = {};
      for (const c of document.querySelectorAll("#rail-chips .chip")) {
        h[c.getAttribute("data-resource")] = Number(c.getAttribute("data-count") || "0");
      }
      return h;
    })(),
    moves,
    modal: document.querySelector("#discard-modal") !== null,
    modalTitle: txt("#discard-modal h2"),
    submitDisabled: (() => {
      const b = document.querySelector("#discard-submit");
      return b === null ? null : b.disabled === true;
    })(),
    victory: txt("#victory-heading"),
    victorySub: txt("#victory-sub"),
    victoryWinner: txt("#victory-winner"),
    rematch: document.querySelector("#victory-rematch") !== null,
    ticker,
  };
})()`;

// The chip's own text is "WOD · wood" plus a nested <span class="chip-count">
// for the remaining count — childNodes[0] is the leading TEXT node ("WOD · ")
// and stops at the element boundary, so parse the whole button text instead.
const CHIPS = `(() => [...document.querySelectorAll("#discard-modal .chip-btn")].map((b) => {
  const all = (b.textContent || "").trim();
  const parts = all.split("·").map((x) => x.trim());
  return {
    // "WOD · wood 3" -> parts = ["WOD", "wood 3"] -> strip the trailing count
    resource: (parts[1] ?? "").replace(/\\s*\\d+\\s*$/, "").trim(),
    count: Number((b.querySelector(".chip-count")?.textContent || "0").trim()),
    disabled: b.disabled === true,
    raw: all,
  };
}))()`;

const TARGETS = `(() => (typeof window.__catanTargets === "function" ? window.__catanTargets() : []))()`;

/** Rail chip abbreviations, matching hudLogic.RESOURCE_ABBR (TradePanel labels).
 *  Kept because the trade selects' OPTION VALUES are the bare resource names
 *  (TradePanel resOpt: value={r}), so the driver never needs the abbreviation
 *  — only a reader of the log does. */
const ABBR = { wood: "WOD", brick: "BRK", wool: "WOL", wheat: "WHT", ore: "ORE" };
void ABBR;

const seqOf = async (p) => (await p.evaluate(READ)).seq;
const read = (p) => p.evaluate(READ);

async function waitSeqAbove(page, before, ms = OP_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = await seqOf(page);
    if (s > before) return s;
    await page.waitForTimeout(70);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// launch + join
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: EXEC });
const W = 1400;
const H = 900;
const errors = [];
const seats = [];

for (const s of [0, 1, 2]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`s${s} pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`s${s} console: ${m.text()}`);
  });
  await page.goto("http://localhost:4274/", { waitUntil: "domcontentloaded" });
  // Opt in to the screen-space ghost hook BEFORE joining (Targets.tsx reads
  // it once per mount).
  await page.evaluate(() => window.localStorage.setItem("catan:e2eTargets", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-code", { timeout: 15_000 });
  await page.fill("#join-code", ROOM);
  await page.fill("#join-name", `Browser${s}`);
  await page.selectOption("#join-seat", { value: String(s) });
  await page.click("button:has-text('Join')");
  await page.waitForSelector("#hud-panel", { timeout: 15_000 });
  seats.push({
    seat: s,
    page,
    ops: 0,
    ctx,
    // --- domestic-offer memory (runs #10-#12) ---
    // `refused` holds `${partner}|${give}|${want}` triples a partner already
    // declined; a declined offer is NEVER re-sent (run #11: 1,244 identical
    // offers, 1,244 declines, seq 2,569, zero builds).
    refused: new Set(),
    // The turn (HUD `rolls` value) this seat last sent an offer on. serverSeq
    // is NOT a turn key — it changes on every op, which is exactly how run
    // #10 managed to re-offer 459 times inside one turn.
    offerTurn: -1,
    // The in-flight offer, resolved on the next visit from the rail counts.
    lastOffer: null,
    declineRun: 0,
    coolUntil: 0,
  });
  log(`seat ${s} joined (${await seqOf(page)})`);
}

const pageOf = (s) => seats[s].page;

// ---------------------------------------------------------------------------
// evidence counters
// ---------------------------------------------------------------------------

const seenEvents = new Set(); // `${seat}:${seq}` — dedupe the ring buffer
let rejected = 0;
const rejectedRows = [];
// Domestic-trade accounting (the run #11 post-mortem needs both numbers:
// 755 offers for 2 accepts is the signature of a broken offer policy).
let offers = 0;
let accepts = 0;
/** Consecutive declines before a seat stops offering for a while. */
const DECLINE_COOLDOWN_TRIGGER = 5;
/** Rolls a seat stays quiet after hitting the decline trigger. */
const DECLINE_COOLDOWN_ROLLS = 10;
const shots = {};
let midgameShot = false;
let discardShot = false;
let robberShot = false;

async function harvestTicker(s, snap) {
  for (const row of snap.ticker) {
    const key = `s${s}:${row.seq}`;
    if (row.seq === "" || seenEvents.has(key)) continue;
    seenEvents.add(key);
    if (/rejected/i.test(row.text)) {
      rejected++;
      rejectedRows.push(`s${s} ${row.text}`);
      log(`!! REJECTED seen on seat ${s}: ${row.text}`);
    }
  }
}
async function harvestAll() {
  for (const s of [0, 1, 2]) {
    try {
      await harvestTicker(s, await read(pageOf(s)));
    } catch {
      /* transient */
    }
  }
}

const shot = async (name, seat) => {
  if (shots[name]) return;
  shots[name] = true;
  const p = `${OUT}/${name}.png`;
  await pageOf(seat).screenshot({ path: p });
  log(`shot ${name}.png (seat ${seat})`);
};

// ---------------------------------------------------------------------------
// click helpers
// ---------------------------------------------------------------------------

/** DOM move click: pick the first enabled button whose label is in `labels`. */
async function clickMoveByLabel(page, labels) {
  const snap = await read(page);
  for (const label of labels) {
    // Uniform-random among the enabled buttons carrying this label — the
    // golden bot's within-bucket rule (goldenReplay.ts:75-79). Always taking
    // the first one gives every seat the same deterministic (and likely
    // worst) road/settlement choice every turn.
    const hits = [];
    snap.moves.forEach((m, i) => {
      if (m.label === label && !m.disabled) hits.push(i);
    });
    if (hits.length === 0) continue;
    const idx = hits[Math.floor(Math.random() * hits.length)];
    const before = snap.seq;
    await page.locator("#moves-list li button").nth(idx).click({ timeout: 4000 });
    const after = await waitSeqAbove(page, before);
    return { ok: after > before, label, detail: snap.moves[idx].detail ?? "", seq: after };
  }
  return null;
}

/** On-canvas ghost click. `pick` chooses one of the live ghosts. */
async function clickGhost(page, kind, pick) {
  const targets = await page.evaluate(TARGETS);
  if (targets.length === 0) return null;
  const pool = targets.filter(
    (t) => t.x > 8 && t.x < W - RAIL_W && t.y > 8 && t.y < H - 8 && (kind === null || t.kind === kind),
  );
  const list = pool.length > 0 ? pool : targets.filter((t) => kind === null || t.kind === kind);
  if (list.length === 0) return null;
  const t = pick(list);
  if (t === undefined || t === null) return null;
  const before = await seqOf(page);
  await page.mouse.click(t.x, t.y);
  const after = await waitSeqAbove(page, before);
  return { ok: after > before, kind: t.kind, id: t.id, seq: after };
}

// The golden bot picks a UNIFORM RANDOM member of each op bucket
// (goldenReplay.ts:75-79) — and it wins 6/6 in ~600 ops. An always-first
// driver gives all three tabs the same (probably terrible) opening
// placements, which is the most likely cause of the chronically empty hands
// this demo keeps measuring (dev deck 25 untouched after 1,562 ops).
const firstGhost = (list) => list[Math.floor(Math.random() * list.length)];
const centerGhost = (list) => {
  // deterministic: the hex ghost nearest the viewport centre
  let best = list[0];
  let bd = Infinity;
  for (const t of list) {
    const d = (t.x - W / 2) ** 2 + (t.y - H / 2) ** 2;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// the seven window: real DiscardModal
// ---------------------------------------------------------------------------

async function doDiscard(s) {
  const page = pageOf(s);
  await shot("03-discard-modal", s);
  discardShot = true;
  const first = await read(page);
  log(`seat ${s} DISCARD modal open: ${first.modalTitle ?? "?"} (seq ${first.seq})`);
  let guard = 0;
  for (;;) {
    const snap = await read(page);
    if (!snap.modal) {
      // Discriminator vs the throw theory: the modal DOM unmounted between
      // step's read (which called us) and this one. A React remount flicker
      // would live here — log it (dedup keeps the flood sane).
      log(`seat ${s} modal VANISHED between reads (guard ${guard})`);
      return { ok: true, note: "modal closed" };
    }
    const chips = await page.evaluate(CHIPS);
    if (snap.submitDisabled === false) {
      const before = snap.seq;
      await page.click("#discard-submit", { timeout: 4000 });
      const after = await waitSeqAbove(page, before);
      log(`seat ${s} discard submitted -> seq ${before}->${after}`);
      return { ok: after > before, note: "submit" };
    }
    const usable = chips.filter((c) => !c.disabled && c.count > 0);
    if (usable.length === 0 || guard++ > 24) {
      log(`seat ${s} DISCARD STUCK chips=${JSON.stringify(chips)} submitDisabled=${snap.submitDisabled}`);
      return { ok: false, note: "stuck" };
    }
    // greedy: highest remaining count first (self-correcting — a disabled
    // chip means that resource is exhausted in the hand).
    usable.sort((a, b) => b.count - a.count);
    const r = usable[0].resource;
    const idx = await page.evaluate(
      (res) =>
        [...document.querySelectorAll("#discard-modal .chip-btn")].findIndex((b) =>
          ((b.textContent || "").split("·")[1] ?? "")
            .replace(/\s*\d+\s*$/, "")
            .trim() === res,
        ),
      r,
    );
    if (idx < 0) {
      log(`seat ${s} DISCARD chip '${r}' not found in ${JSON.stringify(chips.map((c) => c.raw))}`);
      return { ok: false, note: "chip index" };
    }
    await page.locator("#discard-modal .chip-btn").nth(idx).click({ timeout: 4000 });
    await page.waitForTimeout(40);
  }
}

// ---------------------------------------------------------------------------
// domestic trade helpers (runs #10-#12)
// ---------------------------------------------------------------------------

/**
 * Off-turn: answer a pending domestic offer addressed to this seat.
 *
 * WHY THE PAYABILITY CHECK IS THE WHOLE POINT: the kernel ships `tradeAccept`
 * unconditionally to the offeree (turn.ts:1446-1451), so accepting an offer
 * you cannot pay is a REJECTION — and AC2 demands zero rejections. The offer
 * is public (#hud-trade, from redact.ts's unredacted pendingTrade) and our
 * own hand is on #rail-chips, so this is exactly what a human at the table
 * can see. If we cannot pay, we press "Reject trade" — which the kernel
 * enumerates as the paired legal move (turn.ts:1449), so declining is a legal
 * op, never an illegal one.
 *
 * The regex the previous version used (`gives ... wants ...` against the whole
 * HUD text) matched the FIRST thing it saw and could pick up the offeror's
 * name; it also never checked that the OFFEROR could still cover its side,
 * which applyTradeAccept re-checks (turn.ts:1086). This reads #hud-trade only
 * and splits on the arrow.
 */
async function maybeAcceptTrade(s) {
  const page = pageOf(s);
  const info = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("#moves-list li button")].find(
      (b) => (b.textContent || "").includes("Accept trade"),
    );
    // #hud-trade renders pendingTradeView.summary:
    //   "<offeror name> gives wood, wood → wants ore"  (hudLogic.ts:184)
    const t = document.querySelector("#hud-trade");
    const raw = t === null ? "" : (t.textContent || "");
    const m = /gives\\s+([a-z, ]+?)\\s*→\\s*wants\\s+([a-z, ]+?)(?:\\s|$|—)/.exec(raw);
    const hand = {};
    for (const c of document.querySelectorAll("#rail-chips .chip")) {
      hand[c.getAttribute("data-resource")] = Number(c.getAttribute("data-count") || "0");
    }
    return {
      has: btn !== undefined,
      raw: raw.trim(),
      give: m === null ? null : m[1].split(",").map((x) => x.trim()).filter(Boolean),
      want: m === null ? null : m[2].split(",").map((x) => x.trim()).filter(Boolean),
      hand,
    };
  })()`);
  if (info.has !== true || info.want === null || info.want.length === 0) return false;

  // Can WE pay every card the offer wants?
  const need = {};
  for (const r of info.want) need[r] = (need[r] ?? 0) + 1;
  const canPay = Object.keys(need).every((r) => (info.hand[r] ?? 0) >= need[r]);

  if (!canPay) {
    // Decline politely — the offeror is waiting on an answer either way, and
    // leaving the offer pending would wedge ITS turn (endTurn is the only
    // other way a pending offer clears, turn.ts:905-908).
    const idx = await page.evaluate(
      `(() => [...document.querySelectorAll("#moves-list li button")].findIndex((b) =>
        (b.textContent || "").includes("Reject trade")))()`,
    );
    if (idx >= 0) {
      const before = await seqOf(page);
      await page.locator("#moves-list li button").nth(idx).click({ timeout: 4000 });
      const after = await waitSeqAbove(page, before);
      if (after > before) {
        seats[s].ops++;
        log(`s${s} reject trade (cannot pay ${info.want.join("+")}) -> seq ${after}`);
        return true;
      }
    }
    return false;
  }
  const before = await seqOf(page);
  await page
    .locator("#moves-list li button")
    .filter({ hasText: "Accept trade" })
    .first()
    .click({ timeout: 4000 });
  const after = await waitSeqAbove(page, before);
  if (after > before) {
    seats[s].ops++;
    accepts++;
    log(`s${s} ACCEPT trade (paid ${info.want.join("+")}) -> seq ${after}`);
    return true;
  }
  return false;
}

/**
 * On-turn: compose and send ONE domestic offer through #trade-panel —
 * give `give` (one card) for `want` (one card) with seat `partner`.
 *
 * The kernel ships no tradeOffer (UI-composed by design, turn.ts:1400-1404),
 * so this is the only way to exercise that surface; whatever we send, the
 * server judges. 2-for-1 generosity is NOT expressible here: TradePanel
 * composes exactly one give and one want (tradeFormToOp, hudLogic.ts:294),
 * so "give 2, want 1" would require editing app source — out of bounds.
 */
async function offerTrade(s, give, want, partner) {
  const page = pageOf(s);
  try {
    await page.click("#trade-panel button:has-text('Opponent')", { timeout: 3000 });
    // The selects are CONTROLLED and reconcile against the live option space
    // (TradePanel I-5), so a stale choice can never stick — but a select that
    // lacks the option throws, which the catch below treats as "not now".
    await page.selectOption("#trade-with", { value: String(partner) }, { timeout: 3000 });
    await page.selectOption("#trade-give", { value: give }, { timeout: 3000 });
    await page.selectOption("#trade-want", { value: want }, { timeout: 3000 });
    const btn = page.locator("#trade-submit");
    if (await btn.isDisabled()) return false;
    const before = await seqOf(page);
    await btn.click({ timeout: 4000 });
    const after = await waitSeqAbove(page, before);
    if (after > before) {
      seats[s].ops++;
      offers++;
      log(`s${s} OFFER ${give}->${want} to s${partner} -> seq ${after}`);
      return true;
    }
  } catch {
    return false; // panel not offering right now — not an error, just not legal
  }
  return false;
}

// ---------------------------------------------------------------------------
// one seat's move
// ---------------------------------------------------------------------------

async function step(s) {
  const page = pageOf(s);
  const snap = await read(page);
  await harvestTicker(s, snap);

  if (snap.phase === "ended" || snap.victory !== null) return "ended";
  if (snap.modal) return (await doDiscard(s)).ok ? "discard" : "discard-stuck";

  if (snap.moves.length === 0) return "idle"; // not this seat's obligation

  const has = (l) => snap.moves.some((m) => m.label === l && !m.disabled);

  // 1. setup placements go through the CANVAS (the plan's 3D-path proof).
  if (snap.phase === "setup") {
    const g = await clickGhost(page, null, firstGhost);
    if (g !== null && g.ok) {
      seats[s].ops++;
      log(`s${s} ghost ${g.kind} ${g.id} -> seq ${g.seq}`);
      return "ghost";
    }
    const d = await clickMoveByLabel(page, ["Place settlement (setup)", "Place road (setup)"]);
    if (d !== null && d.ok) {
      seats[s].ops++;
      log(`s${s} ${d.label} ${d.detail} -> seq ${d.seq}`);
      return "setup-dom";
    }
    return "setup-noclick";
  }

  if (snap.phase === "play" && !midgameShot) {
    await shot("02-midgame", s);
    midgameShot = true;
  }

  // 2a. ANSWER A PENDING DOMESTIC OFFER — off-turn, so it comes BEFORE the
  // build ladder. When a pending offer is addressed to this seat, legalMoves
  // is exactly [tradeAccept, tradeReject] (turn.ts:1446-1451), so nothing
  // below this line can be reached anyway.
  if (has("Accept trade") || has("Reject trade")) {
    if (await maybeAcceptTrade(s)) return "answerTrade";
  }

  // 2. the greedy build ladder (DOM buttons, opLabel text).
  //
  // ORDER IS THE GOLDEN-BOT PRIORITY, VERBATIM (goldenReplay.ts:54-73 — the
  // priority that reaches 10 VP in all six fixed games, verified again today
  // at ~690 ops/game): `roll` comes BEFORE every build and every trade. That
  // is not cosmetic, and run #6 proved it the hard way: with trades ranked
  // above roll, a hand holding 4+ cards always has a legal 4:1, so the driver
  // traded every turn and NEVER rolled — no production at all, each 4:1
  // burning 3 cards from a closed 95-card economy. Result: seq 1103 in 24.4
  // min vs run #5's 7360 in 15. Catan's turn is production-then-action.
  //
  // A CITY is 2 VP and a dev card is a shot at 2 VP (largest army) or a
  // victory-point card, so both are bought the moment the server ships them —
  // a dev deck still 25 cards deep after 1,562 ops was a POLICY bug here,
  // not a rules one.
  //
  // Trades are still server-SHIPPED legalMoves clicked as ordinary
  // #moves-list buttons (the kernel alone decides legality); the demo stays
  // all-clicks. RUN5-STARVATION.md has the full diagnosis.
  const ladder = [
    ["Claim victory"],
    ["Roll dice"],
    ["Upgrade to city"],
    ["Build settlement"],
    ["Build road"],
    ["Buy development card"],
    ["Play knight"],
    ["Play monopoly"],
    ["Play road building"],
    ["Play year of plenty"],
  ];
  for (const label of ladder) {
    if (!has(label[0])) continue;
    const r = await clickMoveByLabel(page, label);
    if (r !== null && r.ok) {
      seats[s].ops++;
      log(`s${s} ${r.label} ${r.detail} -> seq ${r.seq}`);
      return r.label;
    }
  }

  // The build target this seat is working toward — the FIRST one in ladder
  // order it cannot convert right now (run #8's lesson: gating on "already
  // affordable" is a catch-22, because step 2 builds everything affordable).
  const HAND = snap.hand ?? {};
  const n = (r) => HAND[r] ?? 0;
  const BUILD_TARGETS = [
    { label: "Upgrade to city", cost: { wheat: 2, ore: 3 } },
    { label: "Build settlement", cost: { wood: 1, brick: 1, wheat: 1, wool: 1 } },
    { label: "Build road", cost: { wood: 1, brick: 1 } },
    { label: "Buy development card", cost: { ore: 1, wool: 1, wheat: 1 } },
  ];
  const affordable = (t) => Object.keys(t.cost).every((r) => n(r) >= t.cost[r]);
  const target =
    BUILD_TARGETS.find((t) => !affordable(t) || !has(t.label)) ?? BUILD_TARGETS[0];

  // 2b. NEEDS-DRIVEN MARITIME TRADE (run #8). A greedy "click the first
  // shipped 4:1" ping-pongs wood<->brick forever — run #7 did exactly that
  // (228 trades, 151 of them wood->brick, ZERO settlements/cities/dev cards)
  // because every 4:1 BURNS THREE CARDS from a closed 95-card economy. So
  // take ONLY a trade that (a) hands us a card the current target still lacks
  // and (b) is paid with a card we hold four MORE of than the target needs.
  // Otherwise hoard — the next roll is free, a 4:1 is not.
  //
  // The op is still a SERVER-SHIPPED legalMove clicked as an ordinary
  // #moves-list button — the kernel decides legality, we only choose WHICH
  // shipped button to press.
  {
    const wants = Object.keys(target.cost).filter((r) => n(r) < target.cost[r]);
    // Ports ship as "Trade via port" with detail = the port VERTEX, not the
    // give/get pair, so match those by label alone (still needs-shaped where
    // the detail is legible).
    const cands = [];
    snap.moves.forEach((mv, i) => {
      if (mv.disabled) return;
      if (mv.label !== "Trade with bank" && mv.label !== "Trade via port") return;
      const d = mv.detail ?? "";
      const m = /give (\w+) → get (\w+)/.exec(d);
      if (m === null) return;
      const [give, get] = [m[1], m[2]];
      if (!wants.includes(get)) return;
      if (n(give) - (target.cost[give] ?? 0) < 4) return;
      cands.push({ i, give, get });
    });
    if (cands.length > 0) {
      const c = cands[Math.floor(Math.random() * cands.length)];
      const before = snap.seq;
      await page.locator("#moves-list li button").nth(c.i).click({ timeout: 4000 });
      const after = await waitSeqAbove(page, before);
      if (after > before) {
        seats[s].ops++;
        log(`s${s} trade ${c.give}->${c.get} (for ${target.label}) -> seq ${after}`);
        return "trade-needs";
      }
    }
    // No useful trade: FALL THROUGH to the domestic/robber/endTurn policy.
    // (Run #8 ended the turn here instead — 199 rolls / 199 endTurns and no
    // builds at all, because "I can't profitably trade" is not "I am done".)
  }

  // 2c. DOMESTIC OFFER — one per turn, never a repeat of a declined pair.
  //
  // Run #11 is why this block is written the way it is: it sent the identical
  // ore->wood offer 1,244 times, got 1,244 declines, and died at seq 2,569
  // with zero builds. Three guards, all learned the hard way:
  //   (a) ONE offer per turn, keyed on the HUD `rolls` counter (constant
  //       through a turn, unlike serverSeq, which changes on every op — the
  //       bug that let run #10 re-offer 459 times inside one turn);
  //   (b) a declined (partner, give, want) triple is remembered FOREVER and
  //       never re-sent;
  //   (c) after 5 consecutive declines the seat goes quiet for 10 rolls, so a
  //       table with nothing to trade stops spending its whole op budget on
  //       diplomacy. (The golden bot wins with ZERO domestic offers — this
  //       surface is driven for coverage, not because the win needs it.)
  //
  // Either way the offeror PROGRESSES: this block returns on a successful
  // send, and the next visit in the same turn falls straight through to the
  // robber/endTurn policy, so an offer can never wedge the turn loop.
  {
    const st = seats[s];
    // Resolve the previous offer: an ACCEPT raises our count of `want`; a
    // decline leaves the hand alone. (Both are visible on #rail-chips.)
    if (st.lastOffer !== null) {
      const p = st.lastOffer;
      if (n(p.want) > p.handWant) {
        st.declineRun = 0;
        log(`s${s} offer ${p.give}->${p.want} to s${p.partner} was ACCEPTED`);
      } else {
        st.refused.add(`${p.partner}|${p.give}|${p.want}`);
        st.declineRun++;
        st.coolUntil = snap.rolls + DECLINE_COOLDOWN_ROLLS;
        log(
          `s${s} offer ${p.give}->${p.want} to s${p.partner} DECLINED (run ${st.declineRun}); pair blacklisted`,
        );
      }
      st.lastOffer = null;
    }
    if (
      snap.yours &&
      snap.rolls >= 0 &&
      st.offerTurn !== snap.rolls &&
      st.declineRun < DECLINE_COOLDOWN_TRIGGER &&
      snap.rolls >= st.coolUntil
    ) {
      const wants = Object.keys(target.cost).filter((r) => n(r) < target.cost[r]);
      // A real surplus: two MORE than the target needs.
      const surplus = Object.keys(HAND)
        .filter((r) => n(r) - (target.cost[r] ?? 0) >= 2)
        .sort((a, b) => n(b) - (target.cost[b] ?? 0) - (n(a) - (target.cost[a] ?? 0)));
      outer: for (const partner of [0, 1, 2]) {
        if (partner === s) continue;
        for (const want of wants) {
          for (const give of surplus) {
            if (give === want) continue;
            if (st.refused.has(`${partner}|${give}|${want}`)) continue;
            const ok = await offerTrade(s, give, want, partner);
            if (ok) {
              st.offerTurn = snap.rolls;
              st.lastOffer = { give, want, partner, handWant: n(want) };
              return "offerTrade";
            }
            break outer; // the panel refused this send — stop trying for now
          }
        }
      }
    }
  }

  // 3. the robber: a HEX GHOST on the island (plan: click centre).
  {
    const t = await page.evaluate(TARGETS);
    if (t.some((x) => x.kind === "hex")) {
      if (!robberShot) {
        await shot("04-robber", s);
        robberShot = true;
      }
      const g = await clickGhost(page, "hex", centerGhost);
      if (g !== null && g.ok) {
        seats[s].ops++;
        log(`s${s} robber ghost ${g.id} -> seq ${g.seq}`);
        return "moveRobber";
      }
    }
  }
  if (has("Move robber")) {
    const r = await clickMoveByLabel(page, ["Move robber"]);
    if (r !== null && r.ok) {
      seats[s].ops++;
      log(`s${s} ${r.label} ${r.detail} -> seq ${r.seq}`);
      return "moveRobber-dom";
    }
  }

  // 4. steal: the victim is a DOM option; take the first shipped one.
  if (has("Steal a card")) {
    const r = await clickMoveByLabel(page, ["Steal a card"]);
    if (r !== null && r.ok) {
      seats[s].ops++;
      log(`s${s} ${r.label} ${r.detail} -> seq ${r.seq}`);
      return "stealCard";
    }
  }

  // 5. fallback — endTurn always ships, so the turn can never wedge.
  if (has("End turn")) {
    const r = await clickMoveByLabel(page, ["End turn"]);
    if (r !== null && r.ok) {
      seats[s].ops++;
      log(`s${s} endTurn -> seq ${r.seq}`);
      return "endTurn";
    }
  }

  return "no-move";
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

log("all three seats joined; waiting for setup ghosts");
for (let i = 0; i < 60 && !shots["01-setup-ghosts"]; i++) {
  const t = await pageOf(0).evaluate(TARGETS);
  if (t.length > 0) {
    await shot("01-setup-ghosts", 0);
    log(`setup ghosts live: ${t.length} (first ${t[0].kind} ${t[0].id})`);
  } else await pageOf(0).waitForTimeout(500);
}

let lastSeq = -1;
let lastProgress = Date.now();
let ended = false;
let stallDump = null;
let stuckReason = null;

const modalOpen = async () => {
  for (const s of [0, 1, 2]) {
    const m = await pageOf(s)
      .evaluate(`document.querySelector("#discard-modal") !== null`)
      .catch(() => false);
    if (m) return true;
  }
  return false;
};

while (Date.now() - t0 < BUDGET_MS) {
  for (const s of [0, 1, 2]) {
    let r;
    try {
      r = await step(s);
    } catch (e) {
      // An unlogged throw is how run #1 hid its own cause for 87k lines:
      // doDiscard entry-logged, then something between it and the next log
      // threw, and this value was dropped on the floor.
      const snap = await read(pageOf(s)).catch(() => null);
      r = `throw: ${String(e && e.message ? e.message : e)}`;
      log(
        `seat ${s} ${r} | modal=${snap ? snap.modal : "?"} submitDisabled=${
          snap ? snap.submitDisabled : "?"
        } seq=${snap ? snap.seq : "?"}`,
      );
    }
    if (r === "ended") {
      ended = true;
      break;
    }
    if (r === "discard-stuck") {
      stuckReason = `seat ${s} discard modal unresolvable (see log)`;
      break;
    }
  }
  await harvestAll();

  const seqs = [];
  for (const s of [0, 1, 2]) seqs.push(await seqOf(pageOf(s)).catch(() => -1));
  const maxSeq = Math.max(...seqs);
  // Progress = serverSeq advanced anywhere. A MODAL that never closes is NOT
  // progress: it is exactly the failure the watchdog exists to catch (the
  // P2(b1) discard drive died to a modal-shaped stall).
  if (maxSeq > lastSeq) {
    lastSeq = Math.max(lastSeq, maxSeq);
    lastProgress = Date.now();
  }
  if (ended || stuckReason !== null) break;
  const stalledFor = Date.now() - lastProgress;
  if (stalledFor > STALL_MS) {
    stallDump = [];
    for (const s of [0, 1, 2]) {
      const snap = await read(pageOf(s)).catch(() => null);
      stallDump.push(`--- seat ${s} ---\n${snap === null ? "unreadable" : snap.statusText}`);
    }
    log(
      `WATCHDOG: serverSeq stalled ${(stalledFor / 1000).toFixed(0)}s at ${lastSeq} (modal open: ${await modalOpen()})`,
    );
    for (const d of stallDump) log(d.replace(/\n/g, " | "));
    break;
  }
}
if (stuckReason !== null) log(`HONEST FAIL: ${stuckReason}`);

// ---------------------------------------------------------------------------
// victory + rematch
// ---------------------------------------------------------------------------

await harvestAll();
let banner = null;
let bannerSeat = null;
for (const s of [0, 1, 2]) {
  const snap = await read(pageOf(s));
  if (snap.victory !== null && snap.victory !== "") {
    banner = snap;
    bannerSeat = s;
    break;
  }
}

let rematchClicked = false;
let seqAtVictory = -1;
let postRematch = null;

if (banner === null) {
  log("NO VICTORY BANNER — honest fail");
} else {
  seqAtVictory = Math.max(
    ...(await Promise.all([0, 1, 2].map((s) => seqOf(pageOf(s)).catch(() => -1)))),
  );
  await shot("05-victory", bannerSeat);
  log(`VICTORY (seat ${bannerSeat}): ${banner.victory} | ${banner.victoryWinner} | ${banner.victorySub}`);
  const s0 = pageOf(0);
  const btn = s0.locator("#victory-rematch");
  if ((await btn.count()) > 0) {
    rematchClicked = await btn
      .click({ timeout: 5000 })
      .then(() => true)
      .catch((e) => {
        log(`rematch click failed: ${String(e)}`);
        return false;
      });
    log(`rematch clicked: ${rematchClicked}`);
    // Wait for a fresh setup projection on EVERY tab (condition wait, not sleep).
    let ok = false;
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      // Rematch is NOT an op, so by design it does NOT move serverSeq
      // (P3(b): "serverSeq does NOT reset on a rematch" is a pinned test, and
      // the refusal path must leave it frozen too). The plan's AC wording
      // ("seq jumped") was written before that ruling and is wrong — run #12
      // had all three tabs at phase=setup with the banner gone and still
      // "failed" on this one clause. The fresh-game proof is
      // phase=setup + no banner + a NEW setup board, not a seq delta.
      const snapsNow = await Promise.all([0, 1, 2].map((s) => read(pageOf(s))));
      ok =
        snapsNow.every((x) => x.phase === "setup") &&
        snapsNow.every((x) => x.victory === null) &&
        snapsNow.every((x) => x.seq === seqAtVictory); // unchanged, not bumped
      if (ok) {
        postRematch = snapsNow;
        break;
      }
      await s0.waitForTimeout(250);
    }
    if (ok) {
      await shot("06-rematch-fresh", 0);
      log(`rematch ok: all tabs phase=setup, banner gone, seq ${seqAtVictory} -> ${postRematch[0].seq}`);
    } else {
      const snaps = await Promise.all([0, 1, 2].map((s) => read(pageOf(s))));
      log(`rematch NOT confirmed: ${JSON.stringify(snaps.map((x) => ({ p: x.phase, v: x.victory, q: x.seq })))}`);
      await shot("06-rematch-fresh", 0);
    }
  } else {
    log("no #victory-rematch button on seat 0");
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const mins = ((Date.now() - t0) / 60_000).toFixed(1);
const finalSeqs = await Promise.all([0, 1, 2].map((s) => seqOf(pageOf(s)).catch(() => -1)));
const opsTotal = seats.reduce((a, s) => a + s.ops, 0);

log("=== GAME STATISTICS ===");
log(`elapsed ${mins} min · final serverSeq per tab ${JSON.stringify(finalSeqs)}`);
log(`ops applied per seat: ${seats.map((s) => `s${s.seat}=${s.ops}`).join(" ")} · total ${opsTotal}`);
log(`REJECTED events: ${rejected}${rejectedRows.length ? ` (${rejectedRows.join(" | ")})` : ""}`);
log(`domestic trade: ${offers} offers · ${accepts} accepts · ${rejected} rejections`);
log(
  `blacklisted pairs per seat: ${seats.map((x) => `s${x.seat}=${x.refused.size}`).join(" ")} · decline runs ${seats.map((x) => `s${x.seat}=${x.declineRun}`).join(" ")}`,
);
log(`discard modal seen: ${discardShot} · robber ghost shot: ${robberShot}`);
log(`pageerrors/console errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 5).join(" | ")}` : ""}`);
if (banner !== null) log(`WINNER: ${banner.victory} | ${banner.victoryWinner}`);
log(`rematch clicked: ${rematchClicked} · fresh setup on all tabs: ${postRematch !== null}`);
if (stallDump !== null) for (const d of stallDump) log(`STALLDUMP ${d.replace(/\n/g, " | ")}`);

const realWinner = banner !== null && /wins/.test(banner.victory) && /\d+/.test(banner.victory);
const pass =
  realWinner &&
  rematchClicked &&
  postRematch !== null &&
  rejected === 0 &&
  errors.length === 0 &&
  opsTotal > 20 &&
  discardShot;

console.log("---");
console.log(`winner: ${banner === null ? "NONE" : banner.victory}`);
console.log(`ops: ${seats.map((s) => `s${s.seat}=${s.ops}`).join(" ")} total=${opsTotal}`);
console.log(`rejections: ${rejected} · pageerrors: ${errors.length}`);
console.log(`elapsed: ${mins} min · seqs ${JSON.stringify(finalSeqs)}`);
console.log(`rematch clicked: ${rematchClicked} · fresh setup: ${postRematch !== null}`);
console.log(`evidence: ${OUT}`);
console.log(pass ? "PASS" : "FAIL");

await browser.close();
process.exit(pass ? 0 : 2);
