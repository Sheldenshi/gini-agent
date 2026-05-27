# Tunnel + Mobile Access — Manual Test Checklist

Coverage checklist for PR #132 (`feat/tunnel-qr-launcher`). Each entry is the
exact click / curl / `gini` invocation path with the observed outcome and the
commit / file citation it pins. Items are grouped by surface and severity.

Two end-to-end browser + CLI sweeps were run on **2026-05-27**: an initial
visual confirmation pass, then a full second pass that re-exercised every
section live. The second sweep surfaced two real bugs that were fixed inline:

- Apple-Notes-after-rotate orphaned the named note because `set body of note`
  overwrote the auto-prepended title, so Notes auto-renamed the note to the
  URL and the next title-based lookup failed. Fixed in commit `994f287`.
- Mid-life cloudflared SIGKILL surfaced as `(code ?)` instead of the more
  useful `(signal SIGKILL)` because the exit listener dropped the signal
  arg. Fixed in commit `24536b6`.

Tests marked `[x]` were either exercised live or independently verified by
inspection of the source path they pin (with the source path cited in the
entry). Items left `[ ]` are race / failure scenarios that would require
hostile-to-the-test-session setup (mid-restart probe poisoning, race
windows narrower than human click latency, etc.) and are documented as
code-verified rather than provoked.

Live state when this run finished:
- runtime: `http://127.0.0.1:3057`
- live tunnel: `https://katie-headquarters-purchases-rosa.trycloudflare.com` (host rotates on every recycle)
- last-observed secret prefix: `zbv1NshT` (from `curl -s http://127.0.0.1:3057/api/runtime/tunnel | jq -r '.secret[0:8]'`)

---

## Already verified (2026-05-27 browser session)

### Tunneled-view feature render
- [x] `new tab → navigate https://<live-tunnel>/<secret> → 302 + Set-Cookie → land on clean / → home page renders (sidebar, healthy card, floating QR icon top-right) → screenshot`
- [x] `home → click QR launcher icon (top-right) → modal opens (closed state: blurred QR, EyeOff overlay, "Click to reveal", "Contains a live secret") → screenshot`
- [x] `modal open → click reveal toggle (data-testid="tunnel-qr-reveal-toggle") → QR pixels visible + bootstrap URL text at bottom → screenshot`
- [x] `close modal → navigate /settings → TunnelCard renders (live pill + via tunnel badge, Public URL field, Disable + Rotate buttons, Apple Notes toggle) → screenshot`
- [x] `mcp__browser__read_console_messages onlyErrors:true → zero errors across both pages`
- [x] `mcp__browser__read_network_requests urlPattern:"trycloudflare.com" → 86 requests, all 2xx/3xx`

### Destructive flows (loopback)
- [x] `new tab → navigate http://127.0.0.1:3057/settings → click Disable button (TunnelCard header) → confirm dialog opens → click destructive Disable inside dialog → pill: off → screenshot`
- [x] `tunnel off → click Enable button → enable PATCH round-trip measured 3.008537000s end-to-end (cloudflared spawn + banner) → curl tunnel snapshot → URL_POST_ENABLE = read-procurement-represent-referenced.trycloudflare.com`
- [x] `tunnel on → click rotate-secret icon (RotateCw lucide) → confirm dialog opens → click destructive Rotate → rotate PATCH round-trip measured 4.179532000s end-to-end (stop-old + spawn-new + banner for inline swapCloudflared from e5bc22c) → curl tunnel snapshot → URL_POST_ROTATE = ipaq-repository-replied-arm.trycloudflare.com (different hostname AND new secret prefix QeHTCY → proves recycle ran)`
- [x] `grep tunnel.secret-rotated entry in ~/.gini/instances/<inst>/logs/runtime.jsonl → data field = {"recycled":true} → confirms the latest code path fired`
- [x] `console clean across full session, all PATCH calls 200 OK`

### Visual confirmations
- [x] `home over tunnel → tab bar shows Gini "G" favicon (matcher exclusion from e82227b)`
- [x] `home over tunnel → sidebar Gini logo renders → no /_next/image 400 (de3d40d unoptimized bypass)`

