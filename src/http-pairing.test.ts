import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { createHandler, isPairingBootstrapPath, resetPairingLimiters } from "./http";
import { createPairingRequest, mutateState } from "./state";

// The pairing rate limiters are module-level singletons shared across this
// file's many create calls; reset their buckets before each test so tests stay
// hermetic regardless of order.
beforeEach(() => resetPairingLimiters());

function testConfig(instance: string): RuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), `gini-pair-${instance}-`));
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

const RELAY = (instance: string) => `${instance}.gini-relay.lilaclabs.ai`;

interface CallOpts {
  method?: string;
  host?: string;
  origin?: string;
  cookie?: string;
  secFetchDest?: string;
  secFetchSite?: string;
  xff?: string;
  userAgent?: string;
  body?: unknown;
}

function makeHandler(instance: string) {
  const config = testConfig(instance);
  return { config, handler: createHandler(config) };
}

async function pair(handler: ReturnType<typeof createHandler>, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.host) headers.host = opts.host;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.secFetchDest) headers["sec-fetch-dest"] = opts.secFetchDest;
  if (opts.secFetchSite) headers["sec-fetch-site"] = opts.secFetchSite;
  if (opts.xff) headers["x-forwarded-for"] = opts.xff;
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  return handler(
    new Request(`http://127.0.0.1:7337${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    })
  );
}

// Read a single cookie value out of a response's Set-Cookie list.
function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq).trim() === name) return decodeURIComponent(pair!.slice(eq + 1).trim());
  }
  return undefined;
}

// Drive the full happy path and return the handler + the minted session cookie.
async function pairedSession(instance: string) {
  const { config, handler } = makeHandler(instance);
  const relay = RELAY(instance);
  const created = await pair(handler, "/api/pairing/request", {
    method: "POST",
    host: relay,
    origin: `https://${relay}`,
    secFetchSite: "same-origin",
    userAgent: "Mozilla/5.0 (iPhone) Safari",
    body: {}
  });
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  const bind = setCookieValue(created, "gini_pair")!;
  expect(bind).toBeTruthy();
  // operator approves over loopback
  const approved = await pair(handler, `/api/pairing/requests/${createdBody.id}/approve`, {
    method: "POST",
    host: "127.0.0.1:7337",
    origin: "http://127.0.0.1:7337",
    secFetchSite: "same-origin",
    body: {}
  });
  expect(approved.status).toBe(200);
  // device claims
  const claimed = await pair(handler, `/api/pairing/request/${createdBody.id}/claim`, {
    method: "POST",
    host: relay,
    origin: `https://${relay}`,
    secFetchSite: "same-origin",
    cookie: `gini_pair=${encodeURIComponent(bind)}`,
    body: {}
  });
  expect(claimed.status).toBe(200);
  const session = setCookieValue(claimed, "gini_session")!;
  expect(session).toBeTruthy();
  return { config, handler, relay, requestId: createdBody.id as string, session, bind };
}

describe("isPairingBootstrapPath", () => {
  test.each([
    ["/pair", true],
    ["/pair/anything", true],
    ["/_next/static/chunk.js", true],
    ["/favicon.ico", true],
    ["/gini-agent-logo.png", true],
    ["/styles.css", true],
    ["/", false],
    ["/chat", false],
    ["/api/runtime/state", false],
    ["/api/pairing/request", false]
  ])("%p -> %p", (path, expected) => {
    expect(isPairingBootstrapPath(path)).toBe(expected);
  });
});

describe("pairing routes — CSRF / host trust", () => {
  test("rejects a cross-site POST", async () => {
    const { handler } = makeHandler("pair-csrf");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST",
      host: RELAY("pair-csrf"),
      origin: "https://evil.example",
      secFetchSite: "cross-site",
      body: {}
    });
    expect(res.status).toBe(403);
  });
});

