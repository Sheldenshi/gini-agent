# ADR: Device-Pairing Authentication (Loopback-Trusted, Relay-Gated)

## Decision

A web request reaching the gateway on a **loopback** host
(`127.0.0.1` / `localhost` / `[::1]`) is trusted with no pairing — it is the
operator's own machine. A web request on any **non-loopback** front (the
gini-relay tunnel subdomain, or a `GINI_TRUSTED_ORIGINS` host) must carry a
valid **session cookie** (`gini_session`) or it cannot reach the proxied web app
or the `/api/runtime/*` BFF namespace. A device obtains that cookie through an
operator-approved pairing handshake.

This adds one gate to the single front (the gateway, see
[gateway-web-reverse-proxy.md](gateway-web-reverse-proxy.md)): after the
host/origin/CSRF check (`webBoundRequestAllowed`, see
[bff-trust-boundary.md](bff-trust-boundary.md)) and before `proxyWeb`, a
non-loopback web request must resolve a `gini_session` cookie to an active
session. The native bearer-gated `/api/*` surface (CLI, mobile app) is
unchanged.

### The handshake

The flow inverts the existing operator-generates-a-code / device-claims-by-code
mobile pairing: here the **device initiates** and the **operator approves**.

1. An unpaired relay device hits any page → the gateway redirects the page
   navigation to `/pair` (the `/api/runtime/*` BFF namespace 401s instead).
2. `/pair` POSTs `/api/pairing/request` → the gateway mints a `PairingRequest`
   with a 6-digit display `code`, returns `{ id, code }`, and sets an HttpOnly
   binding cookie `gini_pair`. The page shows the code + a spinner and polls
   `GET /api/pairing/request/:id`.
3. An admin's "Pair requests" panel (loopback OR a paired relay session) lists
   pending requests (`GET /api/pairing/requests`, admin: loopback OR a valid
   `gini_session`) and shows the same `code`. The admin **visually compares** the
   code, then approves (`POST /api/pairing/requests/:id/approve`, admin: loopback
   OR a valid `gini_session`).
4. The device's next poll sees `approved` and POSTs
   `/api/pairing/request/:id/claim` (binding cookie required). The gateway mints
   a `PairedDevice` session, returns `Set-Cookie: gini_session=<token>`, clears
   `gini_pair`, and the page reloads into the app — now authenticated.

Reject / cancel flip the request status; both ends converge on the next poll. A
content-free `kind: "pairing"` runtime event (`appendEvent`) nudges the operator
panel to refetch the request list over SSE; the panel also polls as a backstop.

### The session IS a `PairedDevice`

A relay browser session is a `PairedDevice` row (`state.devices`,
`src/state/records.ts`), the same revocable, hashed-token credential the
code-claim mobile flow mints. The `gini_session` cookie value is the device
token. The relay cookie gate validates it via `findActiveSessionByToken`
(`resolveSessionFromCookie`); presented as a `Bearer`, the same token resolves via
`findActiveDeviceByToken` (`resolveCredentialFromBearer`). Both match the same
hashed `tokenHash` in `state.devices` and require `status: "active"`. Consequence:
**one revocation switch** — `revokeDevice` (POST `/api/devices/:id/revoke`) flips
that row to `revoked`, so both the cookie session and any bearer use of that token
fail on the next request, with no separate session blocklist. Browser sessions carry an `origin` (the relay host),
`userAgent`, and a finite `expiresAt`; the read-only validator treats a past
`expiresAt` as inactive even while `status` is still `active`.

Pending requests live in a new `state.pairingRequests` array (lazily expired,
mirroring `pairingCodes`). The display `code` is stored in plaintext on purpose:
it is a human-comparison artifact shown on both the device and the operator
panel, not a secret to be entered — the credential is the cookie minted on
claim, which is hashed.

## Trust tiers of the pairing routes

The device-pairing routes live on the native `/api/pairing/*` surface and are
special-cased inside `handlePairingRoutes` **before** the bearer gate, so each
enforces its own rule from the **true inbound Host/Origin** (the gateway sees the
real first hop). The two legacy *code* routes are gated differently — see the
notes under the table.

