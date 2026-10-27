// Animated stack/heap stepper. A lesson's `visual` is a list of steps; each
// step is a full snapshot (stack frames with vars, heap blocks, arrows), so
// rendering is a pure function of the step index. Elements that appear in a
// step but not the previous one fade in; arrows are drawn as curves.

import { esc } from "./md.js";

const NS = "http://www.w3.org/2000/svg";
const W = 400;
const STACK_X = 6;
const STACK_W = 170;
const HEAP_X = 236;
const HEAP_W = 158;
const ROW = 34;
const BOX_H = 26;

function layout(step) {
  const pos = new Map();
  let y = 30;
  const frames = [];
  for (const f of step.stack || []) {
    const top = y;
    y += 20;
    for (const v of f.vars || []) {
      pos.set(v.id, { x: STACK_X + 8, y, w: STACK_W - 16, side: "stack" });
      y += ROW;
    }
    if (!(f.vars || []).length) y += ROW;
    frames.push({ frame: f, top, bottom: y - 4 });
    y += 10;
  }
  let hy = 50;
  for (const h of step.heap || []) {
    pos.set(h.id, { x: HEAP_X, y: hy, w: HEAP_W, side: "heap" });
    hy += ROW + 8;
  }
  return { pos, frames, height: Math.max(y, hy) + 10 };
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

function arrowPath(a, b) {
  const y1 = a.y + BOX_H / 2;
  const y2 = b.y + BOX_H / 2;
  if (b.side === "heap") {
    const x1 = a.x + a.w;
    const x2 = b.x;
    const mid = (x1 + x2) / 2;
    return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`;
  }
  // stack -> stack (a reference to another local): loop out to the right.
  const x1 = a.x + a.w;
  const x2 = b.x + b.w;
  const bulge = Math.min(80, 24 + Math.abs(y2 - y1) / 2);
  return `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2 + 2},${y2}`;
}

export function renderSvg(step, prevStep) {
  const { pos, frames, height } = layout(step);
  const before = new Set([...(prevStep?.stack || []).flatMap((f) => (f.vars || []).map((v) => v.id)), ...(prevStep?.heap || []).map((h) => h.id)]);
  const svg = el("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": step.note || "memory diagram" });
  const defs = el("defs");
  for (const kind of ["own", "borrow", "mut", "moved"]) {
    const m = el("marker", { id: `ah-${kind}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(el("path", { d: "M0,0 L10,5 L0,10 z", class: `arrow-head ${kind}`, fill: { own: "#31c48d", borrow: "#2f8bff", mut: "#f4b740", moved: "#718096" }[kind] }));
    defs.append(m);
  }
  svg.append(defs);
  svg.append(el("text", { x: STACK_X, y: 16, class: "dim" }, "STACK"));
  svg.append(el("text", { x: HEAP_X, y: 16, class: "dim" }, "HEAP"));

  for (const { frame, top, bottom } of frames) {
    svg.append(el("rect", { x: STACK_X, y: top, width: STACK_W, height: bottom - top, rx: 8, class: "frame" }));
    svg.append(el("text", { x: STACK_X + 8, y: top + 14, class: "dim" }, frame.frame));
    for (const v of frame.vars || []) {
      const p = pos.get(v.id);
      const g = el("g", { class: `var ${v.state || "live"}`, "data-id": v.id });
      if (!before.has(v.id)) g.classList.add("enter");
      g.append(el("rect", { x: p.x, y: p.y, width: p.w, height: BOX_H, rx: 6, class: "box" }));
      const label = v.value !== undefined && v.value !== null ? `${v.name} = ${v.value}` : v.name;
      g.append(el("text", { x: p.x + 8, y: p.y + 17 }, label.length > 20 ? `${label.slice(0, 19)}…` : label));
      if (v.state && v.state !== "live") g.append(el("text", { x: p.x + p.w - 6, y: p.y + 17, "text-anchor": "end", class: "dim" }, v.state));
      svg.append(g);
    }
  }
  for (const h of step.heap || []) {
    const p = pos.get(h.id);
    const g = el("g", { class: `heap ${h.state || "live"}`, "data-id": h.id });
    if (!before.has(h.id)) g.classList.add("enter");
    g.append(el("rect", { x: p.x, y: p.y, width: p.w, height: BOX_H, rx: 6, class: "box" }));
    g.append(el("text", { x: p.x + 8, y: p.y + 17 }, h.label.length > 19 ? `${h.label.slice(0, 18)}…` : h.label));
    if (h.state === "freed") g.append(el("text", { x: p.x + p.w - 6, y: p.y + 17, "text-anchor": "end", class: "dim" }, "freed"));
    svg.append(g);
  }
  for (const a of step.arrows || []) {
    const from = pos.get(a.from);
    const to = pos.get(a.to);
    if (!from || !to) continue;
    svg.append(el("path", { d: arrowPath(from, to), class: `arrow ${a.kind}`, "marker-end": `url(#ah-${a.kind})` }));
  }
  return svg;
}

/** Mounts an interactive stepper into `host`; returns { go(i), destroy() }. */
export function mountVisual(host, visual) {
  const codeLines = visual.code.split("\n");
  host.innerHTML = `
    <div class="visual" tabindex="0" aria-label="Memory visualizer: use left/right arrows to step">
      <div class="visual-head">
        <span class="title">${esc(visual.title)}</span>
        <button class="btn" data-v="prev" title="Previous step (←)">◀</button>
        <span class="ui-muted" data-v="count"></span>
        <button class="btn" data-v="next" title="Next step (→)">▶</button>
        <button class="btn" data-v="play" title="Play">⏵</button>
      </div>
      <pre class="visual-code">${codeLines.map((l, i) => `<div data-line="${i + 1}">${esc(l) || " "}</div>`).join("")}</pre>
      <div class="visual-note" aria-live="polite"></div>
      <div data-v="svg"></div>
      <div class="legend"><span class="l-own">owns</span><span class="l-borrow">&amp; borrow</span><span class="l-mut">&amp;mut borrow</span><span class="l-moved">moved-from</span></div>
    </div>`;
  const root = host.firstElementChild;
  const steps = visual.steps;
  let i = 0;
  let timer = null;
  function go(n) {
    const prev = steps[i];
    i = Math.max(0, Math.min(steps.length - 1, n));
    const step = steps[i];
    root.querySelector('[data-v="count"]').textContent = `${i + 1}/${steps.length}`;
    root.querySelector(".visual-note").textContent = step.note;
    for (const d of root.querySelectorAll(".visual-code div")) d.classList.toggle("cur", Number(d.dataset.line) === step.line);
    const slot = root.querySelector('[data-v="svg"]');
    slot.replaceChildren(renderSvg(step, prev === step ? null : prev));
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    root.querySelector('[data-v="play"]').textContent = "⏵";
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    if (b.dataset.v === "prev") (stop(), go(i - 1));
    if (b.dataset.v === "next") (stop(), go(i + 1));
    if (b.dataset.v === "play") {
      if (timer) return stop();
      if (i >= steps.length - 1) go(0);
      b.textContent = "⏸";
      timer = setInterval(() => (i >= steps.length - 1 ? stop() : go(i + 1)), 1400);
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") (stop(), go(i + 1), e.preventDefault());
    if (e.key === "ArrowLeft") (stop(), go(i - 1), e.preventDefault());
  });
  go(0);
  return { go, destroy: stop };
}
