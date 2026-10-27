import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCatalog, loadLessons, validateLevel } from "../server/lessons.mjs";
import { fixtureCopy } from "./fixtures/copy.mjs";
import { dayKey, openStore, scheduleCard, streakFrom } from "../server/store.mjs";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-27T10:00:00Z");
const catalog = loadLessons(new URL("./fixtures/lessons/", import.meta.url).pathname);

test("scheduleCard: again resets, good grows, easy grows faster, ease floor 1.3", () => {
  const again = scheduleCard({ ease: 1.35, reps: 4, intervalDays: 20 }, 0, T0);
  assert.equal(again.reps, 0);
  assert.equal(again.ease, 1.3);
  assert.equal(Date.parse(again.dueAt) - T0, 10 * 60_000);

  let c = { ease: 2.5, reps: 0, intervalDays: 0 };
  c = scheduleCard(c, 2, T0);
  assert.equal(c.intervalDays, 1);
  c = scheduleCard(c, 2, T0);
  assert.equal(c.intervalDays, 3);
  c = scheduleCard(c, 2, T0);
  assert.equal(c.intervalDays, 7.5);
  const easy = scheduleCard({ ease: 2.5, reps: 2, intervalDays: 3 }, 3, T0);
  assert.ok(easy.intervalDays > 7.5 && easy.ease > 2.5);
  const hard = scheduleCard({ ease: 2.5, reps: 2, intervalDays: 3 }, 1, T0);
  assert.ok(hard.intervalDays < 7.5 && hard.ease < 2.5);
  assert.throws(() => scheduleCard({}, 4, T0), RangeError);
});

test("streak counts consecutive days ending today or yesterday", () => {
  assert.equal(streakFrom(["2026-10-25", "2026-10-26", "2026-10-27"], "2026-10-27"), 3);
  assert.equal(streakFrom(["2026-10-25", "2026-10-26"], "2026-10-27"), 2, "today not yet active");
  assert.equal(streakFrom(["2026-10-24", "2026-10-26"], "2026-10-27"), 1);
  assert.equal(streakFrom(["2026-10-20"], "2026-10-27"), 0);
  assert.equal(streakFrom(["2026-02-28", "2026-03-01"], "2026-03-01"), 2, "month boundary");
});

test("dayKey uses the learner's time zone", () => {
  assert.equal(dayKey(Date.parse("2026-10-27T23:30:00Z"), "Europe/Berlin"), "2026-10-28");
  assert.equal(dayKey(Date.parse("2026-10-27T23:30:00Z"), "UTC"), "2026-10-27");
});

test("verify records attempts, awards XP once, unlocks cards, persists across reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-store-"));
  const file = path.join(dir, "p.db");
  let clock = T0;
  let s = openStore(file, { now: () => clock, timeZone: "UTC" });
  const ch = catalog.challenge("fx-predict");

  let r = s.recordVerify(ch, { passed: false, answer: "compiles" }, catalog);
  assert.deepEqual(r, { firstPass: false, xpAwarded: 0, unlockedCards: [] });
  r = s.recordVerify(ch, { passed: true, answer: "E0382" }, catalog);
  assert.equal(r.firstPass, true);
  assert.equal(r.xpAwarded, 10);
  assert.deepEqual(r.unlockedCards.sort(), ["fx-card-1", "fx-card-3"]);
  r = s.recordVerify(ch, { passed: true, answer: "E0382" }, catalog);
  assert.equal(r.xpAwarded, 0, "no XP for repeat passes");

  s.saveCode(catalog.challenge("fx-fix"), { code: "fn main() {}" });
  assert.equal(s.useHint(catalog.challenge("fx-fix")), 1);
  let p = s.progress(catalog);
  assert.equal(p.xp, 10);
  assert.equal(p.streak, 1);
  assert.equal(p.reviewDue, 2);
  assert.equal(p.levels[0].passed, 1);
  assert.equal(p.levels[0].unlocked, true);
  s.close();

  clock += 1000;
  s = openStore(file, { now: () => clock, timeZone: "UTC" });
  p = s.progress(catalog);
  assert.equal(p.xp, 10, "XP survives reopen");
  assert.equal(s.state("fx-fix").last_code, "fn main() {}");
  assert.equal(s.state("fx-predict").attempts, 3);

  const rev = s.reviewCard("fx-card-1", 2);
  assert.equal(rev.intervalDays, 1);
  assert.equal(s.progress(catalog).reviewDue, 1);
  assert.equal(s.progress(catalog).xp, 12);
  assert.equal(s.reviewCard("fx-card-2", 2), null, "locked card cannot be reviewed");
  clock += 2 * DAY;
  assert.equal(s.dueCards().length, 2);
  assert.equal(s.progress(catalog).streak, 0, "two idle days break the streak");

  s.cachePut("k", "judge", { pass: true });
  assert.deepEqual(s.cacheGet("k"), { pass: true });
  s.close();
  fs.rmSync(dir, { recursive: true });
});

test("levels unlock by boss, but a level with saved progress is never locked", () => {
  // Prelude inserted before a level the learner already started (the 0A/0B/0C migration).
  const cat = createCatalog(
    [
      fixtureCopy("p", { order: 1, label: "0A", section: "prelude" }),
      fixtureCopy("c", { order: 2, label: "1" }),
      fixtureCopy("d", { order: 3, label: "2" }),
    ].map((l) => validateLevel(l)),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-store-"));
  const s = openStore(path.join(dir, "p.db"), { now: () => T0, timeZone: "UTC" });
  const unlocked = () => s.progress(cat).levels.map((l) => l.unlocked);
  assert.deepEqual(unlocked(), [true, false, false], "fresh learner: only the first level");

  s.recordVerify(cat.challenge("c-predict"), { passed: true, answer: "E0382" }, cat);
  assert.deepEqual(unlocked(), [true, true, false], "started level stays open; the one after still needs its boss");

  s.saveCode(cat.challenge("d-fix"), { code: "fn main() {}" });
  assert.deepEqual(unlocked(), [true, true, true], "saved code alone keeps a level open");

  const p = s.progress(cat).levels[0];
  assert.equal(p.passed, 0, "prelude progress is untouched");
  s.close();
  fs.rmSync(dir, { recursive: true });
});
