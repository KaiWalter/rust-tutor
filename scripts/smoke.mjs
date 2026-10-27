// API smoke against a running instance: format/check/run/verify round trips,
// limits (infinite loop, memory hog, fork bomb, output flood), restart-safe progress.
// Usage: BASE=https://localhost:5020 NODE_EXTRA_CA_CERTS=<ca.crt> node scripts/smoke.mjs
// (CA=<ca.crt> is accepted as a shortcut and re-execs with NODE_EXTRA_CA_CERTS.)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CA && !process.env.NODE_EXTRA_CA_CERTS) {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: process.env.CA } });
  process.exit(r.status ?? 1);
}

const BASE = process.env.BASE || "https://localhost:5020";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

async function call(method, p, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), ms: Date.now() - t0 };
}

function expect(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const h = await call("GET", "/healthz");
expect("healthz 200", h.status === 200 && h.json.status === "ok", JSON.stringify(h.json));

const f = await call("POST", "/api/format", { code: "fn main(){let x=1;println!(\"{}\",x);}" });
expect("format via rustfmt", f.json?.ok && f.json.code.includes("    let x = 1;"), `${f.ms}ms`);

const c = await call("POST", "/api/check", { code: 'fn main() {\n    let s = String::from("a");\n    let t = s;\n    println!("{}", s);\n}\n' });
const prim = c.json?.diagnostics?.[0]?.spans?.find((s) => s.primary);
expect("check -> E0382 at 4:20", c.json?.errorCodes?.includes("E0382") && prim?.lineStart === 4 && prim?.colStart === 20, `${c.ms}ms ${JSON.stringify(prim)}`);

const r = await call("POST", "/api/run", { code: 'fn main() { println!("hello from rustc"); }' });
expect("run prints", r.json?.run?.stdout === "hello from rustc\n", `${r.ms}ms`);

const loop = await call("POST", "/api/run", { code: "fn main() { loop {} }" });
expect("infinite loop killed at 5s", loop.json?.run?.timedOut === true && loop.ms < 8000, `${loop.ms}ms`);

const hog = await call("POST", "/api/run", { code: "fn main() { let mut v: Vec<Vec<u8>> = Vec::new(); loop { v.push(vec![1u8; 1 << 20]); } }" });
expect("memory hog aborted by RLIMIT_AS", hog.json?.run?.signal === "SIGABRT", `${hog.ms}ms ${hog.json?.run?.stderr?.split("\n")[0]}`);

const bomb = await call("POST", "/api/run", {
  code: 'use std::process::Command;\nfn main() { for _ in 0..100000 { let _ = Command::new("/proc/self/exe").spawn(); } }',
});
expect("fork bomb contained and killed", bomb.json?.run?.timedOut === true || bomb.json?.run?.exitCode !== null, `${bomb.ms}ms`);
const after = await call("POST", "/api/run", { code: 'fn main() { println!("still alive"); }' });
expect("compiler usable right after fork bomb", after.json?.run?.stdout === "still alive\n", `${after.ms}ms`);

const flood = await call("POST", "/api/run", { code: 'fn main() { loop { println!("flood"); } }' });
expect("output flood truncated", flood.json?.run?.truncated === true, `${flood.ms}ms`);

const ex = await call("GET", "/api/explain/E0499");
expect("explain E0499", /mutabl/i.test(ex.json?.text || ""), `${ex.ms}ms`);

// Verify the first compiled challenge of level 1 with its reference (read from the repo).
const lessonsDir = process.env.LESSONS_DIR || path.join(root, "lessons");
const files = fs.readdirSync(lessonsDir).filter((x) => x.endsWith(".json")).sort();
if (files.length) {
  const level = JSON.parse(fs.readFileSync(path.join(lessonsDir, files[0]), "utf8"));
  const ch = level.challenges.find((x) => x.check.kind !== "choice");
  const v = await call("POST", "/api/verify", { challengeId: ch.id, code: ch.reference });
  expect(`verify ${ch.id} reference passes`, v.json?.passed === true, `${v.ms}ms`);
  const s = await call("POST", "/api/verify", { challengeId: ch.id, code: ch.starter });
  expect(`verify ${ch.id} starter fails`, s.status === 200 && s.json?.passed === false, `${s.ms}ms`);
}

const p = await call("GET", "/api/progress");
expect("progress readable", typeof p.json?.xp === "number", `xp=${p.json?.xp} streak=${p.json?.streak} due=${p.json?.reviewDue}`);

console.log(failures ? `\n${failures} FAILED` : "\nsmoke OK");
process.exit(failures ? 1 : 0);
