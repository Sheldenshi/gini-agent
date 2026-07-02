# ADR: Per-Agent Browser Domain Policy

## Decision

Each agent can carry a user-managed browsing boundary,
`AgentRecord.browserDomainPolicy?: { deny?: string[]; allow?: string[] }`,
enforced by the browser tool layer in `packages/runtime/src/tools/browser.ts`:

- `deny` — domains the agent's browser may never reach. Always checked
  first.
- `allow` — when non-empty, switches the agent to **allow-only** browsing:
  any host not matching an `allow` entry is refused. An empty or absent
  `allow` keeps the default open-web posture (deny list only).

Absent policy (or both lists empty) means no domain restrictions beyond
the always-on SSRF gate. Tasks with no owning agent (system-driven flows)
have no policy.

## Matching semantics

Entries are bare domains — no scheme, no ports, no wildcards, no regex. A
URL's host matches an entry when it equals the entry or is a subdomain of
it (`example.com` matches `sub.example.com` but not `notexample.com` or
`example.com.attacker.net`), case-insensitively, after the same host
normalization `safetyCheck` applies (IPv6 bracket strip, trailing root
dot strip, lowercase). Deny beats allow: a host matching both lists is
blocked.

## Enforcement points

`domainPolicyBlockReason(url, policy)` runs at both boundaries the SSRF
gate already guards:

1. **Navigate pre-flight** — `browser_navigate` and `browser_tabs`
   (action `"new"` with a `url`) refuse a policy-blocked URL before any
   browser work, alongside `safetyCheck`.
2. **Post-redirect / live-page re-validation** — `browser_navigate`'s
   final-URL check and `disallowedOriginReason()` (the shared origin
   boundary consulted by the snapshot boundary, `browser_console`, and
   `browser_vision`) re-check the page's settled URL, so a redirect
   chain, JS navigation, meta-refresh, or link click that lands on a
   blocked domain is bounced to `about:blank` the same way a loopback
   landing is.

Ordering: the SSRF/loopback gate (`safetyCheck`) always runs first and
cannot be overridden — `allow: ["localhost"]` does not open the loopback
control plane. The failure message names the blocked host and that the
agent's domain policy blocked it (nothing here is secret), so the model
can stop instead of retrying.

The policy reaches the browser layer through the same channel as the CDP
connection record: the tool resolves the task's owning agent from
instance state (`readState(runtimeInstance)` → task `agentId` →
`AgentRecord.browserDomainPolicy`) per check. A failed state read or an
unregistered instance degrades to "no policy"; the SSRF gate still
applies.

## Out of scope

- **CLI / web UI surface.** The policy is user-managed by editing the
  agent record (instance `state.json`) directly. A settings surface can
  come later without changing the enforcement contract.
- **Wildcard / regex patterns and per-path rules.** Suffix-on-domain
  matching keeps the semantics predictable and unspoofable.
- **Egress enforcement for non-browser tools.** `web_fetch` / `web_search`
  have their own guards; this ADR covers only the controlled browser.

## Acceptance Checks

- An agent with `deny: ["tracker.evil"]`: `browser_navigate` to
  `https://sub.tracker.evil/...` fails pre-flight naming the host; a page
  that settles on the domain after a redirect is bounced to `about:blank`
  at the next origin-boundary check.
- An agent with non-empty `allow`: hosts outside the list are refused
  with an allow-only message; `allow` entries cannot unblock anything
  `safetyCheck` refuses (loopback, metadata, link-local).
- A host on both lists is blocked (deny beats allow).
- Tasks without an `agentId`, and instances where the state read fails,
  browse without domain restrictions but still behind the SSRF gate.
- `packages/runtime/src/tools/browser.test.ts` covers the matching semantics (exact,
  subdomain, case-insensitivity, boundary-not-substring, allow-only,
  deny-beats-allow) and both enforcement points without launching a real
  browser.
