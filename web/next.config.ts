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
  // it's a dev-server concern only. Tunneled (relay) page loads reach this dev
  // server through the gateway's reverse-proxy with a loopback Host (the gateway
  // rewrites Host/Origin before proxying — see src/http.ts proxyWeb), so no
  // relay-domain entry is needed here.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
