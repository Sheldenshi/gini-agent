// `gini autostart enable|disable|status` — macOS LaunchAgent integration.
//
// What this does for the user: after `gini install` (or by hand on an
// existing instance), enabling autostart writes ~/Library/LaunchAgents/
// ai.lilac.gini.<instance>.plist, registers it with launchctl, and from
// then on the runtime is up at login and respawned on crash. `gini stop`
// (clean exit) is honored — the agent does NOT respawn after a deliberate
// stop.
//
// macOS only in v1. Linux systemd --user is a follow-up, but invoking
// `gini autostart ...` on Linux prints a clear platform message rather
// than failing silently.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import { print } from "../output";
import { flagValue } from "../args";
import {
  bootout,
  bootstrap,
  isLoaded,
  kickstart,
  labelFor,
  labelForKind,
  loadedLastExitStatus,
  loadedPid,
  platformIsSupported,
  plistPathFor,
  resolveLaunchSpecPair,
  serviceTarget,
  unsupportedPlatformMessage,
  writePlist,
  type PlistKind
} from "../autostart";

const KINDS: PlistKind[] = ["gateway", "web"];

export async function autostart(ctx: CliContext): Promise<void> {
  const sub = ctx.cliArgs[1];
  // No subcommand → show usage. We render it as JSON-like output to match
  // the rest of the CLI, but with a help payload so it's still actionable.
  if (!sub) {
    print(usage());
    return;
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    print(usage());
    return;
  }

  if (!platformIsSupported()) {
    print({ ok: false, error: unsupportedPlatformMessage(), platform: process.platform });
    process.exitCode = 1;
    return;
  }

  const instance = ctx.config.instance;
  // `--test-root <dir>` opts the resulting plists into a scratch state-root
  // (and matching log-root if specified). Used by GINI_AUTOSTART_E2E tests
  // so they can run against a private state dir without touching the
  // developer's real install. Plain GINI_STATE_ROOT in the shell env does
  // NOT leak into the plist — only this explicit flag (or
  // GINI_AUTOSTART_E2E=1 + the env vars actually set) does.
  const testRootFlag = flagValue(ctx.rawArgs, "--test-root");
  const testLogRootFlag = flagValue(ctx.rawArgs, "--test-log-root");
  const e2eMode = process.env.GINI_AUTOSTART_E2E === "1";
  const testRoot = testRootFlag
    ? { stateRoot: testRootFlag, logRoot: testLogRootFlag ?? process.env.GINI_LOG_ROOT }
    : e2eMode
      ? { stateRoot: process.env.GINI_STATE_ROOT, logRoot: process.env.GINI_LOG_ROOT }
      : undefined;

  if (sub === "enable") {
    const kindFlag = flagValue(ctx.rawArgs, "--kind");
    const kinds: PlistKind[] = kindFlag === "gateway" || kindFlag === "web" ? [kindFlag] : KINDS;
    const result = await enable(instance, testRoot, kinds);
    print(result);
    // HIGH-4: exit code reflects ok:false so install.sh's `if … then`
    // sees the failure. Previously soft failures (e.g. partial bootstrap)
    // returned exit 0 because the JSON had ok:false but the CLI didn't
    // surface that to the shell.
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "disable") {
    const result = await disable(instance);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "status") {
    print(status(instance));
    return;
  }
  if (sub === "kick") {
    const result = kick(instance, ctx.rawArgs);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  print({
    ok: false,
    error: `Unknown autostart subcommand: ${sub}. Run \`gini autostart\` for usage.`
  });
  process.exitCode = 1;
}

function usage(): Record<string, unknown> {
  return {
    usage: [
      "gini autostart enable  [--instance <name>] [--test-root <dir>]",
      "gini autostart disable [--instance <name>]",
      "gini autostart status  [--instance <name>]",
      "gini autostart kick    [--instance <name>] [--kind gateway|web]  # force respawn (see notes)"
    ],
    notes: [
      "macOS only in v1 (Linux systemd --user is a follow-up).",
      "Two services per instance: <prefix>.<instance>.gateway (Bun runtime) and <prefix>.<instance>.web (Next.js).",
      "PID supervision only — a wedged-but-alive runtime is not detected here. A health watchdog hitting /api/healthz is a follow-up.",
      "`gini stop` is honored: SuccessfulExit:false means clean exits do NOT respawn. The web shim execs `bun run dev`, which exits 0 on SIGTERM; the same KeepAlive contract applies.",
      "macOS 26 (Tahoe): launchd often defers auto-respawn after SIGKILL indefinitely (`pended nondemand spawn = inefficient`). Use `gini autostart kick` to force a respawn when this happens; RunAtLoad still fires at login.",
      "Secrets in ~/.gini/secrets.env are merged into both plists' EnvironmentVariables at enable time. If you change a key (e.g. `gini provider set`), re-run `autostart enable` to refresh the plists for future respawns.",
      "`--test-root <dir>` is an E2E-test escape hatch: scoped state/log roots are embedded in the plist. Plain GINI_STATE_ROOT in your shell does NOT leak into a permanent plist."
    ]
  };
}

interface PerKindEnableResult {
  kind: PlistKind;
  label: string;
  plistPath: string;
  serviceTarget: string;
  alreadyLoaded: boolean;
  enabled: boolean;
  error?: string;
  stderr?: string;
}

interface EnableResult {
  ok: boolean;
  enabled: boolean;
  instance: string;
  resolution: "installed" | "source";
  results: PerKindEnableResult[];
  error?: string;
}

// Compute the plist's StandardOutPath/StandardErrorPath log root WITHOUT
// honoring process.env.GINI_LOG_ROOT. MEDIUM-6: logDir() in paths.ts
// returns join(GINI_LOG_ROOT, instance) when that env var is set, so a
// developer who runs `autostart enable` from a shell with GINI_LOG_ROOT
// set would bake scratch paths into the permanent plist. The fix: when
// not in testRoot opt-in, compute the log root from instance state root
// directly. When testRoot.logRoot is provided (E2E), embed that.
function resolveLogRoot(instance: string, testRoot?: { stateRoot?: string; logRoot?: string }): string {
  if (testRoot?.logRoot) return join(testRoot.logRoot, instance);
  if (testRoot?.stateRoot) return join(testRoot.stateRoot, "instances", instance, "logs");
  // Production path: derive from $HOME/.gini regardless of whether
  // GINI_LOG_ROOT or GINI_STATE_ROOT are set in the invoking shell.
  // We use HOME directly so a stray env-set GINI_STATE_ROOT also doesn't
  // leak into the plist via instanceRoot() → baseStateRoot().
  const home = process.env.HOME ?? "";
  return join(home, ".gini", "instances", instance, "logs");
}

async function enable(
  instance: string,
  testRoot?: { stateRoot?: string; logRoot?: string },
  kinds: PlistKind[] = KINDS
): Promise<EnableResult> {
  const pair = resolveLaunchSpecPair({ instance, testRoot });
  const logRoot = resolveLogRoot(instance, testRoot);
  const results: PerKindEnableResult[] = [];
  let allOk = true;

  // HIGH-5: clean up the round-1 legacy single-plist
  // `ai.lilac.gini.<instance>` (no kind suffix) BEFORE bootstrapping the
  // round-2 split pair. Otherwise an upgrade from round 1 → round 2
  // leaves the legacy service running alongside the new pair, which
  // either fights for the gateway port or wedges launchd. `bootout` on
  // an unknown label is a no-op (we ignore "Could not find service"),
  // so it's safe to always run.
  if (isLoaded(instance) && kinds.includes("gateway")) {
    const out = bootout(instance);
    if (!out.ok && !out.stderr.includes("Could not find service")) {
      // Surface as a top-level error and bail — running both legacy
      // and new gateway simultaneously is worse than failing the
      // enable.
      return {
        ok: false,
        enabled: false,
        instance,
        resolution: pair.resolution,
        results: [],
        error: `legacy bootout failed: ${out.stderr.trim()}`
      };
    }
  }
  // Remove the legacy plist file too so a future `disable` doesn't
  // bother re-cleaning it (and so `ls ~/Library/LaunchAgents/` shows
  // only the round-2 split files).
  const legacyPlist = plistPathFor(instance);
  if (existsSync(legacyPlist) && kinds.includes("gateway")) {
    try { rmSync(legacyPlist, { force: true }); } catch { /* best-effort */ }
  }

  // HIGH-4 (b): track which kinds we successfully bootstrapped so we
  // can roll them back if a later kind fails. Leaving a half-loaded
  // service set is worse than nothing loaded — `gini status` would
  // report the gateway up but the user can't reach the webapp.
  const bootstrapped: PlistKind[] = [];

  for (const kind of kinds) {
    const spec = kind === "gateway" ? pair.gateway : pair.web;
    const stdoutPath = join(logRoot, kind === "gateway" ? "runtime-stdout.log" : "web.log");
    // launchd routes stderr to its own file by default — we keep that
    // separate so an autostart-only crash log doesn't get tangled with the
    // user-driven `gini run` stdout tee.
    const stderrPath = join(logRoot, kind === "gateway" ? "runtime-launchd.err.log" : "web-launchd.err.log");
    const path = writePlist({ instance, kind, spec, stdoutPath, stderrPath });
    const target = serviceTarget(instance, kind);
    const wasLoaded = isLoaded(instance, kind);

    if (wasLoaded) {
      // Idempotent re-enable: the plist on disk may have changed, so we
      // bootout the old registration first, then bootstrap the new one.
      // `kickstart -k` alone wouldn't pick up the new plist contents.
      const out = bootout(instance, kind);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        results.push({
          kind,
          label: labelForKind(instance, kind),
          plistPath: path,
          serviceTarget: target,
          alreadyLoaded: wasLoaded,
          enabled: false,
          error: "launchctl bootout failed",
          stderr: out.stderr.trim()
        });
        allOk = false;
        continue;
      }
    }

    // Bootstrap with a short retry. macOS launchd sometimes returns
    // "Bootstrap failed: 5: Input/output error" when the previous
    // bootout hasn't fully flushed yet — typically clears within ~1s.
    // We retry up to 3 times with 500ms backoff to ride out the gap.
    let res = bootstrap(instance, path);
    let attempts = 1;
    while (!res.ok && attempts < 3 && res.stderr.includes("Input/output error")) {
      await Bun.sleep(500);
      res = bootstrap(instance, path);
      attempts += 1;
    }
    if (!res.ok) {
      results.push({
        kind,
        label: labelForKind(instance, kind),
        plistPath: path,
        serviceTarget: target,
        alreadyLoaded: wasLoaded,
        enabled: false,
        error: "launchctl bootstrap failed",
        stderr: res.stderr.trim()
      });
      allOk = false;
      // HIGH-4 (b): roll back any kinds we already bootstrapped in this
      // call so we don't leave a half-loaded service set behind. Skip
      // kinds that were `wasLoaded:true` on entry — those are the
      // user's prior state, not something this call created.
      for (const earlier of bootstrapped) {
        bootout(instance, earlier);
      }
      continue;
    }
    bootstrapped.push(kind);
    results.push({
      kind,
      label: labelForKind(instance, kind),
      plistPath: path,
      serviceTarget: target,
      alreadyLoaded: wasLoaded,
      enabled: true
    });
  }

  return {
    ok: allOk,
    enabled: allOk,
    instance,
    resolution: pair.resolution,
    results
  };
}

