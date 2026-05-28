import type { NextConfig } from "next";
import { resolve } from "node:path";

// Per-instance distDir lets the CLI run multiple `next dev` instances in
// parallel without them fighting over the same `<distDir>/lock`. The CLI
// passes `GINI_DIST_DIR=.next-<instance>` (always relative, kept inside `web/`
// per Next.js' distDir constraint). Defaulting to `.next` preserves the
// standalone `bun run dev` workflow for anyone running the web app
// outside `gini start`.
const distDir = process.env.GINI_DIST_DIR ?? ".next";

const nextConfig: NextConfig = {
  distDir,
  // Next.js 16 defaults to blocking dev-resource requests from any origin
  // other than `localhost`, which silently breaks HMR + client-component
  // hydration when the user lands on http://127.0.0.1:<port>. The Gini
  // installer and CLI consistently open the app via 127.0.0.1, so we
  // allow both forms explicitly. Production builds don't read this —
  // it's a dev-server concern only.
  //
  // `*.trycloudflare.com` MUST be in the allowlist for tunneled access
  // to work in dev mode. Without it, Next.js 16 rejects every Origin
  // check from the tunnel host: the HMR WebSocket upgrade is denied,
  // and Client Component hydration on tunneled pages silently fails
  // (the page renders the SSR HTML but `useEffect` never runs). That
  // breaks the `/connect` deep-link interstitial (no setTimeout
  // fallback fires, the page sits on "Opening Gini…" forever) and
  // every interactive control on `/settings` / `/chat` / etc. The
  // earlier attempt to drop the entry to gate the HMR + source-map
  // disclosure surface (commit 47343f2) made the tunnel functionally
  // unusable; we restored the entry and accept the dev-only HMR
  // exposure as a tradeoff. Production builds don't ship HMR, so the
  // disclosure surface is bounded to local dev instances reached
  // through their quick tunnel.
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.trycloudflare.com"],
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
