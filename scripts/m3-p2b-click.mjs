/**
 * m3-p2b-click.mjs — browser proof for "click the island" (M3-P2(b1)).
 *
 * What it proves, with pixels:
 *   1. a target ghost exists on the canvas and reports screen coords via the
 *      DEV-only window.__catanTargets() hook;
 *   2. clicking that ghost's screen position advances the server (serverSeq
 *      in section[aria-label='status'] increases);
 *   3. no 'rejected' event appears in the events ticker;
 *   4. orbit still works (drag on empty canvas does not send an op).
 *
 * Not part of the app: run manually against a live stack.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// playwright-core is CJS here — named ESM imports fail, so go through require.
const { chromium } = createRequire(import.meta.url)(
  "/Users/alejandrodelvillar/Projects/mahjong-vtt/node_modules/playwright-core/index.js",
);

const EXEC =
  "/Users/alejandrodelvillar/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const ROOM = process.env.RC ?? "sSvsTu";
const OUT = "/Users/alejandrodelvillar/Projects/catan/docs/e2e-review/m3-p2b";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto("http://localhost:4274/", { waitUntil: "domcontentloaded" });
// Opt in to the screen-space target hook BEFORE joining (see Targets.tsx).
await page.evaluate(() => window.localStorage.setItem("catan:e2eTargets", "1"));
await page.reload({ waitUntil: "domcontentloaded" });
await page.fill("#join-code", ROOM);
await page.selectOption("select", { value: "2" }).catch(async () => {
  // JoinPanel may expose the seat as its own select; fall back to the first
  // select on the page.
  const sels = await page.locator("select").all();
  for (const s of sels) {
    const vals = await s.locator("option").allTextContents();
    if (vals.some((v) => v.includes("2"))) {
      await s.selectOption({ value: "2" }).catch(() => {});
    }
  }
});
await page.click("button.btn-primary");
await page.waitForSelector("#hud-panel", { timeout: 30000 });

const statusText = async () =>
  (await page.locator("section[aria-label='status']").innerText()) ?? "";
const serverSeq = async () => {
  const m = /serverSeq\D*(\d+)/.exec(await statusText());
  return m === null ? -1 : Number(m[1]);
};
const tickerHasRejected = async () => {
  const t = await page.locator("section[aria-label='events']").innerText();
  return /rejected/i.test(t);
};

// Wait until it is seat 2's turn AND at least one target ghost is live.
let targets = [];
for (let i = 0; i < 120; i++) {
  targets = await page.evaluate(() => {
    const fn = window.__catanTargets;
    return typeof fn === "function" ? fn() : [];
  });
  if (targets.length > 0) break;
  await page.waitForTimeout(1000);
}

const seqBefore = await serverSeq();
const turnBefore = await statusText();
await page.screenshot({ path: `${OUT}/01-before-target-click.png` });
console.log("BEFORE seq=", seqBefore, "targets=", targets.length);
console.log("status:", turnBefore.replace(/\n/g, " | "));

if (targets.length === 0) {
  console.log("FAIL: no targets appeared — is it seat 2's turn?");
  await page.screenshot({ path: `${OUT}/01-before-target-click.png` });
  await browser.close();
  process.exit(1);
}

const t0 = targets[0];
console.log("clicking target:", t0.key, t0.kind, t0.id, "at", t0.x, t0.y, JSON.stringify(t0.op));

// Hover first (proves the pointer-cursor + hover path), then click.
await page.mouse.move(t0.x, t0.y);
await page.waitForTimeout(250);
const cursor = await page.evaluate(() => document.body.style.cursor);
console.log("cursor on hover:", cursor);
const cursorHoverOk = cursor === "pointer";
await page.mouse.click(t0.x, t0.y);

let seqAfter = seqBefore;
for (let i = 0; i < 30; i++) {
  seqAfter = await serverSeq();
  if (seqAfter > seqBefore) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-after.png` });

const rejected = await tickerHasRejected();
console.log("AFTER seq=", seqAfter, "rejected=", rejected);
const cursorLeave = await page.evaluate(() => document.body.style.cursor);
console.log("cursor after leave:", cursorLeave);
// After the placement the hovered ghost is REMOVED — the clamp in Targets
// must restore the cursor even though R3F never fires onPointerOut (I-1).
const cursorLeaveOk = cursorLeave !== "pointer";

// Orbit sanity: drag on an empty corner of the canvas must NOT change seq.
const seqPreOrbit = await serverSeq();
await page.mouse.move(120, 700);
await page.mouse.down();
await page.mouse.move(320, 640, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1500);
const seqPostOrbit = await serverSeq();
console.log("ORBIT seq", seqPreOrbit, "->", seqPostOrbit, "(must be equal: drag is not a click)");
await page.screenshot({ path: `${OUT}/03-orbit.png` });

console.log("errors:", errors.length === 0 ? "none" : errors.slice(0, 5));

const ok =
  seqAfter > seqBefore && !rejected && seqPostOrbit === seqPreOrbit &&
  cursorHoverOk && cursorLeaveOk;
console.log(ok ? "PASS: canvas click advanced the server, no rejection, orbit intact" : "FAIL");

await browser.close();
process.exit(ok ? 0 : 1);
