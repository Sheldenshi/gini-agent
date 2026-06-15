import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import type { Instance, RuntimeConfig } from "./types";
import { atomicWriteFile } from "./atomic-write";

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

// Machine-global marker present while `updateRuntime` (src/runtime/update.ts)
// is rewriting the installed runtime at ~/.gini/runtime: git reset, the bun
// installs, and the web production build. Global (not per-instance) because
// the installed runtime is shared by every instance served from it. The
// watchdog reads it each tick and suppresses revive actions while the file
// is fresh (<15 min) — probe misses are expected during the install/build
// window, and a `kickstart -k` then would force-kill a healthy-but-busy
// service. The writer removes it in a finally; the freshness cutoff keeps a
// crashed update from disarming the watchdog forever.
export function updateInProgressMarkerPath(): string {
  return join(baseStateRoot(), "update-in-progress");
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

// The gini-relay credential store home for an instance (device.json +
// session.json). Per-instance so multiple instances on one machine don't share
// a single relay device/session and stomp each other's tunnel (the default
// ~/.gini-relay is global). See ADR tunnel-connectivity.md.
export function relayHome(instance: Instance): string {
  return join(instanceRoot(instance), "relay");
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

export function workspaceDir(instance: Instance): string {
  return process.env.GINI_WORKSPACE
    ? resolve(process.env.GINI_WORKSPACE)
    : join(instanceRoot(instance), "workspace");
}

export function uploadsDir(instance: Instance): string {
  return join(instanceRoot(instance), "uploads");
}

// Files the agent's browser saves via the approval-gated browser_download
// tool. Instance-scoped (like uploads/) so removing the instance dir removes
// every downloaded artifact with it. See ADR browser-automation-engine.md.
export function downloadsDir(instance: Instance): string {
  return join(instanceRoot(instance), "downloads");
}

// Playwright trace archives written by the opt-in browser session
// recording (RuntimeConfig.browserRecording). Instance-scoped like
// downloads/; bounded retention is enforced by the writer in
// src/tools/browser.ts.
export function browserTracesDir(instance: Instance): string {
  return join(instanceRoot(instance), "browser-traces");
}

export function defaultConfig(instance: Instance): RuntimeConfig {
  // Platform default fallback is codex/gpt-5.5. Users without `codex` CLI
  // auth will hit a runtime error on first prompt — that's the accepted
  // tradeoff for not landing on the placeholder `echo` provider.
  //
  // The allow-list here is intentionally wider than the `gini install`
  // validator: `echo` is recognized here ONLY because the ephemeral smoke
  // path pins GINI_PROVIDER=echo (src/cli/args.ts) and smoke materializes
  // its config directly through defaultConfig() — it does NOT flow through
  // install_(). Without this branch, smoke would fall through to the
  // codex default and call the real codex backend with a nonsense model.
  // The user-facing `gini install` path forbids echo; see admin.ts.
  const envProvider = process.env.GINI_PROVIDER;
  const providerName: "openai" | "codex" | "echo" =
    envProvider === "openai" || envProvider === "codex" || envProvider === "echo"
      ? envProvider
      : "codex";
  const defaultModelFor: Record<"openai" | "codex" | "echo", string> = {
    codex: "gpt-5.5",
    openai: "gpt-5.4-mini",
    echo: "gini-echo-v0"
  };
  return {
    instance,
    port: Number(process.env.GINI_PORT ?? defaultRuntimePort(instance)),
    token: crypto.randomUUID(),
    provider: {
      name: providerName,
      model: process.env.GINI_MODEL ?? defaultModelFor[providerName],
      apiKeyEnv: providerName === "openai" ? "OPENAI_API_KEY" : undefined
    },
    workspaceRoot: workspaceDir(instance),
    stateRoot: instanceRoot(instance),
    logRoot: logDir(instance),
    // Fresh installs default to "yolo": full bypass of every approval
    // gate. This is the install template only. Existing on-disk configs
    // that predate an explicit `approvalMode` are NOT escalated to yolo
    // — `loadConfig` backfills "auto" for them so the default flip never
    // silently removes approval gates from an instance the operator
    // already created. See ADR approval-mode.md. Legacy configs with
    // `dangerouslyAutoApprove: true` are aliased to "yolo" at load time
    // by `runtime/index.ts`.
    approvalMode: "yolo"
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
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  // One-time migration: an earlier release configured Azure as a MODE of the
  // `openai` provider — {name:"openai", apiVersion, deployment, authScheme,
  // baseUrl:<azure-host>}. Azure is now a first-class `azure` provider keyed on
  // provider.name, and normalizeProvider drops those fields for `openai`, so a
  // persisted azure-on-openai config would silently route to the flat
  // api.openai.com path and break. An `apiVersion` on an `openai` config only
  // ever came from that azure-on-openai path, so rewrite it to the `azure`
  // provider here (mirrors the dangerouslyAutoApprove → approvalMode shim
  // below). The rewrite is persisted via `needsRewrite` so it runs once.
  const migratedAzureFromOpenai =
    parsed.provider?.name === "openai" && (parsed.provider.apiVersion?.trim().length ?? 0) > 0;
  if (migratedAzureFromOpenai) {
    const legacy = parsed.provider;
    parsed.provider = {
      ...legacy,
      name: "azure",
      // Preserve the env var the key actually lives under. The azure-on-openai
      // config wrote its key to OPENAI_API_KEY by default (or to a custom
      // apiKeyEnv), and this migration only rewrites config.json — it does NOT
      // move the secret in secrets.env. Switching apiKeyEnv to
      // AZURE_OPENAI_API_KEY would point the migrated provider at an empty var
      // and break a working config, so carry the existing apiKeyEnv (defaulting
      // to OPENAI_API_KEY for the no-custom-env case).
      apiKeyEnv: legacy.apiKeyEnv ?? "OPENAI_API_KEY"
    };
  }
  // `defaultConfig` is both the fresh-install template (which stamps
  // "yolo") AND the merge base for existing files below. An existing
  // on-disk config that predates an explicit `approvalMode` must NOT
  // inherit the "yolo" install default — that would silently strip
  // every approval gate from an instance the operator never opted into.
  // So for an existing file without `approvalMode`, override the merge
  // base instead of letting "yolo" through:
  //   - `dangerouslyAutoApprove: true` → drop `approvalMode` so the
  //     install-time migration shim aliases it to "yolo" (legacy
  //     behavior, audited as `from: "dangerouslyAutoApprove: true"`).
  //   - otherwise → backfill "auto" so pre-flip / explicit-false files
  //     keep their documented effective mode and the pre-flip migration
  //     records `to: "auto"`.
  const defaults = defaultConfig(instance);
  if (parsed.approvalMode === undefined) {
    if (parsed.dangerouslyAutoApprove === true) {
      delete (defaults as { approvalMode?: unknown }).approvalMode;
    } else {
      defaults.approvalMode = "auto";
    }
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
  const needsRewrite = persistedIsOldBare || persistedIsOldLanes || persistedIsRepoRoot || !persistedRoot || migratedAzureFromOpenai;
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

/** Atomic write of the runtime config. Replaces every
 *  `writeFileSync(configPath(...), JSON.stringify(config, null, 2) + "\n")`
 *  call site in the codebase so a `config.json` reader can never observe
 *  a torn JSON document. Uses a tempfile + fsync + rename so readers
 *  either see the OLD complete file or the NEW complete file, never a
 *  partial. */
export function writeRuntimeConfig(config: RuntimeConfig): void {
  atomicWriteFile(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
}