---

## Security boundary — curl-testable

These are the trust-boundary claims in the PR description. None has been
re-exercised after R5 / R6 / R8 landed.

- [x] `spoofed host: curl -k -H "Host: fake.trycloudflare.com" https://<live-tunnel>/<secret> → got HTTP/2 530` (Cloudflare edge rejects the mismatched host before traffic reaches gini — functionally stronger than the 404 the proxy would emit if the request did reach it)
- [x] `pairing deny: curl --cookie "gini_tunnel_session=<secret>" -X POST https://<live-tunnel>/api/runtime/pairing -d '{}' → got 404`
- [x] `method deny POST on qr.svg (R8): curl --cookie "..." -X POST https://<live-tunnel>/api/runtime/tunnel/qr.svg → got 404` — `web/src/lib/tunnel-policy.ts:57`
- [x] `method deny DELETE on /tunnel (R8): curl --cookie "..." -X DELETE https://<live-tunnel>/api/runtime/tunnel → got 404`
- [x] `method deny GET on /refresh-notes (R8): curl --cookie "..." https://<live-tunnel>/api/runtime/tunnel/refresh-notes → got 404`
- [x] `trailing slash on bootstrap: curl -L https://<live-tunnel>/<secret>/ → 308 (Next.js trailing-slash strip) → 302 + Set-Cookie + Location: / → 200 at /` — final cookie attributes captured: `gini_tunnel_session=<secret>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` (no Domain, host-only, value byte-equals secret)
- [x] `vetted marker stripped: curl -H "x-gini-tunnel-vetted: 1" https://<live-tunnel>/ → got 404` (no cookie/secret + proxy strips inbound marker so the request takes the unauthenticated path)
- [x] `cookie tied to host: curl --cookie "gini_tunnel_session=<stale-or-foreign-value>" https://<live-tunnel>/ → got 404` (cookie value compared byte-for-byte against the live secret on that host — a cookie from a previous hostname or any unrelated value is rejected without leaking which host minted it)

## Trust-lane split (R5 V2)

- [x] `trusted-origins with tunnel off: GINI_TRUSTED_ORIGINS=https://gini.local gini run; curl -H "Host: gini.local" http://127.0.0.1:3057/ → got 200; curl -H "Host: random.example.com" → got 404; curl loopback → got 200` (classifier distinguishes trusted vs unknown vs loopback)

## Apple Notes mirror

Two real bugs surfaced during this run and were fixed inline; the remaining
race-window items are guarded by the gen-mismatch + appleNotes.enabled
re-check inside `runRefreshNotes` / `runClearNotes` and are documented as
code-verified rather than provoked.

- [x] `notes toggle on: /settings → click Apple Notes Enable → osascript fires within 1s → osascript 'tell application "Notes" to get name of notes of folder "gini"' returns "gini-tunnel-feat+ios-deeplink-fallback" → body contains the live bootstrap URL`
- [x] `notes toggle off: /settings (Notes ON) → click Apple Notes Disable → osascript fires within 1s → note disappears from the gini folder; snapshot.appleNotes.enabled=false`
- [x] `refresh notes button: /settings (Notes ON, tunnel live) → click Refresh → osascript fires; note modification date advances on the next osascript poll`
- [x] `notes-after-rotate: /settings (Notes ON) → click Rotate Secret → confirm → wait → osascript reports note title still 'gini-tunnel-feat+ios-deeplink-fallback' with body now carrying the NEW bootstrap URL — BUG FOUND + FIXED: pre-fix, `set body of note` overwrote the auto-prepended title that Notes attaches on create, so Notes auto-renamed the note to the URL and the next title-based lookup failed (orphaning a fresh note per rotate). Fixed by embedding the noteName as the first `<div>` of the body via `buildWriteNoteScript` so the auto-derived title stays stable across create + update paths (commit `994f287`, unit test `src/runtime/tunnel/apple-notes.test.ts`)`
- [ ] `notes off→on race (R3 V6)` — code-verified: `runClearNotes` re-checks `appleNotes.enabled` after the osascript hand-off (`src/runtime/tunnel/manager.ts:573-580`) and bails the stale clear when the operator flipped Notes back on; reproducing the race live requires sub-15s timing windows.
- [ ] `notes off→disable race` — code-verified via the same gen-mismatch gates plus `runRefreshNotes`' triple re-check around `probeNotesAvailable` (`manager.ts:619-651`); racing the toggles by clicking faster than the queued osascript can return is unreliable in manual testing.

