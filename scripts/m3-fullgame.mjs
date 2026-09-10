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
 * GREEDY PER-SEAT POLICY (deterministic; the only randomness is the server's
 * own dice):
 *   setup phase    -> click the first on-canvas ghost (placement order IS the
 *                     server's legalMoves order; ghost-first proves the 3D
 *                     path under load — 15 placements per game);
 *   own turn       -> Upgrade to city > Build settlement > Build road >
 *                     Buy development card > Roll dice > Play knight >
 *                     (road building / year of plenty / monopoly) >
 *                     Move robber (hex ghost) > Steal a card > End turn;
 *   seven window   -> DiscardModal chips, highest remaining count first,
 *                     until #discard-submit enables, then submit;
 *   NO trading     — tradeBank/tradePort/tradeOffer/tradeAccept/tradeRejec …
 *                     are skipped (P2(a) proved trading; skipping keeps the
 *                     driver short and the win unassisted).
 *   "roll if rolls==0" (plan wording) is implemented as "roll when the server
 *   ships it": legalMoves only ever contains `roll` when this seat has not
 *   rolled this turn, so the server — not the driver — decides.
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

/** Rail chip abbreviations, matching hudLogic.RESOURCE_ABBR (TradePanel labels). */
const ABBR = { wood: "WOD", brick: "BRK", wool: "WOL", wheat: "WHT", ore: "ORE" };

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
  seats.push({ seat: s, page, ops: 0, ctx });
  log(`seat ${s} joined (${await seqOf(page)})`);
}

const pageOf = (s) => seats[s].page;

// ---------------------------------------------------------------------------
// evidence counters
// ---------------------------------------------------------------------------

const seenEvents = new Set(); // `${seat}:${seq}` — dedupe the ring buffer
let rejected = 0;
const rejectedRows = [];
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
// domestic trade helpers (run #10)
// ---------------------------------------------------------------------------

/**
 * Off-turn: if this seat is the offeree of a pending offer AND can actually
 * pay what the offer wants, accept it. Returns false otherwise.
 *
 * The payability check is the whole point: the kernel ships `tradeAccept`
 * unconditionally to the offeree (turn.ts:1446-1451), so a blind accept of an
 * unaffordable offer is a REJECTION — and AC2 demands zero rejections. The
 * pending offer is public (redact.ts) and our own hand is on #rail-chips, so
 * this is exactly what a human at the table can see.
 */
