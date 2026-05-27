# Tunnel + Mobile Access — Design Plan

A local-first agent runtime exposed through a single public Cloudflare quick tunnel, gated by a per-instance secret embedded in the URL.

This is a design contract. File layout, naming, language idiom, and concurrency primitives are left to the implementer. Numeric constants, invariants, and security policies stated here are binding.

## Goals

- One public surface (Cloudflare quick tunnel) for both browser and mobile clients.
- No bearer token in the URL bar, browser history, or browser JavaScript. Ever.
- Browser CSRF / DNS-rebinding protections survive the tunnel.
- Operator-driven enable / disable; works without a Cloudflare account.
- A global top-corner QR launcher icon in the app shell. Opens a modal showing the QR. Visible on every page outside the `/setup/*` route prefix. Hidden when the tunnel is disabled.
- Optional iCloud Notes mirror so the operator's phone learns the new URL after a tunnel rotation. Defaults OFF; opt in once and accept the macOS TCC Automation prompt. Enabling the mirror knowingly extends the secret's trust radius to iCloud sync.
- CLI surface for status, QR, enable, disable, secret rotation.

## Non-goals

- Replacing the localhost bearer-token gate for direct API access.
- Replacing the device pairing flow (mint code from localhost, claim from anywhere).
- Real-time SSE over the quick tunnel — Cloudflare's free quick tunnels buffer; polling covers it. Real-time needs a named tunnel.
- Production multi-tenant hosting.
- Rate limiting on the proxy. The 192-bit secret math is the defense; named-tunnel deployments can add rate limits if needed.

## Constants (design requirements)

| Knob | Value | Rationale |
|---|---|---|
| Per-instance secret entropy | 192 bits | Base64url-friendly (32 chars). At the documented 200 in-flight request ceiling, brute-forcing a 128-bit secret already exceeds the heat-death of the universe; 192 bits fits cleanly on a 32-char URL segment. |
| Session cookie max-age | 86400 seconds (24 hours) | Operator's phone may sit idle overnight and resume next morning. Honest browsers respect this; exfiltrated cookies are bounded by `rotate-secret`, not the lifetime. |
| Disable-exposure window upper bound | 5000 milliseconds | Cloudflared receives SIGTERM; if it hasn't exited by 5000 ms, SIGKILL forces termination. Worst-case interval the tunnel can remain reachable after a disable PATCH. Start time = config write commits; observable bound = no new request through cloudflared succeeds after that interval. |
| Web port discovery ceiling | 60000 milliseconds | 6.0× headroom over Next.js Turbopack's documented "over 10 seconds" cold-compile boundary for large applications. Failure mode on exceeded ceiling: gateway emits `tunnel.port.discovery.timeout` and refuses to spawn cloudflared until the operator retries. |
| osascript subprocess timeout | 15000 milliseconds | Bounds a hung Notes.app TCC prompt or slow iCloud roundtrip. SIGKILL on overrun. On a never-surfaced TCC prompt (launchd-managed processes), this fails the refresh cleanly rather than hanging the manager. |
| Quick tunnel concurrency ceiling | 200 simultaneous in-flight | Cloudflare-imposed; not a Gini knob. Gini surfaces the resulting 429 to the client without retry. Polling + single chat session sit well under the ceiling. |
| Marker header name | `x-gini-tunnel-vetted` | Used everywhere; pinned here so a typo in proxy or BFF can't desync. Value is the literal string `1` when stamped. |
| Session cookie name | `gini_tunnel_session` | Pinned for the same reason. |
| Marker header value | `1` | Literal. |

## Tunnel session cookie

The bootstrap secret is a path segment in the public URL: the operator scans the QR, the first request lands at `/<secret>/...`, and the proxy validates it. To avoid the secret living in every subsequent URL the phone visits, the proxy mints an HttpOnly session cookie on that first valid request and 302-redirects the browser to the same path without the prefix.

Cookie contract:

```
Name:       gini_tunnel_session
Value:      the live tunnel.secret, byte-for-byte
HttpOnly:   true
Secure:     true
SameSite:   Lax
Path:       /
Domain:     omitted entirely (NOT set to a parent eTLD+1; the cookie
            scope is the exact rotating subdomain, never the registrable
            parent. A future deployment on a different trycloudflare
            subdomain after a restart implicitly invalidates the cookie
            for that reason alone.)
Max-Age:    86400 (24 hours)
```

`SameSite=Lax` is chosen over `Strict` so the cookie is delivered on the 302 that follows the QR-tap top-level navigation. With `Strict`, the cookie minted on `/<secret>/...` would not be sent on the redirect target on some platforms. The Lax cross-site GET surface is closed by the deny list (QR endpoints and tunnel-mutation routes are blocked through the tunnel; see Deny list).

Validation on subsequent requests: constant-time byte equality against the live `tunnel.secret`, using a fixed-length compare that does not short-circuit on length difference. The proxy reads `tunnel.secret` from config on every request (uncached); a `rotate-secret` causes every outstanding cookie to mismatch on the very next request.

The cookie value IS the secret. This is a deliberate choice over a server-side session table:

- No server-side state to maintain or reconcile.
- Rotation is instant and atomic; no cleanup job.
- All log redaction work has to happen anyway (request paths contain the secret on first hit), so the cookie-value scrub piggybacks on the same machinery.

The cost: any place that logs the `Cookie` header logs the secret. The log-redaction invariant below is therefore hard and tested.

Cookie invalidation cases:

| Trigger | Mechanism | Observable |
|---|---|---|
| Operator runs `gini tunnel rotate-secret` | Next request's cookie value no longer equals `tunnel.secret` | Returns 404; phone re-bootstraps via fresh QR |
| Operator runs `gini tunnel disable` | Proxy reads `tunnel.enabled=false`; tunnel branch rejects regardless of cookie | Returns 404 even with a valid cookie |
| Cookie's Max-Age expires | Browser stops sending the cookie | Phone hits proxy without cookie; re-bootstraps via QR |
| Cloudflared restart rotates hostname | Cookie is host-only (Domain omitted) and pinned to the old hostname; browser doesn't send it to the new one | Phone has to re-scan QR for the new hostname |
| Tunnel `Domain` mismatch (cookie scoped to host) | Browser doesn't send the cookie to non-matching hosts | Defense-in-depth |

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                         PUBLIC INTERNET (Cloudflare edge)                       │
│                                                                                 │
│      Phone Safari ────────► https://<random>.trycloudflare.com/<secret>/...     │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │  managed subprocess; lifetime = gateway lifetime
               ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  cloudflared                                                                    │
│  - tunnels http://127.0.0.1:<webPort>                                          │
│  - stderr banner parsed to learn the public URL                                │
│  - hostname rotates on every restart                                           │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │  inbound request reaches the proxy with TLS already terminated;
               │  Host is the trycloudflare hostname, scheme info gone
               ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  Next.js proxy (middleware)                                                     │
