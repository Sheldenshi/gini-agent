import { runtimeInstance } from "@/lib/runtime";

// This route exists so the CLI can probe a Next.js-specific marker rather
// than trusting that any HTTP server on the chosen port is ours. The CLI
// matches on `service: "gini-web"` AND the spawned child PID being alive —
// see src/cli.ts:waitForWebHealthz. It also serves as the web-process
// identity marker for the update gate (web/src/components/UpdateGate.tsx):
// `pid` only changes on a real process restart — next-dev module re-evals
// reuse the same process — so a changed pid proves the web server was
// kickstarted onto the new build.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    ok: true,
    service: "gini-web",
    instance: runtimeInstance(),
    pid: process.pid
  });
}