interface PerKindDisableResult {
  kind: PlistKind;
  label: string;
  plistPath: string;
  wasLoaded: boolean;
  bootoutOk: boolean;
  plistRemoved: boolean;
  bootoutStderr?: string;
  rmError?: string;
}

interface DisableResult {
  ok: boolean;
  disabled: boolean;
  instance: string;
  alreadyDisabled: boolean;
  results: PerKindDisableResult[];
  // Legacy single-plist fields kept for tests / shell scripts that grep
  // for them. Each reflects the AGGREGATE across kinds.
  label?: string;
  plistPath?: string;
  plistRemoved: boolean;
  stderr?: string;
}

async function disable(instance: string): Promise<DisableResult> {
  // Pull legacy (round-1) single-plist into the cleanup loop too. If a
  // user upgrades from round 1 → round 2 and runs `autostart disable`,
  // we want to clean up the old `ai.lilac.gini.<instance>` plist too.
  // It's safe to call bootout on a label that isn't loaded — launchctl
  // returns "Could not find service".
  const legacyPath = plistPathFor(instance);
  const results: PerKindDisableResult[] = [];
  const stderrParts: string[] = [];

  // Handle legacy plist if it's present.
  if (existsSync(legacyPath) || isLoaded(instance)) {
    const wasLoaded = isLoaded(instance);
    let bootoutOk = true;
    let bootoutStderr: string | undefined;
    if (wasLoaded) {
      const out = bootout(instance);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        bootoutOk = false;
        bootoutStderr = out.stderr.trim();
        stderrParts.push(`legacy bootout: ${bootoutStderr}`);
      }
    }
    let plistRemoved = false;
    let rmError: string | undefined;
    if (existsSync(legacyPath)) {
      try {
        rmSync(legacyPath, { force: true });
        plistRemoved = true;
      } catch (error) {
        rmError = error instanceof Error ? error.message : String(error);
        stderrParts.push(`legacy rm: ${rmError}`);
      }
    }
    results.push({
      kind: "gateway",
      label: labelFor(instance),
      plistPath: legacyPath,
      wasLoaded,
      bootoutOk,
      plistRemoved,
      ...(bootoutStderr ? { bootoutStderr } : {}),
      ...(rmError ? { rmError } : {})
    });
  }

  for (const kind of KINDS) {
    const path = plistPathFor(instance, kind);
    const wasLoaded = isLoaded(instance, kind);

    if (!wasLoaded && !existsSync(path)) {
      continue;
    }

    let bootoutOk = true;
    let bootoutStderr: string | undefined;
    if (wasLoaded) {
      const out = bootout(instance, kind);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        bootoutOk = false;
        bootoutStderr = out.stderr.trim();
        stderrParts.push(`${kind} bootout: ${bootoutStderr}`);
      }
    }

    let plistRemoved = false;
    let rmError: string | undefined;
    if (existsSync(path)) {
      try {
        rmSync(path, { force: true });
        plistRemoved = true;
      } catch (error) {
        rmError = error instanceof Error ? error.message : String(error);
        stderrParts.push(`${kind} rm plist: ${rmError}`);
      }
    }

    results.push({
      kind,
      label: labelForKind(instance, kind),
      plistPath: path,
      wasLoaded,
      bootoutOk,
      plistRemoved,
      ...(bootoutStderr ? { bootoutStderr } : {}),
      ...(rmError ? { rmError } : {})
    });
  }

  if (results.length === 0) {
    return {
      ok: true,
      disabled: false,
      instance,
      alreadyDisabled: true,
      results: [],
      label: labelFor(instance),
      plistPath: legacyPath,
      plistRemoved: false
    };
  }

  const allOk = results.every((r) => r.bootoutOk && !r.rmError);
  const anyPlistRemoved = results.some((r) => r.plistRemoved);
  const aggregateStderr = stderrParts.join("; ");
  return {
    ok: allOk,
    disabled: allOk,
    instance,
    alreadyDisabled: false,
    results,
    label: labelFor(instance),
    plistPath: legacyPath,
    plistRemoved: anyPlistRemoved,
    ...(aggregateStderr ? { stderr: aggregateStderr } : {})
  };
}

