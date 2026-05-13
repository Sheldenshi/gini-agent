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
import {
  bootout,
  bootstrap,
  isLoaded,
  labelFor,
  loadedLastExitStatus,
  loadedPid,
  platformIsSupported,
  plistPathFor,
  resolveLaunchSpec,
  serviceTarget,
  unsupportedPlatformMessage,
  writePlist
} from "../autostart";
import { logDir } from "../../paths";

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
  if (sub === "enable") {
    print(await enable(instance));
    return;
  }
  if (sub === "disable") {
    print(await disable(instance));
    return;
  }
  if (sub === "status") {
    print(status(instance));
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
      "gini autostart enable  [--instance <name>]",
      "gini autostart disable [--instance <name>]",
      "gini autostart status  [--instance <name>]"
    ],
    notes: [
      "macOS only in v1 (Linux systemd --user is a follow-up).",
      "PID supervision via launchd KeepAlive. No health watchdog yet — a wedged-but-alive runtime won't be detected here.",
      "`gini stop` is honored: SuccessfulExit:false means clean exits do NOT respawn."
    ]
  };
}

interface EnableResult {
  ok: boolean;
  enabled: boolean;
  instance: string;
  label: string;
  plistPath: string;
  serviceTarget: string;
  alreadyLoaded: boolean;
  error?: string;
  stderr?: string;
}

async function enable(instance: string): Promise<EnableResult> {
  const spec = resolveLaunchSpec({ instance });
  const logRoot = logDir(instance);
  const stdoutPath = join(logRoot, "runtime-stdout.log");
  // launchd routes stderr to its own file by default — we keep that
  // separate so an autostart-only crash log doesn't get tangled with the
  // user-driven `gini run` stdout tee.
  const stderrPath = join(logRoot, "runtime-launchd.err.log");
  const path = writePlist({ instance, spec, stdoutPath, stderrPath });
  const target = serviceTarget(instance);
  const wasLoaded = isLoaded(instance);

  if (wasLoaded) {
    // Idempotent re-enable: the plist on disk may have changed, so we
    // bootout the old registration first, then bootstrap the new one.
    // `kickstart -k` alone wouldn't pick up the new plist contents.
    const out = bootout(instance);
    if (!out.ok && !out.stderr.includes("Could not find service")) {
      return {
        ok: false,
        enabled: false,
        instance,
        label: labelFor(instance),
        plistPath: path,
        serviceTarget: target,
        alreadyLoaded: wasLoaded,
        error: "launchctl bootout failed",
        stderr: out.stderr.trim()
      };
    }
  }

  const res = bootstrap(instance, path);
  if (!res.ok) {
    return {
      ok: false,
      enabled: false,
      instance,
      label: labelFor(instance),
      plistPath: path,
      serviceTarget: target,
      alreadyLoaded: wasLoaded,
      error: "launchctl bootstrap failed",
      stderr: res.stderr.trim()
    };
  }
  // `bootstrap` registers + RunAtLoad fires, so the runtime should be
  // booting now. We don't poll for /api/status here — autostart is the
  // supervision layer, not a health probe. `gini status` already covers
  // the live runtime view.
  return {
    ok: true,
    enabled: true,
    instance,
    label: labelFor(instance),
    plistPath: path,
    serviceTarget: target,
    alreadyLoaded: wasLoaded
  };
}

interface DisableResult {
  ok: boolean;
  disabled: boolean;
  instance: string;
  label: string;
  plistPath: string;
  alreadyDisabled: boolean;
  plistRemoved: boolean;
  stderr?: string;
}

async function disable(instance: string): Promise<DisableResult> {
  const path = plistPathFor(instance);
  const wasLoaded = isLoaded(instance);

  if (!wasLoaded && !existsSync(path)) {
    return {
      ok: true,
      disabled: false,
      instance,
      label: labelFor(instance),
      plistPath: path,
      alreadyDisabled: true,
      plistRemoved: false
    };
  }

  let stderr: string | undefined;
  if (wasLoaded) {
    const res = bootout(instance);
    if (!res.ok && !res.stderr.includes("Could not find service")) {
      // Surface the launchctl error but still try to remove the plist —
      // a half-disabled state is worse than a leaked plist with no
      // service.
      stderr = res.stderr.trim();
    }
  }

  let plistRemoved = false;
  if (existsSync(path)) {
    try {
      rmSync(path, { force: true });
      plistRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        disabled: !wasLoaded ? true : false,
        instance,
        label: labelFor(instance),
        plistPath: path,
        alreadyDisabled: false,
        plistRemoved: false,
        stderr: stderr ? `${stderr}; rm plist: ${message}` : `rm plist: ${message}`
      };
    }
  }

  return {
    ok: true,
    disabled: true,
    instance,
    label: labelFor(instance),
    plistPath: path,
    alreadyDisabled: false,
    plistRemoved,
    ...(stderr ? { stderr } : {})
  };
}

interface StatusResult {
  ok: true;
  instance: string;
  label: string;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: string | null;
  limitations: string[];
}

function status(instance: string): StatusResult {
  const path = plistPathFor(instance);
  const loaded = isLoaded(instance);
  const pid = loaded ? loadedPid(instance) : null;
  const lastExit = loaded ? loadedLastExitStatus(instance) : null;
  return {
    ok: true,
    instance,
    label: labelFor(instance),
    plistPath: path,
    plistExists: existsSync(path),
    loaded,
    pid,
    lastExitStatus: lastExit,
    limitations: [
      "PID supervision only — a wedged-but-alive runtime is not detected.",
      "macOS only in v1."
    ]
  };
}

// Best-effort autostart-disable for use by `gini uninstall --instance`.
// Swallows errors so a broken plist doesn't block uninstall. Returns a
// boolean for the caller's audit trail, plus a reason string when nothing
// happened.
export async function disableForUninstall(instance: string): Promise<{ removed: boolean; reason?: string }> {
  if (!platformIsSupported()) return { removed: false, reason: "not macOS" };
  try {
    const result = await disable(instance);
    return { removed: result.disabled || result.plistRemoved, reason: result.alreadyDisabled ? "already disabled" : undefined };
  } catch (error) {
    return { removed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
