import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyRequest, runtimeTunnelState } from "./runtime";

// runtimeTunnelState reads the tunnel slot out of config.json on demand.
// The previous implementation required the runtime to inject
// GINI_TUNNEL_SECRET into the spawned web process at start time, which
// dropped the secret in two failure modes:
//
//   1. First-boot race: the gateway minted the secret AFTER `gini start`
//      had already spawned the web with an empty env.
//   2. Autostart: the launchd web plist did not propagate runtime env
//      variables at all, so the supervised web never saw the secret.
//
// Reading from config.json on each request (with the helper's mtime
// cache for cheap repeated reads) keeps the proxy in lockstep with the
// gateway's source of truth.
//
// Test layout: each test runs against a UNIQUE state root + UNIQUE
// instance name so the production-side mtime cache (a module-level Map
// keyed by absolute config path in lib/runtime.ts) cannot return a
// stale entry from a prior test. Reusing one path with sequential
// rmSync+write cycles risked a flake on filesystems where two writes
// within the same millisecond produced identical statSync().mtimeMs —
// the cache would serve the previous test's body.

let suiteRoot: string;
const envSnapshot: { instance: string | undefined; root: string | undefined } = {
  instance: undefined,
  root: undefined
};

beforeAll(() => {
  envSnapshot.instance = process.env.GINI_INSTANCE;
  envSnapshot.root = process.env.GINI_STATE_ROOT;
  suiteRoot = mkdtempSync(join(tmpdir(), "gini-runtime-tunnel-state-"));
});

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
  // Restore env so a later suite that depends on the original values
  // doesn't see this suite's overrides.
  if (envSnapshot.instance === undefined) delete process.env.GINI_INSTANCE;
  else process.env.GINI_INSTANCE = envSnapshot.instance;
  if (envSnapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = envSnapshot.root;
});

let instanceCounter = 0;
let currentInstance: string;

function withConfig(tunnel: unknown): void {
  const instanceDir = join(suiteRoot, "instances", currentInstance);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    join(instanceDir, "config.json"),
    JSON.stringify({ instance: currentInstance, tunnel }, null, 2)
  );
}

describe("runtimeTunnelState", () => {
  beforeEach(() => {
    instanceCounter += 1;
    currentInstance = `tunnel-state-test-${instanceCounter}`;
    process.env.GINI_INSTANCE = currentInstance;
    process.env.GINI_STATE_ROOT = suiteRoot;
  });

  afterEach(() => {
    // Tear down the per-test instance dir so we don't accumulate state,
    // but leave suiteRoot intact for the remaining tests.
    rmSync(join(suiteRoot, "instances", currentInstance), { recursive: true, force: true });
  });

  test("returns disabled + empty when config.json is missing", () => {
    const state = runtimeTunnelState();
    expect(state).toEqual({ enabled: false, secret: "" });
  });

  test("returns disabled when the tunnel slot is absent", () => {
    withConfig(undefined);
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });

  test("returns enabled+secret for a fully-configured tunnel", () => {
    withConfig({ enabled: true, secret: "abcdefghij0123456789" });
    expect(runtimeTunnelState()).toEqual({
      enabled: true,
      secret: "abcdefghij0123456789"
    });
  });

  test("treats enabled !== true as disabled", () => {
    withConfig({ enabled: "yes", secret: "abcdefghij0123456789" });
    const state = runtimeTunnelState();
    expect(state.enabled).toBe(false);
    expect(state.secret).toBe("abcdefghij0123456789");
  });

  test("ignores non-string secrets", () => {
    withConfig({ enabled: true, secret: 12345 });
    expect(runtimeTunnelState()).toEqual({ enabled: true, secret: "" });
  });

  test("returns disabled when config.json is invalid JSON", () => {
    const instanceDir = join(suiteRoot, "instances", currentInstance);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "config.json"), "{ not valid");
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });
});

