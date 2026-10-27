// Headless-browser smoke of the real UI against a running instance:
// Monaco loads offline under the CSP (incl. its web worker), the level map and
// sequential unlocking work, Check paints rustc markers, Shift+Alt+F formats
// via rustfmt, Ctrl+Shift+E opens the E-code overlay, Submit passes with the
// reference, the memory visualizer steps, and the review queue grades a card.
// No CDN or other off-origin request may happen.
//
// Not a dependency: point PLAYWRIGHT_CORE at any playwright-core checkout and
// CHROMIUM at a chromium binary.
// Usage: BASE=https://kai-lenovo.fritz.box:5020 node scripts/browser-smoke.mjs
//   env: LESSONS_DIR (references are read from disk), SHOTS (screenshot dir),
//        LEVEL (level id to drive; default: first level)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE || "https://localhost:5020").replace(/\/$/, "");
const PW = process.env.PLAYWRIGHT_CORE || path.join(process.env.HOME, "src/slidedeckgen/node_modules/playwright-core");
const CHROMIUM = process.env.CHROMIUM || execFileSync("sh", ["-c", "command -v chromium || command -v chromium-browser"], { encoding: "utf8" }).trim();
const SHOTS = process.env.SHOTS || "/tmp/rust-tutor-shots";
const lessonsDir = process.env.LESSONS_DIR || path.join(root, "lessons");

const { chromium } = await import(pathToFileURL(path.join(PW, "index.mjs")).href);
fs.mkdirSync(SHOTS, { recursive: true });

const levels = fs
  .readdirSync(lessonsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(lessonsDir, f), "utf8")))
  .sort((a, b) => a.order - b.order);
const level = levels.find((l) => l.id === process.env.LEVEL) || levels[0];

let failures = 0;
function expect(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures += 1;
}

// The LAN CA is not in chromium's NSS store here; TLS itself is checked by
// `make verify-access` with curl --cacert.
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const consoleErrors = [];
const offOrigin = [];
const origin = new URL(BASE).origin;
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(origin) && !u.startsWith("blob:") && !u.startsWith("data:")) offOrigin.push(u);
});
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});

const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const editorValue = () => page.evaluate(() => window.__tutor.S.ed.getValue());
const setEditor = (code) => page.evaluate((c) => window.__tutor.S.ed.load(c), code);
const focusEditor = () => page.evaluate(() => window.__tutor.S.ed.editor.focus());
const markers = () => page.evaluate(() => window.monaco.editor.getModelMarkers({}).map((m) => ({ code: typeof m.code === "string" ? m.code : m.code?.value, line: m.startLineNumber, col: m.startColumn, sev: m.severity })));

// ---- map
await page.goto(`${BASE}/#/map`);
await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
const cards = await page.locator(".level-card").count();
expect("level map renders every level", cards === levels.length, `${cards} card(s)`);
expect("top bar shows XP/streak/review", /XP/.test(await page.textContent("#stat-xp")) && /due/.test(await page.textContent("#stat-review")));
await shot("01-map");

// ---- sequential unlocking: the second challenge is locked until the first passes
const [first, second] = level.challenges;
await page.goto(`${BASE}/#/c/${second.id}`);
await page.waitForTimeout(400);
const fresh = !(await page.evaluate(() => window.__tutor.S.progress.levels[0].challenges[0].passed));
if (fresh) expect("locked challenge redirects", !page.url().endsWith(`/c/${second.id}`), page.url());

// ---- monaco + first challenge
await page.goto(`${BASE}/#/c/${first.id}`);
await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });
expect("Monaco editor mounted", true);
expect("Rust language active", (await page.evaluate(() => window.__tutor.S.ed.model.getLanguageId())) === "rust");
const tokenized = await page.locator(".monaco-editor .view-lines span[class*='mtk']").count();
expect("Rust syntax highlighting tokens", tokenized > 3, `${tokenized} token spans`);
await page.waitForTimeout(1500);
const workers = page.workers().map((w) => w.url());
expect("Monaco web worker running (CSP worker-src)", workers.length > 0, workers.join(", ").slice(0, 120));
expect("memory visualizer rendered", (await page.locator("#visual-host svg").count()) === 1);
const step1 = await page.textContent(".visual-note");
await page.click('[data-v="next"]');
const step2 = await page.textContent(".visual-note");
expect("visualizer steps forward", step1 !== step2 && (await page.locator("#visual-host svg .arrow").count()) >= 1, `"${step2.slice(0, 50)}"`);
await shot("02-first-challenge");
await page.locator(".visual").screenshot({ path: path.join(SHOTS, "02b-visual.png") });

async function pass(ch) {
  await page.goto(`${BASE}/#/c/${ch.id}`);
  await page.waitForFunction((id) => window.__tutor?.S.cur?.challenge.id === id, ch.id);
  if (ch.check.kind === "choice") {
    const idx = ch.choices.findIndex((c) => c.id === ch.check.answer);
    await page.locator("#lesson h1").click();
    await page.keyboard.press(`Digit${idx + 1}`);
  } else {
    await setEditor(ch.reference);
    await focusEditor();
  }
  await page.keyboard.press("Control+Shift+Enter");
  await page.waitForSelector("#tests .verdict", { timeout: 60000 });
  return page.textContent("#tests .verdict");
}