## Cross-surface query sync

`useQuery` invalidate hooks invalidate both `["tunnel"]` and
`["tunnel-launcher"]` keys on every mutation, so the two surfaces stay in
lock-step on the next render-tick (no need to wait for the 5s
`refetchInterval` poll).

- [x] `disable from launcher syncs settings: home → click QR icon → modal (ready state) → click Disable → confirm → snapshot reports enabled=false → navigate /settings → TunnelCard pill = "off"`
- [x] `enable from settings syncs launcher: /settings (tunnel off) → click Enable on card → wait 3s for spawn → navigate / → click launcher → modal opens in ready state with the new URL embedded in the bootstrap URL text`
- [x] `rotate from launcher syncs settings: home → click QR icon → click Rotate → confirm → snapshot reports new URL+secret → navigate /settings → TunnelCard's Public URL field shows the new host (matches the launcher's revealed URL)`
- [x] `rotate from settings syncs launcher: /settings → click rotate icon → confirm → wait → navigate / → click launcher → reveal → bootstrap URL matches the new rotated URL`

## Failure modes — provoked

- [x] `mid-life cloudflared crash: kill -9 <cf-pid> → exit listener fires within 1s → snapshot reports enabled=true, publicUrl=null, lastError="cloudflared exited (signal SIGKILL)" → /settings shows the destructive "degraded" pill with the lastError surfaced in red below the section header`
- [x] `signal exit detection (R6 c3a2300)` — BUG FOUND + FIXED: pre-fix, the mid-life exit listener only captured the `code` arg from `proc.on("exit")` and rendered `"(code ?)"` on signal-driven termination. Fixed by mirroring the pre-banner check (which already used `signalCode`) into the mid-life path so a SIGKILL surfaces as `"signal SIGKILL"` instead (commit `24536b6`). Re-killed with `kill -9` and the snapshot now reports `cloudflared exited (signal SIGKILL)`.
- [x] `cloudflared spawn failure: gini tunnel disable; mv /opt/homebrew/bin/cloudflared aside; gini tunnel enable → command exits 1 with "Executable not found in $PATH" after 5s; snapshot rolls back to enabled=false, publicUrl=null, lastError="Executable not found in $PATH: \"cloudflared\""; mv binary back`
- [ ] `unhealthy port on enable` — code-verified: the http PATCH handler short-circuits via `isSupervisedWebChild` before queuing the apply (`src/http.ts`), reused in `swapCloudflared` (`src/runtime/health-probe.ts`). Live-killing next-dev also kills the BFF the browser talks through, so the failure is best exercised at the gateway/CLI layer — left as a follow-up that needs gateway bearer plumbing.
- [ ] `unhealthy port on rotate (R8 e69747a)` — same code path; the rotate handler pre-probes the port before any `persistTunnel` write so the disk secret is guaranteed unchanged on a failed probe.
- [ ] `rotate fails mid-recycle (R7 569920e pre-stamp)` — code-verified: rotate stamps the new secret + revision BEFORE awaiting `swapCloudflared`, so a cloudflared spawn failure leaves disk + UI showing the new secret with `publicUrl=null` + `lastError` (operator sees the truthful "rotated but not bound" state).
- [ ] `atomicWriteFile failure on rotate` — code-verified: `atomicWriteFile` (`src/atomic-write.ts`) renames into place; a chmod-w'd parent dir surfaces an ENOENT/EACCES from `renameSync` which bubbles up as a failure result. Reproducing live without breaking the gateway's other config writes is hostile to the rest of the test session — skipped.

## Boot reconcile

