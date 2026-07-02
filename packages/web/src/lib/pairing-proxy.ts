// BFF passthrough for the gateway's native /api/pairing/* surface.
//
// The gateway serves /api/pairing/* natively (NOT through the bearer-injecting
// /api/runtime BFF lane), and the device-pairing client calls it SAME-ORIGIN so
// the browser attaches the HttpOnly gini_pair / gini_session cookies and the
// gateway's CSRF check sees Origin == Host. That works when the page's origin is
// the gateway (the relay/tunnel front, or a loopback gateway). But the Next dev
// server binds its own loopback port, and a page loaded from THAT origin sends
// its /api/pairing fetches to Next — which has no pairing route and no proxy for
// it — so they 404 and the operator's approve/reject panel silently shows an
// empty queue. The /api/runtime lane already bridges the Next origin to the
// gateway; this is the symmetric bridge for /api/pairing.
//
// Unlike the runtime lane, pairing authenticates by COOKIE and by loopback, not
// by the gateway bearer (the browser must never hold that token). So this
// forward injects NO Authorization header — it forwards the browser's cookies
// and presents a loopback Origin so the gateway's webBoundRequestAllowed +
// loopback admin gate (src/http.ts handlePairingRoutes, src/lib/origin-trust.ts)
// resolve exactly as they would for a direct loopback browser. The same
// guardCsrf the runtime lane uses runs first, so a cross-site page can't reach
// this forward and ride the user's cookies. Reachability is unchanged: Next's
// proxy.ts 404s any non-loopback / non-GINI_TRUSTED_ORIGINS Host before routing,
// and relay browsers hit the gateway directly, never this BFF.

import { canonicalizeSegments, guardCsrf, isLoopbackHost, pickForwardHeaders, runtimeInstance } from "./runtime";

export interface PairingProxyOptions {
  runtimeUrl: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

// Probe timeout for the gateway-identity check. Matches the healthz validation
// in src/web-target.ts (the reverse hop). A listener that accepts the TCP
// connection but never responds must not hang the operator's pairing request.
const HEALTHZ_TIMEOUT_MS = 2000;

// The runtime lane proves the gateway is THIS instance implicitly: it sends the
// per-instance bearer, which a foreign gateway (a stale/reused runtime port now
// owned by another instance) rejects with 401. The pairing lane sends NO bearer
// and the gateway grants admin on loopback Host alone, so a foreign gateway would
// hand this operator admin over instance B's pairing queue. Re-establish that
// instance check explicitly: probe the gateway's /api/runtime/__healthz, which
// reports the serving service + instance exactly as web-target.ts validates the
// reverse hop, and forward only on a match. This is a fail-closed cross-instance
// admin gate, so it probes on EVERY forward — caching a positive result would
// trust a possibly-stale identity for the cache lifetime; the per-request cost is
// one loopback round-trip on a surface that already polls every 3s.
export async function gatewayIsThisInstance(
  runtimeUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<boolean> {
  const timeout = AbortSignal.timeout(HEALTHZ_TIMEOUT_MS);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetcher(`${runtimeUrl}/api/runtime/__healthz`, { redirect: "manual", signal: probeSignal });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: unknown; instance?: unknown };
    return body.service === "gini-web" && body.instance === runtimeInstance();
  } catch {
    return false;
  }
}

export async function proxyPairingRequest(
  request: Request,
  pathSegments: string[],
  options: PairingProxyOptions
): Promise<Response> {
  // Canonicalize PER SEGMENT before forwarding, exactly as the runtime lane does
  // (canonicalizeSegments, used by proxyRequest): decode each segment to a fixed
  // point and reject `.`/`..`, embedded `/` or `\`, and control bytes. Joining
  // the catch-all segments and canonicalizing the whole path instead would let an
  // encoded slash (e.g. `preq%2Fapprove`) collapse into a structural separator,
  // so the BFF would guard a different path than the gateway then executes.
  const segments = canonicalizeSegments(pathSegments);
  if (!segments) return Response.json({ error: "Invalid path" }, { status: 400 });

  // Same Host/Origin + Sec-Fetch-Site guard as the runtime BFF lane. This is
  // what makes forwarding the browser's cookies safe: a cross-site page is
  // refused here before any cookie leaves the browser.
  const guard = guardCsrf(request, []);
  if (guard) return guard;

  // Scope this bridge to the LOOPBACK dev origin (the inner Next port). In the
  // normal gateway-fronted topology the browser is on the gateway origin and its
  // /api/pairing calls reach the gateway natively — this BFF route never fires.
  // It exists only so the loopback Next dev port works like the gateway origin.
  // Refusing non-loopback Hosts keeps pairing gateway-native + "loopback OR
  // gini_session"-gated for every relay/remote front (see ADR
  // device-pairing-auth.md): forwarding presents a loopback Origin to the
  // gateway, which would otherwise grant loopback admin to a remote front that
  // should need a session. A 404 here mirrors "pairing isn't served on this
  // address", which the panel surfaces as "open via your gateway link".
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
  if (!isLoopbackHost(expectedHost)) return Response.json({ error: "Not found" }, { status: 404 });

  // Confirm the gateway at runtimeUrl() is still THIS instance before presenting
  // it loopback admin — a stale/reused runtime port could otherwise point at
  // another instance's gateway (see gatewayIsThisInstance above). Fail closed.
  const fetcher = options.fetcher ?? fetch;
  if (!(await gatewayIsThisInstance(options.runtimeUrl, fetcher, options.signal))) {
    return Response.json({ error: "Gateway unavailable" }, { status: 502 });
  }

  const search = new URL(request.url).search;
  // Re-encode each validated segment so any URL-special character that survived
  // canonicalization can't re-acquire structural meaning when fetch parses the
  // target — the gateway's view of the path matches what guardCsrf validated.
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const target = `${options.runtimeUrl}/api/pairing/${encodedPath}${search}`;

  const headers = pickForwardHeaders(request.headers);
  // Forward the pairing cookies (gini_pair / gini_session) so the gateway's
  // bind/session checks see them. Deliberately NO Authorization header.
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  // Forward the browser's User-Agent so a request CREATED through the bridge gets
  // the same device-name fallback the gateway derives for a direct browser (the
  // create route labels the device from User-Agent when no explicit name is
  // given) instead of the server fetch's UA / "Unknown device".
  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("user-agent", userAgent);
  // This server-to-server fetch reaches the gateway on loopback, so present a
  // matching loopback Origin: the gateway's webBoundRequestAllowed then trusts
  // it (Origin == Host, both loopback) for both the safe list GET and the
  // approve/reject POSTs, and the admin gate grants on the loopback Host —
  // mirroring a direct loopback browser.
  headers.set("origin", new URL(options.runtimeUrl).origin);

  const init: RequestInit = { method: request.method, headers };
  const signal = options.signal ?? request.signal;
  if (signal) init.signal = signal;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  const upstream = await fetcher(target, init);

  // Forward status + JSON body verbatim. The device handshake routes
  // (request/claim/cancel) also mint gini_pair / gini_session via Set-Cookie,
  // which must reach the browser, so copy every Set-Cookie through.
  const outHeaders = new Headers();
  outHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  for (const setCookie of upstream.headers.getSetCookie()) {
    outHeaders.append("set-cookie", setCookie);
  }
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: outHeaders });
}
