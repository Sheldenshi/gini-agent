# Cloudflare Quick Tunnel With Secret-Path Auth And iCloud Notes Mirror

## Status

Accepted.

## Context

The localhost gateway is the system of record for an instance. The Next.js
control plane and the CLI talk to it through `/api/*` using a bearer token,
and paired devices receive a longer-lived token through the pairing flow.
Both auth paths assume the caller is on the same machine, or otherwise
already holds a credential.

There is a separate, more casual access shape we wanted to support: the
operator wants to hit `/api/*` from their phone, browser, or some other
device on a different network without setting up DNS, NAT, or a proper
Cloudflare account. The operator already has cloudflared on PATH and is
comfortable with the URL itself being the credential — same trust model as
a magic link, scoped to the lifetime of the runtime process.

The constraint is that Cloudflare quick tunnels produce a fresh
`https://*.trycloudflare.com` hostname on every restart, so any access
shape that depends on memorising the URL breaks at the next reboot.

## Decision

1. The runtime spawns `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`
   as a managed subprocess when `tunnel.enabled` is true (or
   `GINI_TUNNEL=1` is set on the boot environment). The subprocess
   lifetime matches the gateway lifetime exactly: it's started after
   `Bun.serve` returns, and torn down inside the SIGTERM drain alongside
   the scheduler, the browser sessions, and the messaging supervisors.

2. The cloudflared stderr banner is parsed to obtain the public URL. The
   manager keeps that URL in an in-memory snapshot exposed over
   `/api/tunnel`. The snapshot is intentionally not persisted — every
   restart produces a fresh hostname and we want the snapshot to reflect
   reality, not stale state.

3. Authorization for tunneled requests is by URL prefix. The runtime
   mints (and persists) a 192-bit, 32-character base64url secret per
   instance. A request whose pathname begins with `/<secret>/` is treated
   as fully authorized; the prefix is stripped before the request reaches
   the regular API router. The secret is stable across restarts so a URL
   prefix the operator bookmarks or pastes into a note keeps working.

4. The bearer-token gate stays the only authorization path for direct
   localhost requests. Tunneled requests cannot reach `/api/pairing/claim`
   without going through the secret-path strip; bearer-tokened requests
   without the secret keep working unchanged.

5. The gateway exposes three additional routes that are reachable through
   either the bearer-token path or the tunnel path:
   - `GET /api/tunnel` returns the snapshot (current public URL + secret
     + Apple Notes mirror status + last error).
   - `GET /api/tunnel/qr.svg` returns an SVG QR code for the current
     public URL. 404 when the snapshot has no URL.
   - `GET /api/tunnel/qr.txt` returns an ANSI half-block QR for terminal
     rendering. 404 when the snapshot has no URL.

6. When the runtime is on macOS and the iCloud account is signed in
   under Notes.app, the manager mirrors the current tunnel URL into a
   dedicated note. The note lives in a top-level folder (default `gini`)
   inside the iCloud account, named `gini-tunnel-<instance>`. The
   manager creates the folder + note on first use and overwrites the
   body on every subsequent URL change, so the operator's iPhone sees
   the latest URL within iCloud's normal sync latency without ever
   needing to scan a fresh QR. The note write happens via `osascript`
   driving a small AppleScript that runs entirely against
   `tell application "Notes"` — no third-party dependency.

7. The osascript runner enforces a 15-second hard timeout and SIGKILLs
   the child on overrun. macOS prompts for Automation permission the
   first time a process scripts Notes.app, and the prompt can be
   deferred on processes without an active UI session (e.g. when the
   runtime is launchd-managed). The timeout guarantees that a pending
   prompt never hangs the snapshot — the failure surfaces as a normal
   `lastError` field instead.

## Trust model

- **Localhost bearer token**: unchanged. Still the only way to reach
  `/api/pairing/claim` and the only way for direct callers.
- **Tunnel secret-path**: same surface area as the bearer-token path
  except for `/api/pairing/claim` (which is intentionally
  secret-path-reachable so the operator can pair a phone through the
  tunnel without holding the bearer token first; see point 4). Anyone
  in possession of the URL has full operator-level access until the
  next restart.