if (first.check.kind === "choice") {
  const v = await pass(first);
  expect(`predict ${first.id}: keyboard choice + submit passes`, /Passed/.test(v), v);
  // Check unlocks after the first prediction and should agree with the answer.
  await page.keyboard.press("Control+b");
  await page.waitForFunction(() => /error|compiles/.test(document.querySelector("#statusline").textContent), null, { timeout: 30000 });
  if (/^E\d{4}$/.test(first.check.answer)) expect("predict: rustc agrees after Check", (await markers()).some((m) => m.code === first.check.answer));
}

// ---- a compiled challenge: markers, explain overlay, format, submit
const compiled = level.challenges.find((c) => c.check.kind !== "choice");
for (const c of level.challenges) {
  if (c === compiled) break;
  if (c !== first) await pass(c);
}
await page.goto(`${BASE}/#/c/${compiled.id}`);
await page.waitForFunction((id) => window.__tutor?.S.cur?.challenge.id === id, compiled.id);
await setEditor('fn main() {\n    let s = String::from("a");\n    let t = s;\n    println!("{} {}", s, t);\n}\n');
await focusEditor();
await page.keyboard.press("Control+b");
await page.waitForFunction(() => window.monaco.editor.getModelMarkers({}).length > 0, null, { timeout: 30000 });
const ms = await markers();
const e0382 = ms.find((m) => m.code === "E0382" && m.sev === 8); // 8 = MarkerSeverity.Error (secondary spans are Info)
expect("Check paints E0382 marker at 4:23", e0382?.line === 4 && e0382?.col === 23, JSON.stringify(e0382));
expect("squiggle decoration in DOM", (await page.locator(".monaco-editor .squiggly-error").count()) > 0);
expect("diagnostics panel lists E0382", /E0382/.test(await page.textContent("#diagnostics")));
await shot("03-markers");

await page.evaluate(() => window.__tutor.S.ed.reveal(4, 23));
await page.keyboard.press("Control+Shift+e");
await page.waitForFunction(() => !document.querySelector("#overlay").hidden && /moved/i.test(document.querySelector("#overlay-body").textContent), null, { timeout: 30000 });
expect("Ctrl+Shift+E opens rustc --explain overlay", true, (await page.textContent("#overlay-body h2")).trim());
await shot("04-explain");
await page.keyboard.press("Escape");
expect("Esc closes overlay", await page.locator("#overlay").isHidden());

await setEditor("fn main(){let x=1;println!(\"{}\",x);}");
await focusEditor();
await page.keyboard.press("Shift+Alt+f");
await page.waitForFunction(() => window.__tutor.S.ed.getValue().includes("    let x = 1;"), null, { timeout: 30000 });
expect("Shift+Alt+F formats via rustfmt", (await editorValue()).startsWith("fn main() {\n"));

await setEditor('fn main() {\n    println!("hi from the browser");\n}\n');
await focusEditor();
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => /hi from the browser/.test(document.querySelector("#out").textContent), null, { timeout: 30000 });
expect("Ctrl+Enter runs and shows stdout", true);

const v = await pass(compiled);
expect(`submit ${compiled.id} reference passes`, /Passed/.test(v), v.trim());
await setEditor(compiled.starter);
await focusEditor();
await page.keyboard.press("Control+Shift+Enter");
await page.waitForFunction(() => /Not yet/.test(document.querySelector("#tests .verdict")?.textContent || ""), null, { timeout: 60000 });
expect(`submit ${compiled.id} starter fails`, true);
await shot("05-tests");

// ---- tutor panel answers (agent or graceful fallback), never hangs the UI
await page.keyboard.press("Alt+h");
await page.waitForSelector("#tutor .tutor-msg", { timeout: 5000 });
expect("Alt+H opens a tutor card", true);

// ---- persistence: reload restores code
await setEditor('fn main() {\n    // persisted-marker\n}\n');
await page.waitForTimeout(1200);
await page.reload();
await page.waitForFunction(() => window.__tutor?.S.cur, null, { timeout: 30000 });
expect("code autosave survives reload", (await editorValue()).includes("persisted-marker"));

// ---- review queue
await page.goto(`${BASE}/#/review`);
await page.waitForSelector(".flashcard", { timeout: 10000 });
const due = await page.evaluate(() => window.__tutor.S.review.cards.length);
if (due > 0) {
  await page.keyboard.press("Space");
  await page.waitForSelector("[data-grade]");
  await page.keyboard.press("Digit3");
  await page.waitForFunction((n) => window.__tutor.S.review.i === 1 || n === 0, due);
  expect("review card: Space reveals, 3 grades Good", true, `${due} due`);
} else {
  expect("review queue renders (none due)", /caught up/.test(await page.textContent(".flashcard")));
}
await shot("06-review");

await page.keyboard.press("Shift+Slash");
expect("? opens shortcut help", /Keyboard shortcuts/.test(await page.textContent("#overlay-body")));
await page.keyboard.press("Escape");

const csp = await page.evaluate(() => window.__csp);
expect("no CSP violations", csp.length === 0, csp.join("; "));
expect("no off-origin requests (no CDN)", offOrigin.length === 0, offOrigin.join(", "));
const realErrors = consoleErrors.filter((e) => !/status of (400|404|409|429)/.test(e));
expect("no console errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 400));

await browser.close();
console.log(failures ? `\n${failures} FAILED (screenshots in ${SHOTS})` : `\nbrowser smoke OK (screenshots in ${SHOTS})`);
process.exit(failures ? 1 : 0);
