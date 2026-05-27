# Tunnel + Mobile Access — Manual Test Checklist

Coverage checklist for PR #132 (`feat/tunnel-qr-launcher`). Each entry is the
exact click / curl / `gini` invocation path with the expected outcome and the
commit / file citation it pins. Items are grouped by surface and severity.

The Chrome MCP browser tests run on **2026-05-27** covered the items marked
`[x] DONE`. Everything else is reachable but unexercised — pick the categories
that match your confidence threshold and tick them off as you go.

Live state when this checklist was written:
- runtime: `http://127.0.0.1:3057`
- live tunnel: `https://tion-garmin-tba-physiology.trycloudflare.com` (host rotates per recycle)
- secret prefix: first six chars of `curl -s http://127.0.0.1:3057/api/runtime/tunnel | jq -r .secret`

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

- [ ] `spoofed host: curl -k -H "Host: fake.trycloudflare.com" https://<live-tunnel>/<secret> → expect HTTP/2 404` (proves live-host equality match, not suffix match)
- [ ] `pairing deny: curl --cookie "gini_tunnel_session=<secret>" -X POST https://<live-tunnel>/api/runtime/pairing -d '{}' → expect 404`
- [ ] `method deny POST on qr.svg (R8): curl --cookie "..." -X POST https://<live-tunnel>/api/runtime/tunnel/qr.svg → expect 404` — `web/src/lib/tunnel-policy.ts:57`
- [ ] `method deny DELETE on /tunnel (R8): curl --cookie "..." -X DELETE https://<live-tunnel>/api/runtime/tunnel → expect 404`
- [ ] `method deny GET on /refresh-notes (R8): curl --cookie "..." https://<live-tunnel>/api/runtime/tunnel/refresh-notes → expect 404`
- [ ] `trailing slash on bootstrap: curl https://<live-tunnel>/<secret>/ → expect 302 + Set-Cookie + Location: /` — commit `9a5845c`
- [ ] `vetted marker stripped: curl -H "x-gini-tunnel-vetted: 1" https://<live-tunnel>/ → expect proxy strips inbound header, request 404s because no cookie/secret`
- [ ] `cookie tied to host: scan tunnel A → get cookie A; tunnel rotates to B; phone presents cookie A to host B → expect 404 (host-only cookie binding)`

## Trust-lane split (R5 V2)

Only unit-tested via parser tests. The classification split itself is
unexercised live.

- [ ] `trusted-origins with tunnel off: export GINI_TRUSTED_ORIGINS=https://gini.local; gini tunnel disable; curl -H "Host: gini.local" http://127.0.0.1:3057/ → expect 200, NOT 404` — the original bug had the classifier conflating tunnel + trusted

## Apple Notes mirror

Touched in R3 V6 + R5 race fixes — never exercised live in this PR.

- [ ] `notes toggle on: /settings → toggle Apple Notes mirror ON → wait for runRefreshNotes osascript → open macOS Notes.app → expect "gini-tunnel-<instance>" folder note with bootstrap URL body`
- [ ] `notes toggle off: /settings (Notes ON) → toggle OFF → wait for runClearNotes osascript → check Notes.app → expect note cleared`
- [ ] `notes off→on race (R3 V6): /settings → toggle Notes OFF then ON within the in-flight clear's 15000ms osascript timeout (per OSASCRIPT_TIMEOUT_MS at src/runtime/tunnel/apple-notes.ts:7 — race is reachable any time inside that window) → wait for both side effects → check Notes.app → expect note PRESENT (the runClearNotes appleNotes.enabled re-check guard bails the stale clear)`
- [ ] `refresh notes button: /settings (Notes ON, tunnel live) → click "Refresh Notes" → osascript fires fire-and-forget → check Notes.app shows current bootstrap URL`
- [ ] `notes-after-rotate: /settings (Notes ON) → click Rotate Secret → confirm → wait → check Notes.app → expect NEW bootstrap URL written by rotate's fire-and-forget runRefreshNotes`
- [ ] `notes off→disable race: /settings (Notes ON) → toggle Notes OFF → before clearNote finishes, click Disable Tunnel → expect both transitions land cleanly, no resurrected note`

