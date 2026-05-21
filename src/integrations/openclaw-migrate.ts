// Openclaw → gini migration.
//
// Reads a user's openclaw state root (default `~/.openclaw/`, override via
// `OPENCLAW_STATE_DIR` or an explicit path argument) and translates the
// pieces gini knows how to host into the running gini instance.
//
// What migrates today:
//   - Agents listed under `cfg.agents.list[]` (one gini AgentRecord per
//     openclaw agent id; the `default: true` agent maps to its
//     openclaw id as the gini agent name — the existing gini
//     `agent_default` row is left alone so users don't lose their seeded
//     defaults).
//   - Provider API keys harvested from
//     `<state>/agents/<id>/agent/auth-profiles.json`. Plaintext keys land
//     in `~/.gini/secrets.env` keyed by `<PROVIDER>_API_KEY` (the same
//     convention `gini setup` uses).
//   - Telegram + Discord messaging bridges. Bot tokens come from openclaw
//     `cfg.env.vars.<NAME>` first, then the state-dir `.env` file. Each
//     resulting `MessagingBridgeRecord` gets an encrypted secret via the
//     same `writeSecret(instance, "messaging.<bridgeId>", "bot-token", …)`
//     path the live HTTP create endpoint uses, so the bridge is bootable
//     without a re-pair flow. Telegram allowlists are read from
//     `<state>/credentials/telegram-allowFrom.json` and copied into
//     `metadata.allowedChatIds` as numbers.
//   - User skills under `<state>/skills/<name>/SKILL.md`. The SKILL.md
//     body is rewritten so a top-level `openclaw:` frontmatter block
//     becomes `metadata:\n  gini:` — gini's spec-compliant nesting — and
//     the file is copied into `<gini-instance>/skills/<name>/SKILL.md`.
//     Sibling files in the skill dir (scripts/, references/, etc.) are
//     copied verbatim. Existing same-named skills are skipped.
//   - Workspace bootstrap markdown (`AGENTS.md`, `SOUL.md`, `TOOLS.md`,
//     `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`,
//     `MEMORY.md`) from openclaw's `~/.openclaw/workspace/` into the gini
//     instance workspace. The set mirrors openclaw's
//     `BOOTSTRAP_FILENAMES` constant verbatim. Existing same-named files
//     are skipped (no overwrite by default).
//
// What is intentionally NOT migrated:
//   - Hindsight memory SQLite (`<state>/memory/<id>.sqlite`). Openclaw and
//     gini both use SQLite, but the schemas don't align. Memory is
//     captured in the import report's `unsupported` list so the operator
//     knows to re-train.
//   - Session transcripts (`<state>/agents/<id>/sessions/`). The Claude-CLI
//     handoff openclaw uses doesn't have a gini equivalent.
//   - Tasks/jobs registries, plugin installs, device-pair state. These
//     either belong to features gini doesn't ship or to runtime state
//     that's safer to re-establish.
//
// All mutations land via `mutateState` so the per-instance lock and
// audit chain run unchanged. Secrets never appear in the plan summary —
// `summarizePlan` redacts them. The CLI prints the summary; only the
// in-process apply path sees plaintexts.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ImportReport,
  Instance,
  MessagingBridgeRecord,
  RuntimeConfig
} from "../types";
import {
  addAudit,
  createAgentRecord,
  createImportReport,
  id,
  mutateState,
  now
} from "../state";
import { writeSecret } from "../state/secrets";
import { secretsEnvHasKey, writeKeyToSecretsEnv } from "../state/secrets-env";
import { pidPath, skillsDir } from "../paths";
import { assertHeaderSafeToken } from "./messaging";
import { normalizeProvider } from "../provider";

// --- Public types ---

export interface OpenclawDiscovery {
  stateRoot: string;
  configPath: string | null;
  workspaceRoot: string | null;
  credentialsDir: string;
  skillsDir: string;
  agentsDir: string;
}

// Openclaw's AgentModelConfig (cribbed verbatim from
// `/tmp/openclaw/src/config/types.agents-shared.ts:8-15`): either a
// "provider/model" string or an object with `primary` plus optional
// `fallbacks`. We only need the primary slot for the migration since
// gini stores a single provider+model per agent today.
type OpenclawAgentModelConfig = string | { primary?: string; fallbacks?: string[] };

interface OpenclawAgentConfig {
  id?: string;
  default?: boolean;
  model?: OpenclawAgentModelConfig;
  workspace?: string;
}

interface OpenclawChannelConfig {
  dmPolicy?: string;
  allowFrom?: string[];
  [key: string]: unknown;
}

