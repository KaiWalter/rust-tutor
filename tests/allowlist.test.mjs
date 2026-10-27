import test from "node:test";
import assert from "node:assert/strict";
import { clampRefreshMs, createAllowlist, isTailscaleAddress, MAX_REFRESH_MS, normalizeIp } from "../server/allowlist.mjs";

const IFACES = {
  lo: [{ address: "127.0.0.1" }, { address: "::1" }],
  enp0s31f6: [{ address: "192.168.178.149" }, { address: "2a02:8070:4284:ef20:8369:12b8:1cd7:fd8c" }],
  tailscale0: [{ address: "100.81.197.14" }, { address: "fd7a:115c:a1e0::7401:c5c1" }],
  docker0: [{ address: "172.17.0.1" }],
  "br-e5a7d566b4db": [{ address: "172.30.50.1" }],
};

function dnsTable(records) {
  const lookup = (family) => async (name) => {
    const entry = records[name];
    if (entry instanceof Error) throw entry;
    const list = entry?.[family];
    if (!list || list.length === 0) throw Object.assign(new Error("no data"), { code: "ENODATA" });
    return list;
  };
  return { resolve4: lookup("a"), resolve6: lookup("aaaa") };
}

function make(records, extra = {}) {
  let clock = 1_000_000;
  const list = createAllowlist({
    hosts: ["kai-surfy.fritz.box", "AYCV6WY.fritz.box"],
    selfLabel: "kai-lenovo",
    refreshMs: 30_000,
    interfaces: () => IFACES,
    now: () => clock,
    ...dnsTable(records),
    ...extra,
  });
  return { list, advance: (ms) => (clock += ms) };
}

test("normalizeIp canonicalizes mapped IPv4, case, zone ids and zero compression", () => {
  assert.equal(normalizeIp("::ffff:192.168.178.74"), "192.168.178.74");
  assert.equal(normalizeIp("2A02:8070::CB8"), normalizeIp("2a02:8070:0:0:0:0:0:cb8"));
  assert.equal(normalizeIp("fe80::1%enp0s31f6"), normalizeIp("fe80::1"));
  assert.equal(normalizeIp("::1"), "0000:0000:0000:0000:0000:0000:0000:0001");
  assert.equal(normalizeIp("not-an-ip"), null);
  assert.equal(normalizeIp(undefined), null);
});

test("refresh interval is clamped to at most 60s", () => {
  assert.equal(clampRefreshMs(600_000), MAX_REFRESH_MS);
  assert.equal(clampRefreshMs(30_000), 30_000);
  assert.equal(clampRefreshMs(undefined), 30_000);
  assert.ok(createAllowlist({ hosts: [], refreshMs: 3_600_000 }).refreshMs <= 60_000);
});

test("admits A and AAAA answers of configured names and labels them", async () => {
  const { list } = make({
    "kai-surfy.fritz.box": { a: ["192.168.178.74"], aaaa: ["2a02:8070:4284:ef20:444c:5768:b36e:cb8"] },
    // AYCV6WY has no A record: NODATA for one family must not be a failure.
    "AYCV6WY.fritz.box": { aaaa: ["2a02:8070:4284:ef20:1445:168d:ef2f:49a1"] },
  });
  await list.refresh();
  assert.deepEqual(list.check("192.168.178.74"), { allowed: true, label: "kai-surfy" });
  assert.deepEqual(list.check("::ffff:192.168.178.74"), { allowed: true, label: "kai-surfy" });
  assert.deepEqual(list.check("2a02:8070:4284:ef20:444c:5768:b36e:0cb8"), { allowed: true, label: "kai-surfy" });
  assert.deepEqual(list.check("2a02:8070:4284:ef20:1445:168d:ef2f:49a1"), { allowed: true, label: "AYCV6WY" });
});

test("admits kai-lenovo loopback and LAN interfaces but not tailscale/docker addresses", async () => {
  const { list } = make({});
  await list.refresh();
  for (const ip of ["127.0.0.1", "::1", "192.168.178.149", "2a02:8070:4284:ef20:8369:12b8:1cd7:fd8c"]) {
    assert.deepEqual(list.check(ip), { allowed: true, label: "kai-lenovo" }, ip);
  }
  for (const ip of ["100.81.197.14", "fd7a:115c:a1e0::7401:c5c1", "172.17.0.1", "172.17.0.2", "172.30.50.1", "192.168.178.1", "8.8.8.8", "garbage", ""]) {
    assert.equal(list.check(ip).allowed, false, ip);
  }
});

test("rotated privacy addresses replace the previous answer on refresh", async () => {
  const records = { "kai-surfy.fritz.box": { aaaa: ["2a02:8070:4284:ef20::aaaa"] } };
  const { list } = make(records);
  await list.refresh();
  assert.equal(list.check("2a02:8070:4284:ef20::aaaa").allowed, true);

  records["kai-surfy.fritz.box"] = { aaaa: ["2a02:8070:4284:ef20::bbbb"] };
  await list.refresh();
  assert.equal(list.check("2a02:8070:4284:ef20::bbbb").allowed, true);
  assert.equal(list.check("2a02:8070:4284:ef20::aaaa").allowed, false);
});

test("a failing lookup keeps the last answer only within the grace period, then fails closed", async () => {
  const records = { "kai-surfy.fritz.box": { a: ["192.168.178.74"] } };
  const { list, advance } = make(records, { staleGraceMs: 60_000 });
  await list.refresh();

  records["kai-surfy.fritz.box"] = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  advance(30_000);
  await list.refresh();
  assert.equal(list.check("192.168.178.74").allowed, true, "within grace");

  advance(45_000);
  await list.refresh();
  assert.equal(list.check("192.168.178.74").allowed, false, "beyond grace");
});

test("an unknown name never admits anything", async () => {
  const { list } = make({ "kai-surfy.fritz.box": Object.assign(new Error("nx"), { code: "ENOTFOUND" }) });
  await list.refresh();
  assert.equal(list.snapshot().perLabel["kai-surfy"], undefined);
});

test("tailscale local addresses are detected by interface and by range", async () => {
  const { list } = make({});
  await list.refresh();
  assert.equal(list.isTailscaleLocal("100.81.197.14"), true);
  assert.equal(list.isTailscaleLocal("::ffff:100.81.197.14"), true);
  assert.equal(list.isTailscaleLocal("fd7a:115c:a1e0::7401:c5c1"), true);
  assert.equal(list.isTailscaleLocal("192.168.178.149"), false);
  assert.equal(list.isTailscaleLocal("::1"), false);
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
});

test("start schedules refreshes no slower than the configured interval", async () => {
  let calls = 0;
  const list = createAllowlist({
    hosts: ["kai-surfy.fritz.box"],
    refreshMs: 1_000,
    interfaces: () => ({}),
    resolve4: async () => {
      calls += 1;
      return ["192.168.178.74"];
    },
    resolve6: async () => [],
  });
  await list.start();
  await new Promise((r) => setTimeout(r, 2_300));
  list.stop();
  assert.ok(calls >= 3, `expected >=3 resolutions, got ${calls}`);
});