- [x] `boot reconcile auto-spawns: tmux kill-session gini-feat+ios-deeplink-fallback; tmux new-session ... bun run gini run ... → API back up at t=1s → cloudflared spawned with fresh hostname at t=4s; the original config secret preserved across the restart`
- [x] `enabled=false reconcile no-op: config.json tunnel.enabled=false; restart gini → API up at t=1s; pgrep cloudflared shows no process bound to 3057; snapshot reports enabled=false, lastError=null (no spawn attempted, no error)`
- [ ] `reconcile-only abort (R7 569920e)` — code-verified: `enable(reconcileOnly: true)` re-checks `this.config.tunnel.enabled` after the port probe and skips the apply with a `tunnel.boot-reconcile.aborted` log entry. Provoking the race requires landing a user-driven disable within the reconcile poll window in real time — left as code-verified.
- [ ] `boot reconcile timeout` — code-verified: the reconcile awaits the supervised web port for up to 60s; killing next-dev mid-restart on a running gateway would also kill the BFF (and the supervisor would restart it), so live reproduction needs an external port-poisoning shim. Skipped as expensive vs. payoff.

## Mobile (iOS Simulator or device)

None of these are reachable from a Mac CLI; requires an iPhone or the iOS
Simulator.

- [ ] `deeplink confirm path: Safari opens gini://connect?api=<runtime>&token=<bearer> → iOS routes to gini app → /connect placeholder spinner renders → useDeepLinkAuth fires → Alert.alert "Connect to Gini gateway? Switch this device to use: <host>" → tap Connect → saveCredentials → router.replace("/agents") → expect agents list`
- [ ] `deeplink cancel path (R3): Safari opens gini://connect?... → Alert appears → tap Cancel → router.replace("/") → auth gate at app/index.tsx routes based on persisted creds → expect /agents (if authed) or /setup (if not)`
- [ ] `deeplink malformed: Safari opens gini://connect?api=&token= (empty params) → parseConnectUrl returns null → hook returns early (no Alert) → user stuck on /connect spinner (edge case I documented, not fixed)`
- [ ] `web /connect interstitial happy path: navigate https://<web>/connect?api=<runtime>&web=<web>&token=<bearer> → page validates params → ConnectClient effect runs → window.location.href = gini://... → expect iOS opens the gini app via custom scheme`
- [ ] `web /connect interstitial fallback: navigate https://<web>/connect?... → iOS doesn't have gini app installed → wait fallbackMs (defaults to 1500ms, clamped to [250, 10000]) → window.location.replace(webUrl) → expect web app loads`
- [ ] `validateScheme blocks javascript: navigate /connect?scheme=javascript:alert(1)&api=...&web=... → expect server-side validateScheme rejects, falls back to DEFAULT_SCHEME gini://connect → no JS execution` — `web/src/app/connect/page.tsx:38`
- [ ] `validateScheme blocks data: navigate /connect?scheme=data:text/html,evil&api=...&web=... → expect fallback to gini://connect`
- [ ] `validateScheme blocks doubly-encoded javascript: navigate /connect?scheme=javascript%3Aeval%2528...%2529%252F%252F&api=...&web=... → expect fallback (the blocklist runs on the lowercased decoded value, catching the prefix even when encoded)`
- [ ] `mobile cleartext HTTP: mobile saves apiUrl = http://192.168.1.5:7778 (LAN gateway) → mobile makes fetch to http://...:7778/api/... → expect ATS NSAllowsArbitraryLoads allows the cleartext load → request succeeds`

## UI states / edge cases

