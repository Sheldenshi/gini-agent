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
  // We deliberately do NOT allow `*.trycloudflare.com` here. The proxy
  // matcher in web/src/proxy.ts excludes `/_next/webpack-hmr` and
  // `/_next/static`, so the WebSocket upgrade and source-map fetches
  // bypass the secret gate and reach Next.js dev directly. Allowing the
  // tunnel host would let any anonymous client that can reach the live
  // tunnel hostname open `wss://<live-tunnel>/_next/webpack-hmr` and
  // pull `https://<live-tunnel>/_next/static/...` — leaking module HMR
  // events and source maps without ever proving knowledge of the
  // tunnel secret. The local browser still gets HMR over loopback;
  // HMR-over-tunnel on mobile was already fragile across cloudflared's
  // keepalive limits, so the convenience tradeoff is small relative to
  // the disclosure surface.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
