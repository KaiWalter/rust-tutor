import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { loadLessons } from "../server/lessons.mjs";
import { createLimiter } from "../server/sandbox.mjs";
import { openStore } from "../server/store.mjs";

const catalog = loadLessons(new URL("./fixtures/lessons/", import.meta.url).pathname);

function fakeRust() {
  return {
    limiter: createLimiter(),
    format: async (code) => ({ ok: true, code: code.trim() + "\n" }),
    check: async () => ({ ok: true, diagnostics: [], errorCodes: [] }),
    run: async (_code, stdins) => ({ compile: { ok: true, diagnostics: [] }, runs: stdins.map((s) => ({ exitCode: 0, stdout: s ? s.toUpperCase() : "hi hi\n", stderr: "" })) }),
    test: async () => ({ compile: { ok: true, diagnostics: [] }, cases: [{ name: "adds", passed: true }], run: {} }),
    explain: async (c) => ({ code: c, text: "explained" }),
  };
}

async function start({ allowed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-app-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>t</title>");
  const store = openStore(":memory:", { timeZone: "UTC" });
  const app = createApp({
    rust: fakeRust(),
    catalog,
    store,
    staticDir: dir,
    log: () => {},
    allowlist: {
      check: () => ({ allowed, label: allowed ? "kai-lenovo" : null }),
      isTailscaleLocal: () => false,
      snapshot: () => ({ entries: 3, refreshedAt: Date.now() }),
    },
  });
  const server = http.createServer(app.onRequest);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { call, close: () => new Promise((r) => server.close(r)), dir };
}

test("non-allowlisted clients get 403 everywhere, healthz included", async () => {
  const s = await start({ allowed: false });
  for (const p of ["/healthz", "/api/levels", "/"]) assert.equal((await s.call("GET", p)).status, 403, p);
  await s.close();
});

test("healthz reports ok with content counts and security headers", async () => {
  const s = await start();
  const r = await s.call("GET", "/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
  assert.equal(r.json.challenges, 5);
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await s.call("POST", "/healthz")).status, 405);
  await s.close();
});

test("levels endpoint exposes no hidden material", async () => {
  const s = await start();
  const r = await s.call("GET", "/api/levels");
  assert.equal(r.status, 200);
  assert.equal(r.json.levels[0].challenges.length, 5);
  for (const k of ["reference", "harness", "rubric", "\"answer\"", "hidden_tests", "\"expected\""]) assert.ok(!r.text.includes(k), k);
  await s.close();
});

test("verify flow: wrong then right, XP once, progress and code persisted", async () => {
  const s = await start();
  let r = await s.call("POST", "/api/verify", { challengeId: "fx-predict", answer: "compiles" });
  assert.equal(r.json.passed, false);
  r = await s.call("POST", "/api/verify", { challengeId: "fx-predict", answer: "E0382" });
  assert.equal(r.json.passed, true);
  assert.equal(r.json.xpAwarded, 10);
  assert.equal(r.json.progress.xp, 10);

  r = await s.call("POST", "/api/verify", { challengeId: "fx-fix", code: "let b = a.clone();" });
  assert.equal(r.json.passed, false, "forbid rule");
  r = await s.call("POST", "/api/verify", { challengeId: "fx-boss", code: "fn main(){}" });
  assert.equal(r.json.passed, true, "stdin abc -> ABC via fake runner");

  await s.call("PUT", "/api/challenges/fx-complete/code", { code: "draft" });
  r = await s.call("GET", "/api/challenges/fx-complete");
  assert.equal(r.json.state.code, "draft");
  assert.equal(r.json.challenge.reference, undefined);
  r = await s.call("POST", "/api/challenges/fx-complete/reset");
  assert.equal(r.json.state.code, null);

  r = await s.call("GET", "/api/review");
  assert.deepEqual(r.json.cards.map((c) => c.id).sort(), ["fx-card-1", "fx-card-3"]);
  r = await s.call("POST", "/api/review/fx-card-1", { grade: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.progress.xp, 10 + 30 + 2);
  assert.equal((await s.call("POST", "/api/review/fx-card-1", { grade: 9 })).status, 400);
  assert.equal((await s.call("POST", "/api/review/fx-card-2", { grade: 2 })).status, 404);
  await s.close();
});

test("tool endpoints and input validation", async () => {
  const s = await start();
  assert.equal((await s.call("POST", "/api/format", { code: "fn main(){}  " })).json.code, "fn main(){}\n");
  assert.equal((await s.call("POST", "/api/check", { code: "fn main(){}" })).json.ok, true);
  assert.equal((await s.call("POST", "/api/run", { code: "fn main(){}", stdin: "x" })).json.run.stdout, "X");
  assert.equal((await s.call("GET", "/api/explain/E0382")).json.text, "explained");
  assert.equal((await s.call("POST", "/api/verify", { challengeId: "nope" })).status, 404);
  assert.equal((await s.call("POST", "/api/verify", { challengeId: "fx-fix" })).status, 400, "code required");
  assert.equal((await s.call("POST", "/api/check", { code: 5 })).status, 400);
  assert.equal((await s.call("POST", "/api/check", { code: "x".repeat(70 * 1024) })).status, 413);
  await s.close();
});

test("static files: SPA fallback and no path traversal", async () => {
  const s = await start();
  assert.match((await s.call("GET", "/")).text, /<title>t<\/title>/);
  assert.match((await s.call("GET", "/level/1")).text, /<title>t<\/title>/);
  assert.equal((await s.call("GET", "/missing.js")).status, 404);
  assert.notEqual((await s.call("GET", "/..%2f..%2fetc%2fpasswd")).status, 200);
  assert.equal((await s.call("GET", "/api/nope")).status, 404);
  await s.close();
});