| Method | Path | Auth |
|---|---|---|
| POST | `/api/pairing/request` | Public, rate-limited; sets `gini_pair` |
| GET | `/api/pairing/request/:id` | Public, `gini_pair` required |
| POST | `/api/pairing/request/:id/claim` | Public, `gini_pair`-bound; sets `gini_session` |
| POST | `/api/pairing/request/:id/cancel` | Public, `gini_pair`-bound |
| GET | `/api/pairing/requests` | Admin (loopback Host OR `gini_session`; see "Relay sessions mirror loopback") |
| POST | `/api/pairing/requests/:id/approve` | Admin (loopback Host OR `gini_session`) |
| POST | `/api/pairing/requests/:id/reject` | Admin (loopback Host OR `gini_session`) |
| POST | `/api/pairing` (legacy code create) | Bearer (native owner-bearer `authorized()` gate); a paired session reaches it via the BFF |
| POST | `/api/pairing/claim` (legacy code claim) | Public, rate-limited (brute-force throttle) |

The "Admin" rows are the loopback-OR-`gini_session` mirror gate enforced in
`handlePairingRoutes`; the legacy *create* row is **not** that gate — it is an
ordinary owner-bearer route reached *after* the bearer gate (a paired session
hits it through the BFF's server-side owner bearer, hence the converging
outcome). Only the device-pairing routes (`request`, `request/:id*`,
`requests*`) additionally pass through `webBoundRequestAllowed` for
host/origin/CSRF trust; the two legacy routes do not (`POST /api/pairing` is
bearer-gated, `POST /api/pairing/claim` is public + rate-limited only). The WS
upgrade path (`src/server.ts`) mirrors the same relay session gate.

The device rows above describe the **browser** client. A **verified native
client** (the mobile app) reaches the same `request`/`request/:id*` routes
cookielessly — binding secret via `X-Gini-Pair-Secret`, exempt from the no-Origin
CSRF refusal, token returned in the claim body — gated by `isNativePairingClient`.
See "Native pairing client (mobile app)" below.

## Relay sessions mirror loopback (DELIBERATE — do not "harden" this away)

**A paired relay session is a full mirror of the local `127.0.0.1` operator.**
The ONLY difference between the relay front and loopback is the *initial
connection*: a relay device must complete the pairing handshake (and carry a
valid `gini_session`) to be admitted. After that, a paired relay session has the
**exact same admin capabilities as loopback**, including:

- Viewing the live "Pair requests" list and **approving / rejecting** new
  devices — the relay browser you paired earlier can add a third browser, just
  like `127.0.0.1` can.
- Creating legacy pairing codes (`POST /api/pairing`) for mobile/CLI devices.
- Using its `gini_session` token as a credential (it is a full `PairedDevice`).

This is intentional and load-bearing: **logged in == admin, and admins can add
other devices.** Do NOT add gateway blocks, `isLoopbackHost` narrowing, or
BFF-namespace refusals that make a *paired* relay session less capable than
loopback. The trust anchor is the pairing handshake itself: an *un*paired relay
visitor has no session, is redirected to `/pair`, and can only run the device
handshake (request/poll/claim) — it can never reach the admin routes.

**Mechanism.** The whole pairing API is called **same-origin on the native
`/api/pairing/*` surface** (never the bearer-injecting `/api/runtime` BFF). The
admin routes (`GET /api/pairing/requests`, `POST /api/pairing/requests/:id/{approve,reject}`)
are gated inside `handlePairingRoutes` by **loopback Host OR a valid `gini_session`
cookie** — not loopback alone. A relay browser's same-origin admin call carries
both a relay Origin (so `webBoundRequestAllowed` enforces the relay-Origin ==
relay-Host CSRF rule) and the HttpOnly `gini_session` cookie that the route
validates, so a paired relay session is admin exactly like loopback. An unpaired
relay visitor has neither loopback Host nor a session, so it is refused (403).
The device handshake routes (`/api/pairing/request*`) are public and `gini_pair`-bound
for the unpaired device.
Legacy code creation (`POST /api/pairing`) is bearer-gated and is reached through
the BFF (owner bearer), so any paired session can create codes.

