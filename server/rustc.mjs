// rustc / rustfmt front end: format, check, run, test, explain.
//
// No cargo, no crates: every request is a single-file crate compiled with
// edition 2021 in a fresh temp dir that is removed afterwards.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLimiter, DEFAULT_ENV, runLimited } from "./sandbox.mjs";

const MiB = 1024 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  compileTimeoutMs: 10_000,
  runTimeoutMs: 5_000,
  compile: { asBytes: 3072 * MiB, cpuSeconds: 15, fsizeBytes: 64 * MiB, nofile: 256 },
  program: { asBytes: 256 * MiB, cpuSeconds: 5, fsizeBytes: 1 * MiB, nofile: 64 },
  maxOutputBytes: 64 * 1024,
  maxDiagnosticBytes: 512 * 1024,
});

export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function assertSource(code) {
  if (typeof code !== "string") throw new SourceError("code must be a string");
  if (Buffer.byteLength(code) > MAX_SOURCE_BYTES) throw new SourceError("code exceeds 64 KiB");
  return code;
}

/**
 * Turn rustc --error-format=json stderr into diagnostics.
 * Spans past `userLines` belong to the hidden test harness: they are dropped
 * (their text is never echoed back) and the diagnostic is flagged `inHarness`.
 */
export function parseDiagnostics(stderr, { userLines = Infinity } = {}) {
  const out = [];
  for (const line of String(stderr).split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.$message_type && d.$message_type !== "diagnostic") continue;
    if (!d.message || !d.level || d.level === "failure-note") continue;
    // "aborting due to N previous errors" / "N warnings emitted" are summaries.
    if (!d.spans?.length && /^(aborting due to|\d+ warnings? emitted|some errors have detailed)/.test(d.message)) continue;

    const spans = (d.spans || []).map((s) => ({
      lineStart: s.line_start,
      colStart: s.column_start,
      lineEnd: s.line_end,
      colEnd: s.column_end,
      primary: Boolean(s.is_primary),
      label: s.label || null,
    }));
    const visible = spans.filter((s) => s.lineStart <= userLines);
    const inHarness = spans.length > 0 && visible.length === 0;
    const children = (d.children || [])
      .map((c) => ({
        level: c.level,
        message: c.message,
        spans: (c.spans || [])
          .filter((s) => s.line_start <= userLines)
          .map((s) => ({
            lineStart: s.line_start,
            colStart: s.column_start,
            lineEnd: s.line_end,
            colEnd: s.column_end,
            suggestion: s.suggested_replacement ?? null,
          })),
      }))
      .filter((c) => c.message);
    out.push({
      level: d.level, // error | warning | note | help | failure-note | error: internal compiler error
      message: d.message,
      code: d.code?.code || null,
      spans: visible,
      children,
      inHarness,
      // rendered text quotes source lines; withhold it for harness diagnostics.
      rendered: inHarness || visible.length !== spans.length ? null : d.rendered || null,
    });
  }
  return out;
}

/** Parse libtest's plain output into per-test results. */
export function parseTestOutput(stdout) {
  const cases = [];
  for (const m of String(stdout).matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    cases.push({ name: m[1], passed: m[2] === "ok", ignored: m[2] === "ignored" });
  }
  const failures = new Map();
  const blockRe = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:$|^test result:)/gm;
  for (const m of String(stdout).matchAll(blockRe)) failures.set(m[1], m[2].trim());
  for (const c of cases) if (!c.passed && failures.has(c.name)) c.message = failures.get(c.name);
  return cases;
}

const shortName = (n) => n.replace(/^.*::/, "");

