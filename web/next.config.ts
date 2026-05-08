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
  turbopack: {
    root: resolve(import.meta.dirname)
  }
};

export default nextConfig;
