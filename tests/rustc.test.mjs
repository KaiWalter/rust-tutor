import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { assertSource, createRust, parseDiagnostics, parseTestOutput } from "../server/rustc.mjs";

const fixture = fs.readFileSync(new URL("./fixtures/rustc/e0382.jsonl", import.meta.url), "utf8");
const hasRustc = (() => {
  try {
    execFileSync("rustc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const needsRustc = { skip: hasRustc ? false : "rustc not on PATH (run via `make test` in the image)" };

test("parseDiagnostics maps rustc JSON to error/warning diagnostics with 1-based spans", () => {
  const d = parseDiagnostics(fixture);
  assert.equal(d.length, 3, "summary + failure-note lines are dropped");
  const [err, w1, w2] = d;
  assert.equal(err.level, "error");
  assert.equal(err.code, "E0382");
  assert.equal(err.message, "borrow of moved value: `s`");
  const primary = err.spans.find((s) => s.primary);
  assert.deepEqual([primary.lineStart, primary.colStart, primary.colEnd], [5, 20, 21]);
  assert.equal(primary.label, "value borrowed here after move");
  assert.ok(err.spans.some((s) => !s.primary && s.label === "value moved here"));
  assert.ok(err.rendered.includes("E0382"));
  assert.equal(w1.level, "warning");
  assert.equal(w1.code, "unused_variables");
  assert.ok(w2.children.some((c) => c.level === "help" && c.spans.some((s) => s.suggestion === "_unused")));
});

test("parseDiagnostics hides spans and rendered source inside the hidden harness", () => {
  const d = parseDiagnostics(fixture, { userLines: 4 });
  const err = d[0];
  assert.equal(err.inHarness, false, "one span (line 3) is still in user code");
  assert.ok(err.spans.every((s) => s.lineStart <= 4));
  assert.equal(err.rendered, null, "rendered output would quote harness lines");
  const d2 = parseDiagnostics(fixture, { userLines: 1 });
  assert.equal(d2[0].inHarness, true);
  assert.deepEqual(d2[0].spans, []);
});

test("parseTestOutput reads libtest results and failure messages", () => {
  const out = [
    "running 2 tests",
    "test hidden_tests::adds ... ok",
    "test hidden_tests::bad ... FAILED",
    "",
    "failures:",
    "",
    "---- hidden_tests::bad stdout ----",
    "",
    "thread 'hidden_tests::bad' panicked at main.rs:8:20:",
    "assertion `left == right` failed",
    "",
    "",
    "failures:",
    "    hidden_tests::bad",
    "",
    "test result: FAILED. 1 passed; 1 failed",
  ].join("\n");
  const cases = parseTestOutput(out);
  assert.deepEqual(cases.map((c) => [c.name, c.passed]), [["hidden_tests::adds", true], ["hidden_tests::bad", false]]);
  assert.match(cases[1].message, /assertion `left == right` failed/);
});

test("assertSource rejects non-strings and oversize code", () => {
  assert.throws(() => assertSource(42), /string/);
  assert.throws(() => assertSource("x".repeat(70_000)), /64 KiB/);
});

test("format, check, run, test and explain against real rustc", needsRustc, async () => {
  const rust = createRust();
  const f = await rust.format('fn main(){let x=1;println!("{}",x);}');
  assert.equal(f.ok, true);
  assert.equal(f.code, 'fn main() {\n    let x = 1;\n    println!("{}", x);\n}\n');
  assert.equal((await rust.format("fn main( {")).ok, false);

  const c = await rust.check('fn main() { let s = String::new(); let t = s; println!("{}", s); }');
  assert.equal(c.ok, false);
  assert.deepEqual(c.errorCodes, ["E0382"]);

  const r = await rust.run('fn main(){ let mut l = String::new(); std::io::stdin().read_line(&mut l).unwrap(); print!("hi {}", l); }', ["kai\n"]);
  assert.equal(r.compile.ok, true);
  assert.equal(r.runs[0].stdout, "hi kai\n");

  const t = await rust.test(
    "fn add(a: i32, b: i32) -> i32 { a + b }\nfn main() {}",
    "#[cfg(test)]\nmod hidden {\n    use super::*;\n    #[test] fn ok() { assert_eq!(add(1, 2), 3); }\n    #[test] fn bad() { assert_eq!(add(1, 1), 3); }\n}",
  );
  assert.deepEqual(t.cases.map((x) => [x.name, x.passed]), [["bad", false], ["ok", true]]);
  assert.match(t.cases[0].message, /main\.rs:\d+:\d+/, "temp dir is remapped away");
  assert.doesNotMatch(t.cases[0].message, /\/tmp\//);

  const iface = await rust.test("fn main() {}", "#[cfg(test)]\nmod hidden {\n    use super::*;\n    #[test] fn ok() { assert_eq!(add(1, 2), 3); }\n}");
  assert.equal(iface.compile.ok, false);
  assert.ok(iface.compile.diagnostics.some((d) => d.inHarness && d.code === "E0425"));
  assert.ok(iface.compile.diagnostics.every((d) => d.rendered === null), "harness source never echoed");

  const e = await rust.explain("E0382");
  assert.match(e.text, /used after its contents have been moved/);
  await assert.rejects(rust.explain("rm -rf"), /E0382/);
});

test("run limits: infinite loop, memory hog and output flood are killed", needsRustc, async () => {
  const rust = createRust();
  const loop = await rust.run("fn main() { loop {} }");
  assert.equal(loop.runs[0].timedOut, true);
  assert.ok(loop.runs[0].durationMs < 6500);

  const hog = await rust.run("fn main() { let mut v: Vec<Vec<u8>> = Vec::new(); loop { v.push(vec![1u8; 1 << 20]); } }");
  assert.equal(hog.runs[0].signal, "SIGABRT");
  assert.match(hog.runs[0].stderr, /memory allocation of \d+ bytes failed/);

  const flood = await rust.run('fn main() { loop { println!("flood"); } }');
  assert.equal(flood.runs[0].truncated, true);
});
