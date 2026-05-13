// macOS LaunchAgent integration: write a per-instance plist set (gateway +
// web), register them with `launchctl bootstrap gui/<uid>`, and tear them
// down with `launchctl bootout`.
//
// What this exists for: after `gini install` runs, the user expects BOTH the
// runtime gateway AND the Next.js webapp to be running and to stay running
// across crashes and logins. On macOS the supported way to achieve that for
// a per-user, foreground-session service is a user-domain LaunchAgent under
// ~/Library/LaunchAgents/. System daemons (~/.../Library/LaunchDaemons/)
// can't reach the user's Keychain, which would break Codex auth.
//
// Two plists per instance:
//   - `<prefix>.<instance>.gateway` — the Bun runtime (src/server.ts)
//   - `<prefix>.<instance>.web`     — Next.js dev server, gated on the
//                                     gateway's /api/healthz coming up
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Instance } from "../types";
import { defaultWebPort, projectRoot } from "../paths";

export const LABEL_PREFIX = "ai.lilac.gini";

export type PlistKind = "gateway" | "web";

// The legacy single-plist label `ai.lilac.gini.<instance>` (round 1).
// `labelFor()` keeps returning this for callers that still want a single
// instance handle (e.g. internal logging, label tests). New code that
// distinguishes the gateway/web pair should use `labelForKind`.
export function labelFor(instance: Instance): string {
  return `${LABEL_PREFIX}.${instance}`;
}

export function labelForKind(instance: Instance, kind: PlistKind): string {
  return `${LABEL_PREFIX}.${instance}.${kind}`;
}

