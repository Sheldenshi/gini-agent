# ADR: Tunnel + mobile access via Cloudflare quick tunnel

## Decision

The runtime exposes a public surface for mobile / off-LAN clients through a
single Cloudflare quick tunnel managed by the gateway. Authorization is
provided by a per-instance 192-bit secret embedded in the bootstrap URL and
exchanged for a host-only `gini_tunnel_session` cookie on the first hit.
The Next.js proxy is the chokepoint: it classifies inbound `Host`, validates
the secret or cookie in constant time, and stamps an internal marker
(`x-gini-tunnel-vetted: 1`) on requests that pass before the BFF guard sees
them.

The original design contract lives in `PLAN.md` for historical context.
The trust-radius and deny-list policy were deliberately broadened during
implementation — the live policy is captured below and in
`bff-trust-boundary.md`. When the two disagree, this ADR (and the
implementation it pins) wins; `PLAN.md` has a banner in the deny-list
section pointing back here.

## Context

The local-first runtime has historically been loopback-only. Operators who
want their phone to reach the gateway have three options:

1. Tailscale / VPN — works for the operator but requires per-device setup
   and shares the same trust model as direct loopback.
2. Pairing flow — mints device-scoped bearers, but the operator still has
   to be on the LAN to consume the pairing code.
3. A public reverse proxy — moves the trust boundary to the operator's
   infrastructure.

Cloudflare quick tunnels are a fourth, lighter-weight option: a single
managed subprocess (`cloudflared`) bridges the gateway's loopback port to
a rotating `*.trycloudflare.com` URL. The cost is that any code path
reachable from that URL must defend itself against the public internet,
not against same-UID localhost callers.

## Architecture (summary)

```
phone → Cloudflare edge → cloudflared subprocess → Next.js proxy
                                                     │
                                          [Host classifier]
                                          [secret-path bootstrap | cookie]
                                          [stamp vetted=1]
                                                     │
                                                 BFF guard
                                          [canonicalize → deny → CSRF
                                           → rewrite-to-redacted → bearer]
                                                     │
                                               Runtime API
```

Key invariants the proxy enforces per PLAN.md:

- **Host classification**: inbound Host must equal the live tunnel hostname
  (read from the sibling file the runtime writes on enable) or an explicit
  `GINI_TRUSTED_ORIGINS` allowlist entry. Anything else 404s before any
  secret/cookie check — defends against DNS-rebinding to an attacker host.
- **Secret-path bootstrap**: a request to `/<secret>/<rest>` mints a
  `gini_tunnel_session` cookie (HttpOnly, Secure, SameSite=Lax, no Domain,
  Max-Age=86400 — value byte-equals the live secret) and 302-redirects to
  the clean URL with `Referrer-Policy: no-referrer`.
- **Cookie validation**: every subsequent request is constant-time-compared
  against the live secret read from `config.json` (uncached). A
  `rotate-secret` causes outstanding cookies to mismatch on the next hit.
- **Marker un-forgeability**: the proxy strips any inbound
  `x-gini-tunnel-vetted` value BEFORE its branch decisions and only stamps
  the marker on requests that passed the secret/cookie gate. The BFF reads
  the marker only on forwarded headers, never on inbound.
- **Deny list**: `/api/runtime/pairing/*` (the device-pairing surface) is
  denied for tunneled callers — minting a permanent device bearer from a
  leaked QR is the one real privilege escalation in this design, so the
  pairing subtree stays loopback-only. Every other `/api/runtime/tunnel/*`
  route the tunnel UI needs is explicitly ALLOWED:
  - `GET /api/runtime/tunnel` returns the privileged snapshot (secret +
    publicUrl) so the tunneled settings card can render the QR / URL.
  - `PATCH /api/runtime/tunnel` lets the tunneled view drive enable /
    disable / rotate-secret / Apple-Notes toggle through the same
    confirm dialogs the loopback view uses.
  - `GET /api/runtime/tunnel/qr.svg`, `/qr.txt` serve the QR pixels;
    surfaced behind a click-to-reveal blur + explicit "live credential"
    warning in the UI.
  - `POST /api/runtime/tunnel/refresh-notes` triggers a one-off Apple
    Notes mirror re-sync.

  Any unknown `/api/runtime/tunnel/<sub>` route is denied by default; a
  new tunnel-surfaced endpoint requires an explicit ALLOW entry rather
  than silently inheriting the privileged exposure.

  This is a deliberate broadening of PLAN.md's original conservative
  deny list. The operator opted into surfacing the full tunnel-control
  UI on the tunneled view so that a leaked URL can be revoked from the
  same surface the operator scanned on. The shoulder-surfing
  consequence (the QR pixels carry the bootstrap URL and a JS-level
  XSS could canvas-decode them) is explicitly accepted; rotate-secret
  is the panic-button mitigation.
