// CE-lane tutor: hint / explain / review / judge as one-shot pi-task-runner
// agent jobs (POST /v1/jobs, poll GET /v1/jobs/<id>). The browser never talks to
// the runner; it gets a local job id and polls /api/agent/jobs/<id> every 2 s.
//
// Invariants:
// - deterministic checks come first: explain only for failing code, review and
//   judge only for passing code (409 otherwise). The agent never decides a pass.
// - the reference solution is shown to the hint agent only from hint 3 on.
// - learner code is wrapped in nonce markers. Output must be one strict JSON
//   object that passes the tier's validator, otherwise the job counts as failed.
// - every non-success (runner down, failed, invalid output, 120 s timeout)
//   carries a static fallback so the learner is never left with nothing.
// - judge verdicts are cached by sha256(challengeId, code).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyChallenge } from "./verify.mjs";

export const TIERS = ["hint", "explain", "review", "judge"];
const FINAL = new Set(["done", "failed", "timeout", "unavailable"]);
const SOLUTION_HINT = 3;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- prompts

export function loadPrompts(dir) {
  const read = (name) => fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
  return Object.fromEntries(["frame", ...TIERS].map((n) => [n, read(n)]));
}

/** Single-pass {{key}} substitution: values are never re-scanned, so learner
 * code containing "{{nonce}}" or "{{reference}}" stays inert. */
export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

export function newNonce(...texts) {
  for (;;) {
    const n = crypto.randomBytes(9).toString("hex");
    if (!texts.some((t) => String(t).includes(n))) return n;
  }
}

/** Human-readable summary of a verifyChallenge() result for the prompt. */
export function summarizeCheck(result) {
  if (!result) return "(not checked)";
  const lines = [result.passed ? "PASSED all checks." : "NOT PASSING yet."];
  const diags = (result.compile?.diagnostics || []).filter((d) => d.level.startsWith("error"));
  for (const d of diags.slice(0, 5)) {
    if (d.inHarness) lines.push(`error (inside the hidden tests; usually a missing or wrong function signature): ${d.message}`);
    else lines.push(d.rendered ? d.rendered.trimEnd() : `error${d.code ? `[${d.code}]` : ""}: ${d.message}`);
  }
  if (diags.length > 5) lines.push(`... and ${diags.length - 5} more error(s)`);
  for (const c of result.cases || []) {
    if (c.name === "compile" && diags.length) continue;
    lines.push(`- ${c.name}: ${c.passed ? "ok" : "FAILED"}${!c.passed && c.message ? `: ${c.message}` : ""}`);
  }
  return lines.join("\n").slice(0, 12_000);
}

// ---------------------------------------------------------------- output parsing

/** Pull one JSON object out of an agent's stdout: the whole text, the last
 * ```json fence, or the outermost {...} span. */
export function extractJson(stdout) {
  const text = String(stdout || "").trim();
  const candidates = [text];
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  candidates.push(...fences.reverse());
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      // next candidate
    }
  }
  return null;
}

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Returns the normalized result, or throws with the reason it is invalid. */
export function validateResult(tier, v) {
  const bad = (why) => {
    throw new Error(`invalid ${tier} output: ${why}`);
  };
  if (!v) bad("no JSON object");
  switch (tier) {
    case "hint":
      if (!str(v.hint, 6000)) bad("hint");
      return { hint: v.hint.trim(), reveals_solution: v.reveals_solution === true };
    case "explain":
      if (!str(v.explanation, 6000)) bad("explanation");
      if (v.next_step !== undefined && typeof v.next_step !== "string") bad("next_step");
      return { explanation: v.explanation.trim(), next_step: (v.next_step || "").trim().slice(0, 600) };
    case "review": {
      if (!str(v.summary, 3000)) bad("summary");
      if (!Array.isArray(v.strengths) || !v.strengths.every((s) => str(s, 600))) bad("strengths");
      if (!Array.isArray(v.suggestions) || !v.suggestions.every((s) => s && str(s.title, 200) && str(s.detail, 3000))) bad("suggestions");
      if (!int(v.idiomatic_score, 1, 5)) bad("idiomatic_score");
      return {
        summary: v.summary.trim(),
        strengths: v.strengths.slice(0, 6).map((s) => s.trim()),
        suggestions: v.suggestions.slice(0, 6).map((s) => ({ title: s.title.trim(), detail: s.detail.trim() })),
        idiomatic_score: v.idiomatic_score,
      };
    }
    case "judge":
      if (typeof v.pass !== "boolean") bad("pass");
      if (!int(v.score, 0, 100)) bad("score");
      if (!str(v.feedback, 4000)) bad("feedback");
      // The rubric defines pass as score >= 70; never let the two disagree.
      return { pass: v.score >= 70, score: v.score, feedback: v.feedback.trim() };
    default:
      return bad("unknown tier");
  }
}

