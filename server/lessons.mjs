// Lesson data: one JSON file per level in lessons/, validated at startup.
//
// Hidden material (reference solutions, test harnesses, expected outputs,
// predict answers, judge rubrics, static hints) stays server-side;
// publicLevel() is the only shape the browser ever sees.

import fs from "node:fs";
import path from "node:path";

export const CHALLENGE_KINDS = ["predict", "fix", "complete", "write", "boss"];
export const CHECK_KINDS = ["tests", "output", "choice"];
export const ARROW_KINDS = ["own", "borrow", "mut", "moved"];
const ID = /^[a-z0-9][a-z0-9-]*$/;

export class LessonError extends Error {}

function fail(where, msg) {
  throw new LessonError(`${where}: ${msg}`);
}

function str(v, where, { optional = false, max = 20_000 } = {}) {
  if (v === undefined && optional) return;
  if (typeof v !== "string" || !v.trim()) fail(where, "must be a non-empty string");
  if (v.length > max) fail(where, `longer than ${max} chars`);
}

function arr(v, where, { min = 0, max = 1000 } = {}) {
  if (!Array.isArray(v)) fail(where, "must be an array");
  if (v.length < min || v.length > max) fail(where, `must have ${min}..${max} items (has ${v.length})`);
}

function int(v, where, { min = 0, max = 1e9 } = {}) {
  if (!Number.isInteger(v) || v < min || v > max) fail(where, `must be an integer in ${min}..${max}`);
}

function validateVisual(v, where) {
  if (typeof v !== "object" || !v) fail(where, "must be an object");
  str(v.title, `${where}.title`);
  str(v.code, `${where}.code`);
  const lines = v.code.split("\n").length;
  arr(v.steps, `${where}.steps`, { min: 2, max: 40 });
  v.steps.forEach((s, i) => {
    const w = `${where}.steps[${i}]`;
    int(s.line, `${w}.line`, { min: 1, max: lines });
    str(s.note, `${w}.note`);
    arr(s.stack, `${w}.stack`, { max: 6 });
    const ids = new Set();
    s.stack.forEach((f, j) => {
      str(f.frame, `${w}.stack[${j}].frame`);
      arr(f.vars, `${w}.stack[${j}].vars`, { max: 10 });
      f.vars.forEach((x, k) => {
        const wv = `${w}.stack[${j}].vars[${k}]`;
        str(x.id, `${wv}.id`);
        str(x.name, `${wv}.name`);
        str(x.value, `${wv}.value`, { optional: true });
        if (x.state !== undefined && !["live", "moved", "dropped", "frozen"].includes(x.state)) fail(`${wv}.state`, "must be live|moved|dropped|frozen");
        if (ids.has(x.id)) fail(`${wv}.id`, `duplicate id ${x.id}`);
        ids.add(x.id);
      });
    });
    arr(s.heap || [], `${w}.heap`, { max: 10 });
    (s.heap || []).forEach((h, j) => {
      str(h.id, `${w}.heap[${j}].id`);
      str(h.label, `${w}.heap[${j}].label`);
      if (h.state !== undefined && !["live", "freed"].includes(h.state)) fail(`${w}.heap[${j}].state`, "must be live|freed");
      if (ids.has(h.id)) fail(`${w}.heap[${j}].id`, `duplicate id ${h.id}`);
      ids.add(h.id);
    });
    arr(s.arrows || [], `${w}.arrows`, { max: 20 });
    (s.arrows || []).forEach((a, j) => {
      const wa = `${w}.arrows[${j}]`;
      if (!ids.has(a.from)) fail(`${wa}.from`, `unknown id ${a.from}`);
      if (!ids.has(a.to)) fail(`${wa}.to`, `unknown id ${a.to}`);
      if (!ARROW_KINDS.includes(a.kind)) fail(`${wa}.kind`, `must be one of ${ARROW_KINDS.join("|")}`);
    });
  });
}

