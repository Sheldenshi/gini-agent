// Per-provider guide URLs (docs/remote-access/<id>.md served by the gateway,
// rendered inline via DocSheet/DocReference). Each tunnel provider's guide is
// self-contained: prerequisites, what Connect runs, verification, the manual
// fallback, and troubleshooting — there is no aggregate guide in the app.
import type { TunnelProviderId } from "./types";

export const PROVIDER_DOC_URLS: Record<TunnelProviderId, string> = {
  "gini-relay": "https://gini.lilaclabs.ai/docs/remote-access/gini-relay",
  tailscale: "https://gini.lilaclabs.ai/docs/remote-access/tailscale",
  ngrok: "https://gini.lilaclabs.ai/docs/remote-access/ngrok",
  cloudflare: "https://gini.lilaclabs.ai/docs/remote-access/cloudflare"
};