│   ◄── reads tunnel.secret + tunnel.enabled from config on EVERY request        │
│   ◄── shared canonicalize() helper from a sibling module                       │
│                                                                                │
│   STEP 1: clone inbound headers; DELETE any inbound x-gini-tunnel-vetted       │
│                                                                                │
│   STEP 2: canonicalize the inbound path (see Path canonicalization).           │
│           Reject 4xx if canonicalization fails. All subsequent matching        │
│           (prefix, deny list) runs against the canonical form.                 │
│                                                                                │
│   STEP 3: classify Host                                                        │
│     - loopback (localhost, 127.0.0.1, [::1])  → LOOPBACK BRANCH                │
│     - matches the live tunnel hostname        → TUNNEL BRANCH                  │
│       (the proxy reads tunnel.publicUrl from the in-memory snapshot;           │
│        Host must equal the hostname portion of the live publicUrl;             │
│        the proxy cannot see the scheme — TLS is terminated at Cloudflare —     │
│        so port comparison applies default-port equivalence for HTTPS:          │
│        if publicUrl omits port (typical for https://*.trycloudflare.com),      │
│        Host may omit port OR carry :443; if publicUrl carries an explicit      │
│        port, Host must carry the same port. This matches the CSRF section's   │
│        default-port equivalence rule.)                                         │
│     - matches an origin in GINI_TRUSTED_ORIGINS → TUNNEL BRANCH                │
│       (for operators who front gini with their own stable hostname; the        │
│        same secret/cookie gate applies, and guardCsrf reaches its allowlist    │
│        codepath. Match compares the inbound Host's host[+port] against the     │
│        allowlist entry's host[+port], applying the same default-port           │
│        equivalence rule used for the live-hostname check above.)               │
│     - anything else                            → 404                           │
│       (defends against DNS-rebinding to an attacker-controlled hostname)       │
│                                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐      │
│   │ TUNNEL BRANCH                                                       │      │
│   │   IF tunnel.enabled === false  → 404                                │      │
│   │   IF canonical path starts with /<secret>/  OR  /<secret>$          │      │
│   │     (matched constant-time, segment-exact)                          │      │
│   │     - strip the /<secret> prefix to derive the post-prefix path     │      │
│   │       (the form the runtime would see, e.g.,                        │      │
│   │       /<secret>/api/runtime/tunnel/qr.svg → /api/runtime/tunnel/    │      │
│   │       qr.svg). All subsequent matching in this branch (traversal,   │      │
│   │       pairing deny, tunnel deny) runs against the post-prefix       │      │
│   │       path — the Deny list patterns are defined on the              │      │
│   │       /api/runtime/* canonical form, not the prefixed form.         │      │
│   │     - deny if traversal or denied pairing route or denied tunnel    │      │
│   │       route (path-only; see Deny list for full rule)                │      │
│   │     - mint session cookie (see Cookie contract)                     │      │
│   │     - 302 to the canonical path WITHOUT prefix, query string        │      │
│   │       preserved; if rest was empty, redirect to /                   │      │
│   │       (fragments never reach the server — nothing to preserve)      │      │
│   │     - the 302 response itself carries Referrer-Policy: no-referrer  │      │
│   │   ELSE IF valid session cookie (fixed-length constant-time compare) │      │
│   │     - deny if traversal or denied pairing route or denied tunnel    │      │
│   │       route (path-only; see Deny list for full rule)                │      │
│   │     - forward as-is                                                 │      │
│   │   ELSE                                                              │      │
│   │     - 404                                                           │      │
│   │   On any forward: SET x-gini-tunnel-vetted=1 on the cloned headers  │      │
│   └─────────────────────────────────────────────────────────────────────┘      │
│                                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐      │
│   │ LOOPBACK BRANCH                                                     │      │
│   │   - canonicalize path                                               │      │
│   │   - forward                                                         │      │
│   │   - DO NOT stamp x-gini-tunnel-vetted (left absent)                 │      │
│   └─────────────────────────────────────────────────────────────────────┘      │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  Next.js app  (HTML pages + BFF routes; same process as the proxy)             │
│                                                                                │
│  ┌──────────────────────────────────┐   ┌──────────────────────────────────┐   │
│  │ HTML pages                       │   │ BFF API routes                   │   │
│  │   - app shell                    │   │   - one catch-all proxies        │   │
│  │   - TunnelQrLauncher icon in     │   │     /api/runtime/* to runtime    │   │
│  │     top corner; visible          │   │   - canonicalizes path (same     │   │
│  │     outside /setup/*; hidden     │   │     helper as proxy)             │   │
│  │     when tunnel disabled         │   │   - IF vetted=1 (request came    │   │
│  │   - modal renders QR             │   │     through the tunnel branch):  │   │
│  │   - Settings card shows static   │   │       DENIES /api/runtime/       │   │
│  │     QR + status pill             │   │       pairing subtree (all       │   │
│  │                                  │   │       methods); DENIES /api/     │   │
│  │   Response headers (all          │   │       runtime/tunnel subtree     │   │
│  │   tunneled responses):           │   │       (all methods) plus bare    │   │
│  │     Referrer-Policy:             │   │       path methods != GET        │   │
│  │       strict-origin              │   │   - runs guardCsrf (applies to   │   │
│  │                                  │   │     all requests, vetted or not) │   │
│  │                                  │   │   - if vetted=1: REWRITES bare   │   │
│  │                                  │   │     GET /api/runtime/tunnel      │   │
│  │                                  │   │     (with or without trailing /) │   │
│  │                                  │   │     → /api/tunnel/redacted       │   │
│  │                                  │   │   - on pass: strips inbound      │   │
│  │                                  │   │     x-gini-tunnel-vetted, injects│   │
│  │                                  │   │     runtime bearer from config,  │   │
│  │                                  │   │     forwards to runtime          │   │
│  └──────────────────────────────────┘   └──────────────┬───────────────────┘   │
└─────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │ http://127.0.0.1:<rt>
                                                          ▼ Authorization: Bearer
┌────────────────────────────────────────────────────────────────────────────────┐
│  Runtime API   (bearer-gated; stays loopback when tunnel is the only public    │
│                 surface)                                                        │
│                                                                                │
│  Two tunnel-snapshot endpoints, both bearer-gated:                             │
│    GET /api/tunnel            → privileged shape (secret + publicUrl + …)      │
│    GET /api/tunnel/redacted   → browser-safe shape (secret=null,               │
│                                                     publicUrl=null)            │
│  Path IS the discriminator. BFF rewrites browser callers; CLI/bearer hits      │
│  /api/tunnel directly.                                                         │
└────────────────────────────────────────────────────────────────────────────────┘

Sidecar (opt-in):
   osascript writes the live tunnel URL into iCloud Notes. Defaults OFF.
   Knowingly extends the secret's trust radius to iCloud.
```

## Path canonicalization

Single shared algorithm used by the proxy and the BFF guard. Tests pin the helper directly and pin both invocation sites.

```
INPUT: a raw URL pathname

1. Decode percent-encoding to fixed point:
   - repeatedly URL-decode until a single decode pass yields the same string
   - decoder treats malformed percent-encodings (`%ZZ`, trailing `%`, `%2`) as REJECT — not pass-through. This closes the decoder-variance ambiguity where a tolerant decoder leaves invalid sequences alone and a strict one errors.
   - cap at 8 rounds; reject as malformed if not stable by then. Rationale: each round of `%25` doubling expands input by 3x (`%` → `%25`), so 8 rounds tolerate 3^8 = 6561x growth — well above the 4096-char total cap below; reaching the cap means the input is hostile.
2. Normalize trailing slash: a single trailing `/` is preserved on the canonical form (so downstream forwarding sees what the client actually sent), but multiple consecutive trailing slashes collapse to one and bare `/` is preserved. Comparisons against the deny list and rewrite-trigger paths treat the no-slash and single-trailing-slash forms as equivalent — `/api/runtime/tunnel` and `/api/runtime/tunnel/` match the same deny/rewrite rules. The preservation is a fidelity choice for any code that needs to know whether a trailing slash was supplied; the policy layer never depends on that distinction.
3. Reject if the decoded form contains a `..` segment between `/`s
4. Reject if the decoded form contains a `.` (single-dot) segment between `/`s — `.` is path-resolution noise that downstream routers may collapse, creating a mismatch between what we matched and what the runtime sees (e.g., `/api/runtime/./tunnel/qr.svg` becoming `/api/runtime/tunnel/qr.svg` post-canonical)
5. Reject if the decoded form contains duplicate interior slashes (`//`, `///`, etc.) — for the same router-normalization reason as the dot-segment rule above. The exception is the bare leading slash; `/` itself is preserved
6. Reject if any segment contains a percent sign that survived step 1
7. Reject if the decoded form contains a backslash or NUL byte
8. Reject if the decoded form contains a `?` (question mark) or `#` (hash) byte — these are URL delimiters that the HTTP parser already split off (query and fragment) from the pathname; if they appear in the decoded form they came from `%3F`/`%23` in the original encoded path. Forwarding such a path to the runtime would silently re-introduce a query string or fragment that bypasses the deny/rewrite match we just performed (the runtime's router would re-parse the URL and find a sub-path different from what we matched on)
9. Reject if the decoded form is longer than 4096 characters
OUTPUT: the canonical pathname

Deny-list comparison runs on the canonical form. The deny match is
gated layer-by-layer:

- At the PROXY: the deny is checked while the request is inside the
  TUNNEL BRANCH (and will be stamped vetted=1 on forward). The proxy
  is the stamper, NOT a reader of an inbound marker. Loopback-branch
  requests skip the proxy deny entirely.
- At the BFF: the deny is checked when the inbound request carries
  `x-gini-tunnel-vetted: 1` (the marker the proxy stamped). Marker-
  less requests (loopback callers) skip the BFF deny.

Both layers use the same rule set: subtree prefix match against
`/api/runtime/pairing` (all methods, full subtree) and against
`/api/runtime/tunnel/<sub>` (all methods, full subtree with non-empty
sub-path), plus bare-path match against `/api/runtime/tunnel` (all
methods except GET — GET on the bare path is the rewrite carve-out).
Canonicalization itself runs on every request regardless of layer or
marker; the deny match is the part that gates per the rules above.
See Deny list for the full table.
```

The pairing deny and the tunnel deny apply to the **canonical** path; an attacker who percent-encodes characters (`/api/runtime/%70airing`, `/api/runtime/%74unnel/qr.svg`) is decoded back to the canonical form before the check.

## URL cleanup after bootstrap

The first request that carries `/<secret>` or `/<secret>/<rest>` does not return HTML directly. The proxy mints the session cookie and 302-redirects to:

- `/` when the secret was the whole path or only had a trailing slash
- `/<rest>` otherwise, preserving query string (fragments are browser-side and never reach the server — the proxy has nothing to preserve there)

The 302 response itself carries `Referrer-Policy: no-referrer` so even the brief intermediate `/<secret>/...` URL cannot leak via `Referer` on subsequent subresource fetches the destination page issues. All subsequent tunneled responses (HTML, JSON, assets) carry `Referrer-Policy: strict-origin` so outbound clicks to external sites send only the host (not the path) as referrer.

The browser's URL bar shows the clean path; subsequent navigations within the app are clean URLs authorized by the cookie.

Server-side 302 is chosen over client-side `history.replaceState` because:

- The secret never enters the rendered HTML or any JS bundle.
- Referer leakage on outbound clicks is bounded by the response-header policy above.
- Browser back-button preserves the clean URL.

## Request flow — five scenarios

### Scenario A — Phone's first hit, secret in URL

```
Phone   Cloudflare   cloudflared        Proxy            BFF            Runtime
  │         │            │                │               │               │
  │ GET /<sec>/                            │               │               │
  ├────────►├───────────►├───────────────►│               │               │
  │         │            │                │ enabled? YES  │               │
  │         │            │                │ secret match  │               │
  │         │            │                │ canonicalize  │               │
  │         │            │                │ mint cookie   │               │
  │         │            │                │ 302 to /      │               │
  │         │            │                │               │               │
  │  302 + Set-Cookie    │                │               │               │
  │◄────────┤◄───────────┤◄───────────────┤               │               │
  │ GET /  (Cookie: gini_tunnel_session=<sec>)            │               │
  ├────────►├───────────►├───────────────►│               │               │
  │         │            │                │ no prefix     │               │
  │         │            │                │ cookie==sec ✓ │               │
  │         │            │                │ stamp vetted=1│               │
  │         │            │                ├──────────────►│               │
  │         │            │                │               │ render HTML   │
  │         │            │                │               │ (Referrer-    │
  │         │            │                │               │  Policy: …)   │
  │  HTML                │                │               │               │
  │◄────────┤◄───────────┤◄───────────────┤◄──────────────┤               │
```

### Scenario B — Phone navigates with cookie set, no secret in URL

```
Phone   Cloudflare   cloudflared        Proxy            BFF            Runtime
  │         │            │                │               │               │
  │ GET /chat (cookie=<sec>)               │               │               │
  ├────────►├───────────►├───────────────►│               │               │
  │         │            │                │ enabled=YES   │               │
  │         │            │                │ no prefix     │               │
  │         │            │                │ cookie==sec ✓ │               │
  │         │            │                │ stamp vetted=1│               │
  │         │            │                ├──────────────►│               │
  │         │            │                │               │ render        │
  │         │            │                │               │ JS calls      │
  │         │            │                │               │ GET /api/     │
  │         │            │                │               │  runtime/     │
  │         │            │                │               │  sessions     │
  │         │            │                │               │ guardCsrf ✓   │
  │         │            │                │               │ inject bearer │
  │         │            │                │               ├──────────────►│
  │         │            │                │               │  JSON         │
  │         │            │                │               │◄──────────────┤
  │ HTML + JSON                            │               │               │
  │◄────────┤◄───────────┤◄───────────────┤◄──────────────┤               │
```

### Scenario C — Outsider knows the hostname but not the secret

```
Attacker   Cloudflare   cloudflared        Proxy
   │           │            │                │
   │ GET /chat (no secret, no cookie)        │
   ├──────────►├───────────►├───────────────►│
   │           │            │                │ enabled? YES
   │           │            │                │ no prefix
   │           │            │                │ no cookie
   │           │            │                │ → 404
   │           │◄───────────┤◄───────────────┤
   │◄──────────┤            │                │
```

### Scenario D — DNS rebinding attempt from a page in the operator's browser

```
operator's browser, currently on https://attacker.example
attacker.example DNS rebinds to the tailnet IP / loopback at this moment
attacker JS issues fetch("https://attacker.example/api/runtime/agents",
                          { method: "POST",
                            headers: { Authorization: "Bearer …stolen…",
                                       "x-gini-tunnel-vetted": "1" } })

browser stamps (forbidden headers, JS cannot override):
   Host: attacker.example
   Origin: https://attacker.example
   Sec-Fetch-Site: same-origin
     (the page IS on attacker.example and is fetching attacker.example;
      the browser sees a same-origin request. The defense is NOT
      Sec-Fetch-Site here — it is Step 3's Host classifier, which
      runs BEFORE any secret/cookie/auth check, rejecting
      attacker.example as neither loopback, the live tunnel hostname,
      nor in GINI_TRUSTED_ORIGINS. The 404 is at the Host classifier,
      not at a downstream cookie/secret mismatch.)

                       │
                       ▼
         ┌────────────────────────────┐
         │  Proxy                     │
         │  - Step 1 DELETE inbound   │
         │    vetted=1 (spoof erased) │
         │  - Step 2 canonicalize     │
         │    path (4xx on malformed) │
         │  - Step 3 classify Host    │
         │      attacker.example is   │
         │      not loopback,         │
         │      not live tunnel host, │
         │      not in trusted        │
         │      origins               │
         │    → 404 (Host classifier  │
         │      rejects BEFORE any    │
         │      cookie/secret check)  │
         └────────────────────────────┘
                       │
                       ▼
                    BLOCKED
```

### Scenario E — Co-tenant on the same Mac spoofs the marker

```
   curl -H "x-gini-tunnel-vetted: 1" -H "Origin: https://evil.example" \
        http://127.0.0.1:<webPort>/api/runtime/agents

                       │
                       ▼
         ┌────────────────────────────┐
         │  Proxy (loopback branch)   │
         │  - DELETE inbound vetted=1 │
         │  - DO NOT stamp it back    │  ← forwarded request has no marker
         │  - forward to BFF          │
         └────────────────────────────┘
                       │
                       ▼
         ┌────────────────────────────┐
         │  BFF guardCsrf             │
         │  - no marker present       │
         │  - Origin host ≠ Host      │
         │  - method = POST → require │
         │    Origin host ≡ Host      │
         │  → 403                     │
         └────────────────────────────┘
                       │
                       ▼
                    BLOCKED
```

## CSRF policy

```
Comparison rule: Origin and Host are compared as scheme-stripped
host+port. Cloudflare terminates TLS, so the proxy sees scheme-less Host;
the browser sends scheme-bearing Origin. Strip the scheme from Origin
before comparing. Ports are compared explicitly — `localhost:4000` and
`localhost:3000` are different browser origins and must not compare
equal. Default-port equivalence (`:80` for http, `:443` for https) applies
only when one side omits the port and the other supplies the matching
default.

Allowlist: an env-configured flat list of trusted Origins
(GINI_TRUSTED_ORIGINS, comma-separated origin URLs — no per-entry knobs,
no expressions). Used by operators who front gini with a stable hostname
instead of (or in addition to) the trycloudflare tunnel. Empty by default;
tunnel deployments do not put the rotating trycloudflare hostname in the
allowlist. The allowlist relaxes guardCsrf's Origin/Host equality
requirement only — every entry in the list has the same effect: the
listed Origin is treated as same-origin-equivalent for the equality
check. There is no per-entry flag because the list is flat. It does
NOT authenticate callers. A request from an allowlisted Origin still
needs the secret-path bootstrap or a session cookie or a localhost
bearer to authorize the underlying action; the allowlist only states
which Origins guardCsrf accepts as same-origin-equivalent.

                          No vetted marker            Vetted marker stamped
                          (loopback or rejected)      (came through the proxy)
═══════════════════════════════════════════════════════════════════════════════
Host check                must be loopback. The       NOT required (the proxy
                           "trusted-origin" path        already verified Host
                           routes through the TUNNEL    against the live tunnel
                           branch and arrives WITH      hostname OR an allowlist
                           the marker — never here.    entry before stamping)
Origin host ≡ Host host?  required when Origin        required when Origin
                           is present, UNLESS Origin   is present, UNLESS Origin
                           is in GINI_TRUSTED_ORIGINS  is in GINI_TRUSTED_ORIGINS
                           (which is a flat list,      (same — every allowlist
                           every entry has the same    entry has the same effect)
                           effect)
Sec-Fetch-Site            allowed: same-origin /       allowed: same-origin /
                           none / absent. ANY OTHER     none / absent. ANY OTHER
                           value (cross-site, same-     value (cross-site, same-
                           site) → REJECT regardless    site) → REJECT regardless
                           of method.                   of method.
Safe methods (GET/HEAD)   Origin not required;        Origin not required;
                           Sec-Fetch-Site rule         Sec-Fetch-Site rule
                           still applies               still applies
Unsafe methods            Origin REQUIRED             Origin REQUIRED
 (POST/PUT/PATCH/DELETE)                              (marker never relaxes
                                                       this)
OPTIONS preflight         answered only when           answered only when
                           Origin matches Host or       Origin matches Host or
                           is in the allowlist; never   is in the allowlist;
                           forwards the runtime         never forwards the
                           bearer                       runtime bearer
```

The `Sec-Fetch-Site` rejection of `same-site` and `cross-site` is a deliberate choice that interacts narrowly with the `GINI_TRUSTED_ORIGINS` allowlist. The allowlist relaxes ONLY the Origin/Host equality check; it does NOT relax the `Sec-Fetch-Site` rule. The two gates are independent and the request must pass both. This is consistent because:

- The allowlist exists to cover canonical-form mismatches between Origin and Host (e.g., explicit `:443` port on Origin vs no port on Host, or other URL-text variants that resolve to the same effective origin). In those cases the browser still considers the request `same-origin` and stamps `Sec-Fetch-Site: same-origin`, so both gates pass.
- The allowlist is NOT a mechanism to trust truly cross-origin callers (different host or different subdomain). A page on `app.gini.example` fetching to `gini.example` is `same-site` (same registrable domain, different subdomain) — the browser sends `Sec-Fetch-Site: same-site`, and the request is rejected at the Sec-Fetch-Site gate even if `https://app.gini.example` is in the allowlist. A page on `attacker.example` fetching to `gini.example` would be `cross-site` and similarly rejected.
- This is intentional: gini is a single-origin app per deployment. Cross-subdomain or cross-site UI surfaces sharing the API are out of scope. Operators who want one are accepting that they need their own reverse-proxy front and per-origin CSRF discipline beyond what gini ships.

In practice the allowlist mostly serves the operator's "I front gini with my own stable hostname instead of the rotating trycloudflare hostname" case, where UI and API share the same origin and the allowlist exists as an explicit ledger of trusted Host values for the Host classifier (Architecture Step 3) and for the Origin/Host equality canonical-form match.

## Marker un-forgeability

```
INBOUND request to the proxy
   headers may contain ANY inbound x-gini-tunnel-vetted value

                       │
                       ▼
         ┌────────────────────────────┐
         │  Proxy clones headers      │
         │  DELETE x-gini-tunnel-     │   ← single delete, before branch
         │  vetted from the clone     │
         └────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼                              ▼
  tunnel branch                  loopback branch
  passes secret/cookie gate      forwards
  SET vetted=1                   leave marker absent
  (overwrites nothing —          (co-tenant cannot
   it was already deleted)        inject the marker)
        │                              │
        ▼                              ▼
  forward                        forward

Downstream code reads x-gini-tunnel-vetted ONLY on the FORWARDED request,
NEVER on the inbound one. No codepath reaches the BFF or the runtime with
an attacker-supplied value.

The BFF strips x-gini-tunnel-vetted before forwarding to the runtime.
The runtime never observes the marker; it is a BFF-internal signal only.
```

## Trust radius

```
HOLDS WHAT?               CAN DO                                  ROTATED BY
──────────────────────   ──────────────────────────────────      ─────────────
URL with /<secret>/       full operator access through the        gateway
                          tunnel, MINUS the deny list:            restart
                            /api/runtime/pairing — entire         (rotates
                              subtree, all methods                hostname)
                            /api/runtime/tunnel — entire          OR
                              subtree, all methods, PLUS bare     `gini tunnel
                              path methods != GET                 rotate-secret`
                          (the URL holder cannot mint device         (next request
                           bearers, disable own session,             invalidates
                           rotate secret, drive Notes.app, or        cookies)
                           fetch QR pixels through a tunneled
                           fetch)
                          Browser receives /api/tunnel/redacted
                          shape only (secret + publicUrl nulled)

Session cookie            same authority as URL secret;            (auto-invalid
                          cookie value IS the secret               on rotation,
                                                                    disable, or
                                                                    Max-Age
                                                                    expiry)

Tunnel-vetted browser     full operator access, MINUS the         (auto-invalid
 JS (post-bootstrap)        deny list above (including QR           on rotation,
                            endpoints and tunnel mutation           disable, or
                            routes); receives only redacted         cookie expiry)
                            snapshot shape; cannot read live
                            secret, publicUrl, or QR pixels
                            from any browser-side fetch

Paired-device bearer      full operator access                    device revoke

Loopback bearer           full operator access, unchanged         config edit
```

## Deny list through the tunnel

> **NOTE (deliberate divergence from the original spec below).** PLAN.md
> describes the original conservative deny list — the entire
> `/api/runtime/tunnel/*` subtree (QR endpoints, refresh-notes) was denied
> through the tunnel and `GET /api/runtime/tunnel` was rewritten to
> `/api/tunnel/redacted` so tunneled browser JS only saw the redacted shape.
> That policy was intentionally broadened: the tunneled settings card now
> exposes the same Enable / Disable / Rotate / Apple-Notes-toggle controls
> the loopback view does (so an operator who realizes they've leaked the
> QR can rotate-secret from the same surface they scanned on), so
> `GET /api/runtime/tunnel`, `PATCH /api/runtime/tunnel`,
> `GET /api/runtime/tunnel/qr.svg`, `GET /api/runtime/tunnel/qr.txt`, and
> `POST /api/runtime/tunnel/refresh-notes` are all ALLOWED through the
> tunnel; only `/api/runtime/pairing/*` (the device-bearer mint) remains
> denied. The QR-pixel canvas-decode XSS hazard is explicitly accepted as
> a tradeoff. The live policy lives in
> `docs/adr/tunnel-and-mobile-access.md` and
> `docs/adr/bff-trust-boundary.md`; refer there before reading the historical
> spec below.

The deny list applies ONLY to tunnel-vetted requests — i.e., requests that arrived via the proxy's TUNNEL BRANCH (Host classified as live tunnel hostname or a `GINI_TRUSTED_ORIGINS` entry) and were stamped with `x-gini-tunnel-vetted: 1` before forwarding. Loopback callers (LOOPBACK BRANCH, no marker stamped) bypass the deny list entirely — the operator's localhost browser must be able to fetch the QR endpoints, PATCH `/api/runtime/tunnel` to enable/disable, POST `/api/runtime/pairing` to mint a device code, and so on. The defense for loopback callers is the bearer-on-localhost contract plus `guardCsrf`'s Origin/Host equality requirement on unsafe methods (which rejects any cross-process unsafe call that doesn't supply matching Origin/Host) — NOT the deny list.

All deny rules below are checked at TWO layers, each gated by a layer-specific condition:

- The PROXY checks the deny list while inside the TUNNEL BRANCH (the branch entered when the Host classifier matches the live tunnel hostname or a `GINI_TRUSTED_ORIGINS` entry). The proxy is the layer that STAMPS the marker; it does not read an inbound marker for this purpose. The gating condition is "request is on the tunnel branch and is about to be stamped vetted=1 on forward" — equivalent to "the request is tunneled" for any caller that reaches the BFF.
- The BFF GUARD re-checks the deny list, gated on the inbound `x-gini-tunnel-vetted: 1` marker that the proxy stamped. Loopback callers (LOOPBACK BRANCH, marker absent) reach the BFF without the marker and skip the deny.

Pin twice — defense in depth against a future route that bypasses one layer.

```
Path matches (canonical form)                            Decision
═══════════════════════════════════════════════════════  ════════
/api/runtime/pairing            (ENTIRE SUBTREE under this prefix, DENY
                                 ALL methods — covers /pairing,
                                 /pairing/claim, and any future
                                 sub-route)
/api/runtime/tunnel             (bare path. Per the trailing-      DENY
                                 slash equivalence rule in Path     (except
                                 canonicalization, BOTH             GET)
                                 `/api/runtime/tunnel` and
                                 `/api/runtime/tunnel/` (no sub-
                                 path) match this rule. ALL
                                 methods EXCEPT GET — covers
                                 PATCH and any future non-GET
                                 method on the root by default.
                                 GET on the bare path is the
                                 rewrite carve-out described
                                 below.)
/api/runtime/tunnel/<sub>        (ENTIRE SUBTREE — `<sub>` is a    DENY
                                 NON-EMPTY sub-path of length
                                 ≥ 1 character. Matches
                                 `/api/runtime/tunnel/<x>` and
                                 `/api/runtime/tunnel/<x>/...`
                                 for any non-empty `<x>`. Covers
                                 refresh-notes, qr.svg, qr.txt,
                                 and any future tunnel sub-route;
                                 positive-match on the prefix,
                                 not on the enumerated names.
                                 `/api/runtime/tunnel/` (no sub-
                                 path) does NOT match this rule —
                                 it matches the bare-path rule
                                 above per trailing-slash
                                 equivalence.)
percent-encoded variants of any of the above             DENY (canonicalize first)
everything else /api/runtime/*                           allow (subject to guardCsrf)
```

`POST /api/runtime/pairing` and `POST /api/runtime/pairing/claim` produce long-lived device bearers; the URL-secret holder has no business minting one. On the bare `/api/runtime/tunnel` path, every method except GET is denied through the tunnel — PATCH disables the session or rotates the secret (a tunnel holder must not), and any future non-GET, non-PATCH method on the root inherits the deny by default rather than silently opening as a new attack surface. The bare GET escapes the deny because it is the rewrite carve-out: under vetted=1 the BFF rewrites it to `/api/tunnel/redacted`. The entire `/api/runtime/tunnel/*` subtree is denied through the tunnel because (a) `refresh-notes` triggers an osascript side-effect on the operator's Mac that a tunnel holder should not drive, (b) the QR endpoints' response bytes encode the live bootstrap URL — a tunneled browser that could fetch them could QR-decode the pixels back to the secret, defeating the redacted-snapshot invariant, and (c) any future sub-route added under `/api/runtime/tunnel/` is covered by default. New tunnel sub-routes that legitimately need browser exposure must be added under a different parent (e.g., `/api/runtime/<new-feature>`) or explicitly carved out via a BFF rewrite, not by amending the deny list.

Order of operations in the BFF: canonicalize → deny check → guardCsrf → rewrite (if vetted=1 and matching trigger) → forward. The bare GET on `/api/runtime/tunnel` survives the deny because the bare-path rule denies methods EXCEPT GET, and survives the subtree rule because it has no sub-path; under vetted=1 the rewrite then redirects it to `/api/tunnel/redacted` before forwarding to the runtime.

The TunnelQrLauncher icon in the app shell is hidden when the current request is tunnel-vetted (marker stamped), so the QR endpoints are never fetched by JS in a tunneled context.

Deny check is path-only and independent of auth: a request to a denied path returns the same status code whether or not auth would have succeeded. This is intentional — denied-on-auth-failure would leak auth state via response timing.

Route name mapping through the catch-all: the BFF forwards `/api/runtime/<rest>` to `/api/<rest>` on the runtime for ALL routes, including tunnel sub-paths. So `/api/runtime/tunnel/qr.svg` reaches `/api/tunnel/qr.svg` on the runtime; `/api/runtime/tunnel/refresh-notes` reaches `/api/tunnel/refresh-notes`; `/api/runtime/pairing/claim` reaches `/api/pairing/claim`. The deny list operates on the BFF-visible form before the rewrite, so the runtime-side names never appear as a separate enforcement point.

Path namespace: the deny list is stated in the **proxy-visible form** (`/api/runtime/<rest>`). The BFF catch-all forwards `/api/runtime/<rest>` to `/api/<rest>` on the runtime; the runtime's actual route is `/api/pairing/<...>` etc. The proxy checks before the rewrite; the BFF guard checks again on the same form before the rewrite to the runtime.

## Operational invariants

- `cloudflared` lifetime equals gateway lifetime: started after Next.js reports a port, torn down inside the SIGTERM drain. If cloudflared crashes mid-life, the gateway does not respawn it; the snapshot transitions to `lastError` and the operator can re-enable.
- Tunnel state changes (enable, disable, recycle) go through a single serialized apply path. A monotonic generation counter increments on disable; in-flight retries / Notes writes / port-discovery probes consult the generation before acting. On disable, persistence ordering matters: the apply path commits `enabled:false` to `config.json` via atomic write FIRST (so the next proxy request read sees the new state), THEN kills cloudflared synchronously. Without that ordering the proxy could read a stale `enabled:true` between cloudflared termination and config commit, defeating the immediate-cookie-rejection guarantee. Upper bound on tunnel-up-after-disable is still the SIGKILL hard-cap of 5000 ms, measured from config commit.
- Recycle ordering: stop cloudflared, THEN resolve the new web port. The observable invariant is that cloudflared never forwards to a port bound by an *accidental* squatter — a zombie process from a previous run, an opportunistic listener that grabbed the freed port between teardown and resolve. Port discovery verifies BOTH (a) the port accepts a TCP connection, AND (b) a sentinel request to a known internal health path returns the supervised Next.js child's identity stamp. The stamp is a per-launch random nonce passed to Next.js as an environment variable. A deliberate same-UID attacker who reads the nonce (via `ps`-style environment-variable extraction or the mode-0600 fallback file) can spoof the stamp; this is acknowledged and IN scope of the threat model's "same-UID local processes ... already inside the file-system trust boundary" — the identity stamp is defense-in-depth against accidental collisions, NOT a trust-root against same-UID adversaries. Identity-without-liveness or liveness-without-identity is a failure that retries within the discovery window.
- Web port discovery: probe loop with the 60000 ms ceiling, performing the identity check above. Failure mode: gateway emits a structured `tunnel.port.discovery.timeout` event and refuses to spawn cloudflared until manual re-enable.
- Tunnel snapshot: not persisted. Hostname rotates per restart; persisting would surface stale state.
- `config.json` writes are atomic: write to a sibling tempfile in the same directory, fsync, then `rename(2)`. Reads tolerate a transient `ENOENT` by retrying once. Partial-JSON parse errors trigger one retry; a second failure surfaces as an apply-path error rather than crashing the proxy. The proxy reads `tunnel.enabled` and `tunnel.secret` on every request via this read path.
- A successful PATCH `enabled:false` causes the very next request (even with a valid cookie) to 404 — independent of the 5000 ms cloudflared-termination window. The 5000 ms bounds when cloudflared stops forwarding; the proxy's per-request config read closes the cookie-validity gap immediately.
- Response scrubbing: every browser-visible response body whose `Content-Type` is `text/*`, `application/json`, or `application/xml`, regardless of status code, runs through the same `redact()` helper before write. Compressed bodies (`Content-Encoding: gzip`, `br`, `deflate`, `zstd`) are decompressed in-process, scrubbed, and re-compressed before the wire; alternatively, compression is applied after scrub (preferred — scrub the source, then encode). Binary content types (`image/*`, `font/*`, `application/octet-stream`, etc.) skip redact — the helper is string-shaped and would corrupt non-text payloads. The QR endpoints (the only binary surface that could embed the bootstrap URL by design) are denied through the tunnel, so the binary skip cannot leak the secret to a tunneled browser. Static assets like favicons never carry the secret; the skip is safe.
- Disable does not drain in-flight requests; they are aborted on cloudflared termination. The 5000 ms cap is exposure, not graceful shutdown.
- `lastError` lifecycle: any successful state transition (enable, disable, refresh-notes, port discovery) clears its respective `lastError` field. Sticky errors only persist while the failure condition itself persists.

## Log redaction (hard invariant)

The invariant applies to EMITTED diagnostics — log lines, structured events, audit blobs, trace fields, browser console messages, response headers logged for debugging, the browser-visible REDACTED snapshot at `/api/tunnel/redacted`, and any string the proxy/BFF/runtime sends to a sink that isn't the source-of-truth state store or an explicitly-privileged bearer-gated emission. It does NOT cover:

- The source-of-truth state store itself: `config.json` holds `tunnel.secret` at rest by design (mode `0600`, same-UID-only readable), because that file IS the secret's home. Redacting the source of truth would erase the secret.
- The privileged `GET /api/tunnel` shape: bearer-gated, reachable only on loopback (and only on loopback because the tunnel deny list blocks `/api/runtime/tunnel/<anything>` from tunneled callers; the privileged shape is the runtime path the BFF rewrite avoids). This response intentionally emits `tunnel.secret` and `publicUrl` as a CLI/operator contract; `redact()` does NOT scrub it. The `lastError` strings inside this shape ARE scrubbed (the privileged response carries the raw secret/URL by design but no UN-INTENDED leaks via error strings).
- The Apple Notes mirror: opt-in trust-radius extension covered in the Apple Notes mirror section. The mirror's note body is the bootstrap URL by design.

Every other emission path is scrubbed via `redact()`. The invariant covers, but is not limited to:

- Access logs (request paths that start with `/<secret>/` are rewritten in the log entry before write).
- Error logs and stack traces.
- Structured trace / audit events (every string field passes through `redact()` before serialization).
- Browser console messages that the gateway proxies or relays.
- `Set-Cookie` header values when logging response headers.
- SQLite blob columns, JSON-serialized state, message bus payloads, any string about to enter persistence.
- Snapshot fields surfaced to the browser: both `tunnel.lastError` and `appleNotes.lastError` run through `redact()` before being returned in any snapshot response.

Implementation contract: a centralized `redact(str)` helper takes any string about to enter any sink and replaces every occurrence of any value in the redaction set, AND any percent-encoded variant of those values, with the literal token `<redacted-secret>`. Percent-encoded variants must be considered because some sinks log raw inbound paths before canonicalization; `redact()` either canonicalizes the input string first OR matches against both the raw and decoded forms. The redaction set contains:

- The live `tunnel.secret` value (current).
- The previous `tunnel.secret` values for a bounded window after each `rotate-secret`. The redaction set holds the current secret plus a queue of every prior secret whose window has not yet elapsed; rapid back-to-back rotations DO NOT evict in-flight predecessors. A predecessor leaves the queue only when the max of (`30000 ms` since its own rotation commit) AND (every request that was in-flight at THAT rotation commit has completed or been aborted) — both conditions hold. The single serialized apply path tracks an in-flight counter per rotation generation; every request increment on enter has a paired decrement on exit, where "exit" includes successful response, error response, abort due to client disconnect, AND abort due to cloudflared termination. Cloudflared-driven aborts are observed by the proxy/BFF when the upstream socket closes with the request still mid-flight; the handler's request-finalizer (try/finally equivalent) fires the decrement in both the normal-exit and abort paths. If the runtime cannot observe an abort (e.g., proxy crashed), the `30000 ms` floor serves as the safety net — the queue eventually drains via the time component alone. The cookie value byte-equals the secret, so any place that logs the `Cookie` or `Set-Cookie` header is covered by the same per-rotation entries; no separate cookie-value slot is needed.
- The live tunnel `publicUrl` value (the full URL string).
- The `trycloudflare.com` hostname suffix (so any DNS-error string mentioning it is scrubbed too).

The rotation window ring (`current` + `previous`) closes the gap where an in-flight request, started before rotation, finishes its log write after rotation and would otherwise leak the old secret. Tested by greping every log/state/sink after a request that included the live secret in the path, before AND after `rotate-secret`, asserting zero substring matches against the redaction set.

## Public surface

Routes the runtime exposes (all bearer-gated; reachable directly on localhost or through the BFF generic catch-all over the tunnel):

```
GET    /api/tunnel                  privileged snapshot
                                     (secret, publicUrl, enabled, lastError,
                                      appleNotes.*; lastError and
                                      appleNotes.lastError are redacted by
                                      redact() before serialization, so even
                                      the privileged shape carries no raw
                                      secret/URL in error strings)
GET    /api/tunnel/redacted         browser-safe snapshot
                                     (secret=null, publicUrl=null, enabled,
                                      lastError, appleNotes.enabled,
                                      appleNotes.notesAvailable,
                                      appleNotes.lastError;
                                      both lastError fields are redacted)
PATCH  /api/tunnel                  enable / disable / appleNotes toggle
                                     (DENIED through the tunnel)
POST   /api/tunnel/refresh-notes    explicit Apple Notes re-sync trigger
                                     (DENIED through the tunnel)
GET    /api/tunnel/qr.svg           SVG QR of current public URL;
                                     Cache-Control: no-store
                                     (the rendered pixels encode the
                                      bootstrap URL — DENIED through the
                                      tunnel; localhost-only)
GET    /api/tunnel/qr.txt           ANSI half-block QR for terminals
                                     (DENIED through the tunnel — terminal-
                                      only output)
```

Browser code reaches these through `/api/runtime/tunnel/*`. The BFF rewrite rule: when the inbound request carries `x-gini-tunnel-vetted: 1` (i.e., the proxy stamped it on the way in — a tunnel-vetted browser caller), the canonical path `/api/runtime/tunnel` rewrites to `/api/tunnel/redacted` on the runtime. The rewrite trigger applies the same trailing-slash equivalence used by the deny list — both `/api/runtime/tunnel` and `/api/runtime/tunnel/` match the trigger and both end up at `/api/tunnel/redacted`. A bare GET to `/api/runtime/tunnel/` (trailing slash) never reaches the runtime's privileged `/api/tunnel` shape under a vetted=1 marker.

CLI and direct-bearer callers hit `/api/tunnel` directly and receive the privileged shape.

## CLI

```
gini tunnel status            print snapshot
gini tunnel qr                ANSI QR for the current URL
gini tunnel enable            spawn cloudflared, mint secret if missing
gini tunnel disable           stop cloudflared
gini tunnel rotate-secret     atomically replace the 192-bit secret in
                              config.json. Next request through the proxy
                              reads the new secret; existing cookies
                              mismatch and 404 on the next hit. No
                              restart required.
gini tunnel sync-notes        force an Apple Notes refresh
gini tunnel apple-notes ...   enable / disable / configure the mirror
```

CLI talks to the runtime when up; falls back to atomic `config.json` mutation when not, so the next start picks up the change.

## Apple Notes mirror

Defaults OFF. Opt-in semantics include an explicit acknowledgment: the operator is choosing to extend the live `tunnel.secret` value's trust radius to iCloud sync, including any device that has the same iCloud account signed in. This is the **only** documented exception to the log-redaction invariant: the note's body is, by design, the bootstrap URL (which contains the secret). Disabling the mirror clears the note on next state transition; rotating the secret causes the next refresh to overwrite the note with the new URL, after which the old URL in iCloud's version history is the residual concern (mitigated by `rotate-secret` invalidating the old secret immediately on the gateway).

When the operator opts in:

- Manager spawns `osascript` against `Notes.app`, writing the live URL into a folder named `gini` in iCloud Notes, in a note named `gini-tunnel-<instance>`.
- 15000 ms hard timeout. SIGKILL on overrun.
- macOS TCC Automation prompt fires the first time. For launchd-managed processes, the prompt may not surface; in that case the osascript times out at 15000 ms, the snapshot's `appleNotes.lastError` records the timeout, and the rest of the gateway is unaffected.
- The mirror exists because cloudflared rotates hostnames on restart — a stale QR on the operator's desk would not work; the note's body updates within iCloud's sync latency and the operator's phone picks up the new URL.
- All error strings reaching `appleNotes.lastError` run through `redact()` (see Log redaction). The redactor handles the live secret value AND its percent-encoded variants, every prior secret still inside the rotation window AND its variants, the full public URL, and the `trycloudflare.com` hostname suffix — the same redaction set every other sink uses; no per-sink exception. The note body itself (the only iCloud-mirrored content) carries the live URL by design and is NOT scrubbed; everything else flowing into `appleNotes.lastError` is.

## Persisted config

One new top-level slot:

```
config.json
{
  ...
  tunnel: {
    enabled: boolean,
    secret: string,               // 192-bit, base64url, generated eagerly
                                  // on first gateway boot (whether or not
                                  // tunnel.enabled is true), so a later
                                  // enable doesn't have to mint and the
                                  // file's mtime doesn't leak enable history
    appleNotes: { enabled: boolean }
  }
}
```

Snapshot fields (`publicUrl`, `lastError`, `appleNotes.lastError`, `appleNotes.notesAvailable`) live in memory only. The snapshot is not persisted; hostnames rotate per restart.

`appleNotes.notesAvailable` is probed once at startup (osascript can find `Notes.app`) and re-probed after a successful `refresh-notes` POST. Failures latch into `appleNotes.lastError`, not into `notesAvailable`.

## Known limitations

- SSE buffers fully on Cloudflare quick tunnels. Live activity stream and chat-block stream do not stream in real time over the public URL; polling cadence picks up state changes on the next refetch. Real-time over a public URL requires a named Cloudflare Tunnel (different ADR, paid surface).
- Quick tunnel rejects requests beyond 200 simultaneous in-flight with a 429. Gini surfaces the 429 to the client without retry.
- The QR pixels encode the bootstrap URL (secret included) by design. Anyone who can capture an over-shoulder photo of the QR can claim the tunnel; the operator's threat model treats this as acceptable for the local-first single-operator pattern.

## Threat model

Trust boundaries:

- **Same-UID local processes (co-tenants).** Already inside the file-system trust boundary — `config.json` is mode 0600, same-UID readable; the runtime bearer lives there anyway. The plan does NOT defend against a co-tenant reading state OR deliberately spoofing identity stamps based on state they read. The marker-strip in Scenario E defends against a co-tenant *injecting a forged x-gini-tunnel-vetted header* from outside the proxy (the proxy's per-request strip-then-stamp is structural, not state-dependent). The recycle-ordering invariant defends against *accidental* port-squat by zombie processes / opportunistic listeners — NOT against a deliberate same-UID adversary who has read the nonce. A determined same-UID attacker is out of scope; the file-system trust boundary is the bound.
- **External attackers who know the trycloudflare hostname.** Defended by 192-bit secret-path bootstrap, HttpOnly host-only `SameSite=Lax` session cookie, Origin / Host invariants in guardCsrf, vetted-marker bridge, `/api/runtime/pairing` subtree deny (full subtree, all methods — covers `/pairing/claim` and any future sub-route), and the `/api/runtime/tunnel` deny (entire subtree all-methods, PLUS bare-path all-methods-except-GET; GET on the bare path is the rewrite carve-out that lands at `/api/tunnel/redacted`).
- **Operator's own browser visiting an attacker page (DNS rebinding).** Defended by `Origin host ≡ Host host` requirement on unsafe methods, marker un-forgeability (browser can't fake the marker because the proxy strips inbound), and the loopback-Host rule when no marker is present.

URL leak window:

- A leaked URL grants operator-level access (minus the deny list) until `gini tunnel rotate-secret` runs OR the cloudflared hostname rotates AND the leaked URL holder cannot learn the new hostname. Restart alone rotates the hostname but does NOT rotate the secret; a holder of the secret who can later learn the new hostname is back in.
- Operators who suspect a URL leak should run `rotate-secret` (which invalidates the secret value, the cookies derived from it, and any iCloud Notes copy of the URL) before the next session.

## Test surface (intent, not a literal checklist)

Each bullet is one observable invariant.

**Marker mechanics**
- Proxy strips inbound `x-gini-tunnel-vetted` on both tunnel and loopback branches. BFF only ever observes the proxy-stamped value.
- Runtime never receives `x-gini-tunnel-vetted` (BFF strips before forwarding).

**Tunnel-branch policy**
- `tunnel.enabled=false` causes a request with a valid cookie to 404 within one config-read cycle of the PATCH.
- `tunnel.enabled=true` with no secret prefix and no cookie returns 404.
- `tunnel.enabled=true` with the secret prefix returns 302 + Set-Cookie, leading to a clean URL.
- `tunnel.enabled=true` with a valid cookie and clean URL forwards without re-stripping.

**Rotation**
- `gini tunnel rotate-secret` invalidates an outstanding session cookie on the very next request (404 returned), without a gateway restart.
- After `rotate-secret`, the iCloud Notes mirror's next refresh writes the new URL; the old URL no longer appears anywhere on disk.

**Marker bypass policy** (the BFF guard)
- vetted=1 + unsafe method + `Sec-Fetch-Site: cross-site` → REJECT.
- vetted=1 + safe method (GET/HEAD) + `Sec-Fetch-Site: cross-site` → REJECT (the Sec-Fetch-Site rule applies to safe methods too; the marker does NOT relax it).
- vetted=1 + any method + `Sec-Fetch-Site: same-site` → REJECT (only `same-origin`, `none`, and absent are allowed; everything else, including `same-site`, rejects).
- vetted=1 + Origin-less unsafe method → REJECT.
- vetted=1 + `Origin host ≠ Host host` AND Origin not in `GINI_TRUSTED_ORIGINS` → REJECT.
- vetted=1 + `Origin host ≠ Host host` BUT Origin matches an allowlist entry AND `Sec-Fetch-Site` is `same-origin`/`none`/absent → ALLOW (the allowlist relaxation case — the allowlist relaxes the Origin/Host equality check ONLY, not the Sec-Fetch-Site rule, so this requires the browser to still classify the request as same-origin per its scheme+host+port equality determination; in practice this fires for canonical-form Origin variants of the same effective origin — e.g., explicit `:443` port vs no port — where the browser treats them as one origin and stamps `Sec-Fetch-Site: same-origin`).
- vetted=1 + `Origin host ≠ Host host` + Origin matches an allowlist entry BUT `Sec-Fetch-Site: same-site` (or `cross-site`) → REJECT (the Sec-Fetch-Site rule fires independently of allowlist membership; covers the cross-subdomain case the allowlist does NOT cover).
- vetted=1 + safe method + same-origin or absent Sec-Fetch-Site → ALLOW.
- Loopback (no marker) + any method + `Sec-Fetch-Site: cross-site` → REJECT. Same Sec-Fetch-Site rule applies symmetrically in the no-marker column.
- Loopback (no marker) + any method + `Sec-Fetch-Site: same-site` → REJECT. Same as above.

**Deny list gating** (the BFF guard)
- Tunneled (vetted=1) `GET /api/runtime/tunnel/qr.svg` → DENY (400/404). The QR endpoints are inaccessible to a tunneled browser.
- Loopback (no marker) `GET /api/runtime/tunnel/qr.svg` → ALLOW (the operator's localhost browser must be able to render the QR modal).
- Tunneled (vetted=1) `PATCH /api/runtime/tunnel` → DENY. A tunneled holder must not disable own session or rotate the secret.
- Loopback (no marker) `PATCH /api/runtime/tunnel` (with the bearer or via the BFF) → ALLOW. The CLI and the operator's localhost browser modify tunnel state.
- Tunneled (vetted=1) `POST /api/runtime/pairing` → DENY. The URL holder cannot mint device bearers.
- Loopback (no marker) `POST /api/runtime/pairing` → ALLOW. The operator pairs new devices from localhost.

**Direct-bearer path (runtime, no BFF)**
- A CLI/bearer caller hitting the runtime directly on loopback at `/api/tunnel/qr.svg`, `/api/tunnel/qr.txt`, `POST /api/tunnel/refresh-notes`, `PATCH /api/tunnel`, `POST /api/pairing`, and `POST /api/pairing/claim` with the correct Authorization bearer all succeed. The deny list lives in the proxy and the BFF guard — the runtime itself has no deny logic for these paths because it is bearer-gated and reachable only on loopback. Pinned by direct request to `127.0.0.1:<rt>` with the runtime bearer, asserting non-deny status codes.
- The same CLI/bearer caller hitting the runtime WITHOUT the bearer (or with a wrong bearer) on the same paths returns 401 from the runtime's bearer middleware, NOT a deny — the rejection reason is auth, not the deny list.

**DNS-rebinding regression**
- Tunneled request with `Host: attacker.example`, `Origin: https://attacker.example`, no allowlist match → REJECT.

**Path canonicalization and deny**
- `POST /api/runtime/pairing`, `POST /api/runtime/pairing/claim`, and `PATCH /api/runtime/tunnel` all 403/404 through the tunnel.
- `POST /api/runtime/%70airing`, `POST /api/runtime/pairing/%63laim`, `PATCH /api/runtime/%74unnel` all reach the same deny via canonicalization.
- A request with `..` segments anywhere in the path → 4xx before any handler sees it.
- A doubly-encoded `..` (`%252e%252e/`) decodes to fixed point and rejects.
- A request with a `.` (single-dot) segment anywhere in the path (e.g., `/api/runtime/./tunnel/qr.svg`, `/api/runtime/tunnel/./refresh-notes`, percent-encoded `/api/runtime/%2e/tunnel/qr.svg`) → 4xx; the rejection prevents downstream router normalization from silently collapsing the dot and bypassing the post-canonical deny match.
- A request with duplicate interior slashes (`/api/runtime//tunnel/qr.svg`, `/api/runtime/tunnel///refresh-notes`) → 4xx for the same router-normalization reason.
- A request with `%3F` (encoded `?`) or `%23` (encoded `#`) anywhere in the path (e.g., `/api/runtime/tunnel%3F/qr.svg`, `/api/runtime/tunnel%23extra/refresh-notes`) → 4xx. The encoded delimiter would decode into a `?` or `#` that the downstream runtime router would re-parse as the boundary between path and query/fragment, defeating the deny match we just performed against the pre-forward canonical path.
- A request to a hypothetical sub-route under the tunnel root that was not enumerated when the deny list was authored — e.g., `GET /api/runtime/tunnel/diagnostics` mounted only in the test fixture — returns the deny status. The subtree DENY is positive-match against the `/api/runtime/tunnel/` prefix, not against the listed names; adding a new endpoint to the runtime under that prefix does not silently bypass the deny.
- On the bare `/api/runtime/tunnel` path, every method except GET denies through the tunnel — `POST`, `PUT`, and `DELETE` on the bare path all 403/404 alongside `PATCH`. Only `GET /api/runtime/tunnel` is the rewrite carve-out.
- A request to a path with a single trailing slash (`/api/runtime/tunnel/`, `/api/runtime/pairing/`) is treated as equivalent to its no-slash form for deny matching, and to its no-slash form for rewrite-trigger matching.

**Snapshot shapes**
- Tunneled BFF caller's snapshot has `secret: null` and `publicUrl: null`.
- CLI bearer caller receives the full snapshot.
- BFF rewrites `/api/runtime/tunnel` → `/api/tunnel/redacted` only when the inbound request carries `x-gini-tunnel-vetted: 1` (the proxy stamped it).

**Cookie contract**
- Cookie has `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, `Max-Age=86400`.
- Cookie value byte-equals `tunnel.secret`.
- Cookie scoped to the trycloudflare host: a new hostname after restart does not send the old cookie.

**Disable preemption**
- A PATCH `enabled:false` arriving during an in-flight enable terminates cloudflared within the 5000 ms hard-cap.
- Recycle: during a stop→resolve transition, a sibling process binding the freed port does not cause cloudflared to route to it.

**Apple Notes**
- TCC denial does not latch the toggle off.
- osascript overrun terminates at 15000 ms.
- `appleNotes.lastError` contains no `tunnel.secret` value, no `trycloudflare.com` substring, no full public URL.

**Log redaction**
- After a request that included the live secret in the path, no log file under `logs/` contains the secret value substring.
- After `rotate-secret`, the new secret also stays out of logs.

**Browser-no-secret**
- Every HTTP response body delivered to a tunnel-vetted browser context with a text content-type (`text/*`, `application/json`, `application/xml`) is scanned for the live secret value substring — zero hits. The scan covers 2xx and non-2xx bodies under those content-types. Binary content-types (`image/*`, `font/*`, `application/octet-stream`) are exempt because (a) the redactor is string-shaped and skips them, AND (b) the only binary surface that could embed the bootstrap URL (the QR endpoints) is denied through the tunnel.
- Browser dev-tools cookie inspection shows only `gini_tunnel_session=<opaque-byte-equal-to-secret>`; no other secret material in storage.
- A tunneled GET to `/api/runtime/tunnel/qr.svg`, `/api/runtime/tunnel/qr.txt`, and `POST /api/runtime/tunnel/refresh-notes` all 4xx; the QR pixels never reach a tunneled browser.

**Host validation in the tunnel branch**
- Tunneled request with `Host: <not-loopback, not-live-tunnel-hostname, AND not-in-GINI_TRUSTED_ORIGINS>` returns 404 before any secret/cookie check.
- Tunneled request with `Host` matching a `GINI_TRUSTED_ORIGINS` entry routes through the tunnel branch and reaches the secret/cookie gate; without auth it still 404s.
- Trusted-origin entry `https://gini.example.com` (no explicit port) matches an inbound `Host: gini.example.com` AND an inbound `Host: gini.example.com:443` — default-port equivalence applies in both directions, matching the live-hostname check and the CSRF section's equivalence rule.
- Trusted-origin entry `https://gini.example.com:4000` (non-default port) does NOT match an inbound `Host: gini.example.com` and does NOT match `Host: gini.example.com:443` — default-port equivalence only salvages omitted-vs-default, not arbitrary port mismatch.
- After cloudflared rotates hostname (new restart), a request carrying the old cookie from the previous hostname is not delivered by the browser (host-only cookie); manual `curl` with the old cookie also fails because the Host header doesn't match the new live hostname.

**Atomic config writes**
- A reader hitting `config.json` mid-`rotate-secret` either sees the old or the new content, never a partial JSON; one retry on parse error succeeds.

**Identity-aware port discovery**
- During web-port discovery, a sibling process binding the candidate port before Next.js does is detected by the identity-stamp check; cloudflared spawn is held until the supervised child reports the stamp.

**Rotation-window log redaction**
- A request that includes the secret in the path, racing against a `rotate-secret` that commits before the request's log write, produces zero substring hits for either the old or the new secret value in any log file. (The redact() helper keeps the previous secret in the redaction set until BOTH the 30000 ms floor has elapsed AND every in-flight tunnel-branch request that was outstanding at the rotation commit has either completed or been aborted, whichever is later.)

**lastError lifecycle**
- After a state transition succeeds, the corresponding `lastError` field is null in the next snapshot read.
- After a state transition fails, the field captures the (redacted) error and clears on the next successful transition.
