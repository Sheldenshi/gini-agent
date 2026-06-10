import { runtimeInstance } from "@/lib/runtime";

// This route exists so the CLI can probe a Next.js-specific marker rather
// than trusting that any HTTP server on the chosen port is ours. The CLI
// matches on `service: "gini-web"` AND the spawned child PID being alive —
// see src/cli.ts:waitForWebHealthz. It also serves as the web-server identity
// marker for the update gate (web/src/components/UpdateGate.tsx). `pid` (the
// worker serving this request) is diagnostic only: it is NOT a restart proof,
// because the next CLI respawns the worker — new pid, same server tree — on
// any next.config.* change, which an update's checkout can trigger without
// the tree restarting. `ppid` is the supervising next CLI process and is the
// tree's identity: stable across worker respawns, replaced only when the
// whole tree is restarted (launchctl kickstart / stop+start).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    ok: true,
    service: "gini-web",
    instance: runtimeInstance(),
    pid: process.pid,
    ppid: process.ppid
  });
}