describe("pairing routes — device create + poll", () => {
  test("create returns id+code and sets the binding cookie", async () => {
    const { handler } = makeHandler("pair-create");
    const relay = RELAY("pair-create");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/120 Safari/537", body: {}
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^preq_/);
    expect(body.code).toMatch(/^\d{3}-\d{3}$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("gini_pair="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/api/pairing");
  });

  test("create over a plain-http trusted front omits Secure on the binding cookie", async () => {
    // A non-relay, non-loopback GINI_TRUSTED_ORIGINS front served over plain
    // http would have a Secure cookie silently dropped by the browser, so
    // pairingCookieSecure returns false here and the cookie carries no Secure.
    const front = "pair-front.test:7337";
    const previous = process.env.GINI_TRUSTED_ORIGINS;
    process.env.GINI_TRUSTED_ORIGINS = `http://${front}`;
    try {
      const { handler } = makeHandler("pair-create-insecure");
      const res = await pair(handler, "/api/pairing/request", {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin", body: {}
      });
      expect(res.status).toBe(201);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("gini_pair="));
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toContain("Secure");
    } finally {
      if (previous === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
      else process.env.GINI_TRUSTED_ORIGINS = previous;
    }
  });

  test("poll without the binding cookie is 401", async () => {
    const { handler } = makeHandler("pair-poll-nocookie");
    const relay = RELAY("pair-poll-nocookie");
    const res = await pair(handler, "/api/pairing/request/preq_x", {
      host: relay, secFetchSite: "same-origin"
    });
    expect(res.status).toBe(401);
  });

  test("poll with cookie for unknown id is 404", async () => {
    const { handler } = makeHandler("pair-poll-404");
    const relay = RELAY("pair-poll-404");
    const res = await pair(handler, "/api/pairing/request/preq_missing", {
      host: relay, secFetchSite: "same-origin", cookie: "gini_pair=whatever"
    });
    expect(res.status).toBe(404);
  });

  test("poll returns the pending status", async () => {
    const { handler } = makeHandler("pair-poll-pending");
    const relay = RELAY("pair-poll-pending");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const bind = setCookieValue(created, "gini_pair")!;
    const res = await pair(handler, `/api/pairing/request/${id}`, {
      host: relay, secFetchSite: "same-origin", cookie: `gini_pair=${encodeURIComponent(bind)}`
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });

  test("poll with a mismatched binding cookie is 403", async () => {
    const { handler } = makeHandler("pair-poll-mismatch");
    const relay = RELAY("pair-poll-mismatch");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    // The request exists, but the presented secret doesn't match its bindHash:
    // bind_mismatch maps to 403, not the 404 reserved for an unknown id.
    const res = await pair(handler, `/api/pairing/request/${id}`, {
      host: relay, secFetchSite: "same-origin", cookie: "gini_pair=not-the-real-secret"
    });
    expect(res.status).toBe(403);
  });

  test("unknown pairing path under the prefix is 404", async () => {
    const { handler } = makeHandler("pair-unknown");
    const relay = RELAY("pair-unknown");
    const res = await pair(handler, "/api/pairing/request", {
      host: relay, secFetchSite: "same-origin" // GET with no id, no create
    });
    expect(res.status).toBe(404);
  });
});

describe("pairing routes — operator (loopback-only)", () => {
  test("list/approve/reject require a loopback host", async () => {
    const { handler } = makeHandler("pair-op-relay");
    const relay = RELAY("pair-op-relay");
    for (const [method, path] of [
      ["GET", "/api/pairing/requests"],
      ["POST", "/api/pairing/requests/preq_x/approve"],
      ["POST", "/api/pairing/requests/preq_x/reject"]
    ] as const) {
      const res = await pair(handler, path, { method, host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {} });
      expect(res.status).toBe(403);
    }
  });

  test("loopback list shows a pending request and approve/reject resolve it", async () => {
    const { handler } = makeHandler("pair-op-flow");
    const relay = RELAY("pair-op-flow");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", userAgent: "X Safari", body: {}
    });
    const { id, code } = await created.json();
    const listed = await pair(handler, "/api/pairing/requests", { host: "127.0.0.1:7337", secFetchSite: "same-origin" });
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.requests.find((r: { id: string }) => r.id === id)?.code).toBe(code);
    // the list must never leak the binding hash
    expect(JSON.stringify(listBody)).not.toContain("bindHash");

    const approve = await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()).request.status).toBe("approved");
  });

  test("reject resolves a pending request", async () => {
    const { handler } = makeHandler("pair-op-reject");
    const relay = RELAY("pair-op-reject");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const reject = await pair(handler, `/api/pairing/requests/${id}/reject`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(reject.status).toBe(200);
    expect((await reject.json()).request.status).toBe("rejected");
  });

  test("a bad method on an operator path is 404", async () => {
    const { handler } = makeHandler("pair-op-badmethod");
    const res = await pair(handler, "/api/pairing/requests", {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(res.status).toBe(404);
  });

  test("approve of a missing request is a 404 JSON envelope", async () => {
    const { handler } = makeHandler("pair-op-approve-missing");
    // approvePairing throws "Pairing request not found." which the wrapping
    // try/catch maps through statusFromErrorMessage to 404 JSON, not 500.
    const res = await pair(handler, "/api/pairing/requests/preq_missing/approve", {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  test("approve of an already-resolved request is a 409 JSON envelope", async () => {
    const { handler } = makeHandler("pair-op-approve-twice");
    const relay = RELAY("pair-op-approve-twice");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const first = await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(first.status).toBe(200);
    // The second approve throws "Pairing request is already approved." which
    // maps to 409 JSON, never the catch-all 500.
    const second = await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBeTruthy();
  });
});

describe("pairing routes — dispatch predicate", () => {
  test("a near-miss path falls through to the bearer gate (401, not the pairing handler)", async () => {
    const { handler } = makeHandler("pair-predicate");
    const relay = RELAY("pair-predicate");
    // "/api/pairing/request-foo" is NOT a device-pairing path (isDevicePairingPath
    // is enumerated, not prefix-matched), so it skips the pairing handler and
    // hits the bearer gate. No bearer → 401.
    const res = await pair(handler, "/api/pairing/request-foo", {
      host: relay, secFetchSite: "same-origin"
    });
    expect(res.status).toBe(401);
  });
});

describe("pairing routes — claim", () => {
  test("claim without the binding cookie is 401", async () => {
    const { handler } = makeHandler("pair-claim-nocookie");
    const relay = RELAY("pair-claim-nocookie");
    const res = await pair(handler, "/api/pairing/request/preq_x/claim", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    expect(res.status).toBe(401);
  });

  test("claim of an unknown request is 404", async () => {
    const { handler } = makeHandler("pair-claim-404");
    const relay = RELAY("pair-claim-404");
    const res = await pair(handler, "/api/pairing/request/preq_missing/claim", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: "gini_pair=abc", body: {}
    });
    expect(res.status).toBe(404);
  });

  test("claim with the wrong binding secret is 403", async () => {
    const { handler } = makeHandler("pair-claim-mismatch");
    const relay = RELAY("pair-claim-mismatch");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    const res = await pair(handler, `/api/pairing/request/${id}/claim`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: "gini_pair=wrong", body: {}
    });
    expect(res.status).toBe(403);
  });

  test("claim before approval is 409", async () => {
    const { handler } = makeHandler("pair-claim-early");
    const relay = RELAY("pair-claim-early");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const bind = setCookieValue(created, "gini_pair")!;
    const res = await pair(handler, `/api/pairing/request/${id}/claim`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: `gini_pair=${encodeURIComponent(bind)}`, body: {}
    });
    expect(res.status).toBe(409);
  });

  test("approved claim mints a session cookie and clears the binding cookie", async () => {
    const { session, requestId } = await pairedSession("pair-claim-ok");
    expect(session).toMatch(/^gini_device_/);
    expect(requestId).toMatch(/^preq_/);
  });
});

describe("pairing routes — cancel", () => {
  test("cancel without the binding cookie is 401", async () => {
    const { handler } = makeHandler("pair-cancel-nocookie");
    const relay = RELAY("pair-cancel-nocookie");
    const res = await pair(handler, "/api/pairing/request/preq_x/cancel", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    expect(res.status).toBe(401);
  });

  test("cancel of an unknown request is 404", async () => {
    const { handler } = makeHandler("pair-cancel-404");
    const relay = RELAY("pair-cancel-404");
    const res = await pair(handler, "/api/pairing/request/preq_missing/cancel", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: "gini_pair=abc", body: {}
    });
    expect(res.status).toBe(404);
  });

  test("cancel with a mismatched secret is 403", async () => {
    const { handler } = makeHandler("pair-cancel-mismatch");
    const relay = RELAY("pair-cancel-mismatch");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const res = await pair(handler, `/api/pairing/request/${id}/cancel`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: "gini_pair=wrong", body: {}
    });
    expect(res.status).toBe(403);
  });

  test("cancel of own pending request succeeds and clears the cookie", async () => {
    const { handler } = makeHandler("pair-cancel-ok");
    const relay = RELAY("pair-cancel-ok");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const bind = setCookieValue(created, "gini_pair")!;
    const res = await pair(handler, `/api/pairing/request/${id}/cancel`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: `gini_pair=${encodeURIComponent(bind)}`, body: {}
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("gini_pair=") && c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("pairing routes — rate limit + pending cap", () => {
  // The module-level limiters use the wall clock by default and aren't exported,
  // so freeze the system clock for the create loop: with the clock frozen the
  // per-host bucket never refills, so the 11th create on the same host (capacity
  // 10) reliably trips the limit.
  afterEach(() => setSystemTime());

  test("creation is rate limited per host", async () => {
    const { handler } = makeHandler("pair-ratelimit");
    const relay = RELAY("pair-ratelimit");
    setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    let last = 201;
    for (let i = 0; i < 11; i++) {
      const res = await pair(handler, "/api/pairing/request", {
        method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  test("the legacy code-claim endpoint is rate limited per host", async () => {
    const { handler } = makeHandler("pair-claim-ratelimit");
    setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    // Each wrong code is a 400, but it still consumes a claim token; with the
    // clock frozen the bucket (capacity 10) never refills, so the 11th attempt
    // from the same host trips the limiter before the claim is even attempted.
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await pair(handler, "/api/pairing/claim", {
        method: "POST",
        body: { code: "000000", deviceName: "brute" }
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  test("the pending cap maps to 429", async () => {
    const { config, handler } = makeHandler("pair-pendingcap");
    const relay = RELAY("pair-pendingcap");
    // Pre-seed the cap of pending requests directly through the state mutation
    // (no rate-limiter tokens consumed) so the cap — not the host limiter — is
    // what the create has to clear. A fresh host keeps the host limiter happy.
    await mutateState(config.instance, (state) => {
      for (let i = 0; i < 20; i++) {
        createPairingRequest(state, { userAgent: "seed", relayHost: relay, bindSecret: `seed-${i}` });
      }
    });
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    expect(res.status).toBe(429);
  });
});

describe("relay session gate (web-bound branch)", () => {
  test("unpaired relay page navigation redirects to /pair", async () => {
    const { handler } = makeHandler("gate-redirect");
    const relay = RELAY("gate-redirect");
    const res = await pair(handler, "/", { host: relay, secFetchDest: "document" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pair");
  });

  test("unpaired relay /api/runtime call is 401", async () => {
    const { handler } = makeHandler("gate-api-401");
    const relay = RELAY("gate-api-401");
    const res = await pair(handler, "/api/runtime/state", {
      host: relay, origin: `https://${relay}`, secFetchSite: "same-origin"
    });
    expect(res.status).toBe(401);
  });

  test("a bootstrap path is reachable unpaired (not redirected)", async () => {
    const { handler } = makeHandler("gate-bootstrap");
    const relay = RELAY("gate-bootstrap");
    const res = await pair(handler, "/pair", { host: relay, secFetchDest: "document" });
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
  });

  test("a valid session cookie passes the gate", async () => {
    const { handler, relay, session } = await pairedSession("gate-allow");
    const res = await pair(handler, "/", {
      host: relay, secFetchDest: "document", cookie: `gini_session=${encodeURIComponent(session)}`
    });
    // Past the gate → proxyWeb fallback (no web child in tests), never 302/401.
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
  });

  test("loopback is never gated", async () => {
    const { handler } = makeHandler("gate-loopback");
    const res = await pair(handler, "/", { host: "127.0.0.1:7337", secFetchDest: "document" });
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
  });

  test("a relay session cannot create legacy pairing codes (POST /api/runtime/pairing is 403)", async () => {
    // A relay session is owner-equivalent for live use but must not mint a
    // persistent, non-expiring legacy device bearer that would outlive its own
    // revocation. The only browser path to legacy creation is the BFF
    // (/api/runtime/pairing); the gateway refuses it for relay sessions.
    const { handler, relay, session } = await pairedSession("gate-legacy-create");
    const res = await pair(handler, "/api/runtime/pairing", {
      method: "POST",
      host: relay,
      origin: `https://${relay}`,
      secFetchSite: "same-origin",
      cookie: `gini_session=${encodeURIComponent(session)}`,
      body: { ttlSeconds: 600 }
    });
    expect(res.status).toBe(403);
  });

  test("encoded /api/runtime/pairing variants are also refused for a relay session", async () => {
    // url.pathname is not percent-decoded, so a literal compare alone would miss
    // /api/runtime/%70airing — but the BFF recursively decodes it back to
    // "pairing" and forwards legacy create. The gate decodes before comparing.
    const { handler, relay, session } = await pairedSession("gate-legacy-create-encoded");
    for (const path of ["/api/runtime/%70airing", "/api/runtime/%2570airing", "/api/runtime/pa%69ring"]) {
      const res = await pair(handler, path, {
        method: "POST",
        host: relay,
        origin: `https://${relay}`,
        secFetchSite: "same-origin",
        cookie: `gini_session=${encodeURIComponent(session)}`,
        body: { ttlSeconds: 600 }
      });
      expect(res.status).toBe(403);
    }
  });

  test("loopback is NOT refused for legacy create (no relay gate)", async () => {
    const { handler } = makeHandler("gate-legacy-create-loopback");
    const res = await pair(handler, "/api/runtime/pairing", {
      method: "POST",
      host: "127.0.0.1:7337",
      origin: "http://127.0.0.1:7337",
      secFetchSite: "same-origin",
      body: { ttlSeconds: 600 }
    });
    // Loopback isn't relay-gated, so it proxies to the (absent in tests) web
    // child and falls back — never the relay-only 403.
    expect(res.status).not.toBe(403);
  });
});
