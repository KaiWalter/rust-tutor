// Bounded subprocess execution for rustc, rustfmt and student binaries.
//
// Every child runs:
//   - under prlimit (address space, CPU seconds, file size, open files, no core),
//   - as the leader of its own process group (detached), so a timeout or output
//     overflow kills the whole group, including anything the program forked,
//   - with a wall-clock timeout and a hard cap on captured stdout+stderr,
//   - with a scrubbed environment.
//
// Fork bombs are contained one level up by the container's cgroup pids limit
// (docker --pids-limit): RLIMIT_NPROC counts every process of the uid on the
// host, so it cannot be used as a per-run bound here.

import { spawn } from "node:child_process";

export const DEFAULT_ENV = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  HOME: "/tmp",
});

/**
 * @param {object} opts
 * @param {string[]} opts.argv
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {string} [opts.stdin]
 * @param {number} opts.timeoutMs              wall clock
 * @param {number} [opts.maxOutputBytes]       stdout+stderr combined
 * @param {{asBytes?:number, cpuSeconds?:number, fsizeBytes?:number, nofile?:number}} [opts.limits]
 * @param {string} [opts.prlimitPath]
 * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string,
 *   timedOut:boolean, truncated:boolean, durationMs:number, spawnError?:string}>}
 */
export function runLimited(opts) {
  const limits = opts.limits || {};
  const maxOut = opts.maxOutputBytes ?? 64 * 1024;
  const pl = [opts.prlimitPath || "prlimit", "--core=0"];
  if (limits.asBytes) pl.push(`--as=${limits.asBytes}`);
  if (limits.cpuSeconds) pl.push(`--cpu=${limits.cpuSeconds}`);
  if (limits.fsizeBytes) pl.push(`--fsize=${limits.fsizeBytes}`);
  if (limits.nofile) pl.push(`--nofile=${limits.nofile}`);
  const argv = [...pl, "--", ...opts.argv];

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env || DEFAULT_ENV,
        detached: true, // new session + process group; pgid == child.pid
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve(spawnFailure(e, started));
      return;
    }

    const out = [];
    const err = [];
    let seen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: group already gone.
      }
    };

    const take = (bucket) => (chunk) => {
      if (truncated) return;
      const room = maxOut - seen;
      if (chunk.length > room) {
        bucket.push(chunk.subarray(0, Math.max(0, room)));
        seen = maxOut;
        truncated = true;
        killGroup();
        return;
      }
      bucket.push(chunk);
      seen += chunk.length;
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    // EPIPE when the program exits without reading stdin is expected.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(spawnFailure(e, started));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap anything the program left behind in its group.
      killGroup();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

function spawnFailure(e, started) {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: Date.now() - started,
    spawnError: e?.code || e?.message || String(e),
  };
}

export class BusyError extends Error {
  constructor() {
    super("compiler busy, try again in a moment");
    this.status = 429;
  }
}

/** Counting semaphore with a bounded wait queue. */
export function createLimiter({ concurrency = 2, maxQueue = 8 } = {}) {
  let active = 0;
  const waiting = [];

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      active += 1;
      next();
    }
  }

  async function run(fn) {
    if (active >= concurrency) {
      if (waiting.length >= maxQueue) throw new BusyError();
      await new Promise((r) => waiting.push(r));
    } else {
      active += 1;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, stats: () => ({ active, waiting: waiting.length, concurrency }) };
}
