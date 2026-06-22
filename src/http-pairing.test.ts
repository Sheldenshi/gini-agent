import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { createHandler, isPairingBootstrapPath, resetPairingLimiters } from "./http";
import { clearRuntimeTunnelTrust, setRuntimeTunnelTrust } from "./lib/origin-trust";
import { createPairingRequest, mutateState, readState } from "./state";

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
  // Native mobile-client headers: the cookieless pairing path.
  pairClient?: string; // X-Gini-Pair-Client
  pairSecret?: string; // X-Gini-Pair-Secret
  pairClientId?: string; // X-Gini-Client-ID (native per-install id)
  auth?: string; // Authorization: Bearer <token>
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
  if (opts.pairClient) headers["x-gini-pair-client"] = opts.pairClient;
  if (opts.pairSecret) headers["x-gini-pair-secret"] = opts.pairSecret;
  if (opts.pairClientId) headers["x-gini-client-id"] = opts.pairClientId;
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
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
  // The relay front is HTTPS, so the session cookie is issued under the
  // `__Host-` prefix (fall back to the plain name for completeness).
  const session = (setCookieValue(claimed, "__Host-gini_session") ?? setCookieValue(claimed, "gini_session"))!;
  expect(session).toBeTruthy();
  return { config, handler, relay, requestId: createdBody.id as string, session, bind, claimed };
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

  test("create on a runtime-managed tunnel front sets Secure (the runtime only publishes https fronts)", async () => {
    // A runtime-driven tunnel terminates TLS upstream, so the gateway hop is
    // plain http with no X-Forwarded-Proto guarantee — the host being a
    // connected runtime tunnel is itself the proof of an https front.
    setRuntimeTunnelTrust("pair-tunnel-secure", "https://machine.tail-test.ts.net");
    try {
      const { handler } = makeHandler("pair-tunnel-secure");
      const res = await pair(handler, "/api/pairing/request", {
        method: "POST",
        host: "machine.tail-test.ts.net",
        origin: "https://machine.tail-test.ts.net",
        secFetchSite: "same-origin",
        body: {}
      });
      expect(res.status).toBe(201);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("gini_pair="));
      expect(cookie).toContain("Secure");
    } finally {
      clearRuntimeTunnelTrust();
    }
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

describe("pairing routes — admin (loopback or paired session)", () => {
  test("list/approve/reject refuse an UNPAIRED relay request (no session)", async () => {
    // The trust anchor of the mirror model: a relay request with no gini_session
    // (and a non-loopback Host) is not an admin and is refused. A PAIRED relay
    // session IS admin — covered by the "relay session gate" mirror tests.
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

  test("the relay claim mints a __Host- prefixed, Domain-less session cookie", async () => {
    const { claimed } = await pairedSession("pair-claim-prefix");
    const setCookies = claimed.headers.getSetCookie();
    const prefixed = setCookies.find((c) => c.startsWith("__Host-gini_session="));
    // The HTTPS relay front issues the session cookie under the __Host- prefix
    // (Secure, Path=/, no Domain) so a sibling subdomain can't toss it.
    expect(prefixed).toBeTruthy();
    expect(prefixed).toContain("Secure");
    expect(prefixed).toContain("Path=/");
    expect(prefixed).not.toContain("Domain=");
    // The plain, tossable name is NOT also set.
    expect(setCookies.some((c) => c.startsWith("gini_session="))).toBe(false);
  });

  test("a plain-http trusted front mints the un-prefixed session cookie (no __Host-)", async () => {
    // __Host- mandates Secure, which a plain-http GINI_TRUSTED_ORIGINS front
    // can't use, so that front keeps the plain name (pairingCookieSecure false).
    const front = "pair-claim-front.test:7337";
    const previous = process.env.GINI_TRUSTED_ORIGINS;
    process.env.GINI_TRUSTED_ORIGINS = `http://${front}`;
    try {
      const { handler } = makeHandler("pair-claim-plainfront");
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin", body: {}
      });
      const { id } = await created.json();
      const bind = setCookieValue(created, "gini_pair")!;
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin",
        cookie: `gini_pair=${encodeURIComponent(bind)}`, body: {}
      });
      expect(claimed.status).toBe(200);
      const setCookies = claimed.headers.getSetCookie();
      const plain = setCookies.find((c) => c.startsWith("gini_session="));
      expect(plain).toBeTruthy();
      expect(plain).not.toContain("Secure");
      expect(setCookies.some((c) => c.startsWith("__Host-gini_session="))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
      else process.env.GINI_TRUSTED_ORIGINS = previous;
    }
  });

  test("a sibling-tossed plain gini_session cannot override the __Host- session", async () => {
    const { handler, relay, session } = await pairedSession("pair-claim-toss");
    // The browser sends BOTH a sibling's Domain-scoped garbage gini_session and
    // the victim's host-only __Host- cookie; the gate reads the un-tossable
    // __Host- one, so the admin route still admits.
    const both = `gini_session=tossed-garbage; __Host-gini_session=${encodeURIComponent(session)}`;
    const admitted = await pair(handler, "/api/pairing/requests", {
      host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: both
    });
    expect(admitted.status).toBe(200);
    // The tossed garbage alone (no __Host-) is refused.
    const refused = await pair(handler, "/api/pairing/requests", {
      host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie: "gini_session=tossed-garbage"
    });
    expect(refused.status).toBe(403);
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

  // A paired relay session is a full MIRROR of loopback (ADR device-pairing-auth
  // "Relay sessions mirror loopback"): on the native admin routes the gate accepts
  // loopback OR a valid gini_session, so a paired relay session can list AND
  // approve another device exactly like 127.0.0.1.
  test("a paired relay session can list and approve via the native admin routes", async () => {
    const { handler, relay, session } = await pairedSession("gate-mirror");
    const cookie = `gini_session=${encodeURIComponent(session)}`;
    const list = await pair(handler, "/api/pairing/requests", {
      host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie
    });
    expect(list.status).toBe(200);
    // A SECOND device requests pairing; the relay-paired admin approves it.
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome", body: {}
    });
    const id = (await created.json()).id as string;
    const approved = await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", cookie, body: {}
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).request.status).toBe("approved");
  });

  test("an UNPAIRED relay session cannot reach the admin routes (403)", async () => {
    // The trust anchor: no gini_session and a non-loopback Host → refused.
    const { handler } = makeHandler("gate-mirror-unpaired");
    const relay = RELAY("gate-mirror-unpaired");
    const res = await pair(handler, "/api/pairing/requests", {
      host: relay, origin: `https://${relay}`, secFetchSite: "same-origin"
    });
    expect(res.status).toBe(403);
  });

  test("loopback reaches the admin routes with no session (operator)", async () => {
    const { handler } = makeHandler("gate-mirror-loopback");
    const res = await pair(handler, "/api/pairing/requests", {
      host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin"
    });
    expect(res.status).toBe(200);
  });
});

