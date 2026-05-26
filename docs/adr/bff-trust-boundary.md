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

## Consequences

- Operators running the BFF on loopback (the default for `gini run`) get
  no behavioral change. Same-origin browser requests pass; cross-origin
  pages still see 403.
- Operators exposing the BFF on a non-loopback hostname (Tailscale,
  tunnel, public DNS) must set `GINI_TRUSTED_ORIGINS` to the list of
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
- `bun test src/integration.test.ts` pins all of the above.
