import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import type { Instance, RuntimeConfig } from "./types";

// Per-instance default ports. The installed end-user instance (`default`,
// set by the ~/.local/bin/gini wrapper) is pinned to fixed memorable ports so
// users always know what URL to hit. All other instances — dev worktrees,
// smoke runs, named test instances — get deterministic per-instance defaults
// derived from a hash of the instance name so parallel instances coexist
// without manual `--port` wrangling.
const DEFAULT_WEB_PORT_PROD = 7777;
const DEFAULT_RUNTIME_PORT_PROD = 7778;
const RUNTIME_PORT_HASH_BASE = 7337;
const WEB_PORT_HASH_BASE = 3000;
const RUNTIME_PORT_RANGE = 100;
const WEB_PORT_RANGE = 100;

// FNV-1a 32-bit. Cheap, dependency-free, deterministic. We don't need
// cryptographic strength — just something that scatters instance names evenly
// across a 100-port window.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function defaultRuntimePort(instance: Instance): number {
  if (instance === "default") return DEFAULT_RUNTIME_PORT_PROD;
  return RUNTIME_PORT_HASH_BASE + (fnv1a(`runtime:${instance}`) % RUNTIME_PORT_RANGE);
}

export function defaultWebPort(instance: Instance): number {
  if (instance === "default") return DEFAULT_WEB_PORT_PROD;
  return WEB_PORT_HASH_BASE + (fnv1a(`web:${instance}`) % WEB_PORT_RANGE);
}

export function parseInstance(args = Bun.argv.slice(2)): Instance {
  const flagIndex = args.indexOf("--instance");
  if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
  if (process.env.GINI_INSTANCE) return process.env.GINI_INSTANCE;
  // No flag and no env → we're running `bun run gini ...` from a repo
  // checkout (the installed wrapper always sets GINI_INSTANCE=default). Derive
  // the instance from the repo root basename so each worktree gets isolated
  // state by default. Conductor parallel worktrees, casual clones, and CI all
  // land on a name that matches their directory without explicit --instance.
  return basename(projectRoot());
}

export function projectRoot(): string {
  return resolve(import.meta.dir, "..");
}

export function baseStateRoot(): string {
  return process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(homedir(), ".gini");
}

// Only honored when GINI_LOG_ROOT is set (tests / non-default deployments). The
// default layout nests logs inside the instance dir — see logDir().
export function baseLogRoot(): string | undefined {
  return process.env.GINI_LOG_ROOT ? resolve(process.env.GINI_LOG_ROOT) : undefined;
}

// All instance state lives under <baseStateRoot>/instances/<instance>/ so wiping every
// instance is a single rm -rf without touching the shared model cache or logs.
export function instancesRoot(): string {
  return join(baseStateRoot(), "instances");
}

export function instanceRoot(instance: Instance): string {
  return join(instancesRoot(), instance);
}