export function plistPathFor(instance: Instance, kind?: PlistKind): string {
  const home = process.env.HOME || homedir();
  const label = kind ? labelForKind(instance, kind) : labelFor(instance);
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// Returns the "gui/<uid>" service target launchctl understands. The uid is
// the current effective user. We read it from process.getuid because that's
// what the installed wrapper's domain will be at runtime; reading USER from
// the env can desync after `su` / sudo.
export function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

export function serviceTarget(instance: Instance, kind?: PlistKind): string {
  const label = kind ? labelForKind(instance, kind) : labelFor(instance);
  return `${guiDomain()}/${label}`;
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

export interface LaunchSpecPair {
  gateway: LaunchSpec;
  web: LaunchSpec;
  // Recorded for `status`/diagnostics: which working-directory path
  // resolution picked (installed vs source).
  resolution: "installed" | "source";
}

export interface ResolveLaunchOptions {
  instance: Instance;
  // Test seam: override the file-existence checks. Defaults wired to the
  // real filesystem in resolveLaunchSpec.
  fileExists?: (path: string) => boolean;
  // Test seam / production: provide the file body of ~/.gini/secrets.env
  // so we can merge OPENAI_API_KEY (and friends) into the plist's
  // EnvironmentVariables. Defaults to reading the file from disk.
  readSecretsFile?: () => string | null;
  // Test seam: pretend $HOME is somewhere else. Defaults to process.env.HOME
  // or os.homedir().
  homeOverride?: string;
  // Test seam: pretend a different bun is on PATH. Defaults to
  // process.execPath, which is correct under both `bun run` and a compiled
  // bun-driven entry.
  bunPathOverride?: string;
  // Test seam: pretend a different project root. Defaults to projectRoot().
  projectRootOverride?: string;
  // Test seam: pretend a different cwd when deciding source-vs-installed.
  // Defaults to process.cwd().
  cwdOverride?: string;
  // Opt-in scratch state/log root for E2E tests. When set, GINI_STATE_ROOT
  // (and GINI_LOG_ROOT) are embedded in the plist's EnvironmentVariables
  // so launchd-spawned runtime + web both point at the scratch dirs. In
  // production this is undefined and the plist gets a minimal env — no
  // leak of shell-level GINI_STATE_ROOT into a permanent launchd record.
  testRoot?: { stateRoot?: string; logRoot?: string };
}

// Build the launchd command line. We exec the Bun-driven runtime *directly*
// — `bun run src/server.ts --instance <name>` — instead of going through the
// `~/.local/bin/gini` wrapper or `gini run`. Two reasons:
//
//   1. Single-process job. The wrapper/CLI path spawns a chain
//      (bash → bun → bun → bun-server). When launchd kills the head, child
//      processes can outlive the head briefly and exit cleanly via their
//      own SIGTERM handlers; launchd then sees a "successful exit" for the
//      job and KeepAlive.SuccessfulExit:false suppresses respawn. Direct
//      exec collapses the tree to one process, so SIGKILL = signal exit
//      and KeepAlive respawns reliably.
//
//   2. Exit code is what we control. The server's SIGTERM handler
//      (src/server.ts) does process.exit(0), so `launchctl stop` (or
//      `gini stop` SIGTERM) produces a clean exit; KeepAlive.SuccessfulExit:false
//      then honors that intent and won't respawn.
//
// Source-flow vs installed-flow decision: if we're invoked from a gini-agent
// source checkout (cwd has package.json with name "gini-agent"), prefer
// that. Otherwise, fall back to `~/.gini/runtime` when it's a usable
// checkout, then to the resolved project root. Without the cwd-aware
// check, a developer running `bun run gini autostart enable` from a
// worktree would silently supervise the installed runtime instead of
// their checkout — surprising and wrong.
export function resolveLaunchSpec(options: ResolveLaunchOptions): LaunchSpec {
  const pair = resolveLaunchSpecPair(options);
  return pair.gateway;
}

export function resolveLaunchSpecPair(options: ResolveLaunchOptions): LaunchSpecPair {
  const fileExists = options.fileExists ?? existsSync;
  const home = options.homeOverride ?? process.env.HOME ?? homedir();
  const bunPath = options.bunPathOverride ?? process.execPath;
  const repoRoot = options.projectRootOverride ?? projectRoot();
  const cwd = options.cwdOverride ?? process.cwd();
  const runtimeDir = join(home, ".gini", "runtime");

  const runtimeUsable = fileExists(join(runtimeDir, "package.json"))
    && fileExists(join(runtimeDir, "src", "server.ts"));

  // Source-flow detection: cwd is a gini-agent checkout (package.json
  // declares name "gini-agent"). We check both cwd and repoRoot because
  // someone could `bun run gini autostart enable` with cwd in a sub-dir
  // and projectRoot() would still be the repo root.
  const cwdIsSource = isGiniAgentCheckout(cwd, fileExists);
  const repoRootIsSource = isGiniAgentCheckout(repoRoot, fileExists);
  // Prefer source flow when invoked from a source checkout — that's the
  // developer's intent. Fall back to installed flow otherwise.
  const preferSource = cwdIsSource || repoRootIsSource;
  const useSource = preferSource || !runtimeUsable;
  const resolution: "installed" | "source" = useSource ? "source" : "installed";
  const workingDirectory = useSource ? (cwdIsSource ? cwd : repoRoot) : runtimeDir;

  // Always make bun's directory available on PATH so child invocations
  // (e.g. `bun install` triggers from inside the runtime) can resolve it.
  // macOS launchd hands the service a minimal PATH; we explicitly extend
  // it rather than copy the parent shell's because the agent must work
  // across reboots too.
  const baseEnv: Record<string, string> = {
    PATH: buildLaunchAgentPath(bunPath, home),
    HOME: home,
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };
  // Opt-in: only propagate GINI_STATE_ROOT / GINI_LOG_ROOT into the plist
  // when an explicit testRoot is passed. Reading them from process.env
  // would bake whatever scratch path the developer's shell currently has
  // into the persistent plist — a footgun. Tests that need the override
  // pass testRoot explicitly.
  if (options.testRoot?.stateRoot) baseEnv.GINI_STATE_ROOT = options.testRoot.stateRoot;
  if (options.testRoot?.logRoot) baseEnv.GINI_LOG_ROOT = options.testRoot.logRoot;

  // Merge ~/.gini/secrets.env into the plist environment. The installed
  // `gini` wrapper sources this file at the top of every invocation, but
  // the autostart plist execs `bun run src/server.ts` directly (no shell
  // sourcing) — so without this merge the launchd-spawned runtime has no
  // OPENAI_API_KEY in its env and the provider throws. We read the file
  // every time `autostart enable` is called, so `gini provider set` →
  // re-enable picks up new keys automatically.
  const secretsBody = options.readSecretsFile
    ? options.readSecretsFile()
    : readSecretsEnvFile(home);
  const secretsEnv = secretsBody ? parseSecretsEnv(secretsBody) : {};

  const gatewayEnv: Record<string, string> = {
    ...baseEnv,
    ...secretsEnv,
    GINI_INSTANCE: options.instance
  };

  const gateway: LaunchSpec = {
    programArguments: [bunPath, "run", "src/server.ts", "--instance", options.instance],
    workingDirectory,
    environment: gatewayEnv
  };

  // Web plist: same working directory (the repo or installed runtime),
  // but exec'd via an inline `sh -c` shim that polls /api/healthz on the
  // gateway port before starting Next.js. Without the gate, the web
  // process boots before the gateway, the BFF's first requests fail
  // (ECONNREFUSED), and the user sees a broken UI for the first ~5s
  // after every login. The shim's `exec bun run dev …` collapses the
  // shell into Next.js so the launchd-tracked PID is the dev server,
  // not the wrapper.
  const webEnv: Record<string, string> = {
    ...baseEnv,
    ...secretsEnv,
    GINI_INSTANCE: options.instance,
    // The `bun run dev` invocation otherwise defaults to Next.js's 3000.
    // For instances other than `main`/`dev`, that would collide with
    // whatever else is using 3000. Pin to the per-instance default that
    // `gini start` would have picked.
    PORT: String(defaultWebPort(options.instance))
  };
  // sh -c arg vector. We exec `bun run dev` from the web/ subdir, after
  // polling the gateway runtime port file or 127.0.0.1:<port>/api/status.
  // The port for the instance is recorded at <stateRoot>/instances/<inst>/runtime.port
  // (written by the gateway at startup). We can't easily compute the
  // default-by-instance hash from sh, so we read the file the gateway
  // writes; until it appears (cold boot), we fall back to the default
  // gateway port for instance 'main' and to a 30s timeout overall.
  const shim = buildWebShim(options.instance);
  const web: LaunchSpec = {
    programArguments: ["/bin/sh", "-c", shim],
    workingDirectory,
    environment: webEnv
  };

  return { gateway, web, resolution };
}

// Read ~/.gini/secrets.env. Returns null when missing; never throws on
// read errors (a quarantined file would otherwise block `autostart enable`).
function readSecretsEnvFile(home: string): string | null {
  const path = join(home, ".gini", "secrets.env");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Parse a shell-format `KEY=VALUE` file (the same shape writeKeyToSecretsFile
// produces). Supports `export KEY=value`, bare `KEY=value`, single-quoted,
// double-quoted, and unquoted values. Comments and blank lines are skipped.
// Values are returned in their final unescaped form, ready to drop into
// launchd's EnvironmentVariables.
export function parseSecretsEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    out[key] = unquoteSecretsValue(match[2] ?? "");
  }
  return out;
}

function unquoteSecretsValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

function isGiniAgentCheckout(dir: string, fileExists: (path: string) => boolean): boolean {
  const pkg = join(dir, "package.json");
  if (!fileExists(pkg)) return false;
  try {
    const body = readFileSync(pkg, "utf8");
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name === "gini-agent";
  } catch {
    return false;
  }
}

// Build the sh -c body that gates `bun run dev` on the gateway becoming
// healthy. Polls the runtime port file (written by src/server.ts on boot)
// and then /api/status until it returns 200 OR a 60s budget elapses. We
// poll the port file rather than guessing the port from instance hashing
// because the runtime walks ports under contention. Final `exec bun run
// dev` replaces the shell with Next.js so launchd tracks the dev server's
// PID directly.
//
// HOME is set by launchd from EnvironmentVariables; we expand it inline so
// the script doesn't depend on a parent process env. The instance dir
// path matches `src/paths.ts` (instances/<inst>/runtime.port).
function buildWebShim(instance: Instance): string {
  // Reject suspicious instance names defensively. CLI validation (and the
  // dir-name layout) already restricts instances to alphanumerics, dashes,
  // and underscores, but we'd rather fail at write time than emit a shim
  // that could be coerced. A hostile instance name that slips past CLI
  // validation here would land inside a shell-double-quoted path and could
  // break out via `$(...)` or `${...}`; we forbid those characters.
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) {
    throw new Error(`autostart: refusing to embed instance name '${instance}' in launchd shim — name must match [A-Za-z0-9._-]+`);
  }
  // GINI_STATE_ROOT is propagated into the env via the plist when --test-root
  // is passed; absent that, the runtime uses ~/.gini. We honor the same
  // logic here so the web shim talks to the same state dir as the gateway:
  // ${GINI_STATE_ROOT:-$HOME/.gini}.
  // 120 attempts * 0.5s = 60s budget. The gateway typically lands in
  // under 3s on warm caches.
  return [
    // Propagate SIGTERM during the polling phase. Without this, launchctl
    // bootout while the shim is sleeping in the poll loop would interrupt
    // the sleep, walk to the next iteration, and only exit when the
    // overall loop completes. Trapping → exit 0 makes the polling phase
    // honor KeepAlive.SuccessfulExit:false the same way the runtime does.
    // Once `exec bun run dev` runs, the shell is gone and bun handles
    // SIGTERM directly.
    `trap 'exit 0' TERM INT`,
    `cd web 2>/dev/null || true`,
    `state_root="\${GINI_STATE_ROOT:-$HOME/.gini}"`,
    `port_file="$state_root/instances/${instance}/runtime.port"`,
    `instance_root="$state_root/instances/${instance}"`,
    // 1) Wait for the gateway port file to appear and have a value.
    `port=""`,
    `for i in $(seq 1 120); do`,
    `  if [ -f "$port_file" ]; then`,
    `    port=$(cat "$port_file" 2>/dev/null | tr -d '[:space:]')`,
    `    if [ -n "$port" ]; then break; fi`,
    `  fi`,
    `  sleep 0.5`,
    `done`,
    // 2) If we have a port, poll the gateway until it responds at all.
    // /api/status returns 401 without auth, but we don't need a 2xx —
    // any HTTP response means the runtime is up. -sS without -f keeps
    // curl from failing on the 401; -o /dev/null + --max-time 2 stops
    // a hung gateway from blocking the loop forever.
    `if [ -n "$port" ]; then`,
    `  for i in $(seq 1 120); do`,
    `    if curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null; then break; fi`,
    `    sleep 0.5`,
    `  done`,
    `fi`,
    // 3) Record the *future* bun PID so `gini stop` can SIGTERM it.
    // We use $$ — the current shell's PID — which `exec` will reuse for
    // the bun process below (exec replaces the shell with bun, keeping
    // the same PID).
    `mkdir -p "$instance_root" 2>/dev/null || true`,
    `echo $$ > "$instance_root/web.pid"`,
    // 4) Hand off to Next.js. exec so launchd tracks dev server PID.
    `exec bun run dev`
  ].join("\n");
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
  // Which member of the (gateway, web) pair this plist is. Defaults to
  // omitted, which preserves the legacy single-plist label
  // `ai.lilac.gini.<instance>` — kept for compatibility with tests that
  // assert the historical shape. New code should always pass a kind.
  kind?: PlistKind;
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
  const label = options.kind ? labelForKind(options.instance, options.kind) : labelFor(options.instance);
  const args = options.spec.programArguments.map(escapeXml).map((a) => `        <string>${a}</string>`).join("\n");
  const envEntries = Object.entries(options.spec.environment)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");

  // Per the ADR-style decisions in /tmp/claude-context-gini-autostart.md:
  //   - KeepAlive is a dict (not bool). SuccessfulExit:false means a clean
  //     `gini stop` (exit 0) is NOT respawned; anything non-zero IS.
  //   - ThrottleInterval:10 caps crashloop CPU.
  //   - RunAtLoad:true means it starts at user login.
  //
  // NetworkState was considered (would gate first-boot launches until the
  // network came up) but launchd treats NetworkState as a *pended-spawn
  // semaphore*: even after a non-zero exit, the next spawn waits for a
  // network-state transition, which doesn't fire when the network was
  // already up. Empirically that prevents respawn-after-SIGKILL entirely.
  // The runtime tolerates a network-not-yet-up startup (provider auth
  // retries with backoff), so dropping NetworkState gets us the contract
  // that matters — clean `gini stop` honored, crash respawned.
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
  kind?: PlistKind;
  stdoutPath: string;
  stderrPath: string;
  throttleIntervalSeconds?: number;
}

export function writePlist(options: WritePlistOptions): string {
  const path = plistPathFor(options.instance, options.kind);
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
export function isLoaded(instance: Instance, kind?: PlistKind): boolean {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  return res.ok;
}

// Read the live PID launchctl thinks the service is running as. Returns
// null if launchctl doesn't know about it OR the service is registered
// but not currently running (e.g. crashed inside ThrottleInterval). Used
// for status output.
export function loadedPid(instance: Instance, kind?: PlistKind): number | null {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  if (!res.ok) return null;
  // `launchctl print` output includes a `pid = NNN` line when running.
  // Format is stable across macOS 11+.
  const match = res.stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  return match && match[1] ? Number(match[1]) : null;
}

// Read the last exit signal/status if launchctl recorded one. Useful for
// telling the user "service was running but exited with 1" in `status`.
export function loadedLastExitStatus(instance: Instance, kind?: PlistKind): string | null {
  const res = runLaunchctl(["print", serviceTarget(instance, kind)]);
  if (!res.ok) return null;
  const match = res.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

export function bootstrap(instance: Instance, plistPath: string): LaunchctlResult {
  return runLaunchctl(["bootstrap", guiDomain(), plistPath]);
}

export function bootout(instance: Instance, kind?: PlistKind): LaunchctlResult {
  return runLaunchctl(["bootout", serviceTarget(instance, kind)]);
}

export function kickstart(instance: Instance, kind?: PlistKind): LaunchctlResult {
  // `kickstart -k` forces a stop+start, used by `autostart enable` when the
  // service is already loaded so an updated plist takes effect immediately.
  return runLaunchctl(["kickstart", "-k", serviceTarget(instance, kind)]);
}

export function platformIsSupported(): boolean {
  return process.platform === "darwin";
}

export function unsupportedPlatformMessage(): string {
  return `gini autostart is macOS-only in v1 (current platform: ${process.platform}). ` +
    `Linux systemd --user parity is a follow-up.`;
}

export const __testing = {
  buildLaunchAgentPath,
  escapeXml,
  buildWebShim,
  isGiniAgentCheckout
};
