// Proves every challenge is solvable and not pre-solved:
//   - reference passes the hidden verification, starter fails it;
//   - predict answers agree with real rustc when `compilerAgrees` is set
//     (choice ids: "compiles", "panics", or a rustc error code like "E0382"),
//     and the starter prints exactly `check.output` when that is given;
//   - every predict challenge is machine-checked by at least one of those;
//   - references are rustfmt-clean (warning only).
// Usage: node scripts/check-lessons.mjs [lessons/level-3.json ... | dir]   (default: whole lessons/ dir)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog, loadLessons, validateLevel } from "../server/lessons.mjs";
import { createRust } from "../server/rustc.mjs";
import { normalizeOutput, verifyChallenge } from "../server/verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A directory argument is loaded as a whole (order 1..n, unique ids); single
// files are validated on their own so one level can be checked in isolation.
const args = process.argv.slice(2);
const catalog =
  args.length === 1 && fs.statSync(args[0]).isDirectory()
    ? loadLessons(args[0])
    : args.length
      ? createCatalog(args.map((f) => validateLevel(JSON.parse(fs.readFileSync(f, "utf8")), path.basename(f))).sort((a, b) => a.order - b.order))
      : loadLessons(process.env.LESSONS_DIR || path.join(root, "lessons"));

const rust = createRust({ concurrency: 2, maxQueue: 64 });
let failed = 0;
let warned = 0;
let total = 0;

const summarize = (r) =>
  r.cases
    .filter((c) => !c.passed)
    .map((c) => `${c.name}: ${String(c.message || "").split("\n").slice(0, 6).join(" | ")}`)
    .concat((r.compile?.diagnostics || []).filter((d) => d.level === "error").map((d) => `rustc ${d.code || ""} ${d.message} @${d.spans[0]?.lineStart ?? "harness"}`))
    .join("\n      ");

async function predictAgrees(ch) {
  const answer = ch.check.answer;
  if (/^E\d{4}$/.test(answer)) {
    const c = await rust.check(ch.starter);
    return c.errorCodes.includes(answer) ? null : `rustc reports [${c.errorCodes.join(", ") || "no errors"}], answer says ${answer}`;
  }
  if (answer === "compiles") {
    const c = await rust.check(ch.starter);
    return c.ok ? null : `rustc reports [${c.errorCodes.join(", ")}], answer says it compiles`;
  }
  if (answer === "panics") {
    const r = await rust.run(ch.starter);
    if (!r.compile.ok) return `does not compile: [${r.compile.errorCodes.join(", ")}]`;
    return r.runs[0].exitCode === 101 ? null : `exit code ${r.runs[0].exitCode}, expected a panic (101)`;
  }
  return `compilerAgrees needs answer "compiles", "panics" or an error code, got ${answer}`;
}

async function checkChallenge(level, ch) {
  const problems = [];
  const notes = [];
  if (ch.check.kind === "choice") {
    if (!(await verifyChallenge(rust, ch, { answer: ch.reference })).passed) problems.push(`reference answer "${ch.reference}" does not pass`);
    if (ch.reference !== ch.check.answer) problems.push("reference must equal check.answer for predict challenges");
    if ((await verifyChallenge(rust, ch, { answer: undefined })).passed) problems.push("empty answer passes");
    if (ch.check.compilerAgrees) {
      const why = await predictAgrees(ch);
      if (why) problems.push(`compiler disagrees: ${why}`);
    }
    if (ch.check.output !== undefined) {
      const r = await rust.run(ch.starter);
      const got = r.compile.ok ? normalizeOutput(r.runs[0].stdout) : `(does not compile: ${r.compile.errorCodes.join(", ")})`;
      if (got !== normalizeOutput(ch.check.output)) problems.push(`starter output differs from check.output:\n      expected ${JSON.stringify(ch.check.output)}\n      got      ${JSON.stringify(got)}`);
    }
    if (!ch.check.compilerAgrees && ch.check.output === undefined) problems.push("predict is not machine-checked: set compilerAgrees or output");
  } else {
    const ref = await verifyChallenge(rust, ch, { code: ch.reference });
    if (!ref.passed) problems.push(`reference FAILS:\n      ${summarize(ref)}`);
    const start = await verifyChallenge(rust, ch, { code: ch.starter });
    if (start.passed) problems.push("starter already PASSES (challenge is pre-solved)");
    const f = await rust.format(ch.reference);
    if (f.ok && f.code !== ch.reference) notes.push("reference is not rustfmt-clean");
    const c = await rust.check(ch.reference);
    const warns = c.diagnostics.filter((d) => d.level === "warning").map((d) => d.message);
    if (warns.length) notes.push(`reference warnings: ${warns.join("; ")}`);
  }
  return { level, ch, problems, notes };
}

const jobs = [];
for (const level of catalog.levels) for (const ch of level.challenges) jobs.push(checkChallenge(level, ch));
for (const r of await Promise.all(jobs)) {
  total += 1;
  const tag = `${r.level.id}/${r.ch.id} [${r.ch.kind}/${r.ch.check.kind}${r.ch.judge ? "+judge" : ""}]`;
  if (r.problems.length) {
    failed += 1;
    console.log(`FAIL ${tag}\n    - ${r.problems.join("\n    - ")}`);
  } else {
    console.log(`PASS ${tag}  reference passes, starter fails`);
  }
  for (const n of r.notes) {
    warned += 1;
    console.log(`  warn ${n}`);
  }
}
console.log(`\n${total - failed}/${total} challenges OK across ${catalog.levels.length} level(s); ${warned} warning(s)`);
process.exit(failed ? 1 : 0);
