import test from "node:test";
import assert from "node:assert/strict";
import { loadLessons } from "../server/lessons.mjs";
import { normalizeOutput, stripComments, verifyChallenge } from "../server/verify.mjs";

const catalog = loadLessons(new URL("./fixtures/lessons/", import.meta.url).pathname);

test("stripComments removes line/block comments but keeps strings and char literals", () => {
  const src = 'let a = "// not a comment"; // gone\nlet q = \'"\'; /* gone /* nested */ still gone */ let b = 1;\nfn f<\'a>(x: &\'a str) {}';
  const out = stripComments(src);
  assert.ok(out.includes('"// not a comment"'));
  assert.ok(!out.includes("gone"));
  assert.ok(out.includes("let q = '\"';"));
  assert.ok(out.includes("let b = 1;"));
  assert.ok(out.includes("fn f<'a>(x: &'a str) {}"));
});

test("normalizeOutput ignores trailing whitespace and CRLF", () => {
  assert.equal(normalizeOutput("a  \r\nb\n\n"), normalizeOutput("a\nb"));
  assert.notEqual(normalizeOutput("a\nb"), normalizeOutput("a b"));
});

test("choice verification never reveals the answer", async () => {
  const ch = catalog.challenge("fx-predict");
  const wrong = await verifyChallenge(null, ch, { answer: "compiles" });
  assert.equal(wrong.passed, false);
  assert.ok(!JSON.stringify(wrong).includes("E0382"));
  assert.equal((await verifyChallenge(null, ch, { answer: "E0382" })).passed, true);
});

test("forbid rules fail an otherwise passing output check", async () => {
  const ch = catalog.challenge("fx-fix");
  const fake = { run: async () => ({ compile: { ok: true, diagnostics: [] }, runs: [{ exitCode: 0, stdout: "hi hi\n", stderr: "" }] }) };
  const withClone = await verifyChallenge(fake, ch, { code: "let b = a.clone();" });
  assert.equal(withClone.passed, false);
  assert.ok(withClone.cases.some((c) => c.name === "rule" && c.message === "no clone"));
  const commented = await verifyChallenge(fake, ch, { code: "let b = &a; // not a.clone()" });
  assert.equal(commented.passed, true, "patterns ignore comments");
});

test("harness-only compile errors get an interface message", async () => {
  const ch = catalog.challenge("fx-complete");
  const fake = { test: async () => ({ compile: { ok: false, diagnostics: [{ level: "error", inHarness: true }] }, cases: [], run: null }) };
  const r = await verifyChallenge(fake, ch, { code: "fn main() {}" });
  assert.equal(r.passed, false);
  assert.match(r.cases.at(-1).message, /hidden tests can't use it/);
});