// ---------------------------------------------------------------- fallbacks

export function staticHint(ch, n) {
  const hints = ch.hints || [];
  if (!hints.length) return null;
  const i = Math.min(Math.max(1, n), hints.length) - 1;
  return `**Hint ${i + 1}/${hints.length}:** ${hints[i]}`;
}

function fallbackFor(tier, ch, ctx) {
  if (tier === "hint") return { text: staticHint(ch, ctx.hintNumber) || "No built-in hint for this challenge." };
  if (tier === "explain") {
    const failing = (ctx.check?.cases || []).filter((c) => !c.passed && c.message).map((c) => `- **${c.name}**: ${c.message}`);
    const parts = [];
    if (failing.length) parts.push(`What the checks say:\n\n${failing.join("\n")}`);
    parts.push("Read the Diagnostics tab; Ctrl+Shift+E on an error code opens `rustc --explain`.");
    const h = staticHint(ch, Math.max(1, ctx.hintsUsed || 1));
    if (h) parts.push(h);
    return { text: parts.join("\n\n") };
  }
  if (tier === "review") return { text: "Your solution passes every deterministic check. Compare it with the level's concepts: could any `.clone()` be a borrow, any `&String` be a `&str`?" };
  return { text: "Your solution passes every functional test; the idiom verdict needs the tutor and can be requested again later." };
}

// ---------------------------------------------------------------- runner client