// guardCsrf is not exported, so we exercise it through proxyRequest. The
// fetcher stub captures the upstream call; a 200 from the stub means the
// guard let the request through, while a 403 returned without the stub
// being called means the guard rejected.
describe("guardCsrf via proxyRequest", () => {
  let originsSnapshot: string | undefined;

  beforeEach(() => {
    originsSnapshot = process.env.GINI_TRUSTED_ORIGINS;
    delete process.env.GINI_TRUSTED_ORIGINS;
  });

  afterEach(() => {
    if (originsSnapshot === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
    else process.env.GINI_TRUSTED_ORIGINS = originsSnapshot;
  });

  function stubFetcher(): { fetcher: typeof fetch; called: () => number } {
    let calls = 0;
    const fetcher = mock(async () => {
      calls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetcher, called: () => calls };
  }

  test("non-loopback Host without vetted header is rejected", async () => {
    const { fetcher, called } = stubFetcher();
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(403);
    expect(called()).toBe(0);
  });

  test("non-loopback Host WITH vetted header and matching Origin is accepted", async () => {
    const { fetcher, called } = stubFetcher();
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com",
        "x-gini-tunnel-vetted": "1"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(200);
    expect(called()).toBe(1);
  });

  test("vetted header with mismatched Origin/Host is rejected", async () => {
    const { fetcher, called } = stubFetcher();
    // The marker without same-origin verification cannot authorize the
    // request — defense in depth against a proxy.ts bug that stamped the
    // header on a request whose Origin had been mangled in flight.
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://attacker.example",
        "x-gini-tunnel-vetted": "1"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(403);
    expect(called()).toBe(0);
  });

  test("vetted header with wrong value is treated as absent", async () => {
    const { fetcher, called } = stubFetcher();
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com",
        "x-gini-tunnel-vetted": "yes"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(403);
    expect(called()).toBe(0);
  });

  test("vetted header does NOT override GINI_TRUSTED_ORIGINS allowlist", async () => {
    // When the operator opted into the strict allowlist, the vetted
    // marker must not grant access to a hostname not on the list — that
    // would invert the explicit security posture the allowlist
    // represents. A typo-protected operator config wins over the
    // tunnel's internal authorization marker.
    process.env.GINI_TRUSTED_ORIGINS = "https://tail.example";
    const { fetcher, called } = stubFetcher();
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com",
        "x-gini-tunnel-vetted": "1"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(403);
    expect(called()).toBe(0);
  });

  test("vetted POST from tunneled origin is accepted (unsafe method)", async () => {
    const { fetcher, called } = stubFetcher();
    const request = new Request("https://abc.trycloudflare.com/api/runtime/chats", {
      method: "POST",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com",
        "x-gini-tunnel-vetted": "1",
        "content-type": "application/json"
      },
      body: JSON.stringify({ title: "test" })
    });
    const response = await proxyRequest(request, ["chats"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(200);
    expect(called()).toBe(1);
  });

  test("loopback request without vetted header still works", async () => {
    // Verifies the existing local-dev path isn't broken: a same-origin
    // request on 127.0.0.1 still passes without the marker.
    const { fetcher, called } = stubFetcher();
    const request = new Request("http://127.0.0.1:3072/api/runtime/state", {
      method: "GET",
      headers: {
        host: "127.0.0.1:3072",
        origin: "http://127.0.0.1:3072"
      }
    });
    const response = await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(response.status).toBe(200);
    expect(called()).toBe(1);
  });

  test("the vetted header is NOT forwarded to the runtime", async () => {
    // pickForwardHeaders allow-lists `content-type`, `accept`,
    // `cache-control`, and `last-event-id`. The vetted marker is an
    // internal BFF-only signal — the runtime must never see it,
    // otherwise a future runtime change that trusts the header would
    // re-open the bypass that the BFF guard exists to prevent.
    let observed: Headers | null = null;
    const fetcher = mock(async (_url: string, init: RequestInit) => {
      observed = new Headers(init.headers);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const request = new Request("https://abc.trycloudflare.com/api/runtime/state", {
      method: "GET",
      headers: {
        host: "abc.trycloudflare.com",
        origin: "https://abc.trycloudflare.com",
        "x-gini-tunnel-vetted": "1"
      }
    });
    await proxyRequest(request, ["state"], {
      runtimeUrl: "http://127.0.0.1:7778",
      token: "test-token",
      fetcher
    });
    expect(observed).not.toBeNull();
    expect((observed as unknown as Headers).get("x-gini-tunnel-vetted")).toBeNull();
  });
});