- **No password auth**: by design. The URL is the credential. The secret
  is generated with `crypto.getRandomValues(24 bytes)` — 192 bits of
  entropy — so an attacker cannot guess the path without already knowing
  the trycloudflare hostname, which itself rotates every restart.
- **URL leak window**: cloudflared rotates the hostname on every
  gateway restart. A leaked URL therefore only grants access until the
  next reboot. Operators who need to invalidate the secret immediately
  can run `gini tunnel rotate-secret` and restart.

## Apple Notes permission flow

The first time a process invokes `osascript` against Notes.app, macOS
fires a Transparency, Consent, and Control (TCC) prompt asking the user
to allow Automation. The grant is keyed on the parent process executable
path, not the user account, so a grant for Terminal-launched osascript
does not transfer to the Bun-managed runtime and vice versa.

For a Bun runtime started under launchd or a tmux pane, the TCC prompt
fires but may not be visible until the user opens System Settings →
Privacy & Security → Automation. The runtime never blocks waiting for
the prompt:

1. Manager fires the osascript subprocess as a fire-and-forget refresh.
2. The osascript runner kills the child after 15 seconds.
3. The snapshot's `appleNotes.lastError` is set to the timeout/denial
   message; the rest of the snapshot stays valid and the public URL is
   still served unchanged.
4. The operator can grant the permission manually and trigger a
   re-sync by hitting `GET /api/tunnel` (or by restarting the runtime).

## Consequences

- **One new dependency**: requires `cloudflared` on PATH. The runtime
  degrades silently when the binary is missing — tunnel snapshot stays
  empty, gateway keeps working over bearer-token localhost.
- **One new persisted field**: `config.json` gains
  `tunnel: { enabled, secret, appleNotes }`. Existing config files
  without a `tunnel` key receive a freshly generated secret on first
  boot; `enabled` stays false until the operator opts in. The persistence
  step is best-effort — a failed write logs `tunnel.secret.persist.error`
  and continues with the in-memory secret.
- **No browser-token leak**: the secret-path strip happens at the
  runtime gateway, not the Next.js BFF. The browser-side bundle never
  sees the secret — same boundary as the existing bearer-token contract.
- **CLI surface**: `gini tunnel status|qr|enable|disable|rotate-secret|sync-notes|apple-notes ...`
  exposes the snapshot, prints the ANSI QR, flips the persistent
  config, and rotates the secret.
- **Test surface**: dedicated unit tests cover the QR encoder
  (versions 1-10 byte mode, all eight masks, finder + format-info
  placement), the cloudflared stderr parser (banner + structured-log
  shape, EOF and timeout failure modes), the secret-path strip,
  the AppleScript builder (escaping, folder/note upsert), and the
  manager orchestrator (with injected spawner + osascript runner). The
  HTTP layer has an integration test that exercises the secret-path
  guard, the landing page, both QR endpoints, and the bearer-token
  path.

## Alternatives considered

- **Run cloudflared as a named tunnel** (with a stable hostname tied to
  a Cloudflare account). Better URL stability but requires the operator
  to set up a Cloudflare account; we deliberately picked the
  account-less quick-tunnel path so the feature works out of the box.
- **Bake the secret into a query string instead of the path**. The
  query string would leak into proxy logs more readily than a path,
  and the path form lets the landing page link references work without
  the secret leaking into the displayed URL.
- **Write the URL to iCloud Drive instead of Notes.app**. Avoids the
  TCC permission step entirely (writes under
  `~/Library/Mobile Documents/com~apple~CloudDocs/` need no grant), but
  the operator asked specifically for a Note in a folder that gets
  updated, not a file in Files.app. Left as a future-work option for
  hosts where the TCC prompt cannot be answered.
- **Push the URL through Telegram or Discord** as a bridge message.
  Already supported via the messaging surface; iCloud Notes was the
  asked-for "one-tap mirror" path.
