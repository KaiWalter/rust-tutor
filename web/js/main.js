// rust-tutor single-page app: level map, challenge workspace (lesson | editor |
// output), review queue, CE-lane tutor panel. Keyboard-first; see KEYS.

import { ApiError, get, post, put } from "./api.js";
import { createEditor } from "./editor.js";
import { esc, md } from "./md.js";
import { mountVisual } from "./visual.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const KEYS = [
  ["Ctrl+Enter", "Run"],
  ["Ctrl+B", "Check (rustc, no run)"],
  ["Ctrl+Shift+Enter", "Submit to hidden tests"],
  ["Shift+Alt+F", "Format with rustfmt"],
  ["Alt+Shift+Backspace", "Reset to starter code"],
  ["Ctrl+Shift+E", "Explain the error code at the cursor"],
  ["Alt+H", "Tutor hint (Socratic; full solution only from the 3rd hint)"],
  ["Alt+E", "Tutor: explain why my attempt fails"],
  ["Alt+R", "Tutor: review my passing solution"],
  ["Alt+N / Alt+P", "Next / previous challenge"],
  ["Alt+1 … Alt+4", "Output / Tests / Diagnostics / Tutor tab"],
  ["1 … 9", "Pick an answer (predict challenges, outside the editor)"],
  ["← / →", "Step the memory visualizer (when focused)"],
  ["Alt+M", "Level map"],
  ["Alt+V", "Review queue"],
  ["Space, 1–4", "Review: reveal card, then grade again/hard/good/easy"],
  ["Esc", "Close overlay / return focus to the editor"],
  ["?", "This help"],
];

const S = {
  levels: [],
  progress: null,
  view: null,
  cur: null, // { levelId, challenge, state }
  answer: null,
  lastVerify: null,
  saveTimer: null,
  loadingCode: false,
  ed: null,
  vis: null,
  agentOk: null,
  busy: new Set(),
  review: { cards: [], i: 0, shown: false },
};

// ---------------------------------------------------------------- helpers

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), err ? 6000 : 3500);
}

function status(msg, kind = "") {
  const s = $("#statusline");
  s.textContent = msg;
  s.className = `statusline ${kind}`;
}

function overlay(html) {
  $("#overlay-body").innerHTML = html;
  $("#overlay").hidden = false;
  $("#overlay-close").focus();
}

function closeOverlay() {
  if ($("#overlay").hidden) return false;
  $("#overlay").hidden = true;
  if (S.view === "challenge") S.ed?.editor.focus();
  return true;
}

function levelOf(id) {
  return S.levels.find((l) => l.id === id);
}

function progressOf(levelId) {
  return S.progress?.levels.find((l) => l.id === levelId);
}

function chProgress(levelId, chId) {
  return progressOf(levelId)?.challenges.find((c) => c.id === chId);
}

/** A challenge is open when its level is unlocked and the previous one is passed. */
function chUnlocked(level, idx) {
  const lp = progressOf(level.id);
  if (!lp?.unlocked) return false;
  return idx === 0 || Boolean(lp.challenges[idx - 1]?.passed) || Boolean(lp.challenges[idx]?.passed);
}

function setProgress(p) {
  if (!p) return;
  S.progress = p;
  $("#stat-xp").textContent = `${p.xp} XP`;
  $("#stat-streak").textContent = `🔥 ${p.streak}`;
  $("#stat-streak").classList.toggle("idle", !p.activeToday);
  $("#stat-streak").title = p.activeToday ? `Daily streak: ${p.streak} day(s), today counted` : `Daily streak: ${p.streak} day(s); solve or review something today to keep it`;
  const r = $("#stat-review");
  r.textContent = `${p.reviewDue} due`;
  r.classList.toggle("has-due", p.reviewDue > 0);
}

