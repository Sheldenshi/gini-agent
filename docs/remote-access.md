# Remote Access

An instance's gateway binds to loopback. To reach Gini from a phone or another machine you front the **gateway port** with a tunnel — one public origin then serves both the web UI and the `/api/*` surface (see [Gateway And Control Plane](gateway.md)).

There are two ways to get that tunnel:

- **The managed provider — Gini Relay.** Built in, selected and supervised through `gini tunnel` / the web tunnel panel. This is the only provider the runtime can drive today.
- **Manual tunnels — Tailscale, ngrok, Cloudflare.** They appear in the tunnel panel as disabled catalog entries (native integration is planned; see [Roadmap](../ROADMAP.md)), but you can use each of them **today** by running the tool yourself against the gateway port and telling the gateway to trust the external origin. This page documents exactly how, and how to confirm what you've got.

> Terminology: this page is about **tunnel providers**. The similarly-named `gini connectors` CLI and `/api/connectors` routes manage *service* connectors (Google, Linear, MCP-backed tools) and are unrelated to remote access.

## Selecting a mode — and confirming it

The runtime keeps one tunnel selection per instance: a `selectedProvider` plus a connection `status` (`idle`, `connecting`, `connected`, or `error`). Drive it with:

```bash
gini tunnel                      # status + provider catalog
gini tunnel select <provider>    # save a selection (stays idle)
gini tunnel connect [provider]   # connect (provider arg overrides the saved selection)
gini tunnel cancel               # abort a pending login, keep the selection
gini tunnel disconnect           # tear down the tunnel, keep the selection
```

Every command returns the full tunnel state, so any one call tells you whether a mode is selected and what it is. The same state is available to every client at `GET /api/tunnel` (bearer-gated). The contract and connect flow live in ADR [tunnel-connectivity.md](adr/tunnel-connectivity.md).

### The confirmation surfaces

| Surface | How | What it tells you |
| --- | --- | --- |
| CLI | `gini tunnel` | `selectedProvider: null` means **no mode is selected**; a provider id means that mode is selected. `status` + `url` tell you whether it is actually live. |
| HTTP | `curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/tunnel` | Same `TunnelState` JSON — the web UI polls this same state through the BFF (`/api/runtime/tunnel`, token injected server-side). |
| Web UI | Sidebar tunnel pill | `Off / no tunnel` when nothing is connected; `Live / gini-relay` with a green dot when connected. Opening it shows the provider panel with the selected row marked `Selected` (or `Connected`). |
| Disk | `state.json` → `tunnel` | The persisted `TunnelSelectionRecord` (`selectedProvider`, `status`, `url`, `createdAt`/`updatedAt`). Survives restarts. |
| Audit | audit rows `tunnel.select`, `tunnel.connect`, `tunnel.connected`, `tunnel.error`, `tunnel.cancel`, `tunnel.disconnect`, `tunnel.reconcile` | Who changed the mode and when, with the provider id in `evidence`. |
| Logs | `~/.gini/instances/<instance>/logs/runtime.jsonl` | `tunnel.connected`, `tunnel.connect.error`, `tunnel.exited`, `tunnel.resume.*` events from the background connect/resume flows. |

A fresh instance reads:

```json
{ "providers": [ ... ], "selectedProvider": null, "status": "idle" }
```

After `gini tunnel select gini-relay`:

```json
{ "providers": [ ... ], "selectedProvider": "gini-relay", "status": "idle" }
```

`url` appears only when `status` is `connected`; `message` only on `error`. The selection persists across gateway restarts (a `connected` tunnel is resumed automatically on boot; see the reconcile section of ADR [tunnel-connectivity.md](adr/tunnel-connectivity.md)).

`GET /api/tunnel` is cheap to poll: it reads the persisted record and rebuilds the static catalog in process — no network calls — so the web UI polling it (through the BFF) during `connecting` costs effectively nothing.

### Selecting a provider that isn't available

Only catalog-enabled providers can be selected. Today that is `gini-relay` alone; the others are placeholders, and selecting one is rejected **before any state changes** with HTTP 400 (CLI exit 1):

```text
$ gini tunnel select tailscale
Tunnel provider Tailscale is not available (requires Tailscale network).

$ gini tunnel select wireguard
Unknown tunnel provider: wireguard
```

So: a disabled provider can never be the selected mode. If you front Gini with Tailscale, ngrok, or Cloudflare manually (below), `gini tunnel` intentionally keeps reporting `selectedProvider: null` (or your relay selection) — the runtime only reports tunnels *it* manages. Confirm a manual tunnel at its own layer instead, per its section below.

