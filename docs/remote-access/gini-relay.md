# Gini Relay

The managed provider — zero host setup, always available. The relay assigns this instance a stable subdomain and proxies it to your gateway over an outbound tunnel, so it works behind NAT and firewalls without opening ports.

## Connect

Tap **Connect** in the tunnel panel, or:

```bash
gini tunnel connect gini-relay
```

`connect` returns immediately with `status: "connecting"`. When no relay session is stored, an OAuth consent page opens in the host browser (reconnects and restarts reuse the stored session; `disconnect` logs the instance out, so the next connect prompts again). A supervised `frpc` child then exposes the gateway port, and the state flips to `connected` with your stable public URL:

```text
https://<subdomain>.gini-relay.lilaclabs.ai
```

The subdomain is keyed to this device, so reconnects and gateway restarts keep the **same URL**. A persisted `connected` tunnel is resumed automatically on boot.

## Trust and pairing

Relay subdomains are trusted by the gateway automatically — no configuration. The first browser to visit the URL is redirected to `/pair` and must be approved once (from the operator's tunnel popover, or any already-paired session). Paired sessions are owner-equivalent; pair only devices you fully trust.

## Confirm it's live

- The sidebar pill reads `Live / gini-relay` with a green dot.
- `gini tunnel` shows `status: "connected"` plus the `url`.
- A page request to the URL answers `302 → /pair` until the device is paired, then serves the app.

## Privacy

The relay forwards encrypted tunnel traffic, but it terminates TLS for the public hostname — treat the relay operator as part of your trust domain, or use Tailscale for a tailnet-private front with TLS terminating on your own machine.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `connecting` never settles | The OAuth consent tab was closed or never completed | `gini tunnel cancel`, then connect again and finish the consent flow |
| `error` after a previous successful connect | The stored relay session was revoked server-side | Connect again — a fresh consent flow runs |
| URL changed | `disconnect` logs out; a different account/device claims a different subdomain | Reconnect with the same account to keep a stable subdomain |
