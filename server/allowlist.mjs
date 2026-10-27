// Reused from duotronic-web (apps/duotronic/web/gateway/allowlist.mjs); only this
// header differs. Keep in sync with that file rather than diverging.
//
// Source-IP allowlist (LAN clients by name, re-resolved).
//
// Clients are identified by name, never by a hardcoded address: kai-surfy and
// AYCV6WY use rotating IPv6 privacy addresses, so every refresh re-resolves
// their A and AAAA records and replaces the previous answer. kai-lenovo itself
// is admitted via loopback plus the addresses currently on its LAN interfaces.
//
// Fail-closed: a name whose lookup fails keeps its last good answer only for a
// bounded grace period, after which its addresses stop being admitted.

import net from "node:net";
import os from "node:os";
import { promises as dnsPromises } from "node:dns";

export const MAX_REFRESH_MS = 60_000;
const LOOPBACK = ["127.0.0.1", "::1"];
// Interfaces whose addresses are never "kai-lenovo on the LAN".
const DEFAULT_EXCLUDED_INTERFACES = /^(tailscale|docker|br-|veth|virbr|wg|zt|cni|flannel)/;
const TAILSCALE_INTERFACES = /^tailscale/;

/** Canonical textual form so DNS answers and socket addresses compare equal. */
export function normalizeIp(raw) {
  if (typeof raw !== "string") return null;
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family === 6) return expandIPv6(ip);
  return null;
}

// Full 8-group form: avoids equal addresses differing only in zero compression.
function expandIPv6(ip) {
  let head = ip;
  let tail = "";
  const dbl = ip.indexOf("::");
  if (dbl !== -1) {
    head = ip.slice(0, dbl);
    tail = ip.slice(dbl + 2);
  }
  const toGroups = (part) => {
    if (!part) return [];
    const groups = [];
    for (const g of part.split(":")) {
      if (net.isIPv4(g)) {
        const [a, b, c, d] = g.split(".").map(Number);
        groups.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else groups.push(g);
    }
    return groups;
  };
  const h = toGroups(head);
  const t = toGroups(tail);
  const fill = dbl === -1 ? [] : new Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => g.padStart(4, "0")).join(":");
}

/** Tailscale CGNAT (100.64.0.0/10) or Tailscale ULA (fd7a:115c:a1e0::/48). */
export function isTailscaleAddress(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return ip.startsWith("fd7a:115c:a1e0:");
}

export function clampRefreshMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return Math.min(Math.max(n, 1_000), MAX_REFRESH_MS);
}

/**
 * @param {object} opts
 * @param {string[]} opts.hosts             names resolved for A + AAAA
 * @param {string} [opts.selfLabel]         label reported for kai-lenovo's own addresses
 * @param {number} [opts.refreshMs]         clamped to <= 60s
 * @param {number} [opts.staleGraceMs]      how long a failed name keeps its last answer
 * @param {(name: string) => Promise<string[]>} [opts.resolve4]
 * @param {(name: string) => Promise<string[]>} [opts.resolve6]
 * @param {() => Record<string, Array<{address: string}>>} [opts.interfaces]
 * @param {RegExp} [opts.excludeInterfaces]
 * @param {boolean} [opts.includeLoopback]  admit 127.0.0.1 and ::1 (default true)
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 */
export function createAllowlist(opts) {
  const hosts = [...new Set((opts.hosts || []).map((h) => String(h).trim()).filter(Boolean))];
  const selfLabel = opts.selfLabel || os.hostname();
  const refreshMs = clampRefreshMs(opts.refreshMs);
  const staleGraceMs = Math.max(0, Number(opts.staleGraceMs ?? refreshMs * 2));
  const resolve4 = opts.resolve4 || ((n) => dnsPromises.resolve4(n));
  const resolve6 = opts.resolve6 || ((n) => dnsPromises.resolve6(n));
  const interfaces = opts.interfaces || (() => os.networkInterfaces());
  const exclude = opts.excludeInterfaces || DEFAULT_EXCLUDED_INTERFACES;
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const loopback = opts.includeLoopback === false ? [] : LOOPBACK;

  // name -> { addrs: string[], resolvedAt: number }
  const lastGood = new Map();
  let table = new Map(); // normalized ip -> label
  let tailscaleLocal = new Set();
  let refreshedAt = 0;
  let timer = null;
  let inflight = null;

  async function resolveName(name) {
    const settled = await Promise.allSettled([resolve4(name), resolve6(name)]);
    const addrs = [];
    let anyOk = false;
    for (const r of settled) {
      if (r.status === "fulfilled") {
        anyOk = true;
        for (const a of r.value) {
          const ip = normalizeIp(a);
          if (ip) addrs.push(ip);
        }
      } else if (!["ENODATA", "ENOTFOUND"].includes(r.reason?.code)) {
        // NODATA/NOTFOUND for one family is an authoritative empty answer (e.g.
        // AYCV6WY has no A record); anything else is a lookup failure.
        log(`allowlist: ${name} lookup error ${r.reason?.code || r.reason}`);
      } else {
        anyOk = true;
      }
    }
    return { ok: anyOk && addrs.length > 0, addrs };
  }

  function selfAddresses() {
    const out = new Set(loopback.map(normalizeIp));
    const ts = new Set();
    for (const [name, list] of Object.entries(interfaces() || {})) {
      for (const entry of list || []) {
        const ip = normalizeIp(entry.address);
        if (!ip) continue;
        if (TAILSCALE_INTERFACES.test(name)) ts.add(ip);
        if (exclude.test(name)) continue;
        out.add(ip);
      }
    }
    return { self: out, ts };
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      const t = now();
      const next = new Map();
      const { self, ts } = selfAddresses();
      for (const ip of self) next.set(ip, selfLabel);

      const results = await Promise.all(hosts.map(async (name) => [name, await resolveName(name)]));
      for (const [name, r] of results) {
        if (r.ok) lastGood.set(name, { addrs: r.addrs, resolvedAt: t });
        const entry = lastGood.get(name);
        if (!entry) continue;
        if (!r.ok && t - entry.resolvedAt > staleGraceMs) {
          lastGood.delete(name);
          log(`allowlist: ${name} unresolved beyond grace; dropped`);
          continue;
        }
        const label = name.split(".")[0];
        for (const ip of entry.addrs) if (!next.has(ip)) next.set(ip, label);
      }
      table = next;
      tailscaleLocal = ts;
      refreshedAt = t;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function check(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip) return { allowed: false, label: null };
    const label = table.get(ip);
    return label ? { allowed: true, label } : { allowed: false, label: null };
  }

  /** True when a connection arrived on a Tailscale address of this host. */
  function isTailscaleLocal(rawLocal) {
    const ip = normalizeIp(rawLocal);
    return Boolean(ip) && (tailscaleLocal.has(ip) || isTailscaleAddress(ip));
  }

  function snapshot() {
    const perLabel = {};
    for (const label of table.values()) perLabel[label] = (perLabel[label] || 0) + 1;
    return { refreshedAt, refreshMs, entries: table.size, perLabel };
  }

  function start() {
    if (timer) return refresh();
    timer = setInterval(() => {
      refresh().catch((e) => log(`allowlist: refresh failed ${e?.message || e}`));
    }, refreshMs);
    timer.unref?.();
    return refresh();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, check, isTailscaleLocal, snapshot, start, stop, refreshMs };
}
