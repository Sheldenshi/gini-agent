import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

// Drive `proxy()` against the real `runtimeTunnelState()` by writing
// config.json on disk under a scratch GINI_STATE_ROOT. Mocking the
// module instead (via `mock.module`) would persist across the test
// process and leak into sibling test files — runtime.test.ts in
// particular reads the same exports and breaks if it sees a stale
// in-memory stub.
//
// Test layout: per-test instance + scratch root via mkdtempSync, so
// filesystem state from a prior test cannot leak into the current one
// (two writes within the same millisecond could otherwise share an
// indistinguishable mtime).

let suiteRoot: string;
const TOKEN = "test-token";
const envSnapshot: { instance?: string; root?: string; token?: string; url?: string } = {};
const originalFetch = globalThis.fetch;
let instanceCounter = 0;
let currentInstance: string;

beforeAll(() => {
  envSnapshot.instance = process.env.GINI_INSTANCE;
  envSnapshot.root = process.env.GINI_STATE_ROOT;
  envSnapshot.token = process.env.GINI_TOKEN;
  envSnapshot.url = process.env.GINI_RUNTIME_URL;
  suiteRoot = mkdtempSync(join(tmpdir(), "gini-proxy-test-"));
});

afterAll(() => {
  if (envSnapshot.instance === undefined) delete process.env.GINI_INSTANCE;
  else process.env.GINI_INSTANCE = envSnapshot.instance;
  if (envSnapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = envSnapshot.root;
  if (envSnapshot.token === undefined) delete process.env.GINI_TOKEN;
  else process.env.GINI_TOKEN = envSnapshot.token;
  if (envSnapshot.url === undefined) delete process.env.GINI_RUNTIME_URL;
  else process.env.GINI_RUNTIME_URL = envSnapshot.url;
  // CRITICAL: restore globalThis.fetch. The beforeEach replaces it with
  // a Bun mock; without this restoration, sibling test files in the
  // same Bun process inherit the stubbed fetch and start failing
  // because every real HTTP request resolves to providerConfigured:true
  // regardless of target. browser-connect tests in particular hit
  // unreachable CDP endpoints and expect timeouts; the stub turns
  // those into spurious successes.
  globalThis.fetch = originalFetch;
  rmSync(suiteRoot, { recursive: true, force: true });
});

function writeTunnelConfig(tunnel: unknown): void {
  const dir = join(suiteRoot, "instances", currentInstance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ instance: currentInstance, token: TOKEN, tunnel }, null, 2)
  );
}