interface PerKindStatus {
  kind: PlistKind;
  label: string;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: string | null;
}

interface StatusResult {
  ok: true;
  instance: string;
  services: PerKindStatus[];
  // Round-1 single-plist fields, surfaced for compatibility (some tests and
  // user scripts grep on them). Reflects the gateway service.
  label: string;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: string | null;
  limitations: string[];
}

function status(instance: string): StatusResult {
  const services: PerKindStatus[] = [];
  for (const kind of KINDS) {
    const path = plistPathFor(instance, kind);
    const loaded = isLoaded(instance, kind);
    const pid = loaded ? loadedPid(instance, kind) : null;
    const lastExit = loaded ? loadedLastExitStatus(instance, kind) : null;
    services.push({
      kind,
      label: labelForKind(instance, kind),
      plistPath: path,
      plistExists: existsSync(path),
      loaded,
      pid,
      lastExitStatus: lastExit
    });
  }
  const gateway = services[0]!;
  return {
    ok: true,
    instance,
    services,
    label: gateway.label,
    plistPath: gateway.plistPath,
    plistExists: gateway.plistExists,
    loaded: gateway.loaded,
    pid: gateway.pid,
    lastExitStatus: gateway.lastExitStatus,
    limitations: [
      "PID supervision only — a wedged-but-alive runtime is not detected.",
      "macOS 26+: launchd auto-respawn after SIGKILL is unreliable. Use `gini autostart kick` to force respawn.",
      "macOS only in v1.",
      "Two services per instance: <prefix>.<instance>.gateway and <prefix>.<instance>.web. `gini status` aggregates web/runtime health."
    ]
  };
}