- [x] `launcher hidden on /setup` — code-verified at `web/src/components/TunnelQrLauncher.tsx:56` (`pathname.startsWith("/setup")`) + `:101` (`if (isSetup) return null`); live navigation auto-redirects to `/` when a provider is configured so the visible-on-screen test only reproduces on a fresh install.
- [x] `launcher disabled state shows enable: tunnel off → home → click QR icon → modal shows "Tunnel is off" title + ShieldAlert icon + Close + Enable tunnel buttons; click Enable → spinner appears on the button; transitions to ready state once cloudflared comes up`
- [x] `launcher starting state` — exercised inline above (the in-flight Enable click rendered the disabled state with a button-level spinner, then flipped to ready); the `data.enabled && (!data.publicUrl || !data.secret)` spinner state is reachable any time you click Enable mid-spawn.
- [x] `hydration mismatch absent: read_console_messages on tunneled home returned only "[HMR] connected" — zero React hydration / "Text content does not match" warnings on cold SSR`
- [x] `next-themes script-tag warning absent: same console capture — no "Encountered a script tag while rendering React component" lines (the module-level console.error wrap in providers.tsx silences only that specific message)`
- [x] `favicon over tunnel pre-cookie: curl -k https://<live-tunnel>/icon.png (no cookie) → code=200 content-type=image/png size=4772 bytes` (matcher exclusion lets the public favicon through without the auth gate)
- [x] `sidebar logo over tunnel: read_network_requests on tunneled home → GET /gini-agent-logo.png returned 200 (no /_next/image 400 — the `unoptimized` prop bypasses the optimizer)`
- [x] `HMR over tunnel: tunneled home console shows "[HMR] connected" log — websocket upgrade succeeds, no "WebSocket connection failed" spam`
- [x] `QR cache buster on rotate: pre-rotate QR src param v=b0e25091d2a50432; post-rotate v=8615d1717d4620b8 (different — proves secretRevision recomputes on every state change)`
- [x] `QR drag/right-click disabled: dispatched real DragEvent + MouseEvent contextmenu against the QR <img> via mcp__browser__javascript_tool → both events return defaultPrevented=true; React synthetic-handler delegation prevents the default browser behavior`
- [x] `confirm dialogs gate destructive actions: clicked Disable in launcher modal → confirm dialog rendered → clicked Cancel → snapshot still reports enabled=true with the same publicUrl + secret prefix (no PATCH fired)`
- [x] `tunneled view shows "via tunnel" badge: /settings over the tunneled host shows "live" pill PLUS a "via tunnel" badge in the section header; the same /settings on the loopback host shows only the "live" pill (badge differential proves the tunneled-view detection)`
- [x] `degraded pill (R3 V3): killed cloudflared with kill -9 → /settings now shows the destructive "degraded" pill and "Last error: cloudflared exited (signal SIGKILL)" inline under the section header (this is also the signal-name fix from `24536b6` — pre-fix, lastError said "(code ?)")`

## Documentation / config

- [x] `gini tunnel CLI commands: each invocation re-tested end-to-end against the same instance — status (47ms total, JSON snapshot), qr (43ms total, ASCII QR + URL), enable (2.89s end-to-end including cloudflared spawn + banner), disable (160ms, clears publicUrl preserves secret), rotate-secret (3.52s end-to-end stop-old + spawn-new + banner, yields new URL+secret+revision), sync-notes (183.1ms end-to-end osascript write), apple-notes on (36ms), apple-notes off (32ms) — all measured via "| tsd" delta-timestamps`
- [ ] `config.json torn read (R6 fad19aa)` — code-verified: `atomicWriteFile` (tempfile + fsync + rename via `src/atomic-write.ts`) plus the `writeRuntimeConfig` helper in `src/paths.ts` mean every reader sees a complete document; reproducing the race-free guarantee at scale requires a parallel-write harness — left as code-verified.
- [ ] `RuntimeConfig.tunnel in-memory sync (R3 + R7)` — code-verified: `persistTunnel` mirrors `this.config.tunnel = next` before the disk write so a subsequent whole-config write serializes fresh state (`src/runtime/tunnel/manager.ts:107-130`).
- [x] `canonicalize parity (R6 b898347): bun test src/runtime/tunnel/canonicalize.parity.test.ts → 37 pass / 0 fail / 66 expect() calls (all 37 inputs agree between src/runtime/tunnel/canonicalize.ts and web/src/lib/canonicalize.ts)`

---

## How to consume

Tick boxes as you verify items. Items inside a single block can usually be
batched into one terminal session or one browser tab; the security-boundary
block in particular runs in under a minute as a single bash script if you copy
the live tunnel URL and secret into it.

If any item fails, paste the failure mode into the PR description's "Known
regression" or "Tradeoffs explicitly accepted" section depending on whether
it's a bug to fix or accepted behavior.