describe("proxy", () => {
  beforeEach(() => {
    instanceCounter += 1;
    currentInstance = `proxy-test-${instanceCounter}`;
    process.env.GINI_INSTANCE = currentInstance;
    process.env.GINI_STATE_ROOT = suiteRoot;
    process.env.GINI_TOKEN = TOKEN;
    // Pin the runtime URL so isProviderConfigured() always targets the
    // stubbed fetch below — without a static URL the helper would resolve
    // to the real instance's runtime.port and the test would race a live
    // gateway.
    process.env.GINI_RUNTIME_URL = "http://127.0.0.1:9";
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ providerConfigured: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    // Restore the original fetch after each test so a sibling test
    // that runs between hooks doesn't observe the stub.
    globalThis.fetch = originalFetch;
    rmSync(join(suiteRoot, "instances", currentInstance), { recursive: true, force: true });
  });

  test("external host with tunnel disabled returns 404", async () => {
    writeTunnelConfig({ enabled: false, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://tunnel.example.com/anything"), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("external host bootstrap to /<secret> redirects to / with Set-Cookie", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect([307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toBe("https://tunnel.example.com/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Max-Age=86400");
  });

  test("external host bootstrap to /<secret>/settings rewrites with Set-Cookie", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}/settings`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    expect(rewriteHeader).not.toBeNull();
    expect(new URL(rewriteHeader as string).pathname).toBe("/settings");
    expect(response.status).toBeLessThan(300);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);
    expect(setCookie).toContain("HttpOnly");
  });

  test("external host with valid cookie + bare path passes through", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL("https://tunnel.example.com/dashboard"), {
      headers: { host: "tunnel.example.com", cookie: `gini_tunnel_session=${secret}` }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const location = response.headers.get("location");
    if (location) expect(location).not.toContain("/setup");
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    if (rewriteHeader) {
      expect(new URL(rewriteHeader).pathname).toBe("/dashboard");
    }
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("external host with wrong cookie and no prefix returns 404", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://tunnel.example.com/dashboard"), {
      headers: {
        host: "tunnel.example.com",
        cookie: "gini_tunnel_session=not-the-secret"
      }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("suffix-shadow hostname `localhost.attacker.example` still requires tunnel auth", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("https://localhost.attacker.example/dashboard"), {
      headers: { host: "localhost.attacker.example" }
    });
    const response = await proxy(request);
    expect(response.status).toBe(404);
  });

  test("localhost host 127.0.0.1:3072 bypasses the tunnel gate", async () => {
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("http://127.0.0.1:3072/whatever"), {
      headers: { host: "127.0.0.1:3072" }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const location = response.headers.get("location");
    if (location) expect(location).not.toContain("/setup");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("external host with trailing-slash bootstrap `/<secret>/` accepts the request", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}/`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`gini_tunnel_session=${secret}`);

    const isRedirect = response.status >= 300 && response.status < 400;
    const rewriteHeader = response.headers.get("x-middleware-rewrite");
    if (isRedirect) {
      const location = response.headers.get("location") ?? "";
      expect(new URL(location, "https://tunnel.example.com").pathname).toBe("/");
    } else {
      expect(rewriteHeader).not.toBeNull();
      expect(new URL(rewriteHeader as string).pathname).toBe("/");
    }
  });

  // Verify the tunnel-vetted marker is stamped on rewritten requests so
  // the BFF guard accepts them. NextResponse.rewrite with
  // `{ request: { headers } }` propagates modified headers via
  // `x-middleware-request-<key>` + an `x-middleware-override-headers`
  // index — Next's adapter rewrites those onto the request before the
  // route handler sees it. We inspect those internal markers rather
  // than running the full handler.
  test("rewritten cookie-authed request carries x-gini-tunnel-vetted: 1", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL("https://tunnel.example.com/api/runtime/state"), {
      headers: { host: "tunnel.example.com", cookie: `gini_tunnel_session=${secret}` }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    const overrideIndex = response.headers.get("x-middleware-override-headers") ?? "";
    expect(overrideIndex.split(",")).toContain("x-gini-tunnel-vetted");
    expect(response.headers.get("x-middleware-request-x-gini-tunnel-vetted")).toBe("1");
  });

  test("rewritten bootstrap request carries x-gini-tunnel-vetted: 1", async () => {
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL(`https://tunnel.example.com/${secret}/settings`), {
      headers: { host: "tunnel.example.com" }
    });
    const response = await proxy(request);
    const overrideIndex = response.headers.get("x-middleware-override-headers") ?? "";
    expect(overrideIndex.split(",")).toContain("x-gini-tunnel-vetted");
    expect(response.headers.get("x-middleware-request-x-gini-tunnel-vetted")).toBe("1");
  });

  test("inbound x-gini-tunnel-vetted from a tunnel client is stripped and re-set", async () => {
    // Without the strip, a remote attacker who knows the trycloudflare
    // hostname but NOT the secret could attach the marker themselves
    // and bypass the BFF guard. The proxy must always overwrite the
    // value rather than passing it through verbatim. We verify by
    // sending a deliberately wrong value and confirming the rewritten
    // request carries `1` (the proxy's canonical value).
    const secret = "abcdefghij0123456789";
    writeTunnelConfig({ enabled: true, secret });
    const request = new NextRequest(new URL("https://tunnel.example.com/api/runtime/state"), {
      headers: {
        host: "tunnel.example.com",
        cookie: `gini_tunnel_session=${secret}`,
        "x-gini-tunnel-vetted": "attacker-supplied"
      }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    expect(response.headers.get("x-middleware-request-x-gini-tunnel-vetted")).toBe("1");
  });

  test("localhost requests have x-gini-tunnel-vetted stripped (not set)", async () => {
    // Defense in depth: a co-tenant process on 127.0.0.1 should not be
    // able to forge the marker to influence the BFF guard. The proxy
    // strips it on the localhost path and does NOT re-set it (loopback
    // Host already satisfies the guard). The override index lists the
    // header (because the proxy clones+modifies the headers object) but
    // the value must be empty, signalling deletion.
    writeTunnelConfig({ enabled: true, secret: "abcdefghij0123456789" });
    const request = new NextRequest(new URL("http://127.0.0.1:3072/api/runtime/state"), {
      headers: {
        host: "127.0.0.1:3072",
        "x-gini-tunnel-vetted": "attacker-supplied"
      }
    });
    const response = await proxy(request);
    expect(response.status).not.toBe(404);
    // The strippedHeaders helper deletes the marker. NextResponse.next
    // stamps the override index only for keys that differ from the
    // request — when we delete a header the override index records it
    // with an empty value so the downstream sees no marker.
    const stampedValue = response.headers.get("x-middleware-request-x-gini-tunnel-vetted");
    expect(stampedValue === null || stampedValue === "").toBe(true);
  });
});
