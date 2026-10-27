// End-to-end check of the CE-lane tutor against a running instance with the
// real pi-task-runner behind it: hint 1..3 (solution only at 3), explain on
// failing code, review and judge on passing code, judge cache hit.
// With EXPECT=unavailable it instead proves the fallback path (runner down).
//
// Usage: BASE=https://localhost:5020 CA=~/.local/share/lan-tls/ca.crt node scripts/agent-e2e.mjs
//   env: LESSONS_DIR (reads starters/references), CHALLENGE (a judged challenge id;
//        default: first `judge: agent` challenge), EXPECT=done|unavailable

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE || "https://localhost:5020").replace(/\/$/, "");
const EXPECT = process.env.EXPECT || "done";
const lessonsDir = process.env.LESSONS_DIR || path.join(root, "lessons");
const ca = process.env.CA ? fs.readFileSync(process.env.CA) : undefined;

const levels = fs
  .readdirSync(lessonsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(lessonsDir, f), "utf8")));
const all = levels.flatMap((l) => l.challenges);
const ch = all.find((c) => c.id === process.env.CHALLENGE) || all.find((c) => c.judge === "agent");
if (!ch) throw new Error("no judged challenge found");

function call(method, p, body) {
  const url = new URL(`/api${p}`, BASE);
  const payload = body ? JSON.stringify(body) : undefined;
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, ca, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

let failures = 0;
function expect(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures += 1;
}

async function ask(tier, body) {
  const t0 = Date.now();
  let r = await call("POST", `/agent/${tier}`, { challengeId: ch.id, ...body });
  if (r.status !== 200) return { http: r.status, error: r.json?.error, ms: Date.now() - t0 };
  let j = r.json;
  while (j.status === "queued" || j.status === "running") {
    await new Promise((res) => setTimeout(res, 2000));
    j = (await call("GET", `/agent/jobs/${j.jobId}`)).json;
  }
  return { ...j, ms: Date.now() - t0 };
}

const short = (s) => JSON.stringify(s).slice(0, 220);
console.log(`challenge ${ch.id} (${ch.kind}) via ${BASE}, expecting ${EXPECT}`);
const st = (await call("GET", "/agent/status")).json;
expect(`status available=${EXPECT === "done"}`, st.available === (EXPECT === "done"), short(st));

if (EXPECT === "unavailable") {
  const h = await ask("hint", { code: ch.starter });
  expect("hint falls back to a static hint", h.status === "unavailable" && /Hint \d+\/\d+/.test(h.fallback?.text || ""), short(h));
  const e = await ask("explain", { code: ch.starter });
  expect("explain falls back with check results", e.status === "unavailable" && Boolean(e.fallback?.text), short(e));
  const v = await ask("review", { code: ch.reference });
  expect("review falls back", v.status === "unavailable" && Boolean(v.fallback?.text), short(v));
} else {
  const hints = [];
  for (let i = 0; i < 3; i++) {
    const h = await ask("hint", { code: ch.starter });
    hints.push(h);
    expect(`hint ${h.hintNumber}: done in ${Math.round(h.ms / 1000)} s`, h.status === "done" && typeof h.result?.hint === "string", short(h.result || h));
  }
  expect("hints 1-2 do not reveal the solution", hints.slice(0, 2).every((h) => h.result?.reveals_solution === false));
  expect("hint 3 may reveal the solution", hints[2].status === "done", `reveals_solution=${hints[2].result?.reveals_solution}`);

  const e = await ask("explain", { code: ch.starter });
  expect(`explain on the failing starter: done in ${Math.round(e.ms / 1000)} s`, e.status === "done" && Boolean(e.result?.explanation), short(e.result || e));
  expect("explain on passing code is refused (409)", (await ask("explain", { code: ch.reference })).http === 409);

  expect("review on failing code is refused (409)", (await ask("review", { code: ch.starter })).http === 409);
  const v = await ask("review", { code: ch.reference });
  expect(`review of the reference: done in ${Math.round(v.ms / 1000)} s`, v.status === "done" && Number.isInteger(v.result?.idiomatic_score), short(v.result || v));

  const marker = `// e2e ${Date.now()}`;
  const j1 = await ask("judge", { code: `${ch.reference}${marker}\n` });
  expect(`judge of the reference: done in ${Math.round(j1.ms / 1000)} s`, j1.status === "done" && typeof j1.result?.pass === "boolean", short(j1.result || j1));
  const j2 = await ask("judge", { code: `${ch.reference}${marker}\n` });
  expect("judge cached for identical code", j2.status === "done" && j2.cached === true && j2.result?.score === j1.result?.score, `${j2.ms} ms`);
}

console.log(failures ? `\n${failures} FAILED` : "\nagent e2e OK");
process.exit(failures ? 1 : 0);
