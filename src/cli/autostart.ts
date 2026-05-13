// macOS LaunchAgent integration: write a per-instance plist, register it
// with `launchctl bootstrap gui/<uid>`, and tear it down with `launchctl
// bootout`.
//
// What this exists for: after `gini install` runs, the user expects the
// runtime to be running and to stay running across crashes and logins. On
// macOS the supported way to achieve that for a per-user, foreground-session
// service is a user-domain LaunchAgent under ~/Library/LaunchAgents/. System
// daemons (~/.../Library/LaunchDaemons/) can't reach the user's Keychain,
// which would break Codex auth.
//
// Scope notes:
//   - macOS only in v1. Linux systemd --user parity is a follow-up.
//   - PID supervision only (launchd's default). A health watchdog that hits
//     /api/healthz to detect wedged-but-alive Bun is OUT of v1 — `status`
//     and `--help` surface that limitation so users know what they're
//     getting.
//   - `gini stop` exits with the server SIGTERM handler doing process.exit(0),
//     which feeds launchd's `KeepAlive.SuccessfulExit: false` semantics:
//     clean exits are treated as the user's intent and are NOT respawned;
//     anything else triggers a respawn.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Instance } from "../types";
import { projectRoot } from "../paths";

export const LABEL_PREFIX = "ai.lilac.gini";

export function labelFor(instance: Instance): string {
  return `${LABEL_PREFIX}.${instance}`;
}

export function plistPathFor(instance: Instance): string {
  const home = process.env.HOME || homedir();
  return join(home, "Library", "LaunchAgents", `${labelFor(instance)}.plist`);
}

// Returns the "gui/<uid>" service target launchctl understands. The uid is
// the current effective user. We read it from process.getuid because that's
// what the installed wrapper's domain will be at runtime; reading USER from
// the env can desync after `su` / sudo.
export function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

export function serviceTarget(instance: Instance): string {
  return `${guiDomain()}/${labelFor(instance)}`;
}

export interface LaunchSpec {
  // What launchd will exec. In installed-flow this is just the wrapper plus
  // run + --instance; in source-flow it's bun + entry script + run + flags.
  programArguments: string[];
  // Directory the runtime resolves project paths from. In installed-flow
  // that's ~/.gini/runtime (so `bun run` uses the right package.json);
  // in source-flow it's the repo root.
  workingDirectory: string;
  // PATH must include bun's dir so the wrapper can find it. We avoid bare
  // exec of a brittle absolute path so users who upgrade bun keep working.
  environment: Record<string, string>;
}

export interface ResolveLaunchOptions {
  instance: Instance;
  // Test seam: override the file-existence checks. Defaults wired to the
  // real filesystem in resolveLaunchSpec.
  fileExists?: (path: string) => boolean;
  // Test seam: pretend $HOME is somewhere else. Defaults to process.env.HOME
  // or os.homedir().
  homeOverride?: string;
  // Test seam: pretend a different bun is on PATH. Defaults to
  // process.execPath, which is correct under both `bun run` and a compiled
  // bun-driven entry.
  bunPathOverride?: string;
  // Test seam: pretend a different project root. Defaults to projectRoot().
  projectRootOverride?: string;
}

// Decide whether to point launchd at the installed wrapper or at the source
// checkout. The installed wrapper at ~/.local/bin/gini sources
// ~/.gini/secrets.env, sets GINI_INSTANCE, cds into ~/.gini/runtime, and
// execs `bun run gini`, which gives the LaunchAgent the same environment as
// the user's shell would.
//
// We deliberately also check that ~/.gini/runtime exists as a runtime
// checkout, not just that the wrapper file is present. A stale wrapper
// pointing at a deleted runtime dir would fail at exec time with no useful
// signal.
export function resolveLaunchSpec(options: ResolveLaunchOptions): LaunchSpec {
  const fileExists = options.fileExists ?? existsSync;
  const home = options.homeOverride ?? process.env.HOME ?? homedir();
  const bunPath = options.bunPathOverride ?? process.execPath;
  const repoRoot = options.projectRootOverride ?? projectRoot();
  const wrapperPath = join(home, ".local", "bin", "gini");
  const runtimeDir = join(home, ".gini", "runtime");

  const wrapperUsable = fileExists(wrapperPath)
    && isInstallerManagedWrapper(wrapperPath, fileExists)
    && fileExists(join(runtimeDir, "package.json"));

  // Always make bun's directory available on PATH so the wrapper (or `bun
  // run` in the source-flow branch) can resolve it. macOS launchd hands the
  // service a minimal PATH; we explicitly extend it rather than copy the
  // parent shell's because the agent must work across reboots too.
  const baseEnv: Record<string, string> = {
    PATH: buildLaunchAgentPath(bunPath, home),
    HOME: home,
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };

  if (wrapperUsable) {
    return {
      programArguments: [wrapperPath, "run", "--instance", options.instance, "--no-web"],
      workingDirectory: runtimeDir,
      environment: { ...baseEnv, GINI_INSTANCE: options.instance }
    };
  }

  // Source-flow: invoke `bun run gini run --instance <name>` from the
  // repo root. We pass the absolute path of bun so we don't depend on PATH
  // resolution at exec time (still set PATH in env for child invocations).
  return {
    programArguments: [bunPath, "run", "gini", "run", "--instance", options.instance, "--no-web"],
    workingDirectory: repoRoot,
    environment: { ...baseEnv, GINI_INSTANCE: options.instance }
  };
}