interface PerKindKickResult {
  kind: PlistKind;
  label: string;
  loaded: boolean;
  kicked: boolean;
  error?: string;
  stderr?: string;
}

interface KickResult {
  ok: boolean;
  instance: string;
  results: PerKindKickResult[];
}

// `kick` is a manual respawn trigger. macOS 26 (Tahoe) sometimes refuses to
// auto-respawn a launchd job after a SIGKILL, leaving it stuck in
// `pended nondemand spawn = inefficient` indefinitely. `gini autostart kick`
// runs `launchctl kickstart -k` to force a stop+start.
//
// Defaults: kick BOTH gateway and web. `--kind gateway` or `--kind web`
// narrows it to one. Practical use: a healthcheck loop discovers a wedged
// runtime and runs `gini autostart kick --kind gateway`.
function kick(instance: string, rawArgs: string[]): KickResult {
  const kindFlag = flagValue(rawArgs, "--kind");
  const kinds: PlistKind[] = kindFlag === "gateway" || kindFlag === "web" ? [kindFlag] : KINDS;
  const results: PerKindKickResult[] = [];
  let allOk = true;
  for (const kind of kinds) {
    const loaded = isLoaded(instance, kind);
    if (!loaded) {
      results.push({
        kind,
        label: labelForKind(instance, kind),
        loaded: false,
        kicked: false,
        error: `Autostart is not enabled for ${kind} on instance '${instance}'. Run \`gini autostart enable\` first.`
      });
      allOk = false;
      continue;
    }
    const res = kickstart(instance, kind);
    if (!res.ok) {
      results.push({
        kind,
        label: labelForKind(instance, kind),
        loaded: true,
        kicked: false,
        error: "launchctl kickstart failed",
        stderr: res.stderr.trim()
      });
      allOk = false;
      continue;
    }
    results.push({ kind, label: labelForKind(instance, kind), loaded: true, kicked: true });
  }
  return { ok: allOk, instance, results };
}