// Drive the native (mobile-app) handshake: no Origin, no Sec-Fetch, the opt-in
// header, and the binding secret carried in a header instead of a cookie. The
// claim returns the session token in the BODY so a bearer client can store it.
async function nativePairedSession(instance: string) {
  const { config, handler } = makeHandler(instance);
  const relay = RELAY(instance);
  const created = await pair(handler, "/api/pairing/request", {
    method: "POST", host: relay, pairClient: "native", userAgent: "GiniMobile/1.0 (iOS)", body: {}
  });
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.bindSecret).toMatch(/^[0-9a-f]{64}$/);
  const approved = await pair(handler, `/api/pairing/requests/${body.id}/approve`, {
    method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
  });
  expect(approved.status).toBe(200);
  const claimed = await pair(handler, `/api/pairing/request/${body.id}/claim`, {
    method: "POST", host: relay, pairClient: "native", pairSecret: body.bindSecret as string, body: {}
  });
  expect(claimed.status).toBe(200);
  const claimedBody = await claimed.json();
  return { config, handler, relay, requestId: body.id as string, token: claimedBody.token as string, claimed };
}

describe("pairing routes — native client (mobile)", () => {
  test("native create (no Origin) returns 201 with id, code, and the bindSecret in the body", async () => {
    const { handler } = makeHandler("pair-native-create");
    const relay = RELAY("pair-native-create");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, pairClient: "native", userAgent: "GiniMobile/1.0 (iOS)", body: {}
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^preq_/);
    expect(body.code).toMatch(/^\d{3}-\d{3}$/);
    // Browsers never see the secret in the body (HttpOnly cookie only); native does.
    expect(body.bindSecret).toMatch(/^[0-9a-f]{64}$/);
    // Native is cookieless — the secret rides the body, NOT a Set-Cookie, so the
    // iOS cookie jar never persists a gini_pair the gateway won't read.
    expect(setCookieValue(res, "gini_pair")).toBeUndefined();
  });

  test("native create works on a runtime-managed tunnel front (same trust as the relay)", async () => {
    setRuntimeTunnelTrust("pair-native-tunnel", "https://machine.tail-test.ts.net");
    try {
      const { handler } = makeHandler("pair-native-tunnel");
      const res = await pair(handler, "/api/pairing/request", {
        method: "POST",
        host: "machine.tail-test.ts.net",
        pairClient: "native",
        userAgent: "GiniMobile/1.0 (iOS)",
        body: {}
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.bindSecret).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      clearRuntimeTunnelTrust();
    }
  });

  test("a no-Origin POST WITHOUT the native opt-in is still refused (the exemption requires opt-in)", async () => {
    const { handler } = makeHandler("pair-native-nooptin");
    const relay = RELAY("pair-native-nooptin");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, body: {} // no Origin, no Sec-Fetch, no opt-in header
    });
    expect(res.status).toBe(403);
  });

  test("a native opt-in on an UNTRUSTED host is still refused", async () => {
    const { handler } = makeHandler("pair-native-badhost");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: "evil.example.com", pairClient: "native", body: {}
    });
    expect(res.status).toBe(403);
  });

  test("native poll via the X-Gini-Pair-Secret header returns the pending status", async () => {
    const { handler } = makeHandler("pair-native-poll");
    const relay = RELAY("pair-native-poll");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, pairClient: "native", body: {}
    });
    const { id, bindSecret } = await created.json();
    const res = await pair(handler, `/api/pairing/request/${id}`, {
      host: relay, pairClient: "native", pairSecret: bindSecret
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });

  test("native claim returns the token in the body, and that token authenticates a bearer call", async () => {
    const { handler, relay, token } = await nativePairedSession("pair-native-claim");
    expect(token).toMatch(/^gini_device_/);
    // The minted device token works as Authorization: Bearer on the native API
    // surface over the relay (isWebProxyPath routes /api/agents to the bearer gate).
    const authed = await pair(handler, "/api/agents", { host: relay, auth: token });
    expect(authed.status).toBe(200);
    // A bogus bearer is rejected — proving the 200 above is the token, not an open route.
    const denied = await pair(handler, "/api/agents", { host: relay, auth: "gini_device_bogus" });
    expect(denied.status).toBe(401);
  });

  test("native claim sets no session cookie — the body token is the only credential", async () => {
    const { claimed } = await nativePairedSession("pair-native-claim-nocookie");
    // A native client can't read Set-Cookie and uses the body token as its bearer;
    // setting a session cookie would only leave a stale credential in the iOS jar
    // that sign-out doesn't clear.
    expect(claimed.headers.getSetCookie()).toHaveLength(0);
    expect(setCookieValue(claimed, "__Host-gini_session")).toBeUndefined();
    expect(setCookieValue(claimed, "gini_session")).toBeUndefined();
  });

  test("native cancel via the header clears the request", async () => {
    const { handler } = makeHandler("pair-native-cancel");
    const relay = RELAY("pair-native-cancel");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, pairClient: "native", body: {}
    });
    const { id, bindSecret } = await created.json();
    const res = await pair(handler, `/api/pairing/request/${id}/cancel`, {
      method: "POST", host: relay, pairClient: "native", pairSecret: bindSecret, body: {}
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("a browser is never native: the opt-in header + Sec-Fetch present stays cookie-only (no body token)", async () => {
    // A real browser claim (Sec-Fetch present, cookie-bound) that ALSO sets the
    // native opt-in header must NOT receive the token in the body — otherwise an
    // XSS on /pair could exfiltrate it. Sec-Fetch is unforgeable from JS, so it
    // is the security anchor; the opt-in alone never flips a browser to native.
    const { handler } = makeHandler("pair-native-browserguard");
    const relay = RELAY("pair-native-browserguard");
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin", body: {}
    });
    const { id } = await created.json();
    const bind = setCookieValue(created, "gini_pair")!;
    await pair(handler, `/api/pairing/requests/${id}/approve`, {
      method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
    });
    const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
      cookie: `gini_pair=${encodeURIComponent(bind)}`, pairClient: "native", body: {}
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).token).toBeUndefined();
    // The session still arrives the browser way — as the __Host- cookie.
    expect(setCookieValue(claimed, "__Host-gini_session")).toBeTruthy();
  });

  test("the ordinary browser claim body never contains the token", async () => {
    const { claimed } = await pairedSession("pair-native-nobodytoken");
    expect((await claimed.json()).token).toBeUndefined();
  });

  test("a request with an Origin is never native even with the opt-in and no Sec-Fetch", async () => {
    // A pre-Fetch-Metadata browser (e.g. Safari < 16.4 / an iOS-15 WebView) sends
    // no Sec-Fetch but DOES send Origin on a POST. It must NOT be classified
    // native — otherwise an XSS on /pair could exfiltrate the in-body secret.
    const { handler } = makeHandler("pair-native-originguard");
    const relay = RELAY("pair-native-originguard");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, pairClient: "native", body: {}
    });
    expect(res.status).toBe(201); // passes webBoundRequestAllowed as a same-origin browser POST
    // ...but it's the browser shape: the binding secret is cookie-only, not in the body.
    expect((await res.json()).bindSecret).toBeUndefined();
    expect(setCookieValue(res, "gini_pair")).toBeTruthy();
  });
});