export function createRust(cfg = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  const rustc = cfg.rustc || "rustc";
  const rustfmt = cfg.rustfmt || "rustfmt";
  const tmpRoot = cfg.tmpDir || os.tmpdir();
  const limiter = cfg.limiter || createLimiter({ concurrency: cfg.concurrency ?? 2, maxQueue: cfg.maxQueue ?? 8 });
  const explainCache = new Map();

  async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "rt-"));
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  function compileRun(argv, dir) {
    return runLimited({
      argv,
      cwd: dir,
      env: DEFAULT_ENV,
      timeoutMs: limits.compileTimeoutMs,
      maxOutputBytes: limits.maxDiagnosticBytes,
      limits: limits.compile,
    });
  }

  function baseArgs(dir, extra = []) {
    // Remap the temp dir so panic locations read `main.rs:7:5`, not `/tmp/rt-xyz/main.rs`.
    return [rustc, "--edition", "2021", "--crate-name", "main", "--error-format=json", `--remap-path-prefix=${dir}/=`, ...extra, path.join(dir, "main.rs")];
  }

  function compileOutcome(res, userLines) {
    const diagnostics = parseDiagnostics(res.stderr, { userLines });
    const errors = diagnostics.filter((d) => d.level.startsWith("error"));
    return {
      ok: res.exitCode === 0 && !res.timedOut,
      timedOut: res.timedOut,
      diagnostics,
      errorCount: errors.length,
      warningCount: diagnostics.filter((d) => d.level === "warning").length,
      errorCodes: [...new Set(errors.map((d) => d.code).filter(Boolean))],
      durationMs: res.durationMs,
      ...(res.spawnError ? { spawnError: res.spawnError } : {}),
    };
  }

  function program(binary, dir, stdin, args = []) {
    return runLimited({
      argv: [binary, ...args],
      cwd: dir,
      env: { ...DEFAULT_ENV, RUST_BACKTRACE: "0" },
      stdin,
      timeoutMs: limits.runTimeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      limits: limits.program,
    });
  }

  function programResult(r) {
    return {
      exitCode: r.exitCode,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      truncated: r.truncated,
      durationMs: r.durationMs,
    };
  }

  async function format(code) {
    assertSource(code);
    return limiter.run(async () => {
      const r = await runLimited({
        argv: [rustfmt, "--edition", "2021", "--emit", "stdout", "--quiet"],
        env: DEFAULT_ENV,
        stdin: code,
        timeoutMs: limits.compileTimeoutMs,
        maxOutputBytes: MAX_SOURCE_BYTES * 4,
        limits: limits.compile,
      });
      if (r.exitCode === 0 && !r.timedOut && !r.truncated) return { ok: true, code: r.stdout };
      return {
        ok: false,
        error: r.timedOut ? "rustfmt timed out" : (r.stderr || r.spawnError || "rustfmt failed").trim(),
      };
    });
  }

  async function check(code) {
    assertSource(code);
    return limiter.run(() =>
      withDir(async (dir) => {
        await fs.writeFile(path.join(dir, "main.rs"), code);
        const res = await compileRun(baseArgs(dir, ["--crate-type", "bin", "--emit=metadata", "-o", path.join(dir, "main.rmeta")]), dir);
        return compileOutcome(res, Infinity);
      }),
    );
  }

  /** Compile once, then run the binary once per stdin (at least once). */
  async function run(code, stdins = [""]) {
    assertSource(code);
    return limiter.run(() =>
      withDir(async (dir) => {
        await fs.writeFile(path.join(dir, "main.rs"), code);
        const bin = path.join(dir, "main");
        const res = await compileRun(baseArgs(dir, ["-C", "opt-level=0", "-C", "debuginfo=0", "-o", bin]), dir);
        const compile = compileOutcome(res, Infinity);
        if (!compile.ok) return { compile, runs: [] };
        const runs = [];
        for (const stdin of stdins) runs.push(programResult(await program(bin, dir, stdin)));
        return { compile, runs };
      }),
    );
  }

  /**
   * Append a hidden #[test] harness to the student's code and run it with
   * libtest. Diagnostics inside the harness are reported without source.
   */
  async function test(code, harness) {
    assertSource(code);
    const userLines = code.split("\n").length;
    const source = `${code}\n\n${harness}\n`;
    return limiter.run(() =>
      withDir(async (dir) => {
        await fs.writeFile(path.join(dir, "main.rs"), source);
        const bin = path.join(dir, "tests");
        const res = await compileRun(
          baseArgs(dir, ["--test", "-A", "dead_code", "-A", "unused", "-C", "opt-level=0", "-C", "debuginfo=0", "-o", bin]),
          dir,
        );
        const compile = compileOutcome(res, userLines);
        if (!compile.ok) return { compile, cases: [], run: null };
        // One thread: deterministic order and a single test at a time under the rlimits.
        const r = await program(bin, dir, "", ["--test-threads=1", "--color=never"]);
        // Bound harness names to their short form; module paths are internal.
        const cases = parseTestOutput(r.stdout).map((c) => ({ ...c, name: shortName(c.name) }));
        return { compile, cases, run: programResult(r) };
      }),
    );
  }

  async function explain(errorCode) {
    if (!/^E\d{4}$/.test(String(errorCode))) throw new SourceError("error code must look like E0382");
    if (explainCache.has(errorCode)) return explainCache.get(errorCode);
    const r = await limiter.run(() =>
      runLimited({
        argv: [rustc, "--explain", errorCode],
        env: DEFAULT_ENV,
        timeoutMs: limits.compileTimeoutMs,
        maxOutputBytes: 256 * 1024,
        limits: limits.compile,
      }),
    );
    const result = r.exitCode === 0 ? { code: errorCode, text: r.stdout } : { code: errorCode, text: null, error: (r.stderr || "unknown error code").trim() };
    if (r.exitCode === 0) explainCache.set(errorCode, result);
    return result;
  }

  async function version() {
    const [c, f] = await Promise.all(
      [rustc, rustfmt].map((bin) => runLimited({ argv: [bin, "--version"], env: DEFAULT_ENV, timeoutMs: 5_000, limits: limits.compile })),
    );
    return { rustc: c.stdout.trim() || null, rustfmt: f.stdout.trim() || null };
  }

  return { format, check, run, test, explain, version, limiter, limits };
}
