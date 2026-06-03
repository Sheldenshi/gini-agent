# ADR: BFF trust boundary for bearer-injected requests

## Decision

The Next.js BFF guards every `/api/runtime/*` request before injecting
the gateway bearer token. The guard is method-tiered and runs on every
proxied request, not just a curated allowlist of mutating routes. The
behavior is chosen by the `GINI_TRUSTED_ORIGINS` environment variable
read at request time:

- **`GINI_TRUSTED_ORIGINS` set** — comma-separated list of full origins
  (scheme + host + optional port). When `Origin` is present, it must
  exactly match a parsed entry. When `Origin` is absent (browsers may
  omit it on same-origin safe GETs), the guard fails closed because
  there is nothing to compare. If every entry is malformed (a typo
  that leaves zero parseable origins) the guard fails closed for all
  requests until the operator fixes the env var.

- **`GINI_TRUSTED_ORIGINS` unset** — local-dev fallback. When `Origin`
  is present, both the `Host` header must be loopback (`localhost`,
  `127.0.0.1`, or `[::1]`) AND the `Origin` host must match `Host`.
  When `Origin` is absent (typical for non-browser callers like curl,
  or browser same-origin GETs), the guard still requires the `Host`
  to be loopback — a non-loopback Host without an allowlist is
  refused regardless of method.

- **gini-relay tunnel front** — when the app is served through the
  gini-relay tunnel (see [Tunnel Connectivity](tunnel-connectivity.md)),
  the public host is a per-device subdomain under the relay domain
  (`<subdomain>.<relayDomain>`, `relayDomain` default
  `gini-relay.lilaclabs.ai`, overridable via `GINI_RELAY_DOMAIN`). A
  request whose `Host`/`Origin` host is a relay subdomain is trusted
  regardless of `GINI_TRUSTED_ORIGINS`, so an operator who connects a
  tunnel does not also have to enumerate the (randomly assigned)
  subdomain in the env var. This lane now lives at the **gateway front**
  (`src/lib/origin-trust.ts`, `webBoundRequestAllowed`), which validates it
  for every web-bound request and then rewrites `Host`/`Origin` to loopback
  before proxying — so the inner BFF (`web/src/proxy.ts`,
  `web/src/lib/runtime.ts`) carries no relay lane of its own and only ever
  sees loopback.

Method-tiered fail-closed behavior: unsafe methods (POST, PUT, PATCH,
DELETE) additionally require `Origin` to be present at all. A modern
browser always sends Origin on unsafe methods, so the only callers
that omit it are non-browsers (which should hit the gateway directly
with their own token).

`Sec-Fetch-Site` is checked as a secondary signal — it must be
`same-origin`, `none`, or absent.

The browser never receives the gateway bearer token; the BFF reads it
server-side from the per-instance `config.json` and adds it to the
forwarded request only after the guard passes.

## Context

Before this decision, the BFF compared the request `Origin` against
`new URL(request.url).origin`. Next.js dev (and most reverse-proxy or
tunnel setups) carry a stale internal hostname in `request.url` — usually
`localhost:<port>` — so a legitimate non-localhost request was rejected
on Origin-vs-request-URL mismatch. Operators running Gini on a Tailscale
hostname could not use the web control plane at all.

Relaxing the comparison to `Origin`-vs-`Host` fixed the common case but
opened a DNS-rebinding hole. A page loaded from `attacker.example` with
DNS that initially resolves to attacker-controlled infra then rebinds
to the operator's loopback or tailnet IP sets `Origin:
https://attacker.example` and `Host: attacker.example`. Both values are
under attacker control, the equality check passes, the bearer is
forwarded, and the gateway executes whatever privileged mutation the
attacker picked.

JavaScript cannot spoof `Host` (it's a forbidden request header per the
Fetch spec) so a cross-origin attacker page without DNS rebinding still
sees `Host: <BFF hostname>` regardless of what `Origin` it picks. That's
why the loopback fallback is safe — `Host` on a loopback BFF is always
`localhost`/`127.0.0.1`/`[::1]`, and JS can't lie about it. But rebinding
moves the attack into the operator's *own* browser, where `Host` is
honestly attacker-controlled because the URL bar is attacker-controlled.

