// Proxy unit tests. Exercise the Host-classified branch logic in isolation
// by driving the proxy() function with a synthetic NextRequest plus a temp
// GINI_STATE_ROOT that holds the tunnel config + publicUrl files the proxy
// reads on every request. The temp dir is wiped between tests so config /
// disable / rotate cycles can be exercised without leaking state.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import { proxy } from "./proxy";
import { TUNNEL_PUBLIC_URL_FILENAME } from "@runtime/runtime/tunnel/types";

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
  const p = join(instanceDir(), TUNNEL_PUBLIC_URL_FILENAME);
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

  test("Bearer with wrong value → 401 so mobile drops the stale credential", async () => {
    // A Bearer-bearing request that doesn't match the live secret most
    // often means the operator rotated the secret while the mobile app
    // held a stale credential. Returning 401 lets the mobile auth gate
    // recognize the unauthorized state and bounce the user to /setup;
    // 401 itself doesn't reveal this is a tunneled gateway specifically
    // because any HTTPS endpoint can issue a 401 challenge.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", authorization: `Bearer ${"Y".repeat(32)}` })
    );
    expect(res.status).toBe(401);
  });

  test("cookie with wrong value → 404 (browsers stay on the opaque path)", async () => {
    // Cookie-bearing requests are browser sessions; a 401 wouldn't help a
    // browser that can't programmatically clear its own cookie jar from an
    // unauthenticated response, so the opaque 404 stays right for them.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/runtime/chat",
        cookie: `gini_tunnel_session=${"Y".repeat(32)}`
      })
    );
    expect(res.status).toBe(404);
  });

  test("Bearer with wrong value + tunnel disabled → 404 (disable wins)", async () => {
    // Disabled tunnel must opaque-out before any 401 challenge — there is
    // no live secret to challenge against once the tunnel is down.
    writeConfig({ enabled: false, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/runtime/chat",
        authorization: `Bearer ${"Y".repeat(32)}`
      })
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

  test("malformed Authorization shape (no Bearer prefix) → 404", async () => {
    // `bearer` lowercase, `Token`, and missing-token forms all fail the
    // `^Bearer (.+)$` parser and produce a null bearer, so they hit the
    // "no auth at all" branch and 404. The exact `Bearer <token>` shape
    // is the only one that even reaches the secret comparison.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    for (const bad of [`bearer ${SECRET}`, `Token ${SECRET}`, "Bearer "]) {
      const res = await proxy(
        makeRequest({ path: "/api/runtime/chat", authorization: bad })
      );
      expect(res.status).toBe(404);
    }
  });

  test("Bearer with extra leading whitespace token → 401 (Bearer parsed but mismatched)", async () => {
    // `Bearer  <secret>` parses as Bearer with a leading-space token, which
    // doesn't constant-time-equal the live secret; so it hits the mismatch
    // branch and gets the same 401 a rotated-secret mobile client would.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/runtime/chat", authorization: `Bearer  ${SECRET}` })
    );
    expect(res.status).toBe(401);
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

describe("proxy /api/* rewrite to /api/runtime/* on tunnel branch", () => {
  // Mobile clients build URLs as `${origin}/api${path}` — e.g. `/api/agents`,
  // `/api/chat/<id>/poll` — but the BFF only exposes
  // `/api/runtime/[...path]`. Without this internal rewrite, every mobile
  // call 404s even after Bearer auth passes. The rewrite is scoped to the
  // tunnel branch (loopback / trusted callers reach `/api/runtime/...`
  // directly through the BFF the same way the local web UI does).
  function rewriteTarget(res: NextResponse): string | null {
    return res.headers.get("x-middleware-rewrite");
  }

  test("cookie + tunnel + /api/agents → rewrite to /api/runtime/agents", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/api/agents", cookie: `gini_tunnel_session=${SECRET}` })
    );
    expect(res.status).toBe(200);
    const target = rewriteTarget(res);
    expect(target).not.toBeNull();
    const url = new URL(target!);
    expect(url.pathname).toBe("/api/runtime/agents");
  });

  test("Bearer + tunnel + /api/chat/abc/poll?since=cursor123 → rewrite preserves query", async () => {
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/chat/abc/poll?since=cursor123",
        authorization: `Bearer ${SECRET}`
      })
    );
    expect(res.status).toBe(200);
    const target = rewriteTarget(res);
    expect(target).not.toBeNull();
    const url = new URL(target!);
    expect(url.pathname).toBe("/api/runtime/chat/abc/poll");
    expect(url.searchParams.get("since")).toBe("cursor123");
  });

  test("tunnel + /api/runtime/tunnel → NOT rewritten (already /runtime)", async () => {
    // Already under /api/runtime/... — leave alone so we never
    // double-prepend to /api/runtime/runtime/...
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({
        path: "/api/runtime/tunnel",
        authorization: `Bearer ${SECRET}`
      })
    );
    expect(res.status).toBe(200);
    expect(rewriteTarget(res)).toBeNull();
  });

  test("loopback + /api/agents → NOT rewritten (only tunnel branch rewrites)", async () => {
    // Loopback callers reach the BFF directly the same way the local web UI
    // does — they don't depend on the mobile path-shape rewrite.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const req = new NextRequest("http://localhost/api/agents", {
      method: "GET",
      headers: { host: "localhost" }
    });
    const res = await proxy(req);
    expect(res.status).toBe(200);
    expect(rewriteTarget(res)).toBeNull();
  });

  test("tunnel + /connect?... → NOT rewritten (not under /api/)", async () => {
    // /connect, /, /_next/..., /icon.png, /favicon.ico are app/static
    // routes — not BFF endpoints — so the rewrite must not touch them.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(
      makeRequest({ path: "/connect?api=foo", cookie: `gini_tunnel_session=${SECRET}` })
    );
    expect(res.status).toBe(200);
    expect(rewriteTarget(res)).toBeNull();
  });

  test("tunnel + /api/agents with no auth → 404 (gate runs before rewrite)", async () => {
    // Auth gates the rewrite; we never expose `/api/runtime/*` to a caller
    // who hasn't passed the cookie or Bearer check.
    writeConfig({ enabled: true, secret: SECRET });
    writePublicUrl(TUNNEL_ORIGIN);
    const res = await proxy(makeRequest({ path: "/api/agents" }));
    expect(res.status).toBe(404);
    expect(rewriteTarget(res)).toBeNull();
  });
});