## The managed provider: Gini Relay

```bash
gini tunnel select gini-relay
gini tunnel connect
```

`connect` returns immediately with `status: "connecting"`, opens an OAuth consent page in the host browser (only when no relay session is stored — reconnects and restarts reuse the session, but `gini tunnel disconnect` logs the instance out, so the next connect prompts again), starts a supervised `frpc` child, and flips the state to `connected` with a stable public URL `https://<subdomain>.<relayDomain>`. Poll `gini tunnel` until you see `connected` + `url`, or `error` + `message`. Relay subdomains are trusted by the gateway automatically — no extra configuration. Full lifecycle, supervision, and restart-resume behavior: ADR [tunnel-connectivity.md](adr/tunnel-connectivity.md).

## Manual tunnels

All three manual tunnels follow the same recipe. The examples below use `<gateway-port>` for the instance's gateway port — find yours with `gini status`.

1. **Expose the gateway port** (not the web port) with your tunnel tool. One origin then serves UI + API. For a durable tunnel, pin the port first: non-default instances derive hash-based ports that **walk forward when busy** (see [Gateway And Control Plane](gateway.md)), so after a restart a long-lived tunnel can silently forward to whatever process now owns the old port. Launch with an explicit `--port`/`GINI_PORT` — pinned ports stay strict and fail instead of moving — and stop/recreate the tunnel whenever the port or instance changes.
2. **Trust the external origin.** The gateway fail-closes web-bound requests from hostnames it doesn't know (page navigations 404, `/api/runtime/*` 403). Set `GINI_TRUSTED_ORIGINS` to the comma-separated **full origins** of your tunnels, in the gateway process environment at launch:

   ```bash
   GINI_TRUSTED_ORIGINS=https://my-mac.tailnet-name.ts.net,https://gini.example.com gini start
   ```

   To make it durable, add the line `GINI_TRUSTED_ORIGINS=...` to `~/.gini/secrets.env` — the installed `gini` wrapper sources it on every launch, and `gini autostart enable` merges it into the launchd plist (re-run that after editing). If the variable is set but contains no parseable origin, the gateway refuses every web-bound request on a **non-loopback, non-relay** front until it's fixed (loopback and gini-relay subdomains keep working — behaviorally a garbage value equals an unset one): the typo bricks exactly the manual-tunnel front you were configuring, loudly rather than silently downgrading. See ADR [bff-trust-boundary.md](adr/bff-trust-boundary.md).
3. **Pair the device.** A browser arriving on a trusted non-loopback origin is redirected to `/pair` and must be approved once — from the loopback UI, or from the "Pair requests" panel of any **already-paired** session; see ADR [device-pairing-auth.md](adr/device-pairing-auth.md). A paired session is owner-equivalent (it can approve future pairing requests and mint pairing codes), so pair only devices you fully trust. Non-browser clients are never redirected to `/pair` — the native `/api/*` surface is bearer-gated instead, and the origin gate applies only to web-bound paths. A remote non-browser client should still pair: the mobile app runs the pairing handshake natively, and any other client can claim a pairing code against the tunnel origin — mint the code on the host (`gini pairing`), then from the remote device:

   ```bash
   curl -X POST <origin>/api/pairing/claim \
     -H "content-type: application/json" \
     -d '{"code":"<code>","deviceName":"my laptop"}'
   ```

   The endpoint is public and rate-limited (no bearer needed); the `201` response returns `{ device, token }`, and the device then sends that token as `Authorization: Bearer`. Tokens are individually revocable (`gini device revoke <device-id>`). (`gini pairing claim <code>` wraps the same endpoint but always posts to the local instance, so it is only useful on the gateway host itself.) Reserve the instance owner bearer (`config.json`) for local operator tooling — it is a singleton with no per-device revocation, so don't copy it onto remote devices.

### Tailscale

Private to your tailnet (no public exposure), with TLS and stable DNS — the recommended manual option. TLS terminates on your own node, so Tailscale never sees plaintext.

```bash
tailscale serve --bg http://127.0.0.1:<gateway-port>   # serves https://<machine>.<tailnet>.ts.net
tailscale serve status                                 # confirm the proxy is registered
tailscale serve --https=443 off                        # tear it down
```

Add `https://<machine>.<tailnet>.ts.net` to `GINI_TRUSTED_ORIGINS` and restart the gateway. To expose the same serve config to the public internet instead, Tailscale offers `tailscale funnel` — the origin string stays the same.

