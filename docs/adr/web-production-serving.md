# ADR: Sha-keyed production serving for the web control plane

## Decision

The installed runtime serves its Next.js control plane from a **sha-keyed
production build** when one exists, and falls back to `next dev` otherwise.
One rule, applied identically by every serving path:

- If `web/.next-prod-<sha12>` exists **and** contains a `BUILD_ID` (next
  build's completion marker), where `<sha12>` is `git rev-parse --short=12
  HEAD` of the checkout being served, exec `next start` with
  `GINI_DIST_DIR=.next-prod-<sha12>`.
- Otherwise exec `next dev` exactly as before (per-instance
  `.next-<instance>` dist dir).

The serving paths that apply the rule:

- The launchd web shim (`buildWebShim`, `src/cli/autostart.ts`) — in sh,
  after its gateway-health gate.
- `gini start` / `gini run` (`webLaunchPlan` + `resolveWebProdDistDir`,
  `src/cli/process.ts` / `src/runtime/update.ts`) — in TypeScript.

Only the update and install flows ever **create** prod dirs:

- `updateRuntime` (`src/runtime/update.ts`) runs `bun run build` in `web/`
  with `GINI_DIST_DIR=.next-prod-<sha12-of-the-new-HEAD>` after the web
  `bun install`. The build is skipped when that dir already carries a
  `BUILD_ID` (idempotent re-update onto the same head). On success, every
  *other* `web/.next-prod-*` dir is deleted — a non-matching sha can never
  be served again, and each bundle is a full Next build's worth of disk. On
  build failure `updateRuntime` throws (same contract as a failed
  `bun install`), so **no restart is scheduled** and the old server keeps
  serving its old, still self-consistent bundle.
- `scripts/install.sh` runs the same build after installing web
  dependencies, so a fresh install serves production from first boot.

Security constraint: `next start` defaults to binding `0.0.0.0`. Every prod
exec passes `-H 127.0.0.1` — the BFF trusts a loopback `Host` for its
owner-bearer injection (see [BFF Trust Boundary](bff-trust-boundary.md)),
so an all-interfaces bind would hand owner access to any LAN peer. The dev
path already binds loopback; the port comes from the `PORT` env (launchd
plist) or `-p` (`gini start`), both of which `next start` honors.

## Context

The runtime previously served the control plane with `next dev`
unconditionally. The old comment in `src/cli/process.ts` explained why:
production serving requires an explicit prior `next build`, and a stale
`.next/` from a previous checkout would silently serve outdated code, which
is hostile to fresh-clone and worktree workflows.

Dev-always had two failure modes that surfaced together during a real
auto-update (2026-06-12) and produced ~30s of user-visible web outage:

1. The update's `bun install` swaps `node_modules` under the live dev
   server, breaking its lazy requires (`Cannot find module
   'next/dist/compiled/...'`) for the whole install window.
2. After the restart, `next dev` JIT-compiles every route on demand. When
   the update bumps the Next version, the persisted Turbopack cache is
   invalidated and *everything* recompiles from scratch — pegging the CPU,
   failing the BFF's healthz probes, and (before the watchdog's two-strike
   rule, see [Always-Up Supervision](always-up-supervision.md)) getting the
   mid-compile server hard-killed by the watchdog.

Sha-keying the build dir defuses the staleness hazard that justified
dev-always: a bundle is only ever served when its dir name matches the
*current* HEAD's short sha, so a checkout that moved (update, git pull,
worktree switch) simply misses the key and falls back to dev. Developer
workflows never build prod dirs, so `gini run` from a worktree behaves
exactly as before.

`next start` also tolerates the install-window swap far better than dev: it
loads from the prebuilt bundle rather than lazily requiring compiler
internals out of `node_modules`, and the freshly built bundle for the new
sha is ready before the restart is scheduled, so the post-restart server
answers immediately instead of compiling.

The `BUILD_ID` gate makes an aborted build unservable: `next build` writes
it only on completion, so a partially written dir fails the check and the
fallback (dev, or the surviving old prod bundle before its GC) serves
instead.

## Consequences

- A web-triggered update's downtime window shrinks to the gateway drain +
  respawn (~1-2s); the restarted web service answers from prebuilt assets
  instead of recompiling every route.
- `POST /api/update` now includes a `next build` (tens of seconds). The
  UpdateGate's whole-gate stall deadline was raised to 240s to cover it
  (see [Runtime Update Surface](runtime-update-surface.md)); the updating
  tab sits behind the gate's blur for the duration either way.
- Between the GC of old prod dirs and the restart, the still-running old
  server can 500 on a route it hadn't loaded yet (~1s window). Accepted:
  the updating tab is blurred, and the restart lands on the new bundle.
- `web/.next-prod-*` dirs are working artifacts like `.next-<instance>`;
  `web/.gitignore`'s existing `/.next-*/` entry covers them.
- Production mode ignores dev-only conveniences (`allowedDevOrigins`, HMR);
  nothing in the BFF depends on them — the gateway reverse-proxy and
  relay-origin trust decisions live at the gateway, not in Next's dev
  server (see [Gateway Web Reverse Proxy](gateway-web-reverse-proxy.md)).
- Multiple instances can serve the same prod bundle concurrently: `next
  start` is read-only on the dist dir, unlike `next dev`'s exclusive
  `<distDir>/lock` (which is why the dev fallback keeps the per-instance
  dirs).
- The launchd web plist's `GINI_DIST_DIR` env stays the dev-fallback value;
  the shim exports the prod dir over it only on the prod branch. The shim
  change re-stamps existing installs automatically — the plist stamp hashes
  `ProgramArguments`, which embed the shim — so the startup reconcile
  rewrites and reloads installed web plists on the next gateway boot.

## Acceptance Checks

- `updateRuntime` builds `web/.next-prod-<sha12>` for the new HEAD, skips
  the build when a `BUILD_ID` is already present, deletes other
  `.next-prod-*` dirs on success, and throws (scheduling no restart) on
  build failure.
- The web shim and `webLaunchPlan` both serve `next start` with
  `-H 127.0.0.1` and `GINI_DIST_DIR=.next-prod-<sha12>` iff that dir
  matches the current HEAD and carries a `BUILD_ID`; otherwise they exec
  the unchanged `next dev` command.
- `scripts/install.sh` builds the prod bundle after "Web app installed".
- A checkout with no prod dir (fresh clone, worktree) starts the dev
  server exactly as before.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` pass.