function validateCheck(c, ch, where) {
  if (typeof c !== "object" || !c) fail(where, "must be an object");
  if (!CHECK_KINDS.includes(c.kind)) fail(`${where}.kind`, `must be one of ${CHECK_KINDS.join("|")}`);
  if (c.kind === "tests") {
    str(c.harness, `${where}.harness`);
    if (!/#\[test\]/.test(c.harness)) fail(`${where}.harness`, "must contain at least one #[test]");
    if (!/#\[cfg\(test\)\]/.test(c.harness)) fail(`${where}.harness`, "must be wrapped in a #[cfg(test)] module");
  }
  if (c.kind === "output") {
    arr(c.cases, `${where}.cases`, { min: 1, max: 10 });
    c.cases.forEach((k, i) => {
      str(k.name, `${where}.cases[${i}].name`);
      if (k.stdin !== undefined && typeof k.stdin !== "string") fail(`${where}.cases[${i}].stdin`, "must be a string");
      if (typeof k.expected !== "string") fail(`${where}.cases[${i}].expected`, "must be a string");
    });
  }
  if (c.kind === "choice") {
    if (ch.kind !== "predict") fail(`${where}.kind`, "choice checks are only for predict challenges");
    arr(ch.choices, `challenge ${ch.id}.choices`, { min: 2, max: 6 });
    const ids = ch.choices.map((o, i) => {
      str(o.id, `challenge ${ch.id}.choices[${i}].id`);
      str(o.label, `challenge ${ch.id}.choices[${i}].label`);
      return o.id;
    });
    if (new Set(ids).size !== ids.length) fail(`challenge ${ch.id}.choices`, "duplicate choice ids");
    if (!ids.includes(c.answer)) fail(`${where}.answer`, "must be one of the choice ids");
    // compiles | E0382-style code: verified against real rustc by scripts/check-lessons.mjs
    if (c.compilerAgrees !== undefined && typeof c.compilerAgrees !== "boolean") fail(`${where}.compilerAgrees`, "must be boolean");
    // exact stdout of the starter program, for "what does this print?" predictions
    if (c.output !== undefined && typeof c.output !== "string") fail(`${where}.output`, "must be a string");
  }
  if (c.forbid !== undefined) {
    arr(c.forbid, `${where}.forbid`, { max: 10 });
    c.forbid.forEach((f, i) => {
      str(f.pattern, `${where}.forbid[${i}].pattern`);
      str(f.message, `${where}.forbid[${i}].message`);
      try {
        new RegExp(f.pattern);
      } catch (e) {
        fail(`${where}.forbid[${i}].pattern`, `invalid regex: ${e.message}`);
      }
    });
  }
  if (c.require !== undefined) {
    arr(c.require, `${where}.require`, { max: 10 });
    c.require.forEach((f, i) => {
      str(f.pattern, `${where}.require[${i}].pattern`);
      str(f.message, `${where}.require[${i}].message`);
      try {
        new RegExp(f.pattern);
      } catch (e) {
        fail(`${where}.require[${i}].pattern`, `invalid regex: ${e.message}`);
      }
    });
  }
}

export function validateLevel(level, file = "level") {
  const w = file;
  if (typeof level !== "object" || !level) fail(w, "must be a JSON object");
  str(level.id, `${w}.id`);
  if (!ID.test(level.id)) fail(`${w}.id`, "must be kebab-case");
  int(level.order, `${w}.order`, { min: 1, max: 99 });
  str(level.title, `${w}.title`, { max: 80 });
  str(level.summary, `${w}.summary`, { max: 300 });
  if (typeof level.quest !== "object" || !level.quest) fail(`${w}.quest`, "must be an object");
  str(level.quest.title, `${w}.quest.title`);
  str(level.quest.story, `${w}.quest.story`, { max: 3000 });
  arr(level.concepts, `${w}.concepts`, { min: 1, max: 8 });
  level.concepts.forEach((c, i) => {
    str(c.title, `${w}.concepts[${i}].title`);
    str(c.body, `${w}.concepts[${i}].body`, { max: 2500 });
  });
  validateVisual(level.visual, `${w}.visual`);

  arr(level.challenges, `${w}.challenges`, { min: 5, max: 8 });
  const ids = new Set();
  level.challenges.forEach((ch, i) => {
    const wc = `${w}.challenges[${i}]`;
    str(ch.id, `${wc}.id`);
    if (!ID.test(ch.id)) fail(`${wc}.id`, "must be kebab-case");
    if (ids.has(ch.id)) fail(`${wc}.id`, `duplicate ${ch.id}`);
    ids.add(ch.id);
    str(ch.title, `${wc}.title`, { max: 80 });
    if (!CHALLENGE_KINDS.includes(ch.kind)) fail(`${wc}.kind`, `must be one of ${CHALLENGE_KINDS.join("|")}`);
    int(ch.xp, `${wc}.xp`, { min: 1, max: 500 });
    str(ch.story, `${wc}.story`, { optional: true, max: 1500 });
    str(ch.prompt, `${wc}.prompt`, { max: 4000 });
    if (typeof ch.starter !== "string") fail(`${wc}.starter`, "must be a string");
    str(ch.reference, `${wc}.reference`);
    arr(ch.hints, `${wc}.hints`, { min: 1, max: 5 });
    ch.hints.forEach((h, j) => str(h, `${wc}.hints[${j}]`));
    validateCheck(ch.check, ch, `${wc}.check`);
    if (ch.kind === "predict" && ch.check.kind !== "choice") fail(`${wc}.check.kind`, "predict challenges use a choice check");
    if (ch.judge !== undefined) {
      if (ch.judge !== "agent") fail(`${wc}.judge`, 'only "agent" is supported');
      if (ch.check.kind === "choice") fail(`${wc}.judge`, "judge needs compiled code, not a choice");
      str(ch.rubric, `${wc}.rubric`, { max: 2000 });
    }
  });
  const kinds = new Set(level.challenges.map((c) => c.kind));
  for (const k of CHALLENGE_KINDS) if (!kinds.has(k)) fail(`${w}.challenges`, `missing a ${k} challenge`);
  if (level.challenges.at(-1).kind !== "boss") fail(`${w}.challenges`, "last challenge must be the boss");

  arr(level.cards, `${w}.cards`, { min: 3, max: 20 });
  const cardIds = new Set();
  level.cards.forEach((c, i) => {
    const wc = `${w}.cards[${i}]`;
    str(c.id, `${wc}.id`);
    if (cardIds.has(c.id)) fail(`${wc}.id`, `duplicate ${c.id}`);
    cardIds.add(c.id);
    str(c.front, `${wc}.front`, { max: 600 });
    str(c.back, `${wc}.back`, { max: 1200 });
    if (c.unlockAfter !== undefined && !ids.has(c.unlockAfter)) fail(`${wc}.unlockAfter`, `unknown challenge ${c.unlockAfter}`);
  });
  return level;
}

/** Load and validate lessons/*.json; cross-file uniqueness and ordering. */
export function loadLessons(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new LessonError(`no lesson files in ${dir}`);
  const levels = files.map((f) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (e) {
      throw new LessonError(`${f}: invalid JSON: ${e.message}`);
    }
    return validateLevel(data, f);
  });
  levels.sort((a, b) => a.order - b.order);
  const seen = new Map();
  levels.forEach((l, i) => {
    if (l.order !== i + 1) throw new LessonError(`${l.id}: level orders must be 1..${levels.length} without gaps`);
    for (const id of [l.id, ...l.challenges.map((c) => c.id), ...l.cards.map((c) => c.id)]) {
      if (seen.has(id)) throw new LessonError(`id ${id} used in ${seen.get(id)} and ${l.id}`);
      seen.set(id, l.id);
    }
  });
  return createCatalog(levels);
}

export function createCatalog(levels) {
  const challenges = new Map();
  const cards = new Map();
  for (const l of levels) {
    l.challenges.forEach((c, index) => challenges.set(c.id, { ...c, levelId: l.id, index }));
    for (const c of l.cards) cards.set(c.id, { ...c, levelId: l.id, unlockAfter: c.unlockAfter || l.challenges[0].id });
  }
  return {
    levels,
    challenge: (id) => challenges.get(id) || null,
    card: (id) => cards.get(id) || null,
    cards: () => [...cards.values()],
    level: (id) => levels.find((l) => l.id === id) || null,
  };
}

export function publicChallenge(ch) {
  return {
    id: ch.id,
    title: ch.title,
    kind: ch.kind,
    xp: ch.xp,
    story: ch.story || null,
    prompt: ch.prompt,
    starter: ch.starter,
    choices: ch.kind === "predict" ? ch.choices : undefined,
    checkKind: ch.check.kind,
    judged: ch.judge === "agent",
    hintCount: ch.hints.length,
  };
}

export function publicLevel(l) {
  return {
    id: l.id,
    order: l.order,
    title: l.title,
    summary: l.summary,
    quest: l.quest,
    concepts: l.concepts,
    visual: l.visual,
    challenges: l.challenges.map(publicChallenge),
    cardCount: l.cards.length,
  };
}