**Loopback dev-port bridge (`web/src/app/api/pairing/[...path]`).** In the
gateway-fronted topology the browser is always on the gateway origin, so its
same-origin `/api/pairing/*` calls reach the gateway natively and this BFF route
never fires. But the inner Next dev server binds its own loopback port, and a page
loaded from THAT origin sends its `/api/pairing` fetches to Next — which has no
pairing route — so they 404 and the operator's approve/reject panel renders an
empty queue. `web/src/lib/pairing-proxy.ts` bridges that gap for **loopback only**:
it forwards `/api/pairing/*` to the gateway behind the same `guardCsrf` the
`/api/runtime` lane uses, carrying the browser's `gini_pair` / `gini_session`
cookies (NOT a bearer — the browser must never hold the gateway token) and a
loopback `Origin`, so the gateway's `webBoundRequestAllowed` + loopback admin gate
resolve exactly as for a direct loopback browser (this loopback `Origin` is what
makes the approve/reject POSTs work — the obstacle that previously kept admin
calls off the BFF). A non-loopback Host is refused (404), so pairing stays
gateway-native and `loopback`-OR-`gini_session`-gated for every relay/remote
front: the mirror gate below is unchanged, and the bridge grants no session-less
admin to anything but the operator's own loopback dev port.

> **Design invariant (intentional, not a gap).** A paired session — loopback OR
> relay — is owner-equivalent. It can approve/reject/list pairing requests, create
> pairing codes, and use its `gini_session` token as a credential. These are
> deliberate consequences of the mirror model, **not** privilege escalations, and
> must not be "hardened" away. The sole trust anchor is the pairing handshake: an
> UNPAIRED relay visitor (no session) is refused.

## Cookie handling