Confirm the mode at the Tailscale layer (`tailscale serve status`) and end-to-end: a page request to the `ts.net` URL should answer `302 → /pair` (untrusted it answers `404`). If the `ts.net` name doesn't resolve on a machine, MagicDNS is off for that resolver — `curl --resolve <name>:443:<tailscale-ip>` pins it without giving up certificate validation.

### ngrok

Public URL through ngrok's edge; requires an ngrok account (`ngrok config add-authtoken <token>` once). ngrok terminates TLS at its edge, so ngrok can observe everything proxied — cookies, device tokens, and chat/task content.

```bash
ngrok http <gateway-port>                              # random https://<id>.ngrok-free.app
ngrok http <gateway-port> --url https://you.ngrok.app  # reserved domain (paid)
```

The agent prints the public URL; add exactly that origin to `GINI_TRUSTED_ORIGINS` and restart the gateway. With a random URL you must update the variable every time the agent restarts — a reserved domain avoids the churn.

Confirm at the ngrok layer (the agent's console shows the live URL and each request) and end-to-end with the same `404 → 302 /pair` probe as above.

### Cloudflare

Two distinct modes:

- **Quick tunnel (testing only):** `cloudflared tunnel --url http://127.0.0.1:<gateway-port>` prints a random `https://<words>.trycloudflare.com` URL. No account needed. Two sharp edges: (1) if `~/.cloudflared/` contains a `config.yml` from a named-tunnel setup, quick tunnels **register but serve edge 404s** — pass `--config /dev/null` to override; (2) quick tunnels do **not** proxy Server-Sent Events, and the Gini web UI streams live updates over SSE (`/api/runtime/events/stream`), so the UI will load but won't update live. Fine for a smoke test, not for real use.
- **Named tunnel (real use):** a Cloudflare account plus your own domain, configured per Cloudflare's docs, gives a stable hostname without the SSE limitation of the quick-tunnel edge.

Either way: add the printed/configured origin to `GINI_TRUSTED_ORIGINS`, restart the gateway, and probe for `302 → /pair`. Both modes terminate TLS at Cloudflare's edge, so Cloudflare can observe everything proxied — cookies, device tokens, and chat/task content.

## Verifying a manual tunnel

The full decision table — identical across Tailscale, ngrok, and Cloudflare tunnels:

| Probe through the tunnel | Origin **not** trusted | Origin trusted |
| --- | --- | --- |
| Page navigation (`/`) | `404` | `302 → /pair` (until the device is paired) |
| `GET /api/runtime/__healthz` (web-bound) | `403` | `401` (until paired) |
| `GET /api/tunnel` with bearer (native API) | `200` | `200` |

The third row is the discriminator when something is wrong: the native bearer-gated API ignores the origin gate, so a `200` there means the tunnel and gateway are healthy and any `404` on pages is the origin gate (fix `GINI_TRUSTED_ORIGINS`). If even the bearer probe fails, the tunnel itself is broken — for example a Cloudflare quick tunnel answering edge 404s carries only `server: cloudflare` headers and no gateway response at all.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Page `404` through the tunnel, loopback works | Origin not in `GINI_TRUSTED_ORIGINS` (gateway fails closed) | Add the exact `https://` origin; restart the gateway |
| Tunnel 404s persist after setting the var (loopback still fine) | `GINI_TRUSTED_ORIGINS` set but no entry parses (typo), or the gateway wasn't restarted with the new value | Fix the value — entries are full origins, comma-separated — and restart the gateway |
| Page redirects to `/pair`, API calls `401` | Device not paired (expected on any non-loopback front) | Approve the request from the loopback UI or any already-paired session |
| `Tunnel provider X is not available (requires …)` | Selecting a disabled catalog placeholder | Use `gini-relay`, or run the tool manually per this page |
| `gini tunnel` says `selectedProvider: null` while your manual tunnel works | Expected: the runtime only tracks tunnels it manages | Confirm manual tunnels at their own layer (`tailscale serve status`, the ngrok/cloudflared console) |
| Cloudflare quick tunnel: edge `404`, bearer probe also `404`, headers only `server: cloudflare` | `~/.cloudflared/config.yml` present (quick tunnels unsupported with it) | Run `cloudflared --config /dev/null tunnel --url …`, or use a named tunnel |
| Web UI loads through Cloudflare quick tunnel but never updates | Quick tunnels don't proxy SSE | Use a named tunnel, Tailscale, or ngrok |
| `ts.net` hostname doesn't resolve | MagicDNS off for that resolver | Enable MagicDNS, or `curl --resolve <name>:443:<tailscale-ip>` |