## Cross-surface query sync

Both `TunnelCard` and `TunnelQrLauncher` use `useQuery` with
`refetchInterval: 5_000` (`web/src/app/settings/_components/TunnelCard.tsx:56`
and `web/src/components/TunnelQrLauncher.tsx:61`). The mutation hooks call
`invalidate()` which invalidates both `["tunnel"]` and `["tunnel-launcher"]`
query keys. Untested.

- [ ] `disable from launcher syncs settings: home → click QR icon → modal (ready state) → click Disable → confirm → close modal → navigate /settings → expect TunnelCard pill = "off" within 5000ms refetch`
- [ ] `enable from settings syncs launcher: /settings (tunnel off) → click Enable → wait for ready state → navigate home → click QR icon → expect modal in ready state with new URL`
- [ ] `rotate from launcher syncs settings: home → click QR icon → click Rotate → confirm → close modal → /settings → expect publicUrl + secret in TunnelCard match what launcher shows`
- [ ] `rotate from settings syncs launcher: /settings → click rotate icon → confirm → home → click QR icon → expect launcher's revealed URL matches the new rotated URL`

## Failure modes — provoked

Mid-life crash, signal exits, port re-probe failure. None exercised in this
PR's live testing.

- [ ] `mid-life cloudflared crash: live tunnel → from a second shell, pkill -9 cloudflared → wait for exit listener → curl tunnel snapshot → expect enabled=true, publicUrl=null, lastError contains "cloudflared exited" with code or signal name → /settings → expect "degraded" pill (R3 V3) with lastError tooltip`
- [ ] `signal exit detection (R6 c3a2300): trigger an enable → during banner parse window, pkill -SIGKILL cloudflared → expect snapshot lastError mentions "signal SIGKILL" instead of "code N"`
- [ ] `unhealthy port on enable: stop the supervised Next.js child externally (kill the next dev process) → PATCH /api/runtime/tunnel {enabled:true} → expect 409 from the http handler's pre-probe at src/http.ts (the isSupervisedWebChild check returns false)`
- [ ] `unhealthy port on rotate (R8 e69747a): stop the supervised Next.js child externally while tunnel is up → PATCH /api/runtime/tunnel {rotateSecret:true} → expect 500 with "web port N not healthy — rotation aborted before commit" → confirm disk secret is UNCHANGED (the pre-probe aborts before persistTunnel)`
- [ ] `rotate fails mid-recycle (R7 569920e pre-stamp): contrive a port that probes ok but cloudflared fails to bind → PATCH rotateSecret → expect new secret on disk + snapshot.publicUrl=null + lastError → UI shows the new secret (not the old) so the operator sees the rotated state truthfully`
- [ ] `cloudflared spawn failure: rename ~/.local/bin/cloudflared away → PATCH enable → expect failure result + snapshot.enabled=false rollback + lastError set`
- [ ] `atomicWriteFile failure on rotate: chmod -w on ~/.gini/instances/<inst>/config.json's parent dir briefly → PATCH rotateSecret → expect failure result + on-disk state unchanged`

## Boot reconcile

- [ ] `boot reconcile auto-spawns: edit config.json tunnel.enabled=true → restart gini → wait → curl tunnel snapshot → expect cloudflared spawned with fresh hostname + the original secret preserved`
- [ ] `reconcile-only abort (R7 569920e): set up so boot reconcile is enqueued AND a user disable lands during its poll → expect tunnel.boot-reconcile.aborted log entry with reason "disabled-during-poll" or "disabled-after-probe" + tunnel stays disabled`
- [ ] `enabled=false reconcile no-op: config.json tunnel.enabled=false → restart gini → expect no cloudflared spawn, no boot-reconcile.timeout, clean idle state`
- [ ] `boot reconcile timeout: edit config.json tunnel.enabled=true → kill the next-dev process so port is unhealthy → restart gini → wait the full 60000ms ceiling → expect tunnel.boot-reconcile.timeout log entry`

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

