import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { BusyError, createLimiter, runLimited } from "../server/sandbox.mjs";

const hostEnv = { PATH: process.env.PATH };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("captures stdout, stderr and exit code under prlimit", async () => {
  const r = await runLimited({ argv: ["sh", "-c", "echo out; echo err >&2; exit 3"], env: hostEnv, timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.timedOut, false);
});

test("passes stdin through", async () => {
  const r = await runLimited({ argv: ["cat"], env: hostEnv, stdin: "abc", timeoutMs: 5000 });
  assert.equal(r.stdout, "abc");
});

test("wall timeout kills the whole process group, including background children", async () => {
  const r = await runLimited({ argv: ["sh", "-c", "sleep 30 & echo $!; sleep 30"], env: hostEnv, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, "SIGKILL");
  const childPid = Number(r.stdout.trim());
  assert.ok(childPid > 0);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(childPid), false, "background child must be killed with the group");
});

test("output cap truncates and kills a flooding program", async () => {
  const r = await runLimited({ argv: ["sh", "-c", "yes flood"], env: hostEnv, timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, 1000);
  assert.ok(r.durationMs < 4000);
});

test("RLIMIT_CPU stops a busy loop", async () => {
  const r = await runLimited({ argv: ["sh", "-c", "while :; do :; done"], env: hostEnv, timeoutMs: 10_000, limits: { cpuSeconds: 1 } });
  assert.equal(r.timedOut, false);
  assert.ok(["SIGXCPU", "SIGKILL"].includes(r.signal), `signal ${r.signal}`);
});

test("RLIMIT_AS bounds memory", async () => {
  // 64 MiB address space is not enough to start a second shell that allocates 200 MB.
  const r = await runLimited({
    argv: ["sh", "-c", "head -c 200000000 /dev/zero | tr '\\0' a | (v=$(cat); echo ${#v})"],
    env: hostEnv,
    timeoutMs: 10_000,
    limits: { asBytes: 64 * 1024 * 1024 },
  });
  assert.notEqual(r.stdout.trim(), "200000000");
});

test("spawn failure is reported, not thrown", async () => {
  const r = await runLimited({ argv: ["true"], env: hostEnv, timeoutMs: 1000, prlimitPath: "/nonexistent/prlimit" });
  assert.ok(r.spawnError);
});

test("limiter caps concurrency and rejects beyond the queue", async () => {
  const lim = createLimiter({ concurrency: 2, maxQueue: 1 });
  let peak = 0;
  let active = 0;
  const gate = [];
  const job = () =>
    lim.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => gate.push(r));
      active -= 1;
    });
  const a = job();
  const b = job();
  const c = job(); // queued
  await assert.rejects(job(), BusyError);
  assert.deepEqual(lim.stats(), { active: 2, waiting: 1, concurrency: 2 });
  gate.shift()();
  await a;
  await new Promise((r) => setTimeout(r, 10));
  gate.splice(0).forEach((g) => g());
  await new Promise((r) => setTimeout(r, 10));
  gate.splice(0).forEach((g) => g());
  await Promise.all([b, c]);
  assert.equal(peak, 2);
});

test("prlimit is available", () => {
  assert.match(execFileSync("prlimit", ["--version"]).toString(), /prlimit/);
});