- **No BFF rewrite**: previously the BFF rewrote bare
  `GET /api/runtime/tunnel` under `vetted=1` to `/api/tunnel/redacted`
  so tunneled JS only saw the redacted snapshot shape. That rewrite is
  dropped — vetted callers receive the full privileged snapshot. The
  `/api/tunnel/redacted` endpoint is still exposed by the runtime for
  any caller that wants the safe shape explicitly, but the BFF no
  longer substitutes it implicitly.
- **Operational lifecycle**: `cloudflared` lifetime equals gateway lifetime;
  shutdown stops the subprocess within a 5000 ms SIGKILL cap. Disable
  commits `enabled:false` to config FIRST, then kills cloudflared so the
  proxy's per-request config read closes the cookie-validity window
  immediately. The hostname rotates on every cloudflared restart, so the
  host-only cookie self-invalidates after a gateway restart.
- **Log redaction**: every server-side emission path is scrubbed through a
  `redact()` helper that knows the live secret, prior secrets within the
  rotation window, the live publicUrl, and the trycloudflare.com suffix.
  The Next.js child's stdout is teed through the same redactor before the
  CLI writes `web.log`.

## Trust radius

| Holder | Authority | Rotation |
|---|---|---|
| URL holder (knows `/<secret>/`) | full operator access MINUS deny list | `rotate-secret` or hostname rotation on restart |
| Session-cookie holder | same as URL holder | same |
| Tunnel-vetted browser JS | full operator access MINUS pairing subtree; receives the privileged tunnel snapshot (secret + publicUrl) so it can render the QR / URL / rotate-secret UI | same |
| Paired-device bearer | full operator access | device revoke |
| Loopback bearer | full operator access | config edit |

The QR-pixel-decoding leak ("anyone with an over-shoulder photo of the QR
can claim the tunnel") is accepted as in-scope for the local-first
single-operator pattern. The same-UID-local-process threat is out of scope
(`config.json` is mode 0600 and the runtime bearer lives there anyway).

## Consequences

- The BFF guard relaxes its loopback-Host requirement on Origin-less GETs
  when the marker is stamped. See `bff-trust-boundary.md` for the full
  interaction.
- Apple Notes mirror is an opt-in trust-radius extension: the iCloud note
  body intentionally carries the bootstrap URL, so enabling it extends the
  secret's trust radius to iCloud sync. Defaults OFF.
- SSE buffers fully on Cloudflare quick tunnels — live activity / chat
  streaming over the public URL is not real-time. Polling covers it.
- Cloudflare's free quick tunnels reject beyond 200 simultaneous in-flight
  requests with a 429. Gini surfaces the 429 to the client without retry.

## Alternatives considered

- **Named tunnel (paid Cloudflare account).** Removes the SSE-buffering and
  hostname-rotation pain but requires the operator to maintain a Cloudflare
  account and bind a stable hostname. The quick tunnel keeps the local-first
  story intact.
- **Reverse proxy on a stable hostname (`GINI_TRUSTED_ORIGINS` lane).**
  Already supported; orthogonal to the tunnel. Operators who run their own
  front can ignore the tunnel entirely.
- **A bearer-only public surface (no cookie).** Would require the secret in
  every URL, which leaks via Referer and browser history. The cookie-mint +
  302-to-clean-URL design avoids both.

## Acceptance Checks

PLAN.md "Test surface" enumerates the per-invariant observable checks. The
short version:

- Tunnel-branch requests with no secret-prefix and no cookie return 404.
- Tunnel-branch with the secret-prefix returns 302 + Set-Cookie + a clean
  URL; subsequent requests with the cookie pass and are stamped vetted=1.
- Disable causes the next cookie-bearing request to 404, independent of the
  cloudflared-termination window.
- Rotation invalidates outstanding cookies on the next hit.
- Tunneled GET `/api/runtime/tunnel` returns the privileged snapshot
  (secret + publicUrl populated).
- Tunneled PATCH `/api/runtime/tunnel`, GET `/qr.svg`, GET `/qr.txt`,
  and POST `/refresh-notes` all pass through and execute on the
  runtime.
- Tunneled requests to `/api/runtime/pairing/*` return 404 (the only
  remaining denied subtree).
- Any unknown `/api/runtime/tunnel/<sub>` path returns 404 (default-deny
  for new endpoints).
- Loopback callers of every route pass without the marker.
- The marker is stripped from any inbound request before branch decisions
  and is never forwarded to the runtime.
- Log files under `~/.gini/instances/<inst>/logs/` contain no occurrence of
  the live secret value (or the prior secret within the rotation window)
  after a request that included the secret in the path.