- [ ] `launcher hidden on /setup: navigate /setup → expect floating QR icon NOT rendered`
- [ ] `launcher disabled state shows enable: tunnel off → home page → click QR icon → expect "Tunnel is off" copy + ShieldAlert icon + Enable button → click Enable → expect transient "Bringing tunnel up…" state then ready state`
- [ ] `launcher starting state: tunnel.enabled=true with publicUrl=null mid-spawn → home → click QR icon → expect spinner state with "Spawning cloudflared and waiting for the rotating trycloudflare.com hostname" copy`
- [ ] `hydration mismatch absent: open /settings on the cloudflare host fresh (cold SSR) → check console → expect no "Hydration failed" or "Text content does not match" warnings (R3 commit 84c34a2 useEffect for isTunneledView)`
- [ ] `next-themes script-tag warning absent: open any page → check console → expect no "Encountered a script tag while rendering React component" warning (the module-level console.error wrap in web/src/components/providers.tsx:29)`
- [ ] `favicon over tunnel pre-cookie: incognito tab → navigate https://<live-tunnel>/icon.png directly → expect 200 + image/png (matcher exclusion from e82227b lets the public favicon through without the auth gate)`
- [ ] `sidebar logo over tunnel: open https://<live-tunnel>/ → check Network → expect NO 400 on /_next/image, GET /gini-agent-logo.png returns 200 (unoptimized bypass from de3d40d)`
- [ ] `HMR over tunnel: dev mode, navigate https://<live-tunnel>/ → check DevTools Network → expect ws upgrade on /_next/webpack-hmr succeeds → no WebSocket connection failed spam (matcher exclusion + allowedDevOrigins from 670a77d)`
- [ ] `QR cache buster on rotate: navigate /settings → reveal QR → note QR svg URL hash → click Rotate → wait → reveal QR again → expect different svg URL hash (secretRevision based on SHA-256(secret|publicUrl) per src/runtime/tunnel/secret.ts)`
- [ ] `QR drag/right-click disabled: reveal QR → try to drag the image → expect dragstart preventDefault, no drag image → right-click → expect contextmenu preventDefault, no save-image option`
- [ ] `confirm dialogs gate destructive actions: click Disable → confirm dialog opens with cancel/destructive buttons → click Cancel → expect modal closes, no PATCH fired`
- [ ] `tunneled view shows "via tunnel" badge: open /settings on the cloudflare host → expect badge next to status pill; same page on loopback shows no badge`
- [ ] `degraded pill (R3 V3): force enabled=true with publicUrl=null state (kill cloudflared after enable but before disable propagates) → /settings → expect "degraded" pill (destructive variant) with lastError tooltip`

## Documentation / config

- [ ] `gini tunnel CLI commands: gini tunnel status; gini tunnel qr; gini tunnel enable; gini tunnel disable; gini tunnel rotate-secret; gini tunnel sync-notes; gini tunnel apple-notes on|off → expect each prints expected output and matches API behavior`
- [ ] `config.json torn read (R6 fad19aa): hammer config writes via parallel CLI invocations (e.g. gini provider set + gini admin install loops) → simultaneously hammer GET /api/runtime/tunnel → expect proxy never observes a parse failure (all reads see complete documents thanks to atomicWriteFile + the writeRuntimeConfig helper in src/paths.ts)`
- [ ] `RuntimeConfig.tunnel in-memory sync (R3 + R7): start gini → enable tunnel via PATCH → without restarting, fire a whole-config write via PATCH /api/settings/auto-approve → curl tunnel snapshot AFTER the second PATCH → expect tunnel block intact (persistTunnel mirrors this.config.tunnel = next so the second whole-config write serializes fresh state)`
- [ ] `canonicalize parity (R6 b898347): bun test src/runtime/tunnel/canonicalize.parity.test.ts → expect 37/37 inputs agree between src/runtime/tunnel/canonicalize.ts and web/src/lib/canonicalize.ts`

---

## How to consume

Tick boxes as you verify items. Items inside a single block can usually be
batched into one terminal session or one browser tab; the security-boundary
block in particular runs in under a minute as a single bash script if you copy
the live tunnel URL and secret into it.

If any item fails, paste the failure mode into the PR description's "Known
regression" or "Tradeoffs explicitly accepted" section depending on whether
it's a bug to fix or accepted behavior.