function isInstallerManagedWrapper(path: string, fileExists: (p: string) => boolean): boolean {
  if (!fileExists(path)) return false;
  try {
    const contents = readFileSync(path, "utf8");
    return contents.split("\n").some((line) => line.trim() === "# gini-agent-installer-managed");
  } catch {
    return false;
  }
}

function buildLaunchAgentPath(bunPath: string, home: string): string {
  const bunDir = dirname(resolve(bunPath));
  // Standard macOS PATH plus bun's dir. ~/.local/bin is included so the
  // wrapper itself is findable.
  const segments = [
    bunDir,
    `${home}/.local/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  return segments.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  }).join(":");
}

export interface PlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  // Where stdout/stderr go. Defaults are derived from the project's per-
  // instance log dir (runtime-stdout.log), matching what `gini start` writes.
  stdoutPath: string;
  stderrPath: string;
  // ThrottleInterval bounds how aggressively launchd respawns a crashing
  // service. 10s keeps a crashloop from melting CPU without making clean-stop
  // recovery painfully slow.
  throttleIntervalSeconds?: number;
}

export function generatePlist(options: PlistOptions): string {
  const throttle = options.throttleIntervalSeconds ?? 10;
  const label = labelFor(options.instance);
  const args = options.spec.programArguments.map(escapeXml).map((a) => `        <string>${a}</string>`).join("\n");
  const envEntries = Object.entries(options.spec.environment)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");

  // Per the ADR-style decisions in /tmp/claude-context-gini-autostart.md:
  //   - KeepAlive is a dict (not bool). SuccessfulExit:false means a clean
  //     `gini stop` (exit 0) is NOT respawned; anything non-zero IS. The
  //     NetworkState:true gate avoids relaunching the runtime before the
  //     network is up at boot.
  //   - ThrottleInterval:10 caps crashloop CPU.
  //   - RunAtLoad:true means it starts at user login.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(options.spec.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>NetworkState</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.stderrPath)}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface WritePlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  stdoutPath: string;
  stderrPath: string;
  throttleIntervalSeconds?: number;
}

export function writePlist(options: WritePlistOptions): string {
  const path = plistPathFor(options.instance);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generatePlist(options));
  return path;
}

export interface LaunchctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").toString(),
    stderr: (res.stderr ?? "").toString(),
    status: res.status ?? null
  };
}

// Probe whether launchctl knows the service. `launchctl print` returns
// non-zero when the label isn't loaded; we treat that as "not loaded".
export function isLoaded(instance: Instance): boolean {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  return res.ok;
}

// Read the live PID launchctl thinks the service is running as. Returns
// null if launchctl doesn't know about it OR the service is registered
// but not currently running (e.g. crashed inside ThrottleInterval). Used
// for status output.
export function loadedPid(instance: Instance): number | null {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  if (!res.ok) return null;
  // `launchctl print` output includes a `pid = NNN` line when running.
  // Format is stable across macOS 11+.
  const match = res.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  return match && match[1] ? Number(match[1]) : null;
}

// Read the last exit signal/status if launchctl recorded one. Useful for
// telling the user "service was running but exited with 1" in `status`.
export function loadedLastExitStatus(instance: Instance): string | null {
  const res = runLaunchctl(["print", serviceTarget(instance)]);
  if (!res.ok) return null;
  const match = res.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

export function bootstrap(instance: Instance, plistPath: string): LaunchctlResult {
  return runLaunchctl(["bootstrap", guiDomain(), plistPath]);
}

export function bootout(instance: Instance): LaunchctlResult {
  return runLaunchctl(["bootout", serviceTarget(instance)]);
}

export function kickstart(instance: Instance): LaunchctlResult {
  // `kickstart -k` forces a stop+start, used by `autostart enable` when the
  // service is already loaded so an updated plist takes effect immediately.
  return runLaunchctl(["kickstart", "-k", serviceTarget(instance)]);
}

export function platformIsSupported(): boolean {
  return process.platform === "darwin";
}

export function unsupportedPlatformMessage(): string {
  return `gini autostart is macOS-only in v1 (current platform: ${process.platform}). ` +
    `Linux systemd --user parity is a follow-up.`;
}

export const __testing = {
  isInstallerManagedWrapper,
  buildLaunchAgentPath,
  escapeXml
};
