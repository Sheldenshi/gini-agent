import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { webPortPath } from "./paths";
import { clearWebTargetCache, recordedWebPort, resolveWebPort } from "./web-target";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-web-target-tests";

function cfg(instance: string): RuntimeConfig {
  process.env.GINI_STATE_ROOT = ROOT;
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "t",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`
  } as RuntimeConfig;
}

function writePort(instance: string, value: string): void {
  const path = webPortPath(instance);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

// A healthz responder: status + JSON body, recording how many times it ran.
function healthz(body: unknown, status = 200) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

describe("recordedWebPort", () => {
  beforeEach(() => clearWebTargetCache());

  test("returns null when no web.port file exists", () => {
    expect(recordedWebPort(cfg("none"))).toBeNull();
  });

  test("returns the parsed port when the file holds a positive integer", () => {
    const c = cfg("good");
    writePort("good", "3091\n");
    expect(recordedWebPort(c)).toBe(3091);
  });

  test("returns null for a non-positive or non-numeric value", () => {
    const c = cfg("bad");
    writePort("bad", "0");
    expect(recordedWebPort(c)).toBeNull();
    writePort("bad", "nonsense");
    expect(recordedWebPort(c)).toBeNull();
  });
});

describe("resolveWebPort", () => {
  beforeEach(() => clearWebTargetCache());

  test("returns null without calling healthz when no port is recorded", async () => {
    const h = healthz({});
    expect(await resolveWebPort(cfg("p-none"), { fetch: h.fn })).toBeNull();
    expect(h.calls()).toBe(0);
  });

  test("returns the port when healthz reports our service and instance", async () => {
    const c = cfg("p-ok");
    writePort("p-ok", "3092");
    const h = healthz({ ok: true, service: "gini-web", instance: "p-ok" });
    expect(await resolveWebPort(c, { fetch: h.fn })).toBe(3092);
  });

  test("caches a validated port so healthz is not re-hit within the TTL", async () => {
    const c = cfg("p-cache");
    writePort("p-cache", "3093");
    let t = 1000;
    const h = healthz({ service: "gini-web", instance: "p-cache" });
    const deps = { fetch: h.fn, now: () => t, ttlMs: 5000 };
    expect(await resolveWebPort(c, deps)).toBe(3093);
    t = 4000; // still within TTL
    expect(await resolveWebPort(c, deps)).toBe(3093);
    expect(h.calls()).toBe(1);
    t = 7000; // past TTL → re-validates
    expect(await resolveWebPort(c, deps)).toBe(3093);
    expect(h.calls()).toBe(2);
  });

  test("returns null when healthz identifies a different instance (port reuse)", async () => {
    const c = cfg("p-foreign");
    writePort("p-foreign", "3094");
    const h = healthz({ service: "gini-web", instance: "someone-else" });
    expect(await resolveWebPort(c, { fetch: h.fn })).toBeNull();
  });

  test("returns null when healthz is a non-gini-web service", async () => {
    const c = cfg("p-other");
    writePort("p-other", "3095");
    const h = healthz({ service: "not-us", instance: "p-other" });
    expect(await resolveWebPort(c, { fetch: h.fn })).toBeNull();
  });

  test("returns null on a non-ok healthz status", async () => {
    const c = cfg("p-500");
    writePort("p-500", "3096");
    const h = healthz({ service: "gini-web", instance: "p-500" }, 503);
    expect(await resolveWebPort(c, { fetch: h.fn })).toBeNull();
  });

  test("returns null without probing when the recorded port equals the gateway port", async () => {
    const c = cfg("p-self");
    writePort("p-self", String(c.port)); // web.port == gateway port (stale/corrupt)
    const h = healthz({ service: "gini-web", instance: "p-self" });
    expect(await resolveWebPort(c, { fetch: h.fn })).toBeNull();
    expect(h.calls()).toBe(0); // never probes (would loop back into us)
  });

  test("returns null when healthz answers with a redirect (foreign squatter)", async () => {
    const c = cfg("p-redirect");
    writePort("p-redirect", "3097");
    // A 3xx is not `ok`; resolveWebPort must reject it rather than trust a
    // body it never sees (redirect: "manual" keeps fetch from following it).
    let sawManual = false;
    const fn = (async (_url: string, init?: { redirect?: string }) => {
      if (init?.redirect === "manual") sawManual = true;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/api/runtime/__healthz" } });
    }) as unknown as typeof fetch;
    expect(await resolveWebPort(c, { fetch: fn })).toBeNull();
    expect(sawManual).toBe(true);
  });

  test("a validation racing an invalidation does not repopulate the cache", async () => {
    const c = cfg("p-gen");
    writePort("p-gen", "3088");
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const slow = (async () => {
      await gate; // hold the probe open while we invalidate
      return new Response(JSON.stringify({ service: "gini-web", instance: "p-gen" }), { status: 200 });
    }) as unknown as typeof fetch;
    const inFlight = resolveWebPort(c, { fetch: slow });
    clearWebTargetCache("p-gen"); // bump generation mid-probe
    release();
    expect(await inFlight).toBe(3088); // still returns the just-validated port
    // The racing probe must NOT have cached; the next call re-validates.
    const fresh = healthz({ service: "gini-web", instance: "p-gen" });
    await resolveWebPort(c, { fetch: fresh.fn });
    expect(fresh.calls()).toBe(1);
  });

  test("returns null when the healthz request throws", async () => {
    const c = cfg("p-throw");
    writePort("p-throw", "3097");
    const fn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await resolveWebPort(c, { fetch: fn })).toBeNull();
  });
});

describe("clearWebTargetCache", () => {
  test("clearing a single instance leaves others; clearing all wipes the map", async () => {
    const a = cfg("c-a");
    const b = cfg("c-b");
    writePort("c-a", "3098");
    writePort("c-b", "3099");
    const ha = healthz({ service: "gini-web", instance: "c-a" });
    const hb = healthz({ service: "gini-web", instance: "c-b" });
    await resolveWebPort(a, { fetch: ha.fn });
    await resolveWebPort(b, { fetch: hb.fn });
    clearWebTargetCache("c-a");
    await resolveWebPort(a, { fetch: ha.fn }); // re-validates a
    await resolveWebPort(b, { fetch: hb.fn }); // b still cached
    expect(ha.calls()).toBe(2);
    expect(hb.calls()).toBe(1);
    clearWebTargetCache(); // wipe all
    await resolveWebPort(b, { fetch: hb.fn });
    expect(hb.calls()).toBe(2);
  });
});