async function guarded(name, fn) {
  if (S.busy.has(name)) return;
  S.busy.add(name);
  const btn = $(`[data-action="${name}"]`);
  btn?.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof ApiError && e.status === 429 ? "The compiler is busy, try again in a moment." : e.message;
    status(msg, "err");
    toast(msg, true);
  } finally {
    S.busy.delete(name);
    btn?.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- tabs

function showTab(name) {
  for (const b of $$(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of $$(".tabpanel")) p.hidden = p.dataset.panel !== name;
}

// ---------------------------------------------------------------- rendering: output

function renderCompile(compile) {
  S.ed.setDiagnostics(compile?.diagnostics || []);
  const diags = (compile?.diagnostics || []).filter((d) => d.level !== "note" && d.level !== "help");
  const errors = diags.filter((d) => d.level.startsWith("error")).length;
  const warnings = diags.filter((d) => d.level === "warning").length;
  const badge = $("#diag-count");
  badge.textContent = errors || warnings || "";
  badge.className = `badge${errors ? "" : " warn"}`;
  const host = $("#diagnostics");
  if (!diags.length) {
    host.innerHTML = `<p class="empty">${compile ? "No diagnostics. rustc is happy." : "Run, Check or Submit to see rustc diagnostics."}</p>`;
    return { errors, warnings };
  }
  host.innerHTML = diags
    .map((d, i) => {
      const p = d.spans.find((s) => s.primary) || d.spans[0];
      const loc = p ? `line ${p.lineStart}:${p.colStart}` : d.inHarness ? "in the hidden tests" : "";
      const kids = d.children.length ? `<ul>${d.children.map((c) => `<li><b>${esc(c.level)}</b>: ${esc(c.message)}</li>`).join("")}</ul>` : "";
      const label = p?.label ? `<div class="ui-muted">${esc(p.label)}</div>` : "";
      return `<div class="diag ${d.level.startsWith("error") ? "error" : "warning"}" data-diag="${i}" ${p ? `data-line="${p.lineStart}" data-col="${p.colStart}"` : ""}>
        <div class="diag-head">${d.code ? `<button class="ecode" data-explain="${esc(d.code)}" title="Explain ${esc(d.code)}">${esc(d.code)}</button>` : ""}
        <span>${esc(d.message)}</span><span class="diag-loc">${esc(loc)}</span></div>${label}${kids}</div>`;
    })
    .join("");
  return { errors, warnings };
}

function renderRun(run, compile) {
  const out = $("#out");
  if (!compile.ok) {
    out.innerHTML = `<span class="stderr">compilation failed: ${compile.errorCount} error(s)${compile.timedOut ? " (10 s compile limit)" : ""}. See Diagnostics.</span>`;
    return;
  }
  if (!run) {
    out.innerHTML = `<span class="meta">(not run)</span>`;
    return;
  }
  const meta = [];
  if (run.timedOut) meta.push("killed: 5 s time limit");
  if (run.truncated) meta.push("killed: output limit (64 KiB)");
  if (run.signal && !run.timedOut && !run.truncated) meta.push(`killed by ${run.signal}`);
  if (run.exitCode !== null && run.exitCode !== 0) meta.push(`exit code ${run.exitCode}${run.exitCode === 101 ? " (panic)" : ""}`);
  meta.push(`${run.durationMs} ms`);
  out.innerHTML = `${esc(run.stdout) || '<span class="meta">(no output)</span>'}${run.stderr ? `\n<span class="stderr">${esc(run.stderr)}</span>` : ""}\n<span class="meta">— ${esc(meta.join(" · "))}</span>`;
}

function renderVerify(r) {
  const host = $("#tests");
  const head = r.passed
    ? `<div class="verdict pass">✓ Passed${r.firstPass ? ` · +${r.xpAwarded} XP` : " (already solved)"}</div>`
    : `<div class="verdict fail">✗ Not yet: ${r.cases.filter((c) => !c.passed).length} of ${r.cases.length} check(s) failing</div>`;
  host.innerHTML =
    head +
    r.cases
      .map(
        (c) => `<div class="case"><div class="case-head"><span class="ui-status ui-status--${c.passed ? "success" : "danger"}">${c.passed ? "pass" : "fail"}</span>${esc(c.name)}</div>${
          c.message && !c.passed ? `<pre>${esc(c.message)}</pre>` : ""
        }</div>`,
      )
      .join("");
}

// ---------------------------------------------------------------- tutor (CE-lane)

const TIER_LABEL = { hint: "Hint", explain: "Why it fails", review: "Code review", judge: "Judge" };

function tutorCard(tier, cls = "pending") {
  const el = document.createElement("div");
  el.className = `tutor-msg ${cls}`;
  el.innerHTML = `<h4>${TIER_LABEL[tier]}</h4><div class="body ui-muted">Asking the tutor… (up to 2 minutes)</div>`;
  $("#tutor").prepend(el);
  $("#tutor .empty")?.remove();
  return el;
}

function renderAgentResult(tier, r) {
  if (r.status === "unavailable" || r.status === "failed" || r.status === "timeout") {
    const why = r.status === "timeout" ? "The tutor took too long (120 s)." : r.status === "failed" ? "The tutor run failed." : "The tutor (CE lane) is offline.";
    const fb = r.fallback?.text ? `<div>${md(r.fallback.text)}</div>` : "";
    return `<p class="ui-muted">${why}${fb ? " Here is a built-in hint instead:" : ""}${r.error ? ` <small>(${esc(r.error)})</small>` : ""}</p>${fb}`;
  }
  const x = r.result || {};
  if (tier === "hint")
    return `${md(x.hint)}${r.hintNumber ? `<p class="ui-muted"><small>hint ${r.hintNumber}${x.reveals_solution ? " · reveals the solution" : ""}</small></p>` : ""}`;
  if (tier === "explain") return `${md(x.explanation)}${x.next_step ? `<p><b>Next step:</b> ${esc(x.next_step)}</p>` : ""}`;
  if (tier === "review")
    return `<div class="score">${"★".repeat(x.idiomatic_score || 0)}${"☆".repeat(5 - (x.idiomatic_score || 0))}</div>${md(x.summary)}
      ${x.strengths?.length ? `<h4>Strengths</h4><ul>${x.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${x.suggestions?.length ? `<h4>Suggestions</h4>${x.suggestions.map((s) => `<p><b>${esc(s.title)}</b><br>${md(s.detail)}</p>`).join("")}` : ""}`;
  if (tier === "judge")
    return `<div class="score">${x.pass ? "✓" : "✗"} ${esc(x.score)}/100</div>${md(x.feedback)}${r.cached ? '<p class="ui-muted"><small>cached verdict for this exact code</small></p>' : ""}`;
  return `<pre>${esc(JSON.stringify(x, null, 2))}</pre>`;
}

async function askAgent(tier) {
  if (!S.cur) return;
  const ch = S.cur.challenge;
  showTab("tutor");
  const card = tutorCard(tier);
  const finish = (r) => {
    card.className = `tutor-msg ${r.status === "done" ? "" : "fallback"}`;
    $(".body", card).className = "body";
    $(".body", card).innerHTML = renderAgentResult(tier, r);
    if (r.progress) setProgress(r.progress);
    if (tier === "hint" && typeof r.hintNumber === "number") S.cur.state.hintsUsed = r.hintNumber;
    status(r.status === "done" ? `${TIER_LABEL[tier]} ready` : `${TIER_LABEL[tier]}: ${r.status}`, r.status === "done" ? "ok" : "err");
  };
  try {
    const body = { challengeId: ch.id, code: ch.kind === "predict" ? undefined : S.ed.getValue(), answer: S.answer ?? undefined };
    let r = await post(`/agent/${tier}`, body);
    const t0 = Date.now();
    while (r.jobId && (r.status === "queued" || r.status === "running")) {
      $(".body", card).textContent = `Tutor is ${r.status}… ${Math.round((Date.now() - t0) / 1000)} s`;
      await new Promise((res) => setTimeout(res, 2000));
      r = await get(`/agent/jobs/${encodeURIComponent(r.jobId)}`);
    }
    finish(r);
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return finish({ status: "unavailable", error: "tutor endpoint not available" });
    if (e instanceof ApiError && e.status === 409) {
      card.className = "tutor-msg fallback";
      $(".body", card).innerHTML = `<p>${esc(e.message)}</p>`;
      return null;
    }
    finish({ status: "failed", error: e.message });
    return null;
  }
}

async function refreshAgentStatus() {
  const el = $("#stat-agent");
  try {
    const s = await get("/agent/status");
    S.agentOk = Boolean(s.available);
    el.textContent = S.agentOk ? "tutor online" : "tutor offline";
    el.title = S.agentOk ? "CE lane reachable: hints, review and judge use the agent" : `CE lane unreachable${s.error ? `: ${s.error}` : ""}. Built-in hints still work.`;
  } catch {
    S.agentOk = false;
    el.textContent = "tutor offline";
    el.title = "CE lane not configured. Built-in hints only.";
  }
  el.className = `stat ${S.agentOk ? "ok" : "down"}`;
}

// ---------------------------------------------------------------- actions

const actions = {
  run: () =>
    guarded("run", async () => {
      status("compiling + running…");
      const r = await post("/run", { code: S.ed.getValue(), stdin: $("#stdin").value });
      const { errors } = renderCompile(r.compile);
      renderRun(r.run, r.compile);
      showTab(errors ? "diagnostics" : "output");
      status(errors ? `${errors} error(s)` : `ran in ${r.run?.durationMs ?? "?"} ms`, errors ? "err" : "ok");
    }),
  check: () =>
    guarded("check", async () => {
      status("rustc check…");
      const c = await post("/check", { code: S.ed.getValue() });
      const { errors, warnings } = renderCompile(c);
      if (errors || warnings) showTab("diagnostics");
      status(errors ? `${errors} error(s), ${warnings} warning(s)` : warnings ? `compiles with ${warnings} warning(s)` : `compiles cleanly (${c.durationMs} ms)`, errors ? "err" : "ok");
    }),
  format: () =>
    guarded("format", async () => {
      if (S.ed.readOnly) return;
      await S.ed.format();
    }),
  verify: () =>
    guarded("verify", async () => {
      const ch = S.cur.challenge;
      if (ch.kind === "predict" && !S.answer) return status("Pick an answer first (keys 1–9).", "err");
      status("submitting to hidden tests…");
      const r = await post("/verify", { challengeId: ch.id, code: ch.kind === "predict" ? undefined : S.ed.getValue(), answer: S.answer ?? undefined });
      S.lastVerify = r;
      S.cur.state.attempts += 1;
      if (r.compile) renderCompile(r.compile);
      renderVerify(r);
      setProgress(r.progress);
      showTab("tests");
      if (r.passed) {
        S.cur.state.passed = true;
        status(r.firstPass ? `passed! +${r.xpAwarded} XP` : "passed", "ok");
        if (r.firstPass) toast(`✓ ${ch.title}: +${r.xpAwarded} XP${r.unlockedCards?.length ? ` · ${r.unlockedCards.length} review card(s) unlocked` : ""}`);
        renderLesson();
        if (ch.judged) askAgent("judge");
      } else {
        status("not yet. See Tests" + (r.compile && !r.compile.ok ? " and Diagnostics" : ""), "err");
      }
      if (ch.kind === "predict") renderPredict();
    }),
  reset: () =>
    guarded("reset", async () => {
      const ch = S.cur.challenge;
      if (!confirm(`Reset "${ch.title}" to the starter code? (Ctrl+Z undoes it)`)) return;
      const v = await post(`/challenges/${encodeURIComponent(ch.id)}/reset`);
      S.cur.state = v.state;
      S.answer = null;
      S.ed.setValue(ch.starter);
      if (ch.kind === "predict") renderPredict();
      status("reset to starter");
    }),
  hint: () => askAgent("hint"),
  explain: () => {
    if (S.cur?.challenge.kind === "predict" && !S.cur.state.attempts) return status("Make a prediction first.", "err");
    return askAgent("explain");
  },
  review: () => {
    if (!S.cur?.state.passed) return status("Review is for passing solutions. Submit one first.", "err");
    return askAgent("review");
  },
};

async function explainCode(code) {
  if (!code) return status("No error code at the cursor. Check first.", "err");
  overlay(`<h2>${esc(code)}</h2><p class="ui-muted">loading rustc --explain…</p>`);
  try {
    const r = await get(`/explain/${encodeURIComponent(code)}`);
    overlay(`<h2>${esc(code)} <small class="ui-muted">rustc --explain</small></h2>${r.text ? md(r.text) : `<p>${esc(r.error || "no explanation")}</p>`}`);
  } catch (e) {
    overlay(`<h2>${esc(code)}</h2><p>${esc(e.message)}</p>`);
  }
}

function scheduleSave() {
  if (S.loadingCode || !S.cur || S.cur.challenge.kind === "predict") return;
  clearTimeout(S.saveTimer);
  const id = S.cur.challenge.id;
  const code = S.ed.getValue();
  S.saveTimer = setTimeout(() => put(`/challenges/${encodeURIComponent(id)}/code`, { code }).catch(() => status("could not save code", "err")), 800);
}

// ---------------------------------------------------------------- views

function crumbs(parts) {
  $("#crumbs").innerHTML = parts.map(([label, href]) => (href ? `<a href="${href}">${esc(label)}</a>` : esc(label))).join(" › ");
}

function switchView(name) {
  S.view = name;
  for (const v of ["map", "review", "challenge"]) $(`#view-${v}`).hidden = v !== name;
}

function renderMap() {
  switchView("map");
  crumbs([["Level map"]]);
  const firstOpen = S.progress.levels.find((l) => l.unlocked && !l.complete);
  $("#view-map").innerHTML = `<div class="map-inner">
    <h1>Track 1: Ownership to Error Handling</h1>
    <p class="ui-muted">Five levels. Beat a level's boss challenge to unlock the next. Passed challenges add review cards to your spaced-repetition queue.</p>
    <div class="levels">${S.levels
      .map((l) => {
        const p = progressOf(l.id);
        const cls = [!p.unlocked && "locked", p.complete && "complete", firstOpen?.id === l.id && "current"].filter(Boolean).join(" ");
        const pct = Math.round((100 * p.passed) / p.total);
        return `<a class="ui-card level-card ${cls}" href="${p.unlocked ? `#/l/${l.id}` : "#/map"}" style="color:inherit;text-decoration:none" ${p.unlocked ? "" : 'aria-disabled="true"'}>
          <div class="level-num">${p.complete ? "✓" : l.order}</div>
          <div><h3>${esc(l.title)}</h3><p class="ui-muted">${esc(l.quest.title)}: ${esc(l.summary)}</p><div class="progressbar"><div style="width:${pct}%"></div></div></div>
          <div class="ui-status ui-status--${p.complete ? "success" : p.unlocked ? "neutral" : "warning"}">${p.unlocked ? `${p.passed}/${p.total}` : "🔒 beat the previous boss"}</div></a>`;
      })
      .join("")}</div></div>`;
  $(".level-card.current, .level-card:not(.locked)")?.focus();
}

function renderPredict() {
  const box = $("#choices");
  const ch = S.cur.challenge;
  if (ch.kind !== "predict") {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="choices-title">What happens when this compiles and runs? Pick with <kbd>1</kbd>–<kbd>${ch.choices.length}</kbd>, then Submit.${
    S.cur.state.attempts ? " Check and Run are unlocked now. Ask rustc." : " Check and Run unlock after your first prediction."
  }</div>${ch.choices
    .map((c, i) => `<button class="choice" data-choice="${esc(c.id)}" aria-pressed="${S.answer === c.id}"><kbd>${i + 1}</kbd><span>${esc(c.label)}</span></button>`)
    .join("")}`;
  const locked = !S.cur.state.attempts;
  for (const a of ["run", "check"]) $(`[data-action="${a}"]`).disabled = locked;
}

function choose(id) {
  S.answer = id;
  renderPredict();
  put(`/challenges/${encodeURIComponent(S.cur.challenge.id)}/code`, { answer: id }).catch(() => {});
}

function renderLesson() {
  const { levelId, challenge: ch } = S.cur;
  const level = levelOf(levelId);
  const idx = level.challenges.findIndex((c) => c.id === ch.id);
  const strip = level.challenges
    .map((c, i) => {
      const p = chProgress(levelId, c.id);
      const cls = [p?.passed && "passed", c.id === ch.id && "current", !chUnlocked(level, i) && "locked"].filter(Boolean).join(" ");
      return `<a class="${cls}" href="#/c/${c.id}" title="${esc(`${i + 1}. ${c.title} (${c.kind})`)}">${c.kind === "boss" ? "👑" : i + 1}${p?.passed ? "✓" : ""}</a>`;
    })
    .join("");
  const host = $("#lesson");
  const keepVisualOpen = host.dataset.level === levelId;
  host.dataset.level = levelId;
  host.innerHTML = `
    <div class="ui-muted kind-tag">Level ${level.order} · ${esc(level.title)}</div>
    <div class="challenge-strip">${strip}</div>
    <div class="kind-tag"><span class="ui-status ui-status--${ch.kind === "boss" ? "warning" : "neutral"}">${esc(ch.kind)}</span>
      <span class="ui-muted">${ch.xp} XP${ch.judged ? " · judged by the tutor" : ""}${S.cur.state.passed ? " · ✓ solved" : ""}</span></div>
    <h1>${idx + 1}. ${esc(ch.title)}</h1>
    ${ch.story ? `<div class="story">${md(ch.story)}</div>` : ""}
    <div class="prompt">${md(ch.prompt)}</div>
    <h2>Concepts</h2>
    ${level.concepts.map((c, i) => `<details class="concept" ${i === 0 && idx === 0 ? "open" : ""}><summary>${esc(c.title)}</summary><div>${md(c.body)}</div></details>`).join("")}
    <h2>See it in memory</h2>
    <div id="visual-host"></div>
    <details class="concept" ${idx === 0 && !keepVisualOpen ? "open" : ""}><summary>Quest: ${esc(level.quest.title)}</summary><div class="story">${md(level.quest.story)}</div></details>`;
  S.vis?.destroy();
  S.vis = mountVisual($("#visual-host"), level.visual);
}

async function openChallenge(id) {
  const loc = S.levels.flatMap((l) => l.challenges.map((c, i) => ({ l, c, i }))).find((x) => x.c.id === id);
  if (!loc) return (location.hash = "#/map");
  if (!chUnlocked(loc.l, loc.i)) {
    toast("Locked: finish the previous challenge first.", true);
    return (location.hash = `#/l/${loc.l.id}`);
  }
  switchView("challenge");
  const v = await get(`/challenges/${encodeURIComponent(id)}`);
  S.cur = v;
  S.answer = v.state.answer;
  S.lastVerify = null;
  crumbs([["Map", "#/map"], [`L${loc.l.order} ${loc.l.title}`, `#/l/${loc.l.id}`], [v.challenge.title]]);
  renderLesson();
  S.loadingCode = true;
  S.ed.load(v.state.code ?? v.challenge.starter);
  S.loadingCode = false;
  S.ed.setReadOnly(v.challenge.kind === "predict" ? "Predict challenge: read the code, pick an answer above." : null);
  for (const a of ["run", "check", "format", "reset"]) $(`[data-action="${a}"]`).disabled = false;
  $('[data-action="format"]').disabled = v.challenge.kind === "predict";
  $('[data-action="review"]').disabled = v.challenge.kind === "predict";
  renderPredict();
  renderCompile(null);
  $("#out").innerHTML = '<span class="meta">Ctrl+Enter runs your program. Ctrl+Shift+Enter submits it to the hidden tests.</span>';
  $("#tests").innerHTML = `<p class="empty">Submit (Ctrl+Shift+Enter) to run the hidden ${v.challenge.checkKind === "tests" ? "tests" : v.challenge.checkKind === "output" ? "output checks" : "answer check"}.</p>`;
  $("#tutor").innerHTML = `<p class="empty">Stuck? Alt+H asks the tutor for a Socratic hint (${v.state.hintsUsed} used here). Alt+E explains a failing attempt; Alt+R reviews a passing solution.</p>`;
  showTab("output");
  status(v.state.passed ? "solved. Try a cleaner solution or ask for a review (Alt+R)" : "ready", v.state.passed ? "ok" : "");
  if (v.challenge.kind !== "predict") S.ed.editor.focus();
  else $(".choice")?.focus();
}

function openLevel(id) {
  const level = levelOf(id);
  if (!level || !progressOf(id)?.unlocked) return (location.hash = "#/map");
  const lp = progressOf(id);
  const next = level.challenges.find((c, i) => !lp.challenges[i].passed && chUnlocked(level, i)) || level.challenges[0];
  location.replace(`#/c/${next.id}`);
}

function stepChallenge(delta) {
  if (!S.cur) return;
  const level = levelOf(S.cur.levelId);
  const all = S.levels.flatMap((l) => l.challenges.map((c, i) => ({ l, c, i })));
  const at = all.findIndex((x) => x.c.id === S.cur.challenge.id);
  const target = all[at + delta];
  if (!target) return;
  if (!chUnlocked(target.l, target.i)) return toast(target.l.id === level.id ? "Locked: pass this challenge first." : "Next level is locked: beat the boss.", true);
  location.hash = `#/c/${target.c.id}`;
}

async function renderReview() {
  switchView("review");
  crumbs([["Map", "#/map"], ["Review queue"]]);
  const r = await get("/review");
  S.review = { cards: r.cards, i: 0, shown: false };
  drawCard();
}

function drawCard() {
  const host = $("#view-review");
  const { cards, i, shown } = S.review;
  if (i >= cards.length) {
    host.innerHTML = `<div class="review-inner"><div class="ui-card flashcard"><h2>All caught up 🎉</h2><p class="ui-muted">${
      cards.length ? `You reviewed ${cards.length} card(s).` : "No cards are due."
    } Cards unlock as you pass challenges and come back on an SM-2 schedule.</p><p><a href="#/map">Back to the map</a> (Alt+M)</p></div></div>`;
    return;
  }
  const c = cards[i];
  host.innerHTML = `<div class="review-inner"><p class="ui-muted">Card ${i + 1} of ${cards.length} · ${esc(levelOf(c.levelId)?.title || c.levelId)}</p>
    <div class="ui-card flashcard"><div class="front">${md(c.front)}</div>
    ${shown ? `<div class="back">${md(c.back)}</div>
      <div class="grades">${["Again", "Hard", "Good", "Easy"].map((g, n) => `<button class="btn ${n === 2 ? "primary" : ""}" data-grade="${n}"><kbd>${n + 1}</kbd> ${g}</button>`).join("")}</div>`
      : `<div class="grades"><button class="btn primary" data-reveal="1"><kbd>Space</kbd> Show answer</button></div>`}</div></div>`;
  $(".grades button", host)?.focus();
}

async function gradeCard(grade) {
  const { cards, i, shown } = S.review;
  if (!shown || i >= cards.length) return;
  const r = await post(`/review/${encodeURIComponent(cards[i].id)}`, { grade });
  setProgress(r.progress);
  S.review.i += 1;
  S.review.shown = false;
  drawCard();
}

function help() {
  overlay(`<h2>Keyboard shortcuts</h2><table class="keys">${KEYS.map(([k, d]) => `<tr><td>${k.split(" / ").map((x) => `<kbd>${esc(x)}</kbd>`).join(" / ")}</td><td>${esc(d)}</td></tr>`).join("")}</table>`);
}

// ---------------------------------------------------------------- routing

async function route() {
  closeOverlay();
  const [, kind, id] = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
  try {
    if (kind === "c" && id) return await openChallenge(id);
    if (kind === "l" && id) return openLevel(id);
    if (kind === "review") return await renderReview();
    return renderMap();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- keyboard

function typingOutsideEditor(e) {
  const t = e.target;
  return (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && !t.closest(".monaco-editor");
}

function onKey(e) {
  const k = e.code;
  const ctrl = e.ctrlKey || e.metaKey;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === "Escape" && closeOverlay()) return handled();
  if (!$("#overlay").hidden) return;

  if (e.altKey && !ctrl && !e.shiftKey) {
    const go = { KeyM: () => (location.hash = "#/map"), KeyV: () => (location.hash = "#/review") }[k];
    if (go) return (handled(), go());
  }
  if (S.view === "challenge" && S.cur) {
    let fn = null;
    if (ctrl && e.shiftKey && k === "Enter") fn = actions.verify;
    else if (ctrl && !e.shiftKey && k === "Enter") fn = actions.run;
    else if (ctrl && !e.shiftKey && k === "KeyB") fn = actions.check;
    else if (ctrl && e.shiftKey && k === "KeyE") fn = () => explainCode(S.ed.codeAtCursor());
    else if (e.altKey && e.shiftKey && !ctrl && k === "KeyF") fn = actions.format;
    else if (e.altKey && e.shiftKey && !ctrl && k === "Backspace") fn = actions.reset;
    else if (e.altKey && !ctrl && !e.shiftKey) {
      fn = {
        KeyH: actions.hint,
        KeyE: actions.explain,
        KeyR: actions.review,
        KeyN: () => stepChallenge(1),
        KeyP: () => stepChallenge(-1),
        Digit1: () => showTab("output"),
        Digit2: () => showTab("tests"),
        Digit3: () => showTab("diagnostics"),
        Digit4: () => showTab("tutor"),
      }[k];
    }
    if (fn) {
      const btn = $(`[data-action="${Object.keys(actions).find((a) => actions[a] === fn)}"]`);
      if (btn?.disabled) return handled();
      return (handled(), fn());
    }
    const inEditor = e.target.closest?.(".monaco-editor");
    if (!inEditor && !typingOutsideEditor(e) && !ctrl && !e.altKey && S.cur.challenge.kind === "predict" && /^Digit[1-9]$/.test(k)) {
      const c = S.cur.challenge.choices[Number(k.slice(5)) - 1];
      if (c) return (handled(), choose(c.id));
    }
    if (!inEditor && !typingOutsideEditor(e) && e.key === "?") return (handled(), help());
    return;
  }
  if (S.view === "review" && !ctrl && !e.altKey) {
    if ((e.key === " " || e.key === "Enter") && !S.review.shown && S.review.i < S.review.cards.length) {
      handled();
      S.review.shown = true;
      return drawCard();
    }
    if (/^Digit[1-4]$/.test(k) && S.review.shown) return (handled(), gradeCard(Number(k.slice(5)) - 1));
  }
  if (!typingOutsideEditor(e) && e.key === "?") return (handled(), help());
}

// ---------------------------------------------------------------- boot

async function boot() {
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-action]");
    if (a && !a.disabled) return actions[a.dataset.action]?.();
    const t = e.target.closest("[data-tab]");
    if (t) return showTab(t.dataset.tab);
    const ex = e.target.closest("[data-explain]");
    if (ex) return explainCode(ex.dataset.explain);
    const d = e.target.closest(".diag[data-line]");
    if (d) return S.ed.reveal(Number(d.dataset.line), Number(d.dataset.col));
    const ch = e.target.closest("[data-choice]");
    if (ch) return choose(ch.dataset.choice);
    if (e.target.closest("[data-reveal]")) {
      S.review.shown = true;
      return drawCard();
    }
    const g = e.target.closest("[data-grade]");
    if (g) return gradeCard(Number(g.dataset.grade));
    if (e.target.closest("#btn-help")) return help();
    if (e.target.closest("#overlay-close") || e.target.id === "overlay") return closeOverlay();
  });

  const [lv, prog] = await Promise.all([get("/levels"), get("/progress")]);
  S.levels = lv.levels;
  setProgress(prog);
  S.ed = await createEditor($("#editor"), {
    format: async (code) => {
      status("rustfmt…");
      const r = await post("/format", { code });
      status(r.ok ? "formatted with rustfmt" : `rustfmt: ${r.error.split("\n")[0]}`, r.ok ? "ok" : "err");
      return r;
    },
    explain: explainCode,
    onChange: scheduleSave,
  });
  window.__tutor = { S, actions }; // for the browser smoke test
  refreshAgentStatus();
  setInterval(refreshAgentStatus, 30_000);
  window.addEventListener("hashchange", route);
  await route();
  document.body.dataset.ready = "1";
}

boot().catch((e) => {
  document.body.innerHTML = `<div class="ui-shell"><h1>Rust Tutor failed to start</h1><pre>${esc(e.stack || e.message)}</pre></div>`;
});
