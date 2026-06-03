// Host/Origin trust at the SINGLE FRONT (the gateway).
//
// The gateway reverse-proxies the web app (see ADR gateway-web-reverse-proxy.md)
// and, when a tunnel is connected, is the only network-facing surface (the
// Next.js web child binds loopback and is reached only via this gateway or
// local dev). So the gateway owns the host/origin/CSRF trust decision for every
// web-bound request and then presents a loopback Host/Origin to the inner web
// child — which therefore needs no relay awareness of its own.
//
// This is the relay-aware guard that previously lived in the web BFF
// (web/src/lib/runtime.ts). It is intentionally a separate copy from the BFF's
// own loopback-only guard: the two now protect INDEPENDENT surfaces (this one
// the proxied perimeter, the BFF its direct web-port access), so they never
// both evaluate the same request and cannot drift into a reachability split.

// Loopback hostnames trusted unconditionally — a DNS-rebinding page cannot make
// the browser send a loopback Host, and frpc/local dev reach the gateway on
// loopback. Strips an optional :port (IPv6 literals are bracketed).
export function isLoopbackHost(host: string): boolean {
  const closeBracket = host.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? host.slice(0, closeBracket + 1)
    : host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  return hostnameOnly === "localhost" || hostnameOnly === "127.0.0.1" || hostnameOnly === "[::1]";
}

// A host that is the gini-relay domain or one of its per-device subdomains. The
// relay routes each random subdomain only to its owner's frpc tunnel and owns
// that DNS, so a `*.<relayDomain>` Host can only be present on a request that
// actually arrived through the operator's own tunnel — as un-rebindable as
// loopback. See docs/adr/bff-trust-boundary.md.
export function isRelayHost(host: string): boolean {
  const domain = (process.env.GINI_RELAY_DOMAIN ?? "gini-relay.lilaclabs.ai").toLowerCase();
  const lower = host.toLowerCase();
  const closeBracket = lower.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? lower.slice(0, closeBracket + 1)
    : lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
  return hostnameOnly === domain || hostnameOnly.endsWith(`.${domain}`);
}

// Parse `GINI_TRUSTED_ORIGINS` into validated origin strings. Mirrors the BFF's
// web/src/lib/trusted-origins.ts validation exactly (entries with a path,
// query, hash, or userinfo are rejected as a likely paste error). Tri-state:
//   null  -> env unset (loopback/relay-only fallback applies)
//   Set   -> at least one valid entry parsed
//   empty -> env set but every entry malformed -> fail closed (refuse all
//            non-loopback, non-relay requests).
export function trustedOrigins(): ReadonlySet<string> | null {
  const raw = process.env.GINI_TRUSTED_ORIGINS;
  if (!raw || !raw.trim()) return null;
  const out = new Set<string>();
  for (const candidate of raw.split(",")) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.pathname !== "" && parsed.pathname !== "/")
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.username !== ""
        || parsed.password !== ""
      ) {
        continue;
      }
      out.add(`${parsed.protocol}//${parsed.host}`);
    } catch {
      // Skip malformed entries individually.
    }
  }
  return out;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The web-bound trust decision for the gateway. Returns true when the request
// may be reverse-proxied to the inner web child, false when it must be refused.
//
// Tiered by method, identical in spirit to the BFF guard it replaces:
//   - Unsafe methods (POST/PUT/PATCH/DELETE) require an Origin; absence means a
//     non-browser client that should hit the gateway's native /api/* with its
//     own token, not the token-injecting proxied surface.
//   - Safe methods (GET/HEAD) may omit Origin (top-level navigations), so the
//     Host is validated instead: loopback or relay-subdomain pass; with
//     GINI_TRUSTED_ORIGINS set we fail closed for everything except the relay
//     front. When Origin IS present it is validated against the relay lane, the
//     allowlist, or loopback-Host equality.
//   - Sec-Fetch-Site, when present, must be same-origin or none.
export function webBoundRequestAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const isUnsafe = UNSAFE_METHODS.has(request.method);
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;

  if (!origin) {
    if (isUnsafe) return false;
    const allowlist = trustedOrigins();
    if (allowlist) {
      if (!isRelayHost(expectedHost)) return false;
    } else if (!isLoopbackHost(expectedHost) && !isRelayHost(expectedHost)) {
      return false;
    }
  } else {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return false;
    }
    if (!isRelayHost(originUrl.host)) {
      const allowlist = trustedOrigins();
      if (allowlist) {
        if (!allowlist.has(`${originUrl.protocol}//${originUrl.host}`)) return false;
      } else {
        if (!isLoopbackHost(expectedHost)) return false;
        if (originUrl.host !== expectedHost) return false;
      }
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}
