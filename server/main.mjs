// rust-tutor entry point: load + validate lessons, open progress DB, start the
// allowlist, serve HTTPS (plain HTTP only when TLS_CERT is unset, for tests).

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, createRunnerClient, loadPrompts } from "./agent.mjs";
import { createAllowlist } from "./allowlist.mjs";
import { createApp } from "./app.mjs";
import { loadLessons } from "./lessons.mjs";
import { createRust } from "./rustc.mjs";
import { openStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadAllowlistConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
    selfLabel: raw.selfLabel || "kai-lenovo",
    refreshSeconds: Number(raw.refreshSeconds || 30),
  };
}

async function main() {
  const env = process.env;
  const port = Number(env.PORT || 5020);
  const bindHost = env.BIND_HOST || "::";
  const root = path.resolve(here, "..");

  const catalog = loadLessons(env.LESSONS_DIR || path.join(root, "lessons"));
  const store = openStore(path.join(env.DATA_DIR || path.join(root, "data"), "progress.db"), { timeZone: env.TUTOR_TZ || "Europe/Berlin" });
  const rust = createRust({ concurrency: Number(env.COMPILE_CONCURRENCY || 2) });

  const alcfg = loadAllowlistConfig(env.ALLOWLIST_CONFIG || path.join(root, "allowlist.json"));
  const allowlist = createAllowlist({
    hosts: alcfg.hosts,
    selfLabel: alcfg.selfLabel,
    refreshMs: alcfg.refreshSeconds * 1000,
    log: (m) => console.log(m),
  });
  await allowlist.start();

  // RUNNER_URL="" disables the CE lane entirely (the UI then shows built-in hints only).
  const agent = env.RUNNER_URL === ""
    ? null
    : createAgent({
        runner: createRunnerClient({ baseUrl: env.RUNNER_URL || "http://127.0.0.1:4930" }),
        prompts: loadPrompts(env.PROMPTS_DIR || path.join(root, "prompts")),
        role: env.AGENT_ROLE || "chief-engineer",
        timeoutMs: Number(env.AGENT_TIMEOUT_S || 120) * 1000,
        catalog,
        store,
        rust,
      });

  const app = createApp({ rust, catalog, store, allowlist, staticDir: env.STATIC_DIR || path.join(root, "web"), agent });

  const tls = env.TLS_CERT && fs.existsSync(env.TLS_CERT);
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY), minVersion: "TLSv1.2" }, app.onRequest)
    : http.createServer(app.onRequest);
  server.on("connection", app.onConnection);
  server.on("tlsClientError", () => {}); // untrusted-CA handshakes are expected noise
  server.requestTimeout = 60_000;

  server.listen({ port, host: bindHost, ipv6Only: false }, async () => {
    const v = await rust.version();
    const snap = allowlist.snapshot();
    console.log(
      `rust-tutor listening on ${tls ? "https" : "http"}://[${bindHost}]:${port} levels=${catalog.levels.length} ` +
        `challenges=${catalog.levels.reduce((n, l) => n + l.challenges.length, 0)} ${v.rustc} | ${v.rustfmt} allowlist=${snap.entries} ` +
        `agent=${agent ? env.RUNNER_URL || "http://127.0.0.1:4930" : "off"}`,
    );
  });

  const shutdown = () => {
    allowlist.stop();
    agent?.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`rust-tutor failed to start: ${e.message}`);
    process.exit(1);
  });
}