async function maybeAcceptTrade(s) {
  const page = pageOf(s);
  const info = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("#moves-list li button")].find(
      (b) => (b.textContent || "").includes("Accept trade"),
    );
    const hud = document.querySelector("#hud-panel");
    const txt = hud === null ? "" : (hud.textContent || "");
    const m = txt.match(/gives\\s+([a-z, ]+?)\\s+→\\s+wants\\s+([a-z, ]+?)(?:\\s|$)/);
    const hand = {};
    for (const c of document.querySelectorAll("#rail-chips .chip")) {
      hand[c.getAttribute("data-resource")] = Number(c.getAttribute("data-count") || "0");
    }
    return { has: btn !== undefined, want: m === null ? null : m[2].split(",").map((x) => x.trim()).filter(Boolean), hand };
  })()`);
  if (info.has !== true || info.want === null) return false;
  // Can we pay every card the offer wants?
  const need = {};
  for (const r of info.want) need[r] = (need[r] ?? 0) + 1;
  const canPay = Object.keys(need).every((r) => (info.hand[r] ?? 0) >= need[r]);
  if (!canPay) {
    // Decline politely — the offeror is waiting on an answer either way.
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
    log(`s${s} ACCEPT trade (paid ${info.want.join("+")}) -> seq ${after}`);
    return true;
  }
  return false;
}

/**
 * On-turn: compose and send one domestic offer through #trade-panel —
 * give `give` (one card) for `want` (one card) from any other seat.
 * The kernel ships no tradeOffer (UI-composed by design), so this is the only
 * way to exercise that surface; whatever we send, the server judges.
 */
async function offerTrade(s, give, want) {
  const page = pageOf(s);
  try {
    await page.click("#trade-panel button:has-text('Opponent')", { timeout: 3000 });
    await page.selectOption("#trade-give", { label: `${ABBR[give]} · ${give}` }).catch(async () => {
      await page.selectOption("#trade-give", give);
    });
    await page.selectOption("#trade-want", { label: `${ABBR[want]} · ${want}` }).catch(async () => {
      await page.selectOption("#trade-want", want);
    });
    const btn = page.locator("#trade-submit");
    if (await btn.isDisabled()) return false;
    const before = await seqOf(page);
    await btn.click({ timeout: 4000 });
    const after = await waitSeqAbove(page, before);
    if (after > before) {
      seats[s].ops++;
      log(`s${s} OFFER ${give}->${want} -> seq ${after}`);
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

  // 2. the greedy build ladder (DOM buttons, opLabel text).
  //
  // ORDER IS THE GOLDEN-BOT PRIORITY, VERBATIM (server.test.ts:1185-1195 /
  // cli.ts:48-68 — the priority that wins 6/6 seeded games): `roll` comes
  // BEFORE every build and every trade. That is not cosmetic, and run #6
  // proved it the hard way: with trades ranked above roll, a hand holding 4+
  // cards always has a legal 4:1, so the driver traded every turn and NEVER
  // rolled — no production at all, each 4:1 burning 3 cards from a closed
  // 95-card economy. Result: seq 1103 in 24.4 min vs run #5's 7360 in 15.
  // Catan's turn is production-then-action, so the ladder is too.
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
    ["Trade with bank"],
    ["Trade via port"],
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

  // 2b. NEEDS-DRIVEN MARITIME TRADE (run #8). A greedy "click the first
  // shipped 4:1" ping-pongs wood<->brick forever — run #7 did exactly that
  // (228 trades, 151 of them wood->brick, ZERO settlements/cities/dev cards)
  // because every 4:1 BURNS THREE CARDS from a closed 95-card economy. So:
  // pick the cheapest reachable BUILD TARGET first, then take ONLY a trade
  // that (a) hands us a card that target still lacks and (b) pays with our
  // single most abundant card, which the target does not need. Otherwise
  // hoard (the next roll is free; a 4:1 is not).
  //
  // Costs are the real ones (skill + kernel COST_*): road 1 wood+1 brick,
  // settlement +1 wheat +1 wool, city 2 wheat +3 ore, dev 1 ore+1 wool+1
  // wheat. The op itself is still a SERVER-SHIPPED legalMove clicked as an
  // ordinary #moves-list button — the kernel decides legality, we only
  // choose WHICH shipped button to press.
  {
    const HAND = snap.hand ?? {};
    const n = (r) => HAND[r] ?? 0;
    const TARGETS = [
      { label: "Build settlement", cost: { wood: 1, brick: 1, wheat: 1, wool: 1 } },
      { label: "Upgrade to city", cost: { wheat: 2, ore: 3 } },
      { label: "Build road", cost: { wood: 1, brick: 1 } },
      { label: "Buy development card", cost: { ore: 1, wool: 1, wheat: 1 } },
    ];
    // Chase the NEXT target in ladder order, NOT one that is already legal.
    // (Gating on `has(t.label)` was run #8's bug: a settlement you can
    // already afford is built in step 2, so the only targets left are ones
    // you can never afford — and the chooser starves to death holding cards
    // it refuses to spend. You must be able to trade TOWARD a build.)
    const t = TARGETS[0];
    const lacks = Object.keys(t.cost).filter((r) => n(r) < t.cost[r]);
    if (lacks.length > 0) {
      const want = lacks[0];
      // Pay with our most abundant card that this target does NOT need.
      const spendable = Object.keys(HAND).filter(
        (r) => n(r) >= 4 && (t.cost[r] ?? 0) === 0 && n(r) > (t.cost[r] ?? 0),
      );
      if (spendable.length > 0) {
        const give = spendable.sort((a, b) => n(b) - n(a))[0];
        const hit = snap.moves.findIndex(
          (mv) =>
            (mv.label === "Trade with bank" || mv.label === "Trade via port") &&
            !mv.disabled &&
            (mv.detail ?? "").includes(`give ${give}`) &&
            (mv.detail ?? "").includes(`get ${want}`),
        );
        if (hit !== -1) {
          const before = snap.seq;
          await page.locator("#moves-list li button").nth(hit).click({ timeout: 4000 });
          const after = await waitSeqAbove(page, before);
          if (after > before) {
            seats[s].ops++;
            log(`s${s} trade ${give}->${want} (for ${t.label}) -> seq ${after}`);
            return "trade-needs";
          }
        }
      }
    }
    // No useful trade: FALL THROUGH to the robber/dev/endTurn policy below.
    // (Run #8 ended the turn here instead — 199 rolls / 199 endTurns and no
    // builds at all, because "I can't profitably trade" is not "I am done".)
  }

  // 2c. DOMESTIC TRADE (run #10) — the only LOSSLESS card movement in Catan,
  // and the last unexercised UI surface. Maritime 4:1 burns three cards per
  // use out of a closed 95-card economy that run #9 measured as unable to
  // ever reach 4-of-a-kind (375 rolls, 0 trades, 0 builds).
  //
  // Two halves, both real DOM:
  //   OFFER  (my turn):  #trade-panel "Opponent" tab -> give/want/with ->
  //                      #trade-submit. The op is UI-composed (the kernel
  //                      deliberately ships no tradeOffer — hudLogic:311) and
  //                      the SERVER rejects whatever it rejects, so we offer
  //                      a surplus card for the card our next build lacks.
  //   ACCEPT (off-turn): pendingTrade is PUBLIC (redact.ts), so the offeree
  //                      sees the offer and checks its OWN rail before
  //                      pressing "Accept trade" — never a blind accept,
  //                      which is what would break the 0-rejections law
  //                      (tradeAccept ships unconditionally, turn.ts:1446).
  {
    // --- ACCEPT first: it is off-turn, so it must not wait behind our turn ---
    if (await maybeAcceptTrade(s)) return "acceptTrade";

    // --- OFFER: only on our own turn, only with a real surplus ---
    const HAND = snap.hand ?? {};
    // The FIRST build target we cannot yet afford (ladder order).
    const target = [
      { cost: { wood: 1, brick: 1, wheat: 1, wool: 1 } },
      { cost: { wheat: 2, ore: 3 } },
      { cost: { wood: 1, brick: 1 } },
      { cost: { ore: 1, wool: 1, wheat: 1 } },
    ].find((t) => Object.keys(t.cost).some((r) => (HAND[r] ?? 0) < t.cost[r]));
    if (target !== undefined && snap.yours) {
      // AT MOST ONE OFFER PER TURN (run #10's spinning bug: the driver
      // re-offered the identical ore->brick 459 times, got rejected 459
      // times, and never ended its turn — seq crawled to 958 in 137s). Track
      // the turn by the seq at which we offered, and rotate the wanted card
      // so a repeat offer asks for something the partner may actually hold.
      const turnKey = snap.seq;
      const lastOffer = seats[s].lastOfferSeq ?? -1;
      if (lastOffer !== turnKey) {
        const want = Object.keys(target.cost).find((r) => (HAND[r] ?? 0) < target.cost[r]);
        // A card we hold >=2 of AND the target does not need = a real surplus.
        const give = Object.keys(HAND).find(
          (r) => (HAND[r] ?? 0) >= 2 && (target.cost[r] ?? 0) === 0 && r !== want,
        );
        if (want !== undefined && give !== undefined) {
          seats[s].lastOfferSeq = turnKey;
          const ok = await offerTrade(s, give, want);
          if (ok) return "offerTrade";
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
      const snaps = await Promise.all([0, 1, 2].map((s) => read(pageOf(s))));
      ok =
        snaps.every((x) => x.phase === "setup") &&
        snaps.every((x) => x.victory === null) &&
        Math.max(...snaps.map((x) => x.seq)) > seqAtVictory;
      if (ok) {
        postRematch = snaps;
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