- `gini_session`: value is a `gini_device_<uuid>` token; only `hashSecret(token)`
  persists. `HttpOnly; SameSite=Lax; Path=/`, `Domain` unset (host-only to the
  exact relay subdomain), finite `Max-Age`. HttpOnly because the web app
  authenticates `/api/runtime/*` via the BFF's server-side bearer — the cookie is
  purely the gateway's relay gate, never read by JS. On a **secure** front it is
  issued under the **`__Host-` prefix** (`__Host-gini_session`); the gate reads
  `__Host-gini_session` first and falls back to the plain name. `__Host-` forbids
  a `Domain` attribute, so on the shared relay registrable domain a sibling tenant
  cannot toss a `Domain=.gini-relay…` cookie of the same name to override (deny) a
  victim's session — the browser rejects the sibling's prefixed-with-Domain cookie
  and the victim's host-only one always wins. The prefix is conditional because
  `__Host-` mandates `Secure`, which the plain-HTTP `GINI_TRUSTED_ORIGINS` front
  (below) can't use, so that front keeps the plain name. `gini_pair` stays plain:
  it is single-use, cleared on claim, and `Path=/api/pairing` (incompatible with
  `__Host-`'s `Path=/`), and `gini_session` is the durable owner-equivalent
  credential and the high-value tossing target.
- `gini_pair`: per-request binding secret, `HttpOnly; SameSite=Lax;
  Path=/api/pairing`. Only the browser that created a request holds it, so a
  third party that learns a request id can neither claim its session nor cancel
  it. Cleared on claim/cancel.
- `Secure` is conditional (`pairingCookieSecure`): set on relay (always HTTPS)
  and loopback fronts and any HTTPS request, and omitted only on a deliberately
  plain-HTTP `GINI_TRUSTED_ORIGINS` front — where a `Secure` cookie would be
  silently dropped by the browser and the whole connection is already cleartext
  by the operator's transport choice. Use HTTPS for any remote front.

## Native pairing client (mobile app)

The mobile app runs the SAME device handshake (`request` → poll → `claim`) but
is not a browser, which breaks two browser assumptions:

1. **No cookie jar.** It can't reliably hold the HttpOnly `gini_pair` binding
   cookie, and it can't read the `gini_session` token out of `Set-Cookie` (the
   claim's whole point on the web).
2. **No `Origin`.** React Native fetch sends no `Origin`, so
   `webBoundRequestAllowed` — which refuses no-Origin *unsafe* requests — would
   403 its `POST`s.

A **verified native client** is therefore exempted, gated by
`isNativePairingClient(request, host)`:

- the explicit opt-in header `X-Gini-Pair-Client: native`, **and**
- the **absence of every `Sec-Fetch-*` header**, **and**
- the **absence of an `Origin` header**, **and**
- a trusted front (relay or loopback Host).

`Sec-Fetch-*` absence is the primary anchor: modern browsers always send those on
`fetch`/XHR and page JS **cannot set or strip them** (forbidden header names), so
their absence cannot be forged from a current browser. But Fetch Metadata only
shipped in Safari 16.4 (March 2023), so a pre-16.4 Safari or an iOS-15
WKWebView/SFSafariViewController sends NO `Sec-Fetch-*` yet still sends `Origin`
on an unsafe POST (Origin-on-same-origin-POST predates Fetch Metadata by years).
Requiring `Origin` to also be absent closes that gap: every such browser emits
`Origin`, while the native client (Expo/React Native fetch, which sets no
`Origin`) does not — so an XSS on `/pair` in any browser, old or new, can never
make the gateway treat the page as native and leak the in-body secret/token. The
opt-in header is the explicit-intent signal. Together this predicate authorises
all three native deviations:

- **CSRF exemption.** A native (no-Origin) `POST` to the device routes is allowed
  even though `webBoundRequestAllowed` returns false — a non-browser is not a
  confused deputy. Browsers still go through the full gate, and the admin routes
  still re-validate the session, so this never widens admin reach.
- **Binding secret in the body + header.** `POST /api/pairing/request` returns the
  `bindSecret` in the JSON body for a native client and sets **no** `gini_pair`
  cookie for it (browsers get it only as the HttpOnly cookie). The client echoes
  it back as `X-Gini-Pair-Secret` on poll/claim/cancel; `pairBindSecret` reads the
  secret by the same single gate — **header only** for native, **cookie only** for
  a browser — so the browser path is byte-for-byte unchanged. Header-only for
  native is deliberate: iOS NSURLSession auto-attaches any persisted `gini_pair`,
  and a cookie-first read could prefer a stale cookie over the fresh header secret
  (an intermittent `bind_mismatch`); making native cookieless removes that hazard.
- **Session token in the claim body.** `POST …/claim` returns
  `{ ok: true, token }` for a native client — the same `gini_device_<uuid>` token
  the cookie would carry, just the transport a non-browser needs. The client
  stores it and sends it as `Authorization: Bearer` on every later call. It sets
  **no** session cookie for native (the body token is the only credential); an iOS
  cookie jar would otherwise persist a `__Host-gini_session` the client never
  reads and that the app's sign-out can't clear. The browser claim body stays
  `{ ok: true }` with the token delivered cookie-only, so an XSS can't exfiltrate it.

Post-pairing needs no new gate: `isWebProxyPath` routes `/api/chat`,
`/api/agents`, etc. to the native bearer surface, so the stored device token
authenticates over the relay exactly like the CLI's owner bearer — only the
initial handshake is relay-aware.

### Universal-link entry (open the app from the relay link)

So that a tap on `https://<sub>.gini-relay.lilaclabs.ai` opens the app (not
mobile Safari), the gateway serves an **Apple App Site Association** file at
`GET /.well-known/apple-app-site-association` — public, reachable unpaired, no
redirect — claiming the bare origin + `/pair*` for the app
(`WB6Y3K67AB.ai.lilaclabs.gini.mobile`, overridable via `GINI_IOS_APP_ID`). The
app declares `applinks:*.gini-relay.lilaclabs.ai`. A **wildcard** associated
domain is validated by Apple **per subdomain**, not at the apex, so the gateway —
which serves each relay subdomain through the tunnel — is the correct AASA host
(the relay control plane at the apex is not). `app/+native-intent.tsx` rewrites
the incoming relay URL to `/pair?relay=<origin>` (the host identifies which
gateway; the link's own path is irrelevant); the pair screen then runs the
native handshake above.

> **Operational caveat.** Universal links resolve through Apple's CDN, which
> fetches and caches the per-subdomain AASA. A relay subdomain only serves while
> the operator's tunnel is up, so a first tap can lag CDN propagation. The in-app
> entry (paste the link on the pair screen) is the always-available fallback and
> the surface RN-Web tests exercise; the universal-link open itself is verified on
> a device build.

## Context

The gateway reverse-proxies the web app as a single relay-facing front, but
before this change that front had **no per-user auth**: any request that passed
the host/origin trust check reached the full app and the bearer-injecting BFF.
"Loopback is trusted, the public URL needs pairing" is the local-first,
single-operator model — the operator's machine is the root of trust and grants
remote devices access interactively, one comparison at a time.

`/pair` is a pre-auth entry point and must render regardless of provider-setup
state and without the authenticated app shell: the web setup-gate
(`web/src/proxy.ts`) exempts `/pair` (otherwise an unpaired device loops
`/pair → /setup` while the gateway loops `/setup → /pair`), and a client shell
wrapper (`web/src/components/AppShell.tsx`) plus a gated `RuntimeStreamBridge`
keep the app's authenticated `/api/runtime/*` queries (which would 401) off the
pairing screen.

## Consequences

- Local use is unchanged: loopback is never asked for a cookie.
- Remote access requires an explicit, per-device, human-approved step. Sessions
  are listed (device label, front, last-seen) and individually revocable in the
  Active Sessions UI.
- `GINI_TRUSTED_ORIGINS` hosts are treated as non-loopback and therefore require
  pairing too — the most conservative reading of "any remote front pairs."
- The operator must compare the displayed code before approving (see pitfalls).

## Security pitfalls addressed

- **Concurrent-attacker approval.** An attacker who knows the relay URL can
  create a competing pending request. The display code, shown identically on the
  device and the operator panel with an explicit "approve only if this code
  matches" warning, forces the operator to approve the device in front of them,
  not the attacker's row. The panel renders every pending request so the
  comparison is unavoidable.
- **Request-hijack.** Poll/claim/cancel are bound to the `gini_pair` cookie, so a
  known request id alone cannot steal a freshly-approved session.
- **Unpaired self-approval.** The admin routes (native same-origin
  `/api/pairing/*`) are gated by loopback OR a valid `gini_session` (see "Relay
  sessions mirror loopback"). An UNPAIRED relay visitor has no `gini_session` and
  a non-loopback Host, so `handlePairingRoutes` refuses it (403) — it can never
  approve itself in. (A *paired* session approving another device is intended
  admin behavior, not a bypass.)
- **Broadcast leakage.** The `pairing` SSE event is a content-free tick; codes
  travel only to an admin over the admin-only request list, tokens only in
  `Set-Cookie`.
- **Flooding.** `POST /api/pairing/request` is rate-limited (in-process token
  bucket) with a cap on concurrent pending requests.

## Acceptance Checks

- Unpaired relay page navigation → 302 `/pair`; unpaired relay `/api/runtime/*`
  → 401; loopback web requests are never gated.
- Create → operator list shows the matching code → approve → device claim sets
  `gini_session` → the same relay session reaches the app (no 302) and
  `/api/runtime/*` (200).
- The admin routes over the relay front: an UNPAIRED visitor (no `gini_session`)
  is refused (403), while a PAIRED relay session reaches them same-origin on
  `/api/pairing/*` and succeeds — the deliberate mirror of loopback (a paired
  session can approve/add devices exactly like 127.0.0.1).
- `revokeDevice` on a session immediately 302s its pages and 401s its API on the
  next request (unified revocation).
- `/pair` renders with provider setup incomplete and emits no authenticated
  `/api/runtime/*` calls.
- A native client (opt-in header, no `Sec-Fetch-*`) creates with no `Origin`
  (201 + `bindSecret` in the body), polls/claims with `X-Gini-Pair-Secret`, and
  the claim returns the token in the body; that token authenticates a subsequent
  `Authorization: Bearer` call over the relay. A browser that also sends the
  opt-in header (but carries `Sec-Fetch-*`) still gets the cookie-only claim with
  no body token.
- `GET /.well-known/apple-app-site-association` returns the AASA JSON (with the
  configured app id) unpaired on both relay and loopback fronts, with no redirect.
- State mutators are pinned by `src/state/pairing-requests.test.ts`; the routes,
  gate, cookies, loopback enforcement, native-client path, AASA, and rate limiter
  by `src/http-pairing.test.ts`; the governance wrappers by
  `src/governance/pairing-requests.test.ts`; cookie + rate-limit helpers by
  `src/lib/cookies.test.ts` and `src/lib/rate-limit.test.ts`; the `/pair`
  setup-gate exemption by `web/src/proxy.test.ts`. On the mobile side, the native
  handshake client is pinned by `mobile/src/pairing.test.ts` and the universal-link
  rewrite by `mobile/src/relay-link.test.ts`.