export interface OpenclawConfig {
  agents?: {
    defaults?: { workspace?: string; model?: OpenclawAgentModelConfig };
    list?: OpenclawAgentConfig[];
  };
  channels?: Record<string, OpenclawChannelConfig>;
  env?: {
    vars?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// MigrationPlan is the full internal plan with plaintext values. It is NOT
// safe to print as-is. Use `summarizePlan` for the print-safe view.
export interface MigrationPlan {
  source: { stateRoot: string; configExists: boolean };
  steps: MigrationStep[];
  unsupported: UnsupportedItem[];
}

export type MigrationStep =
  | { kind: "secret"; envVar: string; valueFrom: string; provider: string }
  | { kind: "agent"; openclawId: string; name: string; providerName?: string; model?: string }
  | {
      kind: "bridge";
      bridgeKind: "telegram" | "discord";
      tokenEnv: string;
      tokenValue: string;
      allowedChatIds?: number[];
    }
  | { kind: "skill"; name: string; sourcePath: string }
  | { kind: "workspaceFile"; name: string; sourcePath: string };

export interface UnsupportedItem {
  kind: string;
  detail: string;
}

// The print-safe view. Secret values are dropped; only counts and
// destination metadata survive. This is what `gini import plan openclaw`
// prints. It's also what an HTTP endpoint would return if we ever expose
// the planner over the gateway.
export interface MigrationPlanSummary {
  source: { stateRoot: string; configExists: boolean };
  counts: {
    secrets: number;
    agents: number;
    bridges: number;
    skills: number;
    workspaceFiles: number;
    unsupported: number;
  };
  steps: Array<
    | { kind: "secret"; envVar: string; provider: string }
    | { kind: "agent"; openclawId: string; name: string; providerName?: string; model?: string }
    | {
        kind: "bridge";
        bridgeKind: "telegram" | "discord";
        tokenEnv: string;
        allowedChatCount: number;
      }
    | { kind: "skill"; name: string; sourcePath: string }
    | { kind: "workspaceFile"; name: string; sourcePath: string }
  >;
  unsupported: UnsupportedItem[];
}

export interface MigrationResult {
  applied: boolean;
  report: ImportReport;
  agentsCreated: number;
  bridgesCreated: number;
  skillsCopied: number;
  secretsWritten: number;
  workspaceFilesCopied: number;
  unsupported: UnsupportedItem[];
  warnings: string[];
}

export interface ApplyOptions {
  force?: boolean;
}

// --- Discovery ---

// Resolve the openclaw state root the same way openclaw itself does:
// `OPENCLAW_STATE_DIR` if set, else `~/.openclaw`, else the legacy
// `~/.clawdbot`. An explicit `pathArg` overrides everything (the user
// pointed us at a tarball extract or a non-default install).
export function discoverOpenclawState(pathArg?: string): OpenclawDiscovery {
  const home = process.env.OPENCLAW_HOME || process.env.HOME || homedir();
  const envOverride = process.env.OPENCLAW_STATE_DIR;
  let stateRoot: string;
  if (pathArg) {
    stateRoot = resolve(pathArg);
  } else if (envOverride) {
    stateRoot = resolve(envOverride);
  } else {
    const candidates = [join(home, ".openclaw"), join(home, ".clawdbot")];
    stateRoot = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  }
  const configCandidates = [
    join(stateRoot, "openclaw.json"),
    join(stateRoot, "clawdbot.json")
  ];
  const configPath = configCandidates.find((candidate) => existsSync(candidate)) ?? null;
  // The default workspace dir lives INSIDE the state root by convention
  // (`<state>/workspace/`). Honor `OPENCLAW_WORKSPACE_DIR` and
  // `OPENCLAW_PROFILE` overrides first, then fall back to the in-state
  // location, then the HOME-relative path for setups that overrode the
  // state root but not HOME.
  const workspaceCandidates: string[] = [];
  if (process.env.OPENCLAW_WORKSPACE_DIR) {
    workspaceCandidates.push(resolve(process.env.OPENCLAW_WORKSPACE_DIR));
  }
  const profile = process.env.OPENCLAW_PROFILE;
  if (profile && profile.toLowerCase() !== "default") {
    workspaceCandidates.push(join(stateRoot, `workspace-${profile}`));
    workspaceCandidates.push(join(home, ".openclaw", `workspace-${profile}`));
  }
  workspaceCandidates.push(join(stateRoot, "workspace"));
  workspaceCandidates.push(join(home, ".openclaw", "workspace"));
  const workspaceRoot = workspaceCandidates.find((candidate) => existsSync(candidate)) ?? null;
  return {
    stateRoot,
    configPath,
    workspaceRoot,
    credentialsDir: join(stateRoot, "credentials"),
    skillsDir: join(stateRoot, "skills"),
    agentsDir: join(stateRoot, "agents")
  };
}

// --- Config parsing (JSON5/JSONC tolerant) ---

// Openclaw config files are documented as JSON or JSON5. We accept both
// without pulling in a JSON5 dependency: try strict JSON first, and on
// failure strip line/block comments and trailing commas before retrying.
// Anything that survives that round-trip should land cleanly; anything
// that doesn't is a real syntax error we surface to the caller.
export function parseOpenclawJson(raw: string): OpenclawConfig {
  try {
    return JSON.parse(raw) as OpenclawConfig;
  } catch {
    /* fall through to tolerant parse */
  }
  const stripped = stripCommentsAndTrailingCommas(raw);
  return JSON.parse(stripped) as OpenclawConfig;
}

function stripCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < input.length) {
    const c = input[i]!;
    const next = i + 1 < input.length ? input[i + 1] : "";
    if (inString) {
      out += c;
      if (c === "\\" && next) {
        out += next;
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// --- State-dir dotenv ---

// Openclaw persists service env vars in `<state>/.env` so daemons pick
// them up without the user re-exporting on every restart. We parse the
// same KEY=value (with optional `export` prefix and optional quotes)
// shape gini's own `secrets.env` uses.
export function readStateDotenv(stateRoot: string): Record<string, string> {
  const path = join(stateRoot, ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

function readAllowFromAsNumbers(path: string): number[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { allowFrom?: string[] };
    const ids = (data.allowFrom ?? [])
      .map((entry) => Number(entry))
      .filter((value) => Number.isFinite(value));
    return ids;
  } catch {
    return undefined;
  }
}

// Telegram chat ids come over the wire as numbers but operators routinely
// hand-edit them as strings in openclaw.json. We accept either, filter
// anything non-finite (Telegram chat ids are 64-bit integers but stay
// inside Number.MAX_SAFE_INTEGER in practice), and return undefined when
// the source produced nothing — keeps the union helper's "no input"
// signal clean.
function coerceAllowFromToNumbers(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids: number[] = [];
  for (const entry of raw) {
    const value = typeof entry === "number" ? entry : Number(entry);
    if (Number.isFinite(value)) ids.push(value);
  }
  return ids.length > 0 ? ids : undefined;
}

function unionChatIds(a: number[] | undefined, b: number[] | undefined): number[] | undefined {
  if (!a && !b) return undefined;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

// Split an openclaw `provider/model` string (or AgentModelConfig
// object) into its provider and model components. Returns undefined
// values when the routing isn't set so callers can fall back to the
// defaults block or leave gini's instance-level provider in charge.
//
// Examples:
//   "openai/gpt-5"               → { providerName: "openai", model: "gpt-5" }
//   "anthropic/claude-3-haiku"   → { providerName: "anthropic", model: "claude-3-haiku" }
//   { primary: "openai/gpt-5" }  → same as the first example
//   undefined                    → { providerName: undefined, model: undefined }
//
// Bare "model" strings (no slash) are treated as model-only with no
// provider, which is the openclaw schema's allowed shape for partial
// routing (the runtime resolves provider from the agent's authProfileOrder
// in that case).
export function parseOpenclawModelRouting(
  raw: OpenclawAgentModelConfig | undefined
): { providerName: string | undefined; model: string | undefined } {
  const primary = typeof raw === "string" ? raw : raw?.primary;
  if (!primary) return { providerName: undefined, model: undefined };
  const slash = primary.indexOf("/");
  if (slash <= 0) {
    return { providerName: undefined, model: primary };
  }
  return {
    providerName: primary.slice(0, slash),
    model: primary.slice(slash + 1)
  };
}

// Openclaw's own agent-id validator (`normalizeAgentId` at
// src/routing/session-key.ts upstream) accepts `[a-z0-9][a-z0-9_-]{0,63}`
// case-insensitively. We mirror that here and additionally allow `.` so
// dotted ids that already exist in some openclaw deployments still
// pass. The slug check is purely defensive — it rejects strings that
// would be valid path-segment-traversal payloads when joined into
// agentsDir for the auth-profiles.json read.
const SAFE_AGENT_SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
function isSafeAgentSlug(value: string): boolean {
  return SAFE_AGENT_SLUG.test(value) && !value.includes("..");
}

// Resolve the canonical env-var name gini uses for a given provider.
// Routes through `normalizeProvider` so the migrator and the runtime
// agree on naming — hand-rolling `${PROVIDER.toUpperCase()}_API_KEY`
// produces LOCAL_API_KEY for the local provider while the runtime
// expects GINI_LOCAL_API_KEY, and synthesizes CODEX_API_KEY for the
// codex provider which the runtime ignores entirely (codex reads OAuth
// from ~/.codex/auth.json instead). Codex callers must skip the secret
// migration up front; this helper returns null for codex as a safety
// belt in case a caller forgets that gate.
export function canonicalApiKeyEnv(
  providerName: "openai" | "codex" | "openrouter" | "local"
): string | null {
  const normalized = normalizeProvider({ name: providerName, model: "" });
  return normalized.apiKeyEnv ?? null;
}

// Map openclaw's wide provider catalog onto the narrow set gini supports
// at the moment. Returning `null` puts the provider in the unsupported
// list — the user can wire it manually after the migration. Add a row
// here when gini grows native support for a new provider.
export function mapProviderToGini(
  name: string | undefined
): "openai" | "codex" | "openrouter" | "local" | null {
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === "openai") return "openai";
  if (normalized === "codex") return "codex";
  if (normalized === "openrouter") return "openrouter";
  if (normalized === "local" || normalized === "lmstudio" || normalized === "ollama" || normalized === "vllm") {
    return "local";
  }
  return null;
}

// --- Plan ---

// Openclaw's workspace bootstrap file set, copied verbatim from its
// `workspace.ts` constants (BOOTSTRAP_FILENAMES). These are markdown
// files openclaw injects into the system prompt; the operator commonly
// hand-edits them. Gini doesn't auto-inject them, but operators tend to
// expect them to follow when they migrate.
const WORKSPACE_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md"
] as const;

interface AuthProfileLike {
  type?: string;
  provider?: string;
  key?: string;
  token?: string;
  access?: string;
}

interface AuthProfileFile {
  version?: number;
  profiles?: Record<string, AuthProfileLike>;
}

export function planMigration(source: OpenclawDiscovery): MigrationPlan {
  const steps: MigrationStep[] = [];
  const unsupported: UnsupportedItem[] = [];

  // No openclaw config means there's nothing to migrate. Returning an
  // empty plan with a clear unsupported marker keeps apply() from
  // synthesizing a phantom `main` agent + an "applied" report against a
  // fresh gini install that never had openclaw installed in the first
  // place. The CLI surfaces the unsupported list verbatim so the user
  // sees why nothing happened.
  if (!source.configPath) {
    unsupported.push({
      kind: "openclaw-state",
      detail: `No openclaw config found under ${source.stateRoot}. Migration skipped — install openclaw and run \`openclaw onboard\` first, or point --path at a copy of an openclaw state root.`
    });
    return {
      source: { stateRoot: source.stateRoot, configExists: false },
      steps,
      unsupported
    };
  }

  const config: OpenclawConfig = parseOpenclawJson(readFileSync(source.configPath, "utf8"));

  // Agents
  const agentList = config.agents?.list ?? [];
  const agentIds: string[] = [];
  // Openclaw stores provider+model together as a "provider/model" string
  // (e.g. "openai/gpt-5", "anthropic/claude-3-5-sonnet"). The `primary`
  // slot of `AgentModelConfig` carries the same shape. Gini's
  // AgentRecord keeps provider and model on separate fields, so we split
  // before handing them to the migration step.
  const defaultRouting = parseOpenclawModelRouting(config.agents?.defaults?.model);
  if (agentList.length === 0) {
    // Openclaw treats `main` as the implicit default when no list is
    // configured. We mirror that so users with the simplest config still
    // get an agent record.
    steps.push({
      kind: "agent",
      openclawId: "main",
      name: "main",
      providerName: defaultRouting.providerName,
      model: defaultRouting.model
    });
    agentIds.push("main");
  } else {
    for (const agent of agentList) {
      const openclawId = (agent.id ?? "").trim();
      if (!openclawId) continue;
      // The openclaw config is operator-supplied via --path, so a
      // crafted agent.id like "../../../../etc/passwd" would let the
      // auth-profiles.json read below escape source.agentsDir and open
      // arbitrary files under the user's HOME. Restrict to a safe slug
      // matching openclaw's own validator (alphanumerics, _-., starts
      // with letter/digit, 64 chars max) and surface the bad entry on
      // the unsupported list so the operator sees what was dropped.
      if (!isSafeAgentSlug(openclawId)) {
        unsupported.push({
          kind: "agent",
          detail: `Skipped agent with unsafe id '${openclawId}'. Agent ids must match /^[a-z0-9][a-z0-9_.-]{0,63}$/i.`
        });
        continue;
      }
      const routing = parseOpenclawModelRouting(agent.model);
      // Fall back to the defaults block when the agent didn't supply a
      // model of its own — openclaw resolves the same way at runtime.
      steps.push({
        kind: "agent",
        openclawId,
        name: openclawId,
        providerName: routing.providerName ?? defaultRouting.providerName,
        model: routing.model ?? defaultRouting.model
      });
      agentIds.push(openclawId);
    }
  }

  // Provider API keys (per agent auth-profiles.json)
  const seenSecretEnv = new Set<string>();
  for (const agentId of agentIds) {
    const authPath = join(source.agentsDir, agentId, "agent", "auth-profiles.json");
    if (!existsSync(authPath)) continue;
    let parsed: AuthProfileFile;
    try {
      parsed = JSON.parse(readFileSync(authPath, "utf8")) as AuthProfileFile;
    } catch {
      unsupported.push({
        kind: `auth-profiles:${agentId}`,
        detail: `Could not parse ${authPath}`
      });
      continue;
    }
    const profiles = parsed.profiles ?? {};
    for (const profile of Object.values(profiles)) {
      const giniProvider = mapProviderToGini(profile.provider);
      if (!giniProvider) {
        if (profile.provider) {
          unsupported.push({
            kind: `provider:${profile.provider}`,
            detail: `Gini has no native provider mapping for '${profile.provider}'`
          });
        }
        continue;
      }
      // Codex uses an OAuth file (~/.codex/auth.json), not a bearer env
      // var — that file is shared with openclaw verbatim, so the
      // migration is a no-op once the operator has logged in via
      // `codex --login`. Writing a CODEX_API_KEY would be unread by the
      // runtime and leak the openclaw access token under a misleading
      // name. Surface this explicitly so the operator knows what to do.
      if (giniProvider === "codex") {
        unsupported.push({
          kind: "provider:codex",
          detail: "Gini's codex provider reads OAuth from ~/.codex/auth.json (shared with openclaw); run `codex --login` if you haven't already. No secret was migrated."
        });
        continue;
      }
      const plaintext = profile.key ?? profile.token ?? profile.access;
      if (!plaintext) continue;
      // Source the canonical env var name from the provider layer
      // rather than hand-rolling `${PROVIDER}_API_KEY`. The local
      // provider uses `GINI_LOCAL_API_KEY` (per `normalizeProvider` in
      // src/provider.ts), so a hand-rolled "LOCAL_API_KEY" would land
      // in ~/.gini/secrets.env but the runtime would never read it.
      const envVar = canonicalApiKeyEnv(giniProvider);
      if (!envVar) continue;
      if (seenSecretEnv.has(envVar)) continue;
      seenSecretEnv.add(envVar);
      steps.push({ kind: "secret", envVar, valueFrom: plaintext, provider: giniProvider });
    }
  }

  // Channels → messaging bridges (Telegram + Discord only — these are
  // the bridges gini implements today; the per-channel ADRs are
  // `docs/adr/telegram-bridge.md` and `docs/adr/discord-bridge.md`).
  const channels = config.channels ?? {};
  const envVars = config.env?.vars ?? {};
  const dotenv = readStateDotenv(source.stateRoot);
  for (const name of Object.keys(channels)) {
    if (name === "telegram") {
      const token = envVars.TELEGRAM_BOT_TOKEN ?? dotenv.TELEGRAM_BOT_TOKEN;
      if (token) {
        // Union the allow-list from BOTH sources openclaw uses:
        //   1. `<credDir>/telegram-allowFrom.json` (legacy + default-account)
        //   2. inline `channels.telegram.allowFrom` in the config (the
        //      modern surface; required when dmPolicy="allowlist" per
        //      openclaw's zod schema)
        // Reading only the file silently drops allow-lists for the many
        // configs that hold them inline. De-dup after the union so a
        // chat listed in both sources still appears exactly once.
        const fromFile = readAllowFromAsNumbers(
          join(source.credentialsDir, "telegram-allowFrom.json")
        );
        const fromConfig = coerceAllowFromToNumbers(channels[name]?.allowFrom);
        const allowedChatIds = unionChatIds(fromFile, fromConfig);
        steps.push({
          kind: "bridge",
          bridgeKind: "telegram",
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          tokenValue: token,
          allowedChatIds
        });
      } else {
        unsupported.push({
          kind: "telegram",
          detail: "TELEGRAM_BOT_TOKEN not found in openclaw config or state-dir .env"
        });
      }
    } else if (name === "discord") {
      const token = envVars.DISCORD_BOT_TOKEN ?? dotenv.DISCORD_BOT_TOKEN;
      if (token) {
        steps.push({
          kind: "bridge",
          bridgeKind: "discord",
          tokenEnv: "DISCORD_BOT_TOKEN",
          tokenValue: token
        });
      } else {
        unsupported.push({
          kind: "discord",
          detail: "DISCORD_BOT_TOKEN not found in openclaw config or state-dir .env"
        });
      }
    } else {
      unsupported.push({
        kind: `channel:${name}`,
        detail: `Gini has no bridge implementation for channel '${name}' yet`
      });
    }
  }

  // Skills (managed root: <state>/skills/<name>/SKILL.md)
  if (existsSync(source.skillsDir)) {
    for (const name of readdirSync(source.skillsDir)) {
      const dir = join(source.skillsDir, name);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const skillPath = join(dir, "SKILL.md");
      if (existsSync(skillPath)) {
        steps.push({ kind: "skill", name, sourcePath: skillPath });
      }
    }
  }

  // Workspace bootstrap files
  if (source.workspaceRoot) {
    for (const fileName of WORKSPACE_BOOTSTRAP_FILES) {
      const filePath = join(source.workspaceRoot, fileName);
      if (existsSync(filePath)) {
        steps.push({ kind: "workspaceFile", name: fileName, sourcePath: filePath });
      }
    }
  }

  // Known-unmigrated subsystems — surface them so the user isn't
  // surprised by silent gaps. We check for the directory rather than
  // the file so an empty-but-present dir still counts.
  if (existsSync(join(source.stateRoot, "memory"))) {
    unsupported.push({
      kind: "memory",
      detail: "Openclaw Hindsight SQLite has no compatible gini schema; memory is not migrated"
    });
  }
  if (existsSync(join(source.stateRoot, "tasks"))) {
    unsupported.push({
      kind: "tasks",
      detail: "Openclaw task-registry uses a different model; tasks are not migrated"
    });
  }
  if (existsSync(join(source.stateRoot, "plugins"))) {
    unsupported.push({
      kind: "plugins",
      detail: "Openclaw extension plugins have no gini equivalent; plugins are not migrated"
    });
  }
  if (existsSync(join(source.stateRoot, "devices"))) {
    unsupported.push({
      kind: "devices",
      detail: "Openclaw paired device tokens cannot be reused under gini; re-pair via `gini pair`"
    });
  }

  return {
    source: { stateRoot: source.stateRoot, configExists: source.configPath !== null },
    steps,
    unsupported
  };
}

// Print-safe summary. Strips every plaintext secret. The CLI ALWAYS
// prints this — never the raw plan — so a `gini import plan` invocation
// can't leak credentials into the operator's terminal or shell history.
export function summarizePlan(plan: MigrationPlan): MigrationPlanSummary {
  const counts = {
    secrets: 0,
    agents: 0,
    bridges: 0,
    skills: 0,
    workspaceFiles: 0,
    unsupported: plan.unsupported.length
  };
  const steps: MigrationPlanSummary["steps"] = plan.steps.map((step) => {
    if (step.kind === "secret") {
      counts.secrets += 1;
      return { kind: "secret", envVar: step.envVar, provider: step.provider };
    }
    if (step.kind === "agent") {
      counts.agents += 1;
      return {
        kind: "agent",
        openclawId: step.openclawId,
        name: step.name,
        providerName: step.providerName,
        model: step.model
      };
    }
    if (step.kind === "bridge") {
      counts.bridges += 1;
      return {
        kind: "bridge",
        bridgeKind: step.bridgeKind,
        tokenEnv: step.tokenEnv,
        allowedChatCount: step.allowedChatIds?.length ?? 0
      };
    }
    if (step.kind === "skill") {
      counts.skills += 1;
      return { kind: "skill", name: step.name, sourcePath: step.sourcePath };
    }
    counts.workspaceFiles += 1;
    return { kind: "workspaceFile", name: step.name, sourcePath: step.sourcePath };
  });
  return {
    source: plan.source,
    counts,
    steps,
    unsupported: plan.unsupported
  };
}

// --- Apply ---

// Probe whether a gateway is alive for this instance. Detection is
// cheap and synchronous: check the runtime.pid file for a PID and ask
// the kernel via `kill(pid, 0)` whether the process exists. Stale pid
// files (process gone, file left behind) return false — same convention
// `gini status` uses elsewhere in the CLI.
export function detectRunningGateway(instance: string): { pid: number } | null {
  const path = pidPath(instance);
  if (!existsSync(path)) return null;
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return { pid };
  } catch {
    return null;
  }
}

export async function applyMigration(
  config: RuntimeConfig,
  source: OpenclawDiscovery,
  plan: MigrationPlan,
  options: ApplyOptions = {}
): Promise<MigrationResult> {
  // The CLI apply path runs in a separate OS process from any live
  // gateway, so the in-process mutateState lock can't serialize writes
  // across them. Two independent read-modify-write cycles on state.json
  // can lose updates even though the atomic tmp+rename prevents torn
  // writes. Refuse to mutate while a gateway is up on this instance —
  // the user runs `gini stop --instance <x>` first, applies, then
  // restarts. No --force override here on purpose: foot-gunning the
  // running gateway's own writes is exactly the failure mode the
  // validator surfaced.
  const running = detectRunningGateway(config.instance);
  if (running) {
    throw new Error(
      `Gini gateway is running for instance '${config.instance}' (PID ${running.pid}). Stop it first with \`gini stop --instance ${config.instance}\` so the migration can write state.json without racing the gateway, then re-run \`gini import apply openclaw\`.`
    );
  }

  const warnings: string[] = [];
  let agentsCreated = 0;
  let bridgesCreated = 0;
  let skillsCopied = 0;
  let secretsWritten = 0;
  let workspaceFilesCopied = 0;

  // Short-circuit when there's no openclaw config to read. Otherwise
  // apply would write an "applied" ImportReport with all-zero counts
  // and (pre-fix) a phantom main agent — both of which lie to the
  // operator about what happened. We still emit a report so the
  // activity feed records the attempt; the failed status makes the
  // outcome unambiguous.
  if (!plan.source.configExists) {
    const failedReport = await mutateState(config.instance, (state) =>
      createImportReport(state, {
        source: "openclaw",
        path: source.stateRoot,
        mode: "applied",
        status: "failed",
        counts: {},
        findings: plan.unsupported.map((entry) => `Unsupported: ${entry.kind} — ${entry.detail}`),
        error: `No openclaw config found under ${source.stateRoot}.`
      })
    );
    return {
      applied: false,
      report: failedReport,
      agentsCreated,
      bridgesCreated,
      skillsCopied,
      secretsWritten,
      workspaceFilesCopied,
      unsupported: plan.unsupported,
      warnings
    };
  }

  // 1) Provider secrets to ~/.gini/secrets.env. Done first so a freshly
  // installed gini picks them up on the next `gini run`. Mirror the
  // same skip-if-exists pattern as workspace files, skills, and
  // bridges: an existing OPENAI_API_KEY in ~/.gini/secrets.env is
  // probably the operator's real production credential, and silently
  // replacing it with whatever openclaw stored (which may be stale or
  // a dev key) is a hard-to-debug footgun. --force is the explicit
  // opt-in for rotation.
  for (const step of plan.steps) {
    if (step.kind !== "secret") continue;
    if (secretsEnvHasKey(step.envVar) && !options.force) {
      warnings.push(
        `Skipped existing secret: ${step.envVar} (use --force to overwrite with the openclaw value)`
      );
      continue;
    }
    try {
      writeKeyToSecretsEnv(step.envVar, step.valueFrom);
      secretsWritten += 1;
    } catch (error) {
      warnings.push(
        `Failed to write ${step.envVar}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 2) Workspace bootstrap files. Copy into the configured workspace
  // root. Skip same-named existing files unless --force was passed —
  // operators tend to hand-edit these and a silent overwrite would be
  // surprising.
  mkdirSync(config.workspaceRoot, { recursive: true });
  for (const step of plan.steps) {
    if (step.kind !== "workspaceFile") continue;
    const target = join(config.workspaceRoot, step.name);
    if (existsSync(target) && !options.force) {
      warnings.push(`Skipped existing workspace file: ${step.name} (use --force to overwrite)`);
      continue;
    }
    try {
      copyFileSync(step.sourcePath, target);
      workspaceFilesCopied += 1;
    } catch (error) {
      warnings.push(
        `Failed to copy ${step.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 3) Skills. For each <state>/skills/<name>/, rewrite the openclaw
  // frontmatter dialect into gini's spec-compliant nesting and copy the
  // directory verbatim otherwise. Existing same-named skills are
  // skipped (re-importing should be a deliberate `--force` operation).
  const targetSkillsDir = skillsDir(config.instance);
  mkdirSync(targetSkillsDir, { recursive: true });
  for (const step of plan.steps) {
    if (step.kind !== "skill") continue;
    const targetDir = join(targetSkillsDir, step.name);
    const targetSkill = join(targetDir, "SKILL.md");
    if (existsSync(targetSkill) && !options.force) {
      warnings.push(`Skipped existing skill: ${step.name} (use --force to overwrite)`);
      continue;
    }
    try {
      mkdirSync(targetDir, { recursive: true });
      const raw = readFileSync(step.sourcePath, "utf8");
      writeFileSync(targetSkill, rewriteSkillFrontmatter(raw), { mode: 0o644 });
      copyDirShallow(dirname(step.sourcePath), targetDir, new Set(["SKILL.md"]));
      skillsCopied += 1;
    } catch (error) {
      warnings.push(
        `Failed to copy skill ${step.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 4) Agents. Skip if an agent with the same name already exists so
  // re-running the migrator is idempotent.
  await mutateState(config.instance, (state) => {
    for (const step of plan.steps) {
      if (step.kind !== "agent") continue;
      if (state.agents.some((existing) => existing.name === step.name)) {
        warnings.push(`Skipped existing agent: ${step.name}`);
        continue;
      }
      const giniProvider = step.providerName ? mapProviderToGini(step.providerName) : null;
      createAgentRecord(state, {
        name: step.name,
        providerName: giniProvider ?? undefined,
        model: step.model,
        // The gini default agent ships with these toolsets enabled
        // (per `defaultAgent` in `src/state/defaults.ts`). Mirror that
        // baseline so an imported agent is usable without further
        // toolset wiring.
        toolsets: ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp"],
        messagingTargets: []
      });
      agentsCreated += 1;
    }
  });

  // 5) Messaging bridges. Tokens go through the same encrypted secret
  // store the live HTTP create endpoint uses. We pre-generate the
  // bridge id so the secret file path (`messaging.<bridgeId>.bot-token.json`)
  // and the bridge record agree before insertion. Only one bridge per
  // kind to keep things simple — re-importing a token rotates the
  // underlying file but doesn't fork the bridge.
  for (const step of plan.steps) {
    if (step.kind !== "bridge") continue;
    // Validate the bot token before it ever reaches the encrypted
    // store. The same gate runs in the live POST /api/messaging path —
    // skipping it here would let a token containing a newline or
    // control character flow through to the poller's first fetch,
    // which would then echo the full Authorization header value into
    // bridge.message and leak via GET /api/messaging. Capture the
    // failure as a warning + unsupported entry so the rest of the
    // migration keeps making progress.
    try {
      assertHeaderSafeToken(step.bridgeKind, step.tokenValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${step.bridgeKind} bridge: ${message}`);
      continue;
    }
    // Discord's gini supervisor (`discord-poller.ts:shouldRun`) gates
    // on a non-empty `deliveryTargets` channel list, but openclaw and
    // gini model Discord access differently — openclaw stores a
    // per-sender allow-list (`channels.discord.allowFrom` + a
    // credentials file), gini stores per-channel snowflakes the bot
    // operates in. The two cannot be mapped 1:1 from disk state, so
    // we provision the bridge with the token + status:"configured" so
    // the operator can finish wiring with `gini messaging` after the
    // migration, but warn them clearly that the supervisor will stay
    // dormant until they add at least one delivery channel.
    if (step.bridgeKind === "discord") {
      warnings.push(
        `Discord bridge migrated without deliveryTargets; supervisor will stay idle until you run \`gini messaging add\` to wire at least one channel.`
      );
    }
    // First pass: decide whether we are creating or rotating. We only
    // need the bridge id (and existence flag) out of state here; we
    // intentionally do NOT keep a reference to the bridge object,
    // because the second mutateState below re-reads state from disk and
    // returns a different object graph. Mutating the stale object would
    // be silently dropped — exactly the bug the validator confirmed.
    const decision = await mutateState(config.instance, (state) => {
      const found = state.messagingBridges.find(
        (bridge) => bridge.kind === step.bridgeKind
      );
      return found
        ? { kind: "existing" as const, id: found.id }
        : { kind: "new" as const, id: id("bridge") };
    });
    if (decision.kind === "existing" && !options.force) {
      warnings.push(
        `Skipped ${step.bridgeKind} bridge: one already exists (use --force to rotate token and merge allow-list)`
      );
      continue;
    }
    const ref = writeSecret(
      config.instance,
      `messaging.${decision.id}`,
      "bot-token",
      step.tokenValue
    );
    await mutateState(config.instance, (state) => {
      const at = now();
      const metadata: Record<string, unknown> =
        step.bridgeKind === "telegram"
          ? {
              allowedChatIds: step.allowedChatIds ?? [],
              lastOffset: 0
            }
          : { lastInboundExternalIds: {} };
      if (decision.kind === "existing") {
        // Re-find the bridge inside THIS mutateState call so the mutation
        // lands on the fresh state graph that writeState will serialize.
        const target = state.messagingBridges.find(
          (bridge) => bridge.id === decision.id
        );
        if (target) {
          target.secretRefs = [ref];
          // Merge telegram allowedChatIds (union, deduplicated) so an
          // operator who's enrolled extra chats post-migration doesn't
          // lose them on a token rotation. lastOffset/lastInboundExternalIds
          // are preserved from the existing metadata so the poller doesn't
          // replay old updates.
          target.metadata = mergeBridgeMetadata(target.metadata, metadata, step.bridgeKind);
          target.status = "configured";
          target.updatedAt = at;
        }
      } else {
        const item: MessagingBridgeRecord = {
          id: decision.id,
          instance: state.instance,
          name: `${step.bridgeKind} (migrated from openclaw)`,
          kind: step.bridgeKind,
          status: "configured",
          deliveryTargets: [],
          createdAt: at,
          updatedAt: at,
          secretRefs: [ref],
          metadata
        };
        state.messagingBridges.unshift(item);
      }
      addAudit(
        state,
        {
          actor: "user",
          action: "messaging.configured",
          target: decision.id,
          risk: "medium",
          evidence: {
            kind: step.bridgeKind,
            source: "openclaw-migration",
            rotated: decision.kind === "existing",
            allowedChatCount: step.allowedChatIds?.length ?? 0
          }
        },
        { system: true }
      );
    });
    bridgesCreated += 1;
  }

  // 6) Persist a single applied ImportReport so the activity feed
  // shows exactly what landed. The audit log already records every
  // creation; this gives the operator a one-row summary.
  const counts: Record<string, number> = {
    agentsCreated,
    bridgesCreated,
    skillsCopied,
    secretsWritten,
    workspaceFilesCopied,
    unsupported: plan.unsupported.length,
    warnings: warnings.length
  };
  const findings = [
    `Applied openclaw migration from ${source.stateRoot}`,
    ...plan.unsupported.map((entry) => `Unsupported: ${entry.kind} — ${entry.detail}`),
    ...warnings.map((warning) => `Warning: ${warning}`)
  ];
  const report = await mutateState(config.instance, (state) =>
    createImportReport(state, {
      source: "openclaw",
      path: source.stateRoot,
      mode: "applied",
      status: "completed",
      counts,
      findings
    })
  );

  return {
    applied: true,
    report,
    agentsCreated,
    bridgesCreated,
    skillsCopied,
    secretsWritten,
    workspaceFilesCopied,
    unsupported: plan.unsupported,
    warnings
  };
}

// Merge bridge.metadata across a --force rotation. For Telegram, union
// the existing and incoming allowedChatIds so an operator who enrolled
// extra chats via `gini messaging allow` doesn't lose them when a token
// rotates from a fresh openclaw export. lastOffset / lastInboundExternalIds
// are preserved from the existing record so the poller doesn't replay
// the entire backlog after rotation.
function mergeBridgeMetadata(
  previous: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  bridgeKind: "telegram" | "discord"
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(previous ?? {}), ...incoming };
  if (bridgeKind === "telegram") {
    const previousIds = Array.isArray(previous?.allowedChatIds)
      ? (previous!.allowedChatIds as unknown[]).filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value)
        )
      : [];
    const incomingIds = Array.isArray(incoming.allowedChatIds)
      ? (incoming.allowedChatIds as unknown[]).filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value)
        )
      : [];
    merged.allowedChatIds = Array.from(new Set([...previousIds, ...incomingIds]));
    if (typeof previous?.lastOffset === "number") {
      merged.lastOffset = previous.lastOffset;
    }
  } else {
    if (previous?.lastInboundExternalIds && typeof previous.lastInboundExternalIds === "object") {
      merged.lastInboundExternalIds = previous.lastInboundExternalIds;
    }
  }
  return merged;
}

// Rewrite an openclaw SKILL.md frontmatter so the `openclaw` metadata
// namespace becomes `gini`. Three input shapes exist in the wild:
//
//   1. Flow-style nested under metadata (the dominant bundled shape):
//        metadata:
//          { "openclaw": { "emoji": "X", … } }
//      → "openclaw" quoted-key swap → "gini".
//
//   2. Block-style nested under metadata:
//        metadata:
//          openclaw:
//            emoji: X
//      → indented `openclaw:` line swap → `gini:` (indentation preserved).
//
//   3. Legacy top-level (older docs, smoke fixtures):
//        openclaw:
//          version: 1.0.0
//          category: productivity
//      → promote to a fresh `metadata:\n  gini:` block and re-indent
//        every child line by two extra spaces so the children land under
//        `gini:` instead of next to `metadata:`. Bare re-keying without
//        re-indenting produces invalid YAML.
//
// Only the YAML frontmatter (between the leading `---` markers) is
// touched. Body content and any literal `openclaw` mentions outside
// the frontmatter pass through unchanged.
export function rewriteSkillFrontmatter(raw: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return raw;
  const body = match[1] ?? "";
  const rewritten = rewriteFrontmatterBody(body);
  if (rewritten === body) return raw;
  return `${raw.slice(0, match.index)}---\n${rewritten}\n---${raw.slice(
    match.index + match[0].length
  )}`;
}

function rewriteFrontmatterBody(body: string): string {
  let out = body;
  // Shape 1 (dominant bundled form): flow-style metadata block. The gini
  // skill loader is a hand-rolled YAML-ish parser that does not handle
  // JSON flow-style, so a plain "openclaw" → "gini" key swap leaves the
  // block unreadable. Convert the whole flow-style block to block-style
  // YAML under metadata.gini so the loader actually picks it up.
  out = convertFlowStyleMetadata(out);
  // Shape 2: block-style nested key (any indentation).
  out = out.replace(/^([ \t]+)openclaw:(\s*)$/gm, "$1gini:$2");
  // Shape 3: legacy top-level block. Promote to metadata.gini with
  // child indentation bumped by two spaces.
  const legacy = /^openclaw:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(out);
  if (legacy) {
    const children = legacy[1] ?? "";
    const reindented = children
      .split("\n")
      .map((line) => (line.length > 0 ? `  ${line}` : line))
      .join("\n");
    const trailingNewline = legacy[0].endsWith("\n") ? "\n" : "";
    out = `${out.slice(0, legacy.index)}metadata:\n  gini:\n${reindented}${trailingNewline.length > 0 && !reindented.endsWith("\n") ? "\n" : ""}${out.slice(legacy.index + legacy[0].length)}`;
  }
  return out;
}

// Locate `metadata:\n  {...}` (with the brace block possibly spanning
// multiple lines and containing nested braces) and rewrite it as
// `metadata:\n  gini:\n    key: value\n...` so gini's skill loader can
// read it. The conversion parses the JSON block with the same tolerant
// parser used for openclaw.json itself (comments + trailing commas) and
// reuses the namespace contents — anything under `"openclaw"` becomes
// the body of `metadata.gini`. Unknown shapes fall through unchanged.
function convertFlowStyleMetadata(body: string): string {
  const header = /^metadata:[ \t]*\r?\n/m.exec(body);
  if (!header) return body;
  const blockStart = body.indexOf("{", header.index + header[0].length);
  if (blockStart < 0) return body;
  // Walk forward tracking brace depth and string state so we find the
  // matching closing brace even with nested objects.
  const blockEnd = findMatchingBrace(body, blockStart);
  if (blockEnd < 0) return body;
  const flowBlock = body.slice(blockStart, blockEnd + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseOpenclawJson(flowBlock) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const inner =
    (parsed.openclaw && typeof parsed.openclaw === "object" && parsed.openclaw) ||
    (parsed.gini && typeof parsed.gini === "object" && parsed.gini) ||
    null;
  if (!inner) return body;

  // Find the indentation we should land block-style content at. Look at
  // the existing block's leading whitespace.
  const leadingMatch = /^[ \t]*/.exec(body.slice(header.index + header[0].length));
  const baseIndent = (leadingMatch?.[0] ?? "  ").length === 0 ? "  " : leadingMatch![0];
  const giniBody = emitBlockYaml(inner as Record<string, unknown>, `${baseIndent}  `);
  const replacement = `metadata:\n${baseIndent}gini:\n${giniBody}\n`;
  return `${body.slice(0, header.index)}${replacement}${body.slice(blockEnd + 1).replace(/^\r?\n/, "")}`;
}

// Walk `text` from `openIdx` (which must point at `{`) until the
// matching `}`, ignoring braces inside string literals. Returns the
// index of the matching `}` or -1 if unbalanced.
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") { i += 1; continue; }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Render a parsed JSON-ish object tree as block-style YAML at the
// given indent. Only the shapes we see in openclaw skill metadata
// (strings, numbers, booleans, arrays of scalars, arrays of objects,
// nested objects) are emitted; anything else stringifies to a JSON
// inline scalar so we never silently drop a field.
function emitBlockYaml(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      lines.push(`${indent}${key}: ${yamlScalar(value)}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${key}: []`);
        continue;
      }
      const allScalar = value.every(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean"
      );
      if (allScalar) {
        lines.push(`${indent}${key}: [${value.map(yamlScalar).join(", ")}]`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      for (const entry of value) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const nested = emitBlockYaml(entry as Record<string, unknown>, `${indent}    `);
          const [first, ...rest] = nested.split("\n");
          if (first) lines.push(`${indent}  - ${first.trimStart()}`);
          else lines.push(`${indent}  -`);
          for (const line of rest) if (line.length > 0) lines.push(line);
        } else {
          lines.push(`${indent}  - ${yamlScalar(entry)}`);
        }
      }
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${indent}${key}:`);
      lines.push(emitBlockYaml(value as Record<string, unknown>, `${indent}  `));
      continue;
    }
  }
  return lines.join("\n");
}

// Format a scalar for block-style YAML. Strings are quoted only when
// they contain whitespace, leading dashes, colons, or other characters
// the loader's parser would misread; plain identifiers and numbers
// pass through bare so the output stays human-readable.
function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value);
  if (str === "") return '""';
  const needsQuotes = /[:#\n\r\t"'\\]|^[-?!&*|>%@`]|^\s|\s$/.test(str);
  if (!needsQuotes) return str;
  return JSON.stringify(str);
}

function copyDirShallow(srcDir: string, dstDir: string, exclude: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      cpSync(src, dst, { recursive: true });
    } else if (entry.isFile() && !existsSync(dst)) {
      copyFileSync(src, dst);
    }
  }
}

// Re-exported for the CLI so it can render `Source: ~/.openclaw` in the
// human summary without re-doing the resolve dance.
export function describeSource(source: OpenclawDiscovery): string {
  return source.configPath
    ? `${source.stateRoot} (config: ${basename(source.configPath)})`
    : `${source.stateRoot} (no openclaw.json found)`;
}