The gini-relay lane is the same reasoning applied to the relay's DNS.
The relay controls DNS for `*.<relayDomain>` and routes each random,
per-device subdomain only to its owner's `frpc` tunnel — an attacker
cannot make `<their-subdomain>.<relayDomain>` resolve to the operator's
machine, and cannot rebind a relay subdomain because the relay (not the
operator's resolver) owns those names. So a relay `Host` is as
trustworthy as a loopback `Host`: it can only be present on a request
that actually arrived through the operator's own tunnel. `Sec-Fetch-Site`
still applies as the secondary signal — a genuine cross-site request
through the tunnel front is rejected just as it is on the other lanes.

## Consequences

- Operators running the BFF on loopback (the default for `gini run`) get
  no behavioral change. Same-origin browser requests pass; cross-origin
  pages still see 403.
- Operators exposing the BFF on a non-loopback hostname (Tailscale,
  arbitrary public DNS) must set `GINI_TRUSTED_ORIGINS` to the list of
  hostnames they expect to be reached from. Without it, the guard
  refuses every privileged POST.
- A typo in `GINI_TRUSTED_ORIGINS` is loud (every request 403s)
  rather than silent (downgrade to rebindable fallback). The fail-closed
  posture is the defense-in-depth default for a CSRF-style control.
- The env var is read on every request. The parse cost is negligible
  (short comma-separated string) and the request shape isn't a hot path,
  so the simpler dynamic semantics win over a cached constant.
- The BFF guard runs on every `/api/runtime/*` request — readable GETs
  (which leak RuntimeState contents under DNS rebinding) and mutating
  POST/PUT/PATCH/DELETEs alike. The gateway's route table is the
  dispatch source of truth; the BFF guard is a single chokepoint that
  validates Origin/Host before injecting the bearer, regardless of
  which gateway route a request targets.

## Gateway reverse-proxy interaction

The gateway fronts the BFF as a single origin (ADR
[gateway-web-reverse-proxy.md](./gateway-web-reverse-proxy.md)) and is the
authoritative trust front. For every web-bound request (non-`/api` and
`/api/runtime/*`) the gateway runs the host/origin guard
(`webBoundRequestAllowed` in `src/lib/origin-trust.ts`) — the loopback /
gini-relay / `GINI_TRUSTED_ORIGINS` lanes plus the `Sec-Fetch-Site` check — and
only then reverse-proxies to the Next.js BFF, rewriting `Host` and `Origin` to
loopback on the way. The BFF therefore always sees an internal loopback request:
it keeps its own loopback/allowlist guard as defense-in-depth for direct access
to the Next.js port (with a loopback short-circuit for the gateway's normalized
traffic) but needs no relay awareness. The bearer boundary is preserved: the
gateway hands `/api/runtime/*` to the BFF rather than answering it natively, so
token injection remains the BFF's job and the browser still never sees the
token.

The operational knob is the same as direct exposure, now enforced at the
gateway: if the gateway is exposed on a non-loopback, non-relay hostname (the
tailnet/public case), the gateway guard fails closed unless
`GINI_TRUSTED_ORIGINS` includes the gateway's external origin. The relay lane is
the only auto-trusted non-loopback case, because the relay owns its DNS.

## Alternatives considered

- **Host-equality with no allowlist.** This was the previous behavior;
  it does not survive DNS rebinding when the BFF is exposed beyond
  loopback. Rejected.
- **Strict `Origin === request.url.origin`.** This was the original
  behavior; it broke every legitimate non-localhost dev flow because
  Next.js dev carries a stale internal hostname. Rejected.
- **CSRF tokens (double-submit cookie or synchronizer pattern).**
  Stronger but introduces a token lifecycle the BFF doesn't otherwise
  need, and the operator's authenticated browser already shares a
  same-origin policy with the BFF when the allowlist is honored. The
  origin allowlist matches the local-first, single-operator threat
  model without a new token surface to manage.
- **Bind the BFF to loopback always, force tunnel/exposure operators
  to put a reverse proxy in front.** Pushes the trust boundary onto a
  proxy the operator may not have, and doesn't actually close
  rebinding on the proxy hop. Rejected.

## Acceptance Checks

- Privileged POSTs with cross-origin `Origin` and loopback `Host`
  return 403.
- Privileged POSTs from a tailnet hostname without
  `GINI_TRUSTED_ORIGINS` return 403.
- Privileged POSTs from a tailnet hostname with the hostname in
  `GINI_TRUSTED_ORIGINS` return 200 and forward the bearer.
- `GINI_TRUSTED_ORIGINS` set to garbage (no parseable origins) refuses
  every privileged POST.
- The same-origin loopback case (`Origin: http://localhost`,
  `Host: localhost`) passes whether the env var is set (and matches)
  or unset.
- At the **gateway front**, a web-bound request whose `Origin`/`Host` is a
  relay subdomain (`<subdomain>.<relayDomain>`) passes with
  `GINI_TRUSTED_ORIGINS` unset, while a non-relay, non-loopback `Host` without
  `GINI_TRUSTED_ORIGINS` returns 404 (page) / 403 (`/api/runtime/*`).
- The gateway guard's `GINI_TRUSTED_ORIGINS` / loopback / relay / Origin-match
  / `Sec-Fetch-Site` cases are pinned by `src/lib/origin-trust.test.ts`
  (`webBoundRequestAllowed`), and the gate + `Host`/`Origin` rewrite by
  `src/http.test.ts`. The inner BFF guard (loopback + allowlist + loopback
  short-circuit, relay-agnostic) is pinned by `web/src/lib/runtime.test.ts`
  (`guardCsrf`) and `web/src/proxy.test.ts` (`classifyHost`), with pure-helper
  coverage in `web/src/lib/trusted-origins.test.ts`.
