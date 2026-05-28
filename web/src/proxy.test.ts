// Proxy unit tests. Exercise the Host-classified branch logic in isolation
// by driving the proxy() function with a synthetic NextRequest plus a temp
// GINI_STATE_ROOT that holds the tunnel config + publicUrl files the proxy
// reads on every request. The temp dir is wiped between tests so config /
// disable / rotate cycles can be exercised without leaking state.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const STATE_ROOT = mkdtempSync(join(tmpdir(), "gini-proxy-test-"));
const INSTANCE = "default";
const TUNNEL_HOST = "test-tunnel.trycloudflare.com";
const TUNNEL_ORIGIN = `https://${TUNNEL_HOST}`;
const SECRET = "X".repeat(32);

const originalStateRoot = process.env.GINI_STATE_ROOT;
const originalInstance = process.env.GINI_INSTANCE;
process.env.GINI_STATE_ROOT = STATE_ROOT;
process.env.GINI_INSTANCE = INSTANCE;

function instanceDir(): string {
  return join(STATE_ROOT, "instances", INSTANCE);
}

function writeConfig(opts: { enabled: boolean; secret: string }): void {
  mkdirSync(instanceDir(), { recursive: true });
  writeFileSync(
    join(instanceDir(), "config.json"),
    JSON.stringify({ tunnel: { enabled: opts.enabled, secret: opts.secret } })
  );
}

function writePublicUrl(url: string | null): void {
  mkdirSync(instanceDir(), { recursive: true });
  const p = join(instanceDir(), "tunnel.publicUrl");
  if (url === null) {
    try { rmSync(p); } catch { /* may not exist */ }
    return;
  }
  writeFileSync(p, `${url}\n`);
}

function makeRequest(opts: {
  path: string;
  method?: string;
  cookie?: string;
  authorization?: string;
}): NextRequest {
  const headers: Record<string, string> = { host: TUNNEL_HOST };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.authorization) headers.authorization = opts.authorization;
  return new NextRequest(`${TUNNEL_ORIGIN}${opts.path}`, {
    method: opts.method ?? "GET",
    headers
  });
}

beforeEach(() => {
  try { rmSync(instanceDir(), { recursive: true, force: true }); } catch { /* may not exist */ }
});

afterAll(() => {
  if (originalStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = originalStateRoot;
  if (originalInstance === undefined) delete process.env.GINI_INSTANCE;
  else process.env.GINI_INSTANCE = originalInstance;
  try { rmSync(STATE_ROOT, { recursive: true, force: true }); } catch { /* may not exist */ }
});

describe("proxy bootstrap redirect through /connect", () => {
  test("secret-prefix bootstrap 302s to /connect with api+web+token + Set-Cookie", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(makeRequest({ path: `/${SECRET}` }));
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    // The Location is the exact URL-encoded form the task specifies. Both
    // `api` and `web` carry the full origin so the /connect interstitial can
    // hand off to the gini-mobile app and fall back to the mobile web app.
    const encodedOrigin = encodeURIComponent(TUNNEL_ORIGIN);
    const encodedSecret = encodeURIComponent(SECRET);
    expect(location).toBe(
      `${TUNNEL_ORIGIN}/connect?api=${encodedOrigin}&web=${encodedOrigin}&token=${encodedSecret}`
    );
    // Cookie still minted — the web-app fallback path needs an authed session
    // the moment the visibilitychange timeout fires in the interstitial.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`gini_tunnel_session=${SECRET}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=86400");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("secret-prefix bootstrap with sub-path still redirects to /connect", async () => {
    // The destination after handoff is always /connect — the original
    // sub-path is dropped (the operator scanned a QR; there's no meaningful
    // deep-page intent to preserve).
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(makeRequest({ path: `/${SECRET}/agents/abc` }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/connect?");
  });
});

describe("proxy Bearer-auth fallback", () => {
  test("missing Authorization + missing cookie → 404", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(makeRequest({ path: "/api/runtime/chat" }));
    expect(res.status).toBe(404);
  });

  test("cookie matches secret → vetted + forwarded", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", cookie: `gini_tunnel_session=${SECRET}` })
    );
    // Vetted requests pass through with the next-marker set on the forwarded
    // headers. NextResponse.next() returns 200 with the marker header on the
    // request that gets forwarded — we surface that via the x-middleware-*
    // headers Next attaches.
    expect(res.status).toBe(200);
  });

  test("Bearer matches secret → vetted + forwarded", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", authorization: `Bearer ${SECRET}` })
    );
    expect(res.status).toBe(200);
  });

  test("Bearer with wrong value → 404", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", authorization: `Bearer ${"Y".repeat(32)}` })
    );
    expect(res.status).toBe(404);
  });

  test("Bearer matches but tunnel disabled → 404", async () => {
    // Disable wins over any auth path — the whole tunnel branch 404s before
    // either cookie or Bearer is evaluated.
    writeConfig({ enabled: false, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", authorization: `Bearer ${SECRET}` })
    );
    expect(res.status).toBe(404);
  });

  test("Bearer with malformed scheme prefix → 404", async () => {
    // Multiple spaces and missing scheme name both fall through to the
    // unauthorized branch; only the exact `Bearer <token>` shape passes.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    for (const bad of [`Bearer  ${SECRET}`, `bearer ${SECRET}`, `Token ${SECRET}`, "Bearer "]) {
      const res = await proxy(
        makeRequest({ path: "/api/runtime/chat", authorization: bad })
      );
      expect(res.status).toBe(404);
    }
  });

  test("Bearer + denied path → 404", async () => {
    // Bearer-authed requests are still subject to the same deny list as
    // cookie-authed ones — minting a permanent device bearer through the
    // tunnel must stay blocked regardless of which auth path got the
    // request past the gate.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/runtime/pairing/claim",
        method: "POST",
        authorization: `Bearer ${SECRET}`
      })
    );
    expect(res.status).toBe(404);
  });

  test("cookie + Bearer both present and matching → vetted", async () => {
    // Whichever branch runs first wins; the request is vetted either way.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/runtime/chat",
        cookie: `gini_tunnel_session=${SECRET}`,
        authorization: `Bearer ${SECRET}`
      })
    );
    expect(res.status).toBe(200);
  });
});