// One-time migration of legacy on-disk layouts to ~/.gini/instances/<name>/.
// We support two predecessor layouts in a single pass so users coming from
// either era end up in the same place:
//
//   1. ~/.gini/<name>/         (very old, pre-`lanes/`-prefix)
//   2. ~/.gini/lanes/<name>/   (recent, before the lane→instance rename)
//
// Detection: layout (1) directories sit directly under baseStateRoot and
// carry a config.json (which lets us skip reserved children logs/models/
// lanes/instances). Layout (2) is a literal `lanes/` directory next to the
// new `instances/`. Idempotent: skips entries that already moved.
export function migrateLegacyInstancePaths(): void {
  const root = baseStateRoot();
  if (!existsSync(root)) return;
  const newInstancesDir = instancesRoot();
  let migratedFromBare = 0;
  let migratedFromLanes = 0;

  // Layout (1): ~/.gini/<name>/  → ~/.gini/instances/<name>/
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "instances" || entry.name === "lanes" || entry.name === "logs" || entry.name === "models") continue;
    const oldDir = join(root, entry.name);
    if (!existsSync(join(oldDir, "config.json"))) continue;
    const newDir = join(newInstancesDir, entry.name);
    if (existsSync(newDir)) continue;
    mkdirSync(newInstancesDir, { recursive: true });
    renameSync(oldDir, newDir);
    migratedFromBare += 1;
  }

  // Layout (2): ~/.gini/lanes/<name>/  → ~/.gini/instances/<name>/
  const oldLanesDir = join(root, "lanes");
  if (existsSync(oldLanesDir)) {
    for (const entry of readdirSync(oldLanesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const oldDir = join(oldLanesDir, entry.name);
      const newDir = join(newInstancesDir, entry.name);
      if (existsSync(newDir)) continue;
      mkdirSync(newInstancesDir, { recursive: true });
      renameSync(oldDir, newDir);
      migratedFromLanes += 1;
    }
    // Drop the now-empty lanes/ shell. If the directory still has unexpected
    // residue (e.g. a partially migrated install) we leave it alone so the
    // user can investigate.
    try {
      const remaining = readdirSync(oldLanesDir);
      if (remaining.length === 0) {
        rmdirSync(oldLanesDir);
      }
    } catch {
      // Best-effort cleanup; ignore if we can't remove the empty shell.
    }
  }

  if (migratedFromBare > 0) {
    process.stderr.write(`Migrated ${migratedFromBare} instance(s) from ~/.gini/<name>/ to ~/.gini/instances/<name>/\n`);
  }
  if (migratedFromLanes > 0) {
    process.stderr.write(`Migrated ${migratedFromLanes} instance(s) from ~/.gini/lanes/<name>/ to ~/.gini/instances/<name>/\n`);
  }

  // Layout (3): logs used to live at ~/.gini/logs/<name>/ alongside instances/.
  // We now nest them inside the instance dir so a single rm -rf cleans up
  // everything for an instance. Skip if GINI_LOG_ROOT is set (the user opted
  // into a custom log root and we don't touch it).
  if (process.env.GINI_LOG_ROOT) return;
  const oldLogsDir = join(root, "logs");
  if (!existsSync(oldLogsDir)) return;
  let migratedLogs = 0;
  for (const entry of readdirSync(oldLogsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const oldDir = join(oldLogsDir, entry.name);
    const newDir = join(newInstancesDir, entry.name, "logs");
    if (existsSync(newDir)) continue;
    mkdirSync(join(newInstancesDir, entry.name), { recursive: true });
    renameSync(oldDir, newDir);
    migratedLogs += 1;
  }
  try {
    if (readdirSync(oldLogsDir).length === 0) rmdirSync(oldLogsDir);
  } catch {
    // best-effort cleanup
  }
  if (migratedLogs > 0) {
    process.stderr.write(`Migrated ${migratedLogs} instance log dir(s) from ~/.gini/logs/<name>/ to ~/.gini/instances/<name>/logs/\n`);
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function configPath(instance: Instance): string {
  return join(instanceRoot(instance), "config.json");
}

// Atomic config.json write. Concurrent readers (the web BFF reads on
// every tunneled request, the runtime reloads on certain operations)
// would otherwise observe a torn JSON during the writeFileSync call
// and JSON.parse would throw — defaulting tunnel state to disabled
// for the duration of the syscall, 404ing every in-flight tunneled
// request. The same tmp+rename pattern that state/store.ts uses for
// state.json applies here: writers stage to .tmp, then rename, and
// readers either see the prior file or the next file, never both.
export function writeConfigAtomic(instance: Instance, payload: unknown): void {
  ensureDir(instanceRoot(instance));
  const path = configPath(instance);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tempPath, path);
}

export function statePath(instance: Instance): string {
  return join(instanceRoot(instance), "state.json");
}

export function pidPath(instance: Instance): string {
  return join(instanceRoot(instance), "runtime.pid");
}

// Recorded port files. Written once `gini start` claims a port (which may
// differ from the instance default if the default was busy and the walk rolled
// forward). `gini status` / `stop` / `doctor` / `existingWebUrl` read these
// to know the actual live port without re-probing every default. Cleaned up
// on stop so a stale value doesn't bleed into the next start.
export function runtimePortPath(instance: Instance): string {
  return join(instanceRoot(instance), "runtime.port");
}

export function webPortPath(instance: Instance): string {
  return join(instanceRoot(instance), "web.port");
}

export function traceDir(instance: Instance): string {
  return join(instanceRoot(instance), "traces");
}

// Logs nest under the instance dir by default so a single `rm -rf
// ~/.gini/instances/<name>/` removes everything for that instance. Tests and
// custom deployments can still pin GINI_LOG_ROOT to keep logs separate.
export function logDir(instance: Instance): string {
  const overrideRoot = baseLogRoot();
  return overrideRoot ? join(overrideRoot, instance) : join(instanceRoot(instance), "logs");
}

export function skillsDir(instance: Instance): string {
  return join(instanceRoot(instance), "skills");
}

export function snapshotsDir(instance: Instance): string {
  return join(instanceRoot(instance), "snapshots");
}

export function tunnelLogPath(instance: Instance): string {
  return join(logDir(instance), "cloudflared.log");
}

export function workspaceDir(instance: Instance): string {
  return process.env.GINI_WORKSPACE
    ? resolve(process.env.GINI_WORKSPACE)
    : join(instanceRoot(instance), "workspace");
}

export function defaultConfig(instance: Instance): RuntimeConfig {
  const providerName = process.env.GINI_PROVIDER === "openai" || process.env.GINI_PROVIDER === "codex"
    ? process.env.GINI_PROVIDER
    : "echo";
  return {
    instance,
    port: Number(process.env.GINI_PORT ?? defaultRuntimePort(instance)),
    token: crypto.randomUUID(),
    provider: {
      name: providerName,
      model: process.env.GINI_MODEL ?? (providerName === "echo" ? "gini-echo-v0" : providerName === "codex" ? "gpt-5.5" : "gpt-5.4-mini"),
      apiKeyEnv: providerName === "openai" ? "OPENAI_API_KEY" : undefined
    },
    workspaceRoot: workspaceDir(instance),
    stateRoot: instanceRoot(instance),
    logRoot: logDir(instance),
    // New instances default to "auto": auto-approve safe actions, gate
    // dangerous terminal patterns. See ADR approval-mode.md. Legacy
    // configs with `dangerouslyAutoApprove: true` are aliased to "yolo"
    // at load time by `runtime/index.ts`.
    approvalMode: "auto"
  };
}

export function loadConfig(instance: Instance): RuntimeConfig {
  migrateLegacyInstancePaths();
  ensureDir(instanceRoot(instance));
  ensureDir(traceDir(instance));
  ensureDir(logDir(instance));
  ensureDir(skillsDir(instance));
  ensureDir(snapshotsDir(instance));
  ensureDir(workspaceDir(instance));

  const path = configPath(instance);
  if (!existsSync(path)) {
    const config = defaultConfig(instance);
    writeConfigAtomic(instance, config);
    return config;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  // Don't let the `defaultConfig` spread below stamp `approvalMode:
  // "auto"` onto a legacy config that carries `dangerouslyAutoApprove:
  // true` without an explicit `approvalMode`. Leaving the field
  // undefined here is what lets the install-time migration shim
  // detect "this is a pre-flip config" and alias it to "yolo".
  // Synthesizing a `defaultConfig` without `approvalMode` for the
  // legacy case keeps the legacy detection working without changing
  // any other default.
  const defaults = defaultConfig(instance);
  const isLegacyDangerousFile = parsed.approvalMode === undefined && parsed.dangerouslyAutoApprove === true;
  if (isLegacyDangerousFile) {
    delete (defaults as { approvalMode?: unknown }).approvalMode;
  }
  // Pre-flip existing instance: on-disk config has neither
  // `approvalMode` nor `dangerouslyAutoApprove`. Pre-flip, this
  // instance's effective behavior was "gate everything"; post-flip,
  // the merged defaults stamp `approvalMode: "auto"` and the
  // effective behavior silently changes to "auto-approve safe
  // actions". Emit a one-time `config.migrated` audit row marking
  // that change. We propagate the signal to `install()` via a
  // Symbol-keyed marker so it survives in-memory but does NOT get
  // serialized to disk (JSON.stringify skips symbol-keyed props).
  const isPreFlipExistingFile =
    parsed.approvalMode === undefined && parsed.dangerouslyAutoApprove === undefined;
  const persistedRoot = parsed.workspaceRoot ? resolve(parsed.workspaceRoot) : "";
  const repoRoot = projectRoot();
  // Detect persisted paths from any pre-`instances/` layout. Three predecessor
  // shapes can show up here:
  //   - ~/.gini/<instance>/...     (very old, pre-`lanes/`-prefix)
  //   - ~/.gini/lanes/<instance>/  (recent, pre lane→instance rename)
  //   - <repoRoot>                 (an even older default that pointed at the
  //                                 checkout itself)
  // Re-derive to the new location instead of keeping the stale absolute path.
  const oldBareInstancePrefix = join(baseStateRoot(), instance) + "/";
  const oldLanesInstancePrefix = join(baseStateRoot(), "lanes", instance) + "/";
  const persistedIsOldBare = persistedRoot.startsWith(oldBareInstancePrefix) || persistedRoot === join(baseStateRoot(), instance);
  const persistedIsOldLanes = persistedRoot.startsWith(oldLanesInstancePrefix) || persistedRoot === join(baseStateRoot(), "lanes", instance);
  const persistedIsRepoRoot = persistedRoot === repoRoot;
  const needsRewrite = persistedIsOldBare || persistedIsOldLanes || persistedIsRepoRoot || !persistedRoot;
  const migratedWorkspaceRoot = needsRewrite ? workspaceDir(instance) : persistedRoot;
  const merged: RuntimeConfig = {
    ...defaults,
    ...parsed,
    instance,
    workspaceRoot: migratedWorkspaceRoot,
    stateRoot: instanceRoot(instance),
    logRoot: logDir(instance)
  };
  if (isPreFlipExistingFile) {
    // Symbol key so the marker survives in-memory for `install()` to
    // consult but is dropped by JSON.stringify (it skips symbol keys)
    // so it never lands on disk.
    (merged as unknown as Record<symbol, unknown>)[PRE_FLIP_MIGRATION_MARKER] = true;
  }
  if (needsRewrite) writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// Transient marker stamped onto a freshly-loaded config when the
// on-disk file predates the approval-mode default flip (file exists
// but carries neither `approvalMode` nor `dangerouslyAutoApprove`).
// `install()` reads this to emit the one-time `config.migrated`
// audit row. Symbol keys are non-enumerable by default for
// JSON.stringify so the marker never lands on disk.
export const PRE_FLIP_MIGRATION_MARKER = Symbol.for("gini.preFlipApprovalMigration");

export function hasPreFlipMigrationMarker(config: RuntimeConfig): boolean {
  return (config as unknown as Record<symbol, unknown>)[PRE_FLIP_MIGRATION_MARKER] === true;
}