// Best-effort autostart-disable for use by `gini uninstall --instance`.
// Tries to tear down BOTH plists (gateway + web), but surfaces failures
// rather than swallowing them — a broken plist must not block uninstall
// of state, but the user deserves to know launchctl couldn't unload
// something. State deletion proceeds either way; the caller prints any
// warnings.
export interface UninstallAutostartResult {
  removed: boolean;
  alreadyDisabled: boolean;
  reason?: string;
  // Per-kind audit so the uninstall command can print exactly which
  // service had trouble unloading.
  failures: Array<{ kind: PlistKind | "legacy"; error: string }>;
}

// Called from CLI paths that touch creds (gini provider set, gini setup
// after writing secrets.env). If a gateway plist already exists for the
// instance, re-run `enable` so the launchd registration picks up the
// fresh secrets.env / config values. Bails on non-macOS or when no
// plist is present — both are common, expected states.
//
// Returns the refresh outcome (or a "skipped" reason) so the caller can
// surface it in their output. The refresh DOES bootout + bootstrap, so
// it will briefly stop and respawn the running gateway/web. That's fine
// in a CLI context because the user typed the command and expects it.
// (Never call this from inside the gateway process — it would kill
// itself mid-call. See setup-api.maybeRefreshAutostartPlist.)
export async function maybeRefreshAutostart(instance: string): Promise<{ refreshed: boolean; reason?: string }> {
  if (!platformIsSupported()) return { refreshed: false, reason: "not macOS" };
  const gatewayPlist = plistPathFor(instance, "gateway");
  if (!existsSync(gatewayPlist)) return { refreshed: false, reason: "no autostart plist on disk" };
  try {
    const result = await enable(instance);
    return { refreshed: result.ok, ...(result.ok ? {} : { reason: result.error ?? "autostart enable failed" }) };
  } catch (error) {
    return { refreshed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function disableForUninstall(instance: string): Promise<UninstallAutostartResult> {
  if (!platformIsSupported()) {
    return { removed: false, alreadyDisabled: false, reason: "not macOS", failures: [] };
  }
  try {
    const result = await disable(instance);
    const failures: UninstallAutostartResult["failures"] = [];
    for (const r of result.results) {
      if (!r.bootoutOk) failures.push({ kind: r.kind, error: r.bootoutStderr ?? "launchctl bootout failed" });
      if (r.rmError) failures.push({ kind: r.kind, error: `rm plist: ${r.rmError}` });
    }
    return {
      removed: result.disabled || result.plistRemoved,
      alreadyDisabled: result.alreadyDisabled,
      reason: result.alreadyDisabled ? "already disabled" : undefined,
      failures
    };
  } catch (error) {
    return {
      removed: false,
      alreadyDisabled: false,
      reason: error instanceof Error ? error.message : String(error),
      failures: [{ kind: "legacy", error: error instanceof Error ? error.message : String(error) }]
    };
  }
}
