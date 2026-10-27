// HTTP surface of the tutor. Order per request:
//   1. connections on a Tailscale address are dropped before TLS (onConnection),
//   2. non-allowlisted source IPs get 403 (healthz included),
//   3. /healthz, /api/*, then static files.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publicChallenge, publicLevel } from "./lessons.mjs";
import { verifyChallenge } from "./verify.mjs";

const MAX_JSON_BYTES = 128 * 1024;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "microphone=(), camera=(), geolocation=()",
  // Monaco injects <style> elements and runs its editor worker from a blob.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function readJson(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, "invalid json"));
      }
    });
    req.on("error", reject);
  });
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * @param {object} cfg
 * @param {ReturnType<import('./rustc.mjs').createRust>} cfg.rust
 * @param {ReturnType<import('./lessons.mjs').createCatalog>} cfg.catalog
 * @param {ReturnType<import('./store.mjs').openStore>} cfg.store
 * @param {{check: Function, isTailscaleLocal: Function, snapshot: Function}} cfg.allowlist
 * @param {string|null} cfg.staticDir
 * @param {object|null} [cfg.agent]   CE-lane client (agent.mjs); null disables /api/agent
 * @param {(line: string) => void} [cfg.log]
 */
export function createApp(cfg) {
  const { rust, catalog, store } = cfg;
  const log = cfg.log || ((line) => console.log(line));
  const staticRoot = cfg.staticDir ? path.resolve(cfg.staticDir) : null;
  const started = Date.now();

  const challengeOr404 = (id) => {
    const ch = catalog.challenge(String(id || ""));
    if (!ch) throw new HttpError(404, "unknown challenge");
    return ch;
  };

  const optString = (v, name, max = 64 * 1024) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
    if (v.length > max) throw new HttpError(413, `${name} too large`);
    return v;
  };

  function challengeView(ch) {
    const st = store.state(ch.id);
    return {
      levelId: ch.levelId,
      challenge: publicChallenge(ch),
      state: {
        passed: Boolean(st?.first_passed_at),
        attempts: st?.attempts ?? 0,
        hintsUsed: st?.hints_used ?? 0,
        code: st?.last_code ?? null,
        answer: st?.last_answer ?? null,
      },
    };
  }

  async function verify(body) {
    const ch = challengeOr404(body.challengeId);
    const code = optString(body.code, "code");
    const answer = optString(body.answer, "answer", 64);
    if (ch.check.kind !== "choice" && code === undefined) throw new HttpError(400, "code required");
    const result = await verifyChallenge(rust, ch, { code, answer });
    const rec = store.recordVerify(ch, { passed: result.passed, code, answer, codeHash: code ? sha256(code) : null }, catalog);
    return { challengeId: ch.id, ...result, ...rec, progress: store.progress(catalog) };
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const route = `${req.method} /${parts.map((p, i) => (i === 1 && ["challenges", "explain", "review"].includes(parts[0]) ? ":id" : p)).join("/")}`;

    switch (route) {
      case "GET /levels":
        return send(res, 200, { levels: catalog.levels.map(publicLevel) });
      case "GET /progress":
        return send(res, 200, store.progress(catalog));
      case "GET /challenges/:id":
        return send(res, 200, challengeView(challengeOr404(parts[1])));
      case "PUT /challenges/:id/code": {
        const ch = challengeOr404(parts[1]);
        const body = await readJson(req);
        store.saveCode(ch, { code: optString(body.code, "code"), answer: optString(body.answer, "answer", 64) });
        return send(res, 200, { saved: true });
      }
      case "POST /challenges/:id/reset": {
        const ch = challengeOr404(parts[1]);
        store.resetCode(ch);
        return send(res, 200, challengeView(ch));
      }
      case "POST /format": {
        const body = await readJson(req);
        return send(res, 200, await rust.format(optString(body.code, "code") ?? ""));
      }
      case "POST /check": {
        const body = await readJson(req);
        return send(res, 200, await rust.check(optString(body.code, "code") ?? ""));
      }
      case "POST /run": {
        const body = await readJson(req);
        const r = await rust.run(optString(body.code, "code") ?? "", [optString(body.stdin, "stdin", 16 * 1024) ?? ""]);
        return send(res, 200, { compile: r.compile, run: r.runs[0] || null });
      }
      case "POST /verify":
        return send(res, 200, await verify(await readJson(req)));
      case "GET /explain/:id":
        return send(res, 200, await rust.explain(parts[1]));
      case "GET /review": {
        const cards = store.dueCards().map((row) => {
          const c = catalog.card(row.card_id);
          return c ? { id: c.id, levelId: c.levelId, front: c.front, back: c.back, reps: row.reps, lapses: row.lapses, dueAt: row.due_at } : null;
        });
        return send(res, 200, { cards: cards.filter(Boolean) });
      }
      case "POST /review/:id": {
        const body = await readJson(req);
        if (![0, 1, 2, 3].includes(body.grade)) throw new HttpError(400, "grade must be 0..3");
        const r = store.reviewCard(parts[1], body.grade);
        if (!r) throw new HttpError(404, "card not unlocked");
        return send(res, 200, { ...r, progress: store.progress(catalog) });
      }
      default:
        if (cfg.agent && parts[0] === "agent") return cfg.agent.handle(req, res, parts.slice(1), { challengeOr404, readJson, send, HttpError, optString });
        return send(res, 404, { error: "not found" });
    }
  }

  function serveStatic(req, res, url) {
    if (!staticRoot) return send(res, 404, { error: "not found" });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { error: "bad path" });
    }
    let file = path.resolve(staticRoot, `.${rel}`);
    if (file !== staticRoot && !file.startsWith(staticRoot + path.sep)) return send(res, 403, { error: "forbidden" });
    let stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) {
      if (path.extname(rel)) return send(res, 404, { error: "not found" });
      file = path.join(staticRoot, "index.html");
      stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat) return send(res, 503, { error: "web bundle missing" });
    }
    const vendor = rel.startsWith("/vendor/");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": vendor ? "public, max-age=604800" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function onConnection(socket) {
    if (cfg.allowlist.isTailscaleLocal(socket.localAddress)) {
      log(`drop tailscale connection local=${socket.localAddress} remote=${socket.remoteAddress}`);
      socket.destroy();
    }
  }

  async function onRequest(req, res) {
    const t0 = Date.now();
    const remote = req.socket.remoteAddress;
    res.on("finish", () => {
      log(`${new Date().toISOString()} ${remote} ${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - t0}ms`);
    });

    const client = cfg.allowlist.check(remote);
    if (!client.allowed) return send(res, 403, { error: "forbidden" });

    let url;
    try {
      url = new URL(req.url || "/", "https://rust-tutor.invalid");
    } catch {
      return send(res, 400, { error: "bad request" });
    }

    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
        const snap = cfg.allowlist.snapshot();
        const ok = store.ping();
        return send(res, ok ? 200 : 503, {
          status: ok ? "ok" : "degraded",
          uptimeS: Math.round((Date.now() - started) / 1000),
          levels: catalog.levels.length,
          challenges: catalog.levels.reduce((n, l) => n + l.challenges.length, 0),
          compiler: rust.limiter.stats(),
          allowlist: { entries: snap.entries, ageMs: Date.now() - snap.refreshedAt },
        });
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      return serveStatic(req, res, url);
    } catch (e) {
      if (!e.status) log(`error ${req.method} ${url.pathname}: ${e.stack || e}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
      else res.destroy();
    }
  }

  return { onRequest, onConnection, verify };
}
