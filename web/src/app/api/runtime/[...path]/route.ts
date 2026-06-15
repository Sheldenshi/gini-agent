import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalizePath } from "@/lib/canonicalize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The web server's served-build identity, derived from the dist dir the next
// CLI was started with. Production serving exports
// `GINI_DIST_DIR=.next-prod-<sha12>` (the short HEAD sha of the checkout that
// was built — see src/runtime/update.ts WEB_PROD_DIST_PREFIX); dev serving
// uses `.next-<instance>`, which has no sha and yields undefined. Reported as
// `buildSha` on __healthz so the update gate can latch web completion on the
// actual code being served rather than the indirect ppid proxy.
const PROD_DIST_SHA = /^\.next-prod-([0-9a-f]{12,})$/;
function servedBuildSha(): string | undefined {
  return PROD_DIST_SHA.exec(process.env.GINI_DIST_DIR ?? "")?.[1];
}

async function forward(request: NextRequest, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  // THE healthz handler. Underscore-prefixed App Router folders are private
  // and never route, so a sibling __healthz/route.ts can't serve this path —
  // the catch-all must answer it locally rather than proxying to the runtime
  // (which has no such endpoint). It lets the CLI probe a Next.js-specific
  // marker rather than trusting that any HTTP server on the chosen port is
  // ours: the CLI matches on `service: "gini-web"` AND the spawned child PID
  // being alive — see src/cli/process.ts:waitForWebHealthz. It also serves as
  // the web-server identity marker for the update gate
  // (web/src/components/UpdateGate.tsx). `buildSha` is the gate's primary
  // web-completion signal under production serving: it is the sha of the code
  // THIS server is serving, so the OLD server reports the OLD build and only
  // the restarted server reports the target — an un-raceable identity, unlike
  // the indirect signals below. It is undefined under dev serving (no
  // sha-keyed dist dir), where the gate falls back to `ppid`. `pid` (the
  // worker serving this request) is diagnostic only: it is NOT a restart
  // proof, because the next CLI respawns the worker — new pid, same server
  // tree — on any next.config.* change, which an update's checkout can trigger
  // without the tree restarting. `ppid` is the supervising next CLI process
  // and is the tree's identity: stable across worker respawns, replaced only
  // when the whole tree is restarted (launchctl kickstart / stop+start); it is
  // the gate's dev/legacy web-completion fallback when `buildSha` is absent.
  if (path.length === 1 && path[0] === "__healthz") {
    return Response.json({
      ok: true,
      service: "gini-web",
      instance: runtimeInstance(),
      pid: process.pid,
      ppid: process.ppid,
      buildSha: servedBuildSha()
    });
  }
  // Re-canonicalize the BFF-visible form so the path the runtime receives
  // matches what the BFF validated — defense-in-depth against traversal and
  // encoding tricks before the request is forwarded.
  const inboundPath = `/api/runtime/${path.join("/")}`;
  const canon = canonicalizePath(inboundPath);
  if (!canon.ok) return Response.json({ error: "Invalid path" }, { status: 400 });
  return proxyRequest(request, canon.path.replace(/^\/api\/runtime\//, "").split("/"), {
    runtimeUrl: runtimeUrl(),
    token: runtimeToken(),
    signal: request.signal
  });
}

export const GET = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const POST = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PATCH = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const DELETE = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PUT = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