// The shared-subdomain eviction bug, exercised through the real HTTP route.
// Two distinct browsers (or two distinct mobile installs) pairing on the SAME
// relay subdomain with the SAME User-Agent must NOT evict each other. Identity
// is keyed on a stable per-browser gini_client cookie (browsers) / per-install
// X-Gini-Client-ID header (native), not the User-Agent-derived name.
describe("pairing routes — per-browser client identity (gini_client)", () => {
  const SAME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  test("a browser create issues a host-only gini_client cookie", async () => {
    const { handler } = makeHandler("client-cookie-mint");
    const relay = RELAY("client-cookie-mint");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
      userAgent: SAME_UA, body: {}
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-gini_client="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    // A fresh request with no inbound gini_client mints a non-empty id.
    expect(setCookieValue(res, "__Host-gini_client")).toBeTruthy();
  });

  test("a create that already carries gini_client reuses the value (no new id minted)", async () => {
    const { handler } = makeHandler("client-cookie-reuse");
    const relay = RELAY("client-cookie-reuse");
    const existing = "client-existing-uuid";
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
      userAgent: SAME_UA, cookie: `__Host-gini_client=${encodeURIComponent(existing)}`, body: {}
    });
    expect(res.status).toBe(201);
    // When the browser already holds a gini_client, the server reuses it rather
    // than minting a fresh id (so identity is stable across re-pairs). It may
    // re-set the same value (refreshing Max-Age) or omit the Set-Cookie entirely.
    const reissued = setCookieValue(res, "__Host-gini_client");
    if (reissued !== undefined) expect(reissued).toBe(existing);
  });

  test("native create does NOT set a gini_client cookie (cookieless)", async () => {
    const { handler } = makeHandler("client-cookie-native");
    const relay = RELAY("client-cookie-native");
    const res = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, pairClient: "native", pairClientId: "install-uuid-1",
      userAgent: "GiniMobile/1.0 (iOS)", body: {}
    });
    expect(res.status).toBe(201);
    expect(setCookieValue(res, "__Host-gini_client")).toBeUndefined();
    expect(setCookieValue(res, "gini_client")).toBeUndefined();
  });

  test("over a plain-http trusted front the gini_client cookie is plain-named and omits Secure", async () => {
    // A non-relay, non-loopback GINI_TRUSTED_ORIGINS front served over plain http
    // would have a Secure/__Host- cookie silently dropped — so the gini_client
    // cookie uses the plain name and no Secure, mirroring gini_session/gini_pair.
    const front = "client-front.test:7337";
    const previous = process.env.GINI_TRUSTED_ORIGINS;
    process.env.GINI_TRUSTED_ORIGINS = `http://${front}`;
    try {
      const { handler } = makeHandler("client-cookie-plain");
      const res = await pair(handler, "/api/pairing/request", {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin",
        userAgent: SAME_UA, body: {}
      });
      expect(res.status).toBe(201);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("gini_client="));
      expect(cookie).toBeDefined();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toContain("Secure");
      expect(cookie).not.toContain("__Host-");
      // No __Host- variant is set on a plain front.
      expect(setCookieValue(res, "__Host-gini_client")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
      else process.env.GINI_TRUSTED_ORIGINS = previous;
    }
  });

  test("a plain-named gini_client cookie is read back (plain fallback) and reused on re-pair", async () => {
    // Mirrors the secure-front reuse test but exercises clientCookieValue's plain
    // fallback: a request carrying only the plain gini_client (no __Host-) reuses it.
    const front = "client-front2.test:7337";
    const previous = process.env.GINI_TRUSTED_ORIGINS;
    process.env.GINI_TRUSTED_ORIGINS = `http://${front}`;
    try {
      const { config, handler } = makeHandler("client-cookie-plain-reuse");
      const existing = "plain-client-uuid";
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin",
        userAgent: SAME_UA, cookie: `gini_client=${encodeURIComponent(existing)}`, body: {}
      });
      expect(created.status).toBe(201);
      const { id } = await created.json();
      const bind = setCookieValue(created, "gini_pair")!;
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: front, origin: `http://${front}`, secFetchSite: "same-origin",
        cookie: `gini_pair=${encodeURIComponent(bind)}; gini_client=${encodeURIComponent(existing)}`, body: {}
      });
      expect(claimed.status).toBe(200);
      const device = readState(config.instance).devices.find((d) => d.status === "active")!;
      expect(device.clientId).toBe(existing);
    } finally {
      if (previous === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
      else process.env.GINI_TRUSTED_ORIGINS = previous;
    }
  });

  // End-to-end bug proof for browsers: two distinct browsers, same relay + same
  // UA, distinct gini_client ids → both sessions stay active.
  test("two distinct browsers on the same subdomain do not evict each other", async () => {
    const { config, handler } = makeHandler("client-two-browsers");
    const relay = RELAY("client-two-browsers");

    async function pairWithClient(clientId: string): Promise<string> {
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
        userAgent: SAME_UA, cookie: `__Host-gini_client=${encodeURIComponent(clientId)}`, body: {}
      });
      const { id } = await created.json();
      const bind = setCookieValue(created, "gini_pair")!;
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
        cookie: `gini_pair=${encodeURIComponent(bind)}; __Host-gini_client=${encodeURIComponent(clientId)}`, body: {}
      });
      expect(claimed.status).toBe(200);
      const devices = readState(config.instance).devices;
      return devices.find((d) => d.clientId === clientId && d.status === "active")!.id;
    }

    const alice = await pairWithClient("client-alice");
    const bob = await pairWithClient("client-bob");
    expect(alice).not.toBe(bob);
    const devices = readState(config.instance).devices;
    // Both sessions remain active — neither evicted the other.
    expect(devices.filter((d) => d.status === "active").length).toBe(2);
    expect(devices.find((d) => d.id === alice)!.status).toBe("active");
    expect(devices.find((d) => d.id === bob)!.status).toBe("active");
  });

  // The same browser re-pairing (same gini_client) still supersedes its own
  // prior session — one active session per browser.
  test("the same browser re-pairing supersedes its own prior session", async () => {
    const { config, handler } = makeHandler("client-same-browser-repair");
    const relay = RELAY("client-same-browser-repair");

    async function pairWithClient(clientId: string): Promise<string> {
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
        userAgent: SAME_UA, cookie: `__Host-gini_client=${encodeURIComponent(clientId)}`, body: {}
      });
      const { id } = await created.json();
      const bind = setCookieValue(created, "gini_pair")!;
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: relay, origin: `https://${relay}`, secFetchSite: "same-origin",
        cookie: `gini_pair=${encodeURIComponent(bind)}; __Host-gini_client=${encodeURIComponent(clientId)}`, body: {}
      });
      expect(claimed.status).toBe(200);
      return readState(config.instance).devices.find((d) => d.clientId === clientId && d.status === "active")!.id;
    }

    const first = await pairWithClient("client-stable");
    const second = await pairWithClient("client-stable");
    expect(first).not.toBe(second);
    const devices = readState(config.instance).devices;
    expect(devices.find((d) => d.id === first)!.status).toBe("revoked");
    expect(devices.find((d) => d.id === second)!.status).toBe("active");
    expect(devices.filter((d) => d.status === "active").length).toBe(1);
  });

  // End-to-end bug proof for mobile: two distinct installs, same relay + same UA,
  // distinct X-Gini-Client-ID → both sessions stay active.
  test("two distinct mobile installs on the same subdomain do not evict each other", async () => {
    const { config, handler } = makeHandler("client-two-mobiles");
    const relay = RELAY("client-two-mobiles");

    async function nativePairWithClient(clientId: string): Promise<string> {
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: relay, pairClient: "native", pairClientId: clientId,
        userAgent: "GiniMobile/1.0 (iOS)", body: {}
      });
      const { id, bindSecret } = await created.json();
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: relay, pairClient: "native", pairClientId: clientId, pairSecret: bindSecret, body: {}
      });
      expect(claimed.status).toBe(200);
      return readState(config.instance).devices.find((d) => d.clientId === clientId && d.status === "active")!.id;
    }

    const phoneA = await nativePairWithClient("install-aaaa");
    const phoneB = await nativePairWithClient("install-bbbb");
    expect(phoneA).not.toBe(phoneB);
    const devices = readState(config.instance).devices;
    expect(devices.filter((d) => d.status === "active").length).toBe(2);
  });

  // A native client that sends NO X-Gini-Client-ID (an older mobile build, or one
  // whose id hasn't primed yet) must keep the legacy origin+name supersede: the
  // gateway must NOT mint a throwaway server-side clientId the cookieless client
  // can never echo back, or a re-pair would stack a second active session forever.
  test("a header-less native re-pair still supersedes its prior session (legacy origin+name)", async () => {
    const { config, handler } = makeHandler("client-native-noheader");
    const relay = RELAY("client-native-noheader");

    async function nativePairNoHeader(): Promise<string> {
      const created = await pair(handler, "/api/pairing/request", {
        method: "POST", host: relay, pairClient: "native", userAgent: "GiniMobile/1.0 (iOS)", body: {}
      });
      const { id, bindSecret } = await created.json();
      await pair(handler, `/api/pairing/requests/${id}/approve`, {
        method: "POST", host: "127.0.0.1:7337", origin: "http://127.0.0.1:7337", secFetchSite: "same-origin", body: {}
      });
      const claimed = await pair(handler, `/api/pairing/request/${id}/claim`, {
        method: "POST", host: relay, pairClient: "native", pairSecret: bindSecret, body: {}
      });
      expect(claimed.status).toBe(200);
      const { devices } = readState(config.instance);
      return devices.find((d) => d.status === "active")!.id;
    }

    const first = await nativePairNoHeader();
    const second = await nativePairNoHeader();
    expect(first).not.toBe(second);
    const devices = readState(config.instance).devices;
    // No clientId was minted onto either device — identity falls back to origin+name.
    expect(devices.find((d) => d.id === second)!.clientId).toBeUndefined();
    expect(devices.find((d) => d.id === first)!.status).toBe("revoked");
    expect(devices.find((d) => d.id === second)!.status).toBe("active");
    expect(devices.filter((d) => d.status === "active").length).toBe(1);
  });
});