export function createRunnerClient({ baseUrl, fetchImpl = globalThis.fetch, requestTimeoutMs = 5000 }) {
  const base = baseUrl.replace(/\/$/, "");
  async function call(method, p, body) {
    const res = await fetchImpl(`${base}${p}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // keep null
    }
    if (!res.ok) throw new Error(`runner ${method} ${p}: HTTP ${res.status}${json?.error ? ` ${json.error}` : ""}`);
    return json;
  }
  return {
    health: () => call("GET", "/healthz"),
    submit: (payload) => call("POST", "/v1/jobs", payload).then((r) => r.job),
    get: (id) => call("GET", `/v1/jobs/${encodeURIComponent(id)}`).then((r) => r.job || r),
    cancel: (id) => call("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}),
  };
}

// ---------------------------------------------------------------- agent

/**
 * @param {object} cfg
 * @param {ReturnType<typeof createRunnerClient>} cfg.runner
 * @param {Record<string,string>} cfg.prompts       loadPrompts()
 * @param {object} cfg.catalog
 * @param {object} cfg.store
 * @param {object} cfg.rust
 * @param {string} [cfg.role]                      pi role directory (~/.pi/<role>)
 * @param {number} [cfg.timeoutMs]                 hard limit per job (120 s)
 * @param {number} [cfg.maxActive]                 concurrent agent jobs
 * @param {() => number} [cfg.now]
 */
export function createAgent(cfg) {
  const { runner, prompts, catalog, store, rust } = cfg;
  const role = cfg.role || "chief-engineer";
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const maxActive = cfg.maxActive ?? 3;
  const now = cfg.now || (() => Date.now());
  const log = cfg.log || ((m) => console.log(m));
  const jobs = new Map();
  let health = { at: -Infinity, available: false, error: "not checked yet" };

  async function status({ fresh = false } = {}) {
    if (!fresh && now() - health.at < 15_000) return { available: health.available, ...(health.error ? { error: health.error } : {}) };
    try {
      const h = await runner.health();
      health = { at: now(), available: h?.status === "ok", error: h?.status === "ok" ? null : `runner status ${h?.status}` };
    } catch (e) {
      health = { at: now(), available: false, error: e.cause?.code || e.name === "TimeoutError" ? `runner unreachable (${e.cause?.code || "timeout"})` : e.message };
    }
    return { available: health.available, ...(health.error ? { error: health.error } : {}) };
  }

  function publicJob(j) {
    const out = { jobId: j.id, tier: j.tier, challengeId: j.challengeId, status: j.status };
    if (j.hintNumber !== undefined) out.hintNumber = j.hintNumber;
    if (j.result) out.result = j.result;
    if (j.cached) out.cached = true;
    if (j.error) out.error = j.error;
    if (j.status !== "done" && FINAL.has(j.status)) out.fallback = j.fallback;
    out.elapsedMs = (j.finishedAt ?? now()) - j.startedAt;
    return out;
  }

  function finish(j, st, { result, error } = {}) {
    j.status = st;
    j.finishedAt = now();
    if (result) j.result = result;
    if (error) j.error = error;
    if (st === "done" && j.tier === "judge") store.cachePut(j.cacheKey, "judge", result);
    log(`agent ${j.tier} ${j.challengeId} ${j.id} -> ${st}${error ? ` (${error})` : ""} ${j.finishedAt - j.startedAt}ms`);
  }

  async function refresh(j) {
    if (FINAL.has(j.status)) return j;
    if (now() - j.startedAt > timeoutMs) {
      finish(j, "timeout", { error: `no answer within ${Math.round(timeoutMs / 1000)} s` });
      runner.cancel(j.runnerId).catch(() => {});
      return j;
    }
    let rj;
    try {
      rj = await runner.get(j.runnerId);
    } catch (e) {
      j.pollErrors = (j.pollErrors || 0) + 1;
      if (j.pollErrors >= 5) finish(j, "failed", { error: `lost contact with the runner: ${e.message}` });
      return j;
    }
    j.pollErrors = 0;
    switch (rj.status) {
      case "queued":
      case "running":
        j.status = rj.status;
        break;
      case "succeeded":
        try {
          finish(j, "done", { result: validateResult(j.tier, extractJson(rj.stdout)) });
        } catch (e) {
          finish(j, "failed", { error: e.message });
        }
        break;
      case "timed_out":
        finish(j, "timeout", { error: "the agent run timed out" });
        break;
      default:
        finish(j, "failed", { error: `agent job ${rj.status}${rj.stderr ? `: ${String(rj.stderr).trim().split("\n").pop().slice(0, 200)}` : ""}` });
    }
    return j;
  }

  /** Cancels jobs nobody polls anymore and forgets old finished ones. */
  async function sweep() {
    for (const j of jobs.values()) {
      if (!FINAL.has(j.status)) await refresh(j);
      else if (now() - j.finishedAt > 15 * 60_000) jobs.delete(j.id);
    }
  }
  const sweeper = cfg.sweepMs === 0 ? null : setInterval(() => sweep().catch(() => {}), cfg.sweepMs ?? 10_000);
  sweeper?.unref();

  function promptFor(tier, ch, ctx) {
    const level = catalog.levels.find((l) => l.id === ch.levelId);
    const code = ctx.code ?? (ctx.answer ? `(prediction challenge; the learner's chosen answer id: ${ctx.answer})\n\n${ch.starter}` : ch.starter);
    const nonce = newNonce(code, ctx.checkSummary || "");
    const vars = {
      nonce,
      title: ch.title,
      kind: ch.kind,
      levelTitle: level?.title || ch.levelId,
      prompt: ch.prompt,
      code,
      checkSummary: ctx.checkSummary || "",
      reference: ch.check.kind === "choice" ? `(prediction challenge, correct answer id: ${ch.reference})` : ch.reference,
      rubric: ch.rubric || "Idiomatic, readable Rust that uses ownership and borrowing appropriately.",
      hintNumber: ctx.hintNumber ?? "",
      staticHints: (ch.hints || []).map((h, i) => `${i + 1}. ${h}`).join("\n") || "(none)",
      hintPolicy: "",
    };
    if (tier === "hint") {
      vars.hintPolicy =
        ctx.hintNumber >= SOLUTION_HINT
          ? [
              `This is hint ${ctx.hintNumber}: the learner has asked three times, so you MAY now show a complete working solution. Explain briefly why it works, and set "reveals_solution": true.`,
              "A reference solution (trusted, from the course author) that you can adapt to the learner's code:",
              "",
              "```rust",
              vars.reference,
              "```",
            ].join("\n")
          : `This is hint ${ctx.hintNumber}. Do NOT give the solution or write the corrected code. Ask a guiding question or point at the concept and the line that matters (Socratic). Each hint may be a bit more concrete than the previous one. "reveals_solution" must be false.`;
    }
    // Frame first (it holds {{nonce}}), then the task with the same nonce.
    return render(prompts[tier], { ...vars, frame: render(prompts.frame, { nonce }) });
  }

  /**
   * Starts an agent run. Returns the public job view (status queued/running,
   * or a final status for cached/unavailable answers).
   */
  async function start(tier, ch, { code, answer }) {
    if (!TIERS.includes(tier)) throw Object.assign(new Error("unknown tier"), { status: 404 });
    const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
    if (ch.check.kind === "choice" && (tier === "review" || tier === "judge")) throw conflict("Prediction challenges have no code to review.");
    if (tier === "judge" && ch.judge !== "agent") throw conflict("This challenge is checked by the compiler and tests only. Ask for a review instead.");
    if (ch.check.kind !== "choice" && (tier === "review" || tier === "judge" || tier === "explain") && !code?.trim()) throw conflict("Write some code first.");

    const ctx = { code, answer, hintsUsed: store.state(ch.id)?.hints_used ?? 0 };
    if (tier !== "hint" || code !== undefined || answer !== undefined) {
      ctx.check = await verifyChallenge(rust, ch, { code, answer });
      ctx.checkSummary = summarizeCheck(ctx.check);
    }
    if ((tier === "review" || tier === "judge") && !ctx.check.passed) throw conflict("The tutor reviews passing code only. Make the checks pass first (Ctrl+Shift+Enter).");
    if (tier === "explain" && ctx.check.passed) throw conflict("This code already passes every check. Ask for a review instead (Alt+R).");

    const id = crypto.randomUUID();
    const j = { id, tier, challengeId: ch.id, startedAt: now(), status: "queued" };
    if (tier === "judge") {
      j.cacheKey = `judge:${sha256(`${ch.id}\u0000${code}`)}`;
      const hit = store.cacheGet(j.cacheKey);
      if (hit) {
        Object.assign(j, { status: "done", result: hit, cached: true, finishedAt: now() });
        jobs.set(id, j);
        return publicJob(j);
      }
    }
    const active = [...jobs.values()].filter((x) => !FINAL.has(x.status)).length;
    if (active >= maxActive) throw Object.assign(new Error("The tutor is busy with other questions. Try again in a moment."), { status: 429 });
    if (tier === "hint") j.hintNumber = ctx.hintNumber = store.useHint(ch);
    j.fallback = fallbackFor(tier, ch, ctx);

    const st = await status({ fresh: health.available === false });
    if (!st.available) {
      Object.assign(j, { status: "unavailable", error: st.error, finishedAt: now() });
      jobs.set(id, j);
      return publicJob(j);
    }
    try {
      const rj = await runner.submit({
        executor: "agent",
        role,
        prompt: promptFor(tier, ch, ctx),
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        maxAttempts: 1,
        idempotencyKey: `rust-tutor:${tier}:${ch.id}:${id}`,
      });
      j.runnerId = rj.id;
      j.status = rj.status === "running" ? "running" : "queued";
    } catch (e) {
      health = { at: now(), available: false, error: e.message };
      Object.assign(j, { status: "unavailable", error: e.message, finishedAt: now() });
    }
    jobs.set(id, j);
    log(`agent ${tier} ${ch.id} ${id} -> ${j.status}${j.runnerId ? ` runner=${j.runnerId}` : ""}`);
    return publicJob(j);
  }

  async function poll(id) {
    const j = jobs.get(id);
    if (!j) return null;
    return publicJob(await refresh(j));
  }

  /** HTTP adapter for app.mjs: /api/agent/status | /api/agent/jobs/:id | /api/agent/:tier */
  async function handle(req, res, parts, h) {
    const route = `${req.method} ${parts[0] || ""}`;
    if (route === "GET status") return h.send(res, 200, await status());
    if (route === "GET jobs" && parts[1]) {
      const r = await poll(parts[1]);
      return r ? h.send(res, 200, r) : h.send(res, 404, { error: "unknown job" });
    }
    if (req.method === "POST" && TIERS.includes(parts[0]) && parts.length === 1) {
      const body = await h.readJson(req);
      const ch = h.challengeOr404(body.challengeId);
      try {
        const r = await start(parts[0], ch, { code: h.optString(body.code, "code"), answer: h.optString(body.answer, "answer", 64) });
        return h.send(res, 200, r.hintNumber !== undefined ? { ...r, progress: store.progress(catalog) } : r);
      } catch (e) {
        if (e.status) throw new h.HttpError(e.status, e.message);
        throw e;
      }
    }
    return h.send(res, 404, { error: "not found" });
  }

  return { handle, start, poll, status, sweep, promptFor, jobs, stop: () => sweeper && clearInterval(sweeper) };
}
