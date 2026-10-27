import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCatalog, loadLessons, LessonError, publicLevel, validateLevel } from "../server/lessons.mjs";

const fixtureDir = new URL("./fixtures/lessons/", import.meta.url).pathname;
const base = () => JSON.parse(fs.readFileSync(`${fixtureDir}/level-1.json`, "utf8"));

test("fixture level validates and builds a catalog", () => {
  const cat = loadLessons(fixtureDir);
  assert.equal(cat.levels.length, 1);
  assert.equal(cat.challenge("fx-fix").levelId, "fixture-1");
  assert.equal(cat.card("fx-card-1").unlockAfter, "fx-predict", "defaults to first challenge");
  assert.equal(cat.card("fx-card-2").unlockAfter, "fx-fix");
});

test("public view never carries hidden material", () => {
  const level = base();
  const json = JSON.stringify(publicLevel(createCatalog([validateLevel(level)]).levels[0]));
  for (const ch of level.challenges) {
    if (ch.kind !== "predict") assert.ok(!json.includes(JSON.stringify(ch.reference).slice(1, -1)), `${ch.id} reference leaked`);
    if (ch.check.harness) assert.ok(!json.includes("hidden_tests"), `${ch.id} harness leaked`);
    for (const h of ch.hints) assert.ok(!json.includes(h), `${ch.id} hint leaked`);
  }
  for (const key of ["reference", "check", "rubric", "hints", "\"answer\"", "expected"]) assert.ok(!json.includes(`"${key.replaceAll('"', "")}"`), `${key} present`);
  assert.ok(!json.includes("Idiomatic hello."), "rubric leaked");
});

const broken = [
  ["unknown challenge kind", (l) => (l.challenges[1].kind = "quiz"), /kind: must be one of/],
  ["missing boss", (l) => (l.challenges.at(-1).kind = "write"), /missing a boss|last challenge/],
  ["harness without #[test]", (l) => (l.challenges[2].check.harness = "#[cfg(test)] mod t {}"), /#\[test\]/],
  ["answer not a choice", (l) => (l.challenges[0].check.answer = "E9999"), /answer: must be one of the choice ids/],
  ["arrow to unknown id", (l) => (l.visual.steps[0].arrows[0].to = "nope"), /unknown id nope/],
  ["visual line out of range", (l) => (l.visual.steps[0].line = 99), /line: must be an integer/],
  ["bad forbid regex", (l) => (l.challenges[1].check.forbid[0].pattern = "("), /invalid regex/],
  ["duplicate challenge id", (l) => (l.challenges[2].id = "fx-fix"), /duplicate fx-fix/],
  ["card unlock unknown", (l) => (l.cards[0].unlockAfter = "nope"), /unknown challenge nope/],
  ["judge without rubric", (l) => delete l.challenges[3].rubric, /rubric: must be a non-empty string/],
  ["too few challenges", (l) => l.challenges.splice(1, 1), /5\.\.8 items/],
];
for (const [name, mutate, re] of broken) {
  test(`schema rejects: ${name}`, () => {
    const l = base();
    mutate(l);
    assert.throws(() => validateLevel(l, "x.json"), (e) => e instanceof LessonError && re.test(e.message));
  });
}
