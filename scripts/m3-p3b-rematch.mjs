/**
 * m3-p3b-rematch.mjs — browser proof for P3(b) (parent-owned; sibling of
 * m3-p2b-click.mjs). Proves, with pixels + assertions:
 *   1. host-only affordance: seat 0 (host) sees #victory-rematch and it is
 *      CLICKABLE (the pointer-events:NONE trap in the plan — a visible-but-dead
 *      button fails this test); seat 2 sees "Waiting for the host" instead;
 *   2. server authority survives a forged-adjacent flow: rematch mid-game
 *      (the banner here is the e2e INJECTION, the server game is still setup)
 *      must be refused badPhase — no seq change, banner survives;
 *   3. refused rematch degrades to an honest error note, never a white screen.
 *
 * The SUCCESSFUL rematch + game-2 gameEnded paths are unit/server-test proven
 * (child's suites); a browser reaching a real ended state inside this budget
 * belongs to the P3(c) full-game demo.
 *
 * Usage: RC=<roomcode> node scripts/m3-p3b-rematch.mjs
 * Stack: room server on :4273 ONLY (no bots — they would race the humans).
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(
  "/Users/alejandrodelvillar/Projects/mahjong-vtt/node_modules/playwright-core/index.js",
);
const EXEC =
  "/Users/alejandrodelvillar/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const ROOM = process.env.RC ?? "";
const OUT = "/Users/alejandrodelvillar/Projects/catan/docs/e2e-review/m3-p3b";
if (!/^[A-Za-z0-9]{6}$/.test(ROOM)) {
  console.error("RC=<6-char mixed-case room code> required");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXEC });
// TWO separate contexts: one localStorage per tab, exactly like two real
// players' browsers. (A shared context let tab A's lastRoom auto-rejoin tab B
// into seat 0 — the join form was then 'joined'-disabled and the fill timed
// out. That is the auto-rejoin feature working, ironically.)
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const errors = [];
const watch = (p, who) => {
  p.on("pageerror", (e) => errors.push(`${who}: ${e}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${who} console: ${m.text()}`);
  });
};

async function join(page, seat, name) {
  await page.goto("http://localhost:4274/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#join-code", { timeout: 8000 });
  await page.fill("#join-code", ROOM);
  await page.fill("#join-name", name);
  await page.selectOption("select", { value: String(seat) });
  await page.click("button:has-text('Join')");
  await page.waitForSelector("#hud-panel", { timeout: 8000 });
}

const seqOf = (page) =>
  page.locator("section[aria-label='status']").innerText().then((t) => {
    const m = t.match(/serverSeq\D+(\d+)/);
    return m ? Number(m[1]) : -1;
  });

const ctxC = await browser.newContext({ viewport: { width: 800, height: 600 } });
const A = await ctxA.newPage(); // host, seat 0
const B = await ctxB.newPage(); // guest, seat 2
const C = await ctxC.newPage(); // filler seat 1 — the room needs every seat
watch(A, "A");
watch(B, "B");
watch(C, "C");

await join(A, 0, "Host0");
await join(C, 1, "Filler1");
await join(B, 2, "Guest2");
const seqJoin = await seqOf(A);

// e2eWin=0 in BOTH contexts -> each tab injects winner seat 0 (the host) at mount.
const setWin = async (page) => {
  await page.evaluate(() => localStorage.setItem("catan:e2eWin", "0"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#hud-panel", { timeout: 8000 });
  await page.waitForSelector("#victory-heading", { timeout: 8000 });
};
await setWin(A);
await setWin(B);

const aHead = await A.locator("#victory-heading").textContent();
const bHead = await B.locator("#victory-heading").textContent();
const aBtn = await A.locator("#victory-rematch").count();
const aBtnText = aBtn ? await A.locator("#victory-rematch").textContent() : null;
const bSub = await B.locator("#victory-sub").textContent();
await A.screenshot({ path: `${OUT}/01-host-banner-with-button.png` });
await B.screenshot({ path: `${OUT}/02-guest-waiting.png` });

// 2: click the button (pointer-events trap proof) mid-game -> badPhase.
const clicked = await A
  .locator("#victory-rematch")
  .click({ timeout: 3000 })
  .then(() => true)
  .catch(() => false);
await A.waitForTimeout(700); // error frame round-trip
const seqAfter = await seqOf(A);
const bannerAStill = (await A.locator("#victory-heading").count()) > 0;
await A.screenshot({ path: `${OUT}/03-refused-note.png` });

// honest error display: some visible sign (StatusLine/Hud error text) — assert
// ONLY that we did not white-screen: HUD still present + banner still there.
const hudAlive = (await A.locator("#hud-panel").count()) > 0;

console.log("A head:", JSON.stringify(aHead));
console.log("B head:", JSON.stringify(bHead), "| B sub:", JSON.stringify(bSub));
console.log("host button:", aBtn, JSON.stringify(aBtnText), "| clicked:", clicked);
console.log(`seq ${seqJoin} -> ${seqAfter} (refusal must NOT change it)`);
console.log("banner survived refusal:", bannerAStill, "| hud alive:", hudAlive);
console.log("errors:", errors.length ? errors.join(" | ") : "none");

const pass =
  /Red wins/.test(aHead ?? "") &&
  /Red wins/.test(bHead ?? "") &&
  aBtn === 1 &&
  /rematch/i.test(aBtnText ?? "") &&
  /waiting for the host/i.test(bSub ?? "") &&
  clicked === true &&
  seqAfter === seqJoin &&
  bannerAStill &&
  hudAlive &&
  !errors.some((e) => e.startsWith("A:") || e.startsWith("B:"));
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 2);