describe("pairing routes — device name", () => {
  // Create a native pairing request with the given body, then read the stored
  // deviceName back via the loopback admin list (what the operator's row shows).
  async function createNativeAndRead(instance: string, reqBody: unknown): Promise<string> {
    const { handler } = makeHandler(instance);
    const relay = RELAY(instance);
    const created = await pair(handler, "/api/pairing/request", {
      method: "POST", host: relay, pairClient: "native", userAgent: "GiniMobile/1.0 (iOS)", body: reqBody
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const listed = await pair(handler, "/api/pairing/requests", {
      host: "127.0.0.1:7337", secFetchSite: "same-origin"
    });
    const row = (await listed.json()).requests.find((r: { id: string }) => r.id === id);
    return row.deviceName as string;
  }

  test("a supplied device name is stored and shown to the operator", async () => {
    expect(await createNativeAndRead("pair-dn-basic", { deviceName: "iPhone 16 Pro" })).toBe("iPhone 16 Pro");
  });

  test("trims, collapses whitespace, and caps the name at 64 chars", async () => {
    const noisy = "   " + "A".repeat(100) + String.fromCharCode(0) + "   ";
    expect(await createNativeAndRead("pair-dn-cap", { deviceName: noisy })).toBe("A".repeat(64));
  });

  test("strips control characters", async () => {
    const raw = "Wil" + String.fromCharCode(0) + "son" + String.fromCharCode(127);
    expect(await createNativeAndRead("pair-dn-ctrl", { deviceName: raw })).toBe("Wilson");
  });

  test("a blank name falls back to the User-Agent label (never empty)", async () => {
    const stored = await createNativeAndRead("pair-dn-blank", { deviceName: "   " });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.trim()).toBe(stored);
  });

  test("a non-string device name is ignored (falls back to the UA label)", async () => {
    const stored = await createNativeAndRead("pair-dn-nonstring", { deviceName: 12345 });
    expect(typeof stored).toBe("string");
    expect(stored.length).toBeGreaterThan(0);
  });
});

describe("apple-app-site-association", () => {
  test("served with the app id and JSON content-type, reachable unpaired on the relay", async () => {
    const { handler } = makeHandler("aasa-relay");
    const relay = RELAY("aasa-relay");
    const res = await pair(handler, "/.well-known/apple-app-site-association", { host: relay });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    const detail = body.applinks.details[0];
    expect(detail.appIDs).toContain("WB6Y3K67AB.ai.lilaclabs.gini.mobile");
    expect(detail.components.some((c: Record<string, string>) => c["/"] === "/pair" || c["/"] === "/pair/*")).toBe(true);
  });

  test("reachable on loopback too", async () => {
    const { handler } = makeHandler("aasa-loopback");
    const res = await pair(handler, "/.well-known/apple-app-site-association", { host: "127.0.0.1:7337" });
    expect(res.status).toBe(200);
  });

  test("honors the GINI_IOS_APP_ID override", async () => {
    const previous = process.env.GINI_IOS_APP_ID;
    process.env.GINI_IOS_APP_ID = "TEAM2XYZ.com.example.app";
    try {
      const { handler } = makeHandler("aasa-override");
      const res = await pair(handler, "/.well-known/apple-app-site-association", { host: RELAY("aasa-override") });
      expect((await res.json()).applinks.details[0].appIDs).toEqual(["TEAM2XYZ.com.example.app"]);
    } finally {
      if (previous === undefined) delete process.env.GINI_IOS_APP_ID;
      else process.env.GINI_IOS_APP_ID = previous;
    }
  });
});
