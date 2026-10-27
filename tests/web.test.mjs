// Pure browser modules that run unchanged under node: markdown escaping and
// rustc-diagnostic -> Monaco marker mapping.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { diagnosticsToMarkers, suggestionsFrom } from "../web/js/editor.js";
import { esc, md } from "../web/js/md.js";
import { parseDiagnostics } from "../server/rustc.mjs";

test("md escapes raw HTML everywhere", () => {
  const out = md('<script>alert(1)</script>\n\n**<b>x</b>** and `<i>` and *<img src=x onerror=1>*\n\n```rust\nlet a = "<tag>";\n```');
  assert.ok(!/<script|<b>|<i>|<img/.test(out), out);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<strong>&lt;b&gt;x&lt;\/b&gt;<\/strong>/);
  assert.match(out, /<code>&lt;i&gt;<\/code>/);
  assert.match(out, /<pre><code class="lang-rust">let a = &quot;&lt;tag&gt;&quot;;<\/code><\/pre>/);
});

test("md renders lists, headings and rustdoc fences", () => {
  const out = md("# Title\n- one\n- two `x`\n\n1. first\n2. second\n\n```compile_fail,E0382\nlet a;\n```");
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<ul><li>one<\/li><li>two <code>x<\/code><\/li><\/ul>/);
  assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out, /class="lang-compile_fail"/);
  assert.equal(esc(`"'&`), "&quot;&#39;&amp;");
});

// Minimal stand-in for the Monaco API surface used by diagnosticsToMarkers.
const fakeMonaco = { MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 } };
const model = (lines) => ({ getLineCount: () => lines.length, getLineMaxColumn: (n) => lines[n - 1].length + 1 });

test("E0382 diagnostic becomes an error marker at the primary span plus info markers", () => {
  const diags = parseDiagnostics(fs.readFileSync(new URL("./fixtures/rustc/e0382.jsonl", import.meta.url), "utf8"));
  const src = ['fn main() {', '    let s = String::from("a");', "", "    let t = s;", '    println!("{}", s);', "}"];
  const ms = diagnosticsToMarkers(fakeMonaco, model(src), diags);
  const err = ms.find((m) => m.severity === 8);
  assert.equal(err.code, "E0382");
  assert.equal(err.source, "rustc");
  assert.deepEqual([err.startLineNumber, err.startColumn], [5, 20]);
  assert.match(err.message, /borrow of moved value/);
  assert.ok(ms.some((m) => m.severity === 2 && m.startLineNumber === 3), "secondary 'value moved here' span");
});

test("spans are clamped to the model and harness diagnostics pin to line 1", () => {
  const ms = diagnosticsToMarkers(fakeMonaco, model(["fn main() {}"]), [
    { level: "error", message: "far away", code: null, spans: [{ lineStart: 9, colStart: 3, lineEnd: 9, colEnd: 99, primary: true }], children: [] },
    { level: "error", message: "harness", code: "E0425", spans: [], children: [{ level: "help", message: "check names", spans: [] }], inHarness: true },
  ]);
  assert.equal(ms[0].startLineNumber, 1);
  assert.ok(ms[0].endColumn <= 13);
  assert.equal(ms[1].startLineNumber, 1);
  assert.match(ms[1].message, /help: check names/);
});

test("machine suggestions become quick-fix edits", () => {
  const s = suggestionsFrom([
    { level: "error", message: "m", code: "E0382", spans: [], children: [{ level: "help", message: "consider borrowing", spans: [{ lineStart: 3, colStart: 13, lineEnd: 3, colEnd: 14, suggestion: "&s" }] }] },
    { level: "error", message: "m", code: null, spans: [], children: [{ level: "note", message: "no edit", spans: [{ lineStart: 1, colStart: 1, lineEnd: 1, colEnd: 2, suggestion: null }] }] },
  ]);
  assert.equal(s.length, 1);
  assert.equal(s[0].edits[0].suggestion, "&s");
});
