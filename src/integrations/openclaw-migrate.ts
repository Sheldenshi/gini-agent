// Openclaw → gini migration.
//
// Reads a user's openclaw state root (default `~/.openclaw/`, override via
// `OPENCLAW_STATE_DIR` or an explicit path argument) and translates the
// pieces gini knows how to host into the running gini instance.
//
// What migrates today:
//   - A verbatim zip snapshot of the entire openclaw state root is
//     written into `<instance>/imports/openclaw-<timestamp>.zip`
//     before any other step runs. Migration NEVER deletes openclaw
//     data — we only read from source.stateRoot — but the archive
//     is the operator's insurance policy in case they later wipe
//     their ~/.openclaw thinking the migration moved it. A failure
//     to write the archive aborts the migration before any state
//     mutation lands; the safety net is non-optional.
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
//   - Chat session transcripts under `<state>/agents/<id>/sessions/*.jsonl`.
//     Each session becomes one ChatSessionRecord + N ChatMessageRecord
//     rows under the matching gini agent. Tool_use / tool_result blocks
//     are dropped from the migrated message text — gini's
//     ChatMessageRecord.content is a flat string — but the full
//     verbatim transcript remains accessible in the archive zip for
//     anyone who needs the original tool-call detail.
//   - Hindsight memory units (`<state>/memory/*.sqlite` whose schema
//     advertises `memory_banks` + `memory_units`). Each row is inserted
//     verbatim into the gini instance's memory.db with embedding NULL;
//     a follow-up `gini embedding reembed` pass populates vectors
//     using the configured embedding provider. The legacy
//     file-chunk RAG schema (`chunks`/`files`/`embedding_cache`) has no
//     direct gini target and is reported on the unsupported list with
//     a `Re-index via /api/memory/retain` hint.
//
// What is intentionally NOT migrated:
//   - Tasks/jobs registries, plugin installs, device-pair state. These
//     either belong to features gini doesn't ship or to runtime state
//     that's safer to re-establish.
//
// All mutations land via `mutateState` so the per-instance lock and
// audit chain run unchanged. Secrets never appear in the plan summary —
// `summarizePlan` redacts them. The CLI prints the summary; only the
// in-process apply path sees plaintexts.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  ImportReport,
  RuntimeConfig,
  RuntimeState
} from "../types";
import {
  addAudit,
  buildMessagingBridgeRecord,
  createAgentRecord,
  createChatMessage,
  createChatSession,
  createImportReport,
  DEFAULT_BANK_ID,
  ensureAgentBank,
  ensureDefaultBank,
  getMemoryDb,
  id,
  insertMemoryUnit,
  mutateState,
  now,
  readState
} from "../state";
import type { MemoryUnitStatus, Network } from "../state/memory-db";
import { writeSecret } from "../state/secrets";
import { secretsEnvHasKey, writeKeyToSecretsEnv } from "../state/secrets-env";
import { instanceRoot, pidPath, skillsDir } from "../paths";
import { assertHeaderSafeToken, mintTelegramPairingCodeInState } from "./messaging";
import { normalizeProvider } from "../provider";
import { DEFAULT_AGENT_TOOLSETS } from "../state/defaults";

// --- Public types ---

export interface OpenclawDiscovery {
  stateRoot: string;
  configPath: string | null;
  workspaceRoot: string | null;
  credentialsDir: string;
  skillsDir: string;
  agentsDir: string;
}

// Openclaw's AgentModelConfig, mirrored from the upstream schema at
// https://github.com/openclaw/openclaw/blob/v2026.5.19/src/config/types.agents-shared.ts
// (lines 8-15): either a "provider/model" string or an object with
// `primary` plus optional `fallbacks`. We only need the primary slot
// for the migration since gini stores a single provider+model per
// agent today.
type OpenclawAgentModelConfig = string | { primary?: string; fallbacks?: string[] };

interface OpenclawAgentConfig {
  id?: string;
  default?: boolean;
  model?: OpenclawAgentModelConfig;
  workspace?: string;
  // Per-agent override pointing at the agent secrets directory
  // (defaults to `<state>/agents/<id>/agent/`). Operators commonly
  // hand-edit this for multi-instance / portable-secrets setups; the
  // migrator must honor it so auth-profiles.json is found.
  agentDir?: string;
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
  | { kind: "workspaceFile"; name: string; sourcePath: string }
  | { kind: "session"; openclawId: string; sessionId: string; sourcePath: string; messageCount: number }
  | { kind: "memoryUnit"; sourceBank: string; openclawId: string; text: string; network: string; status: string; confidence: number; metadata: Record<string, unknown>; mentionedAt: string };

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
    sessions: number;
    sessionMessages: number;
    memoryUnits: number;
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
    | { kind: "session"; openclawId: string; sessionId: string; messageCount: number }
    | { kind: "memoryUnit"; sourceBank: string; openclawId: string; network: string }
  >;
  unsupported: UnsupportedItem[];
}

export interface MigrationResult {
  applied: boolean;
  report: ImportReport;
  agentsCreated: number;
  // Net-new MessagingBridgeRecord rows minted this apply.
  bridgesCreated: number;
  // Bridges whose secret + metadata were updated in place via --force
  // (the `decision.kind === "existing"` branch). Operators need this
  // distinct from `bridgesCreated` so a re-run with --force isn't
  // misreported as a brand-new bridge creation.
  bridgesRotated: number;
  skillsCopied: number;
  secretsWritten: number;
  workspaceFilesCopied: number;
  sessionsCreated: number;
  sessionMessagesCreated: number;
  memoryUnitsCreated: number;
  archivePath?: string;
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
  // Honor the OPENCLAW_CONFIG_PATH env var openclaw uses to relocate
  // openclaw.json outside the state root (a documented part of its
  // resolution hierarchy). Without this, an operator with the env set
  // would see "No openclaw config found" and the migrator would short-
  // circuit. The override only applies when no explicit pathArg was
  // supplied — pathArg is the more specific operator gesture.
  const configOverride = pathArg ? undefined : process.env.OPENCLAW_CONFIG_PATH;
  const configCandidates: string[] = [];
  if (configOverride) configCandidates.push(resolve(configOverride));
  configCandidates.push(join(stateRoot, "openclaw.json"));
  configCandidates.push(join(stateRoot, "clawdbot.json"));
  const configPath = configCandidates.find((candidate) => existsSync(candidate)) ?? null;
  // The default workspace dir lives INSIDE the state root by convention
  // (`<state>/workspace/`). Honor `OPENCLAW_WORKSPACE_DIR` and
  // `OPENCLAW_PROFILE` overrides first, then fall back to the in-state
  // location. The HOME-relative `<home>/.openclaw/workspace` fallback
  // only fires when neither `pathArg` nor `OPENCLAW_STATE_DIR` was
  // supplied — when the operator explicitly points the migrator at a
  // snapshot or backup directory, falling through to the live HOME
  // workspace would silently cross the source boundary and copy
  // bootstrap markdown from the running install into the import.
  const explicitStateRoot = Boolean(pathArg) || Boolean(envOverride);
  const workspaceCandidates: string[] = [];
  if (process.env.OPENCLAW_WORKSPACE_DIR) {
    workspaceCandidates.push(resolve(process.env.OPENCLAW_WORKSPACE_DIR));
  }
  const profile = process.env.OPENCLAW_PROFILE;
  if (profile && profile.toLowerCase() !== "default") {
    workspaceCandidates.push(join(stateRoot, `workspace-${profile}`));
    if (!explicitStateRoot) {
      workspaceCandidates.push(join(home, ".openclaw", `workspace-${profile}`));
    }
  }
  workspaceCandidates.push(join(stateRoot, "workspace"));
  if (!explicitStateRoot) {
    workspaceCandidates.push(join(home, ".openclaw", "workspace"));
  }
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

// Openclaw config files in the wild are strict JSON, occasionally with
// JSONC-style line/block comments and trailing commas from hand-edits.
// We accept that subset without pulling in a full JSON5 dependency:
// try strict JSON first, and on failure run a single-pass string-aware
// scanner that elides comments and stray trailing commas BEFORE the
// closing bracket of an object or array. Unquoted keys, single-quoted
// strings, and other JSON5-isms are not supported; anything that
// survives that round-trip parses cleanly, and anything that doesn't
// surfaces as a real syntax error.
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
    // Trailing-comma elision: when we're outside any string literal,
    // a comma followed by optional whitespace AND/OR intervening
    // comments and then a closing brace or bracket gets dropped.
    // Doing this here (inside the string-aware pass) prevents a
    // post-hoc regex from accidentally stripping commas inside string
    // contents like `"hello, world"` — the previous /,(\s*[}\]])/g
    // cleanup did exactly that and silently mangled user data.
    // The lookahead must walk past comments too: configs commonly
    // carry `{"a": 1, /* note */}` or `[1, // note\n]`, where the
    // next non-whitespace character is `/`, not `}` / `]`. A
    // whitespace-only scan would leave the trailing comma in place
    // and strict JSON.parse would then reject the cleaned string.
    if (c === ",") {
      let j = i + 1;
      while (j < input.length) {
        const lookahead = input[j]!;
        if (/\s/.test(lookahead)) {
          j += 1;
          continue;
        }
        if (lookahead === "/" && j + 1 < input.length) {
          const peek = input[j + 1]!;
          if (peek === "/") {
            j += 2;
            while (j < input.length && input[j] !== "\n") j += 1;
            continue;
          }
          if (peek === "*") {
            j += 2;
            while (j + 1 < input.length && !(input[j] === "*" && input[j + 1] === "/")) j += 1;
            j += 2;
            continue;
          }
        }
        break;
      }
      const closer = j < input.length ? input[j] : undefined;
      if (closer === "}" || closer === "]") {
        // Skip the comma; keep the whitespace + comments + closer
        // untouched (the comment-stripping branches above run on the
        // next iteration and clean up the comment bytes).
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

// --- State-dir dotenv ---

// Openclaw persists service env vars in `<state>/.env` so daemons pick
// them up without the user re-exporting on every restart. We parse the
// same KEY=value (with optional `export` prefix and optional quotes)
// shape gini's own `secrets.env` uses.
//
// Leaf-symlink defense: refuse to read when `<state>/.env` resolves
// outside the supplied stateRoot. A hostile state could link
// `<state>/.env` at `~/.zsh_history` (or any KEY=value file the
// operator owns) and the matched UPPER_CASE assignments would flow
// straight into the migrated bridge secrets via collectOpenclawEnv.
// Returns an empty map on escape so the caller treats the file as
// absent — equivalent to the no-dotenv-file path.
export function readStateDotenv(stateRoot: string): Record<string, string> {
  const path = join(stateRoot, ".env");
  if (!existsSync(path)) return {};
  if (escapesSourceRoot(stateRoot, path)) return {};
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
    // Empty values are dropped for the same reason collectOpenclawEnv
    // drops them: the Telegram/Discord token selection uses `?? ` and
    // would otherwise treat an empty placeholder as a real value,
    // shadowing the real token in a later tier of the chain.
    if (value.length === 0) continue;
    out[name] = value;
  }
  return out;
}

// Merge `env.vars` and direct uppercase keys under `env` into a single
// flat env-var map. Mirrors openclaw's runtime
// `collectConfigEnvVarsByTarget` which iterates every entry under
// `env`, skipping only the structured `shellEnv` and `vars` slots.
// Returns string values only — non-string entries are dropped because
// they cannot land in a shell-sourced secrets.env.
//
// Empty strings are also dropped. The Telegram / Discord token
// selection later uses `?? ` to fall through to the dotenv-file and
// inline channel-config tiers; nullish coalescing only falls through
// for null/undefined, so an empty placeholder at this tier
// (e.g. openclaw.json carries `env: { vars: { TELEGRAM_BOT_TOKEN: "" } }`
// and the real token lives in `<state>/.env`) would otherwise shadow
// the real value and the bridge migration would silently fail.
function collectOpenclawEnv(env: OpenclawConfig["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  const direct = env as Record<string, unknown>;
  for (const [key, value] of Object.entries(direct)) {
    if (key === "shellEnv" || key === "vars") continue;
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  if (env.vars && typeof env.vars === "object") {
    for (const [key, value] of Object.entries(env.vars)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
  }
  return out;
}

// Openclaw's per-channel schema carries the bot token inline under the
// channel block itself or under nested per-account sub-objects
// (e.g. `channels.telegram.<account>.botToken`, `channels.discord.<acct>.token`).
// Resolve the first plaintext we can find for the supplied key set —
// the top-level channel block first, then each account-shaped child.
// We deliberately don't deep-walk arbitrary nesting since the openclaw
// shapes documented in the schema only allow one level of per-account
// objects.
function resolveInlineChannelToken(
  channel: OpenclawChannelConfig | undefined,
  keys: readonly string[]
): string | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const direct = pickStringField(channel, keys);
  if (direct) return direct;
  const accounts = (channel as { accounts?: unknown }).accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    for (const account of Object.values(accounts as Record<string, unknown>)) {
      if (account && typeof account === "object") {
        const found = pickStringField(account as Record<string, unknown>, keys);
        if (found) return found;
      }
    }
  }
  // Some openclaw shapes treat the channel value itself as a single
  // account map keyed by name (e.g. `channels.telegram.myaccount.botToken`).
  for (const value of Object.values(channel as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = pickStringField(value as Record<string, unknown>, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function pickStringField(
  bag: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// Openclaw's allow-list normalizer (extensions/telegram/src/allow-from.ts)
// strips a leading `telegram:` or `tg:` prefix (case-insensitive)
// before treating the remainder as a chat id. Mirror that here so
// configs that follow openclaw's documented prefix form don't get
// their entries silently coerced to NaN and dropped.
function stripTelegramAllowPrefix(value: string): string {
  return value.replace(/^(telegram|tg):/i, "");
}

function parseChatIdEntry(entry: unknown): number | null {
  const raw = typeof entry === "number" ? entry : Number(stripTelegramAllowPrefix(String(entry)));
  return Number.isFinite(raw) ? raw : null;
}

function readAllowFromAsNumbers(path: string): number[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { allowFrom?: unknown[] };
    const ids: number[] = [];
    for (const entry of data.allowFrom ?? []) {
      const value = parseChatIdEntry(entry);
      if (value !== null) ids.push(value);
    }
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
    const value = parseChatIdEntry(entry);
    if (value !== null) ids.push(value);
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

// Same gate the messaging path uses on bot tokens: header-safe
// printable ASCII (\x21-\x7E) only. Rejects newlines, control bytes,
// and spaces — all of which would break either shell sourcing or
// launchd EnvironmentVariables splitting.
const HEADER_SAFE_API_KEY = /^[\x21-\x7E]+$/;
function isHeaderSafeApiKey(value: string): boolean {
  return HEADER_SAFE_API_KEY.test(value);
}

// Build a short human-readable description of an openclaw SecretRef so
// the unsupported-entry message tells the operator where the
// credential lives without leaking the value itself.
function describeSecretRef(ref: OpenclawSecretRefLike): string {
  if (ref.source === "env" && ref.id) return `source=env, var=${ref.id}`;
  if (ref.source === "file" && ref.path) return `source=file, path=${ref.path}`;
  if (ref.source === "exec" && ref.command) return `source=exec, command=${ref.command}`;
  if (ref.source) return `source=${ref.source}`;
  return "unknown SecretRef shape";
}

// Count the messages an openclaw session JSONL will actually produce
// as ChatMessageRecord rows in gini. Critically this MUST agree with
// the apply-time filter in `parseOpenclawSessionTranscript`: that
// function drops `type: "message"` lines whose content array
// contains zero text blocks (e.g., tool_use / tool_result-only
// messages). A divergent count surfaces as a plan summary that lies
// to the operator — they're told the migration will produce 73
// messages and apply produces 61. We pay for the extra parse work
// here (a few more JSON.parse calls per file) in exchange for an
// honest plan count.
function countSessionMessages(sessionPath: string): number {
  try {
    return parseOpenclawSessionTranscript(sessionPath).messages.length;
  } catch {
    return 0;
  }
}

interface MemoryUnitPlanShape {
  sourceBank: string;
  openclawId: string;
  text: string;
  network: string;
  status: string;
  confidence: number;
  metadata: Record<string, unknown>;
  mentionedAt: string;
}

// Inspect openclaw's `memory/` directory for either Hindsight tables
// (memory_banks + memory_units, which we copy verbatim) or the
// file-chunk RAG schema (chunks + files + embedding_cache, which has
// no gini target). Returns extracted Hindsight units plus an optional
// note that lands on the unsupported list so the operator sees what
// was actually present.
//
// `stateRoot` is required so the function can refuse symlinked
// memory directories and individual `*.sqlite` symlinks that
// resolve outside the operator's chosen source root. Without the
// containment check the `unknown table layout (...)` note path in
// scanMemorySqlite leaks the table list of arbitrary SQLite files
// (browser cookies, password stores, etc.) into the import report.
function inspectOpenclawMemory(stateRoot: string, memoryDir: string): {
  hindsightUnits: MemoryUnitPlanShape[];
  note?: string;
} {
  if (!existsSync(memoryDir)) {
    return { hindsightUnits: [] };
  }
  if (escapesSourceRoot(stateRoot, memoryDir)) {
    return {
      hindsightUnits: [],
      note: `Openclaw memory/ directory resolves outside the openclaw state root (likely a parent-directory symlink); not migrated.`
    };
  }
  let entries: string[];
  try {
    entries = readdirSync(memoryDir).filter((entry) => entry.endsWith(".sqlite") || entry.endsWith(".db"));
  } catch {
    return { hindsightUnits: [] };
  }
  if (entries.length === 0) {
    return { hindsightUnits: [], note: "Openclaw memory/ exists but contains no .sqlite files; nothing to migrate." };
  }

  const hindsightUnits: MemoryUnitPlanShape[] = [];
  const notes: string[] = [];
  for (const entry of entries) {
    const dbPath = join(memoryDir, entry);
    // Same leaf-symlink defense: a `<state>/memory/main.sqlite`
    // symlinked to `~/.Cookies` would otherwise open the browser's
    // cookie DB and surface its table names via the "unknown table
    // layout" unsupported note.
    if (escapesSourceRoot(stateRoot, dbPath)) {
      notes.push(`${entry}: resolves outside the openclaw state root (likely a symlink); skipped.`);
      continue;
    }
    const bankLabel = entry.replace(/\.(sqlite|db)$/i, "");
    // Refuse bank labels that aren't a safe slug. The label flows
    // into operator-visible copy-paste SQL (the orphan-bank warning
    // suggests an `UPDATE ... WHERE metadata LIKE '%"openclawBank":"<label>"%'`
    // remediation), so a filename like `evil');DROP TABLE memory_units;--`
    // would land as an injectable LIKE clause. Whitelist matches the
    // same slug shape we accept for agent ids; anything else gets a
    // skipped-with-note path instead of a code-injection vector.
    if (!HINDSIGHT_BANK_LABEL_SAFE.test(bankLabel)) {
      notes.push(`${entry}: bank label '${bankLabel}' contains characters that aren't safe for operator-visible SQL suggestions; skipped. Rename the SQLite file to use only [A-Za-z0-9._-] characters and re-migrate.`);
      continue;
    }
    const inspection = scanMemorySqlite(dbPath, bankLabel);
    hindsightUnits.push(...inspection.units);
    if (inspection.note) notes.push(`${entry}: ${inspection.note}`);
  }
  return { hindsightUnits, note: notes.length > 0 ? notes.join("; ") : undefined };
}

// Same safe-slug shape as SAFE_AGENT_SLUG — bank labels come from
// openclaw memory SQLite filenames and feed into operator-visible
// remediation SQL when units land in the orphan bank.
const HINDSIGHT_BANK_LABEL_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function scanMemorySqlite(dbPath: string, bankLabel: string): {
  units: MemoryUnitPlanShape[];
  note?: string;
} {
  let db: SQLiteDatabaseLike | null = null;
  try {
    db = openMemorySqlite(dbPath);
  } catch (error) {
    return {
      units: [],
      note: `could not open (${error instanceof Error ? error.message : String(error)})`
    };
  }
  try {
    const tables = new Set<string>();
    try {
      for (const row of db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>) {
        tables.add(row.name);
      }
    } catch (error) {
      return {
        units: [],
        note: `could not list tables (${error instanceof Error ? error.message : String(error)})`
      };
    }
    if (tables.has("memory_units") && tables.has("memory_banks")) {
      // Older Hindsight schemas may be missing columns we now read
      // (e.g. `confidence` was added later). prepare()/all() throw
      // "no such column" against those; degrade to an unsupported
      // note instead of aborting the whole planMigration call.
      let rows: Array<{
        id: string;
        text: string;
        network: string;
        status: string;
        confidence: number | null;
        metadata: string | null;
        mentioned_at: string;
      }>;
      try {
        rows = db
          .prepare(
            "SELECT id, text, network, status, confidence, metadata, mentioned_at FROM memory_units"
          )
          .all() as typeof rows;
      } catch (error) {
        return {
          units: [],
          note: `Hindsight schema detected but SELECT failed (${error instanceof Error ? error.message : String(error)}); likely an older schema missing a column the migrator reads. Not migrated.`
        };
      }
      const units: MemoryUnitPlanShape[] = rows.map((row) => ({
        sourceBank: bankLabel,
        openclawId: row.id,
        text: row.text,
        network: row.network,
        status: row.status,
        confidence: typeof row.confidence === "number" ? row.confidence : 0,
        metadata: parseMemoryMetadata(row.metadata),
        mentionedAt: row.mentioned_at
      }));
      return units.length === 0
        ? { units, note: "Hindsight schema detected but no memory_units rows present." }
        : { units };
    }
    if (tables.has("chunks") && tables.has("files")) {
      let chunkCount = 0;
      try {
        chunkCount = (db
          .prepare("SELECT COUNT(*) AS n FROM chunks")
          .get() as { n: number }).n;
      } catch {
        // Schema present but COUNT failed — fall through with 0 and
        // let the note say so rather than aborting the whole plan.
      }
      return {
        units: [],
        note: `file-chunk RAG schema detected (${chunkCount} chunks). No Hindsight equivalent; not migrated. Re-index relevant files into gini's memory via /api/memory/retain.`
      };
    }
    return {
      units: [],
      note: `unknown table layout (${[...tables].sort().join(", ")}); no migration target.`
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* close failure is non-fatal */
    }
  }
}

function parseMemoryMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Tiny shape covering just the SQLite features we need so this module
// doesn't take a hard dependency on bun:sqlite. The actual handle is
// loaded lazily and cast in.
interface SQLiteStatementLike {
  all(): unknown[];
  get(): unknown;
}
interface SQLiteDatabaseLike {
  prepare(sql: string): SQLiteStatementLike;
  close(): void;
}

function openMemorySqlite(path: string): SQLiteDatabaseLike {
  // Lazy require so the migration module doesn't fail to load in
  // contexts where bun:sqlite isn't available (e.g. type-only
  // tooling). bun:sqlite ships with the Bun runtime, which is the
  // only environment that actually executes this code.
  const { Database } = require("bun:sqlite") as {
    Database: new (path: string, options?: unknown) => SQLiteDatabaseLike;
  };
  return new Database(path, { readonly: true });
}

// Resolve where to look for an agent's auth-profiles.json. Defaults to
// `<agentsDir>/<id>/agent/`. Honors `agents.list[].agentDir` as an
// operator override, including the common `~/.openclaw/...` tilde form
// (openclaw accepts the literal `~` in agentDir). A missing or
// non-string override falls back to the default — same behavior the
// pre-extraction inline code had.
function resolveAgentDirOverride(
  agent: OpenclawAgentConfig,
  agentsDir: string,
  openclawId: string
): string {
  const override = agent.agentDir;
  if (typeof override === "string" && override.length > 0) {
    const home = process.env.OPENCLAW_HOME || process.env.HOME || homedir();
    return override.replace(/^~(?=\/|$)/, home);
  }
  return join(agentsDir, openclawId, "agent");
}

// Decide whether `candidate` resolves OUTSIDE of `root` after walking
// every symlink in both paths. The migrator uses this to enforce that
// every source path it reads stays inside `source.stateRoot` — the
// boundary the operator chose via `--path`. Without this check a
// crafted openclaw.json could escape the source root in three ways:
//   1. `agents.list[].agentDir: "~/.aws"` redirects the auth-profiles
//      read out of the state root (caught at agent step).
//   2. `<state>/skills` is a SYMLINK to `/etc/`, so readdirSync at
//      plan time follows it and the resulting source paths point at
//      `/etc/...` (caught at skill discovery).
//   3. `<state>/workspace` is a SYMLINK to `~/.ssh`, so the workspace
//      file copy lifts arbitrary files into the gini instance (caught
//      at workspace discovery).
// Returns true when candidate escapes (caller should refuse + surface
// an `unsupported` entry). Returns false when the candidate either
// stays inside or cannot be resolved (broken symlink, missing file —
// the underlying read will then surface a more specific error).
function escapesSourceRoot(root: string, candidate: string): boolean {
  try {
    const rootReal = realpathSync(resolve(root));
    const candidateReal = realpathSync(resolve(candidate));
    const rel = relative(rootReal, candidateReal);
    if (rel === "") return false;
    return rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..\\`);
  } catch {
    // realpath fails when the path doesn't exist or is a broken
    // symlink. The migrator's downstream existsSync / readFileSync
    // calls will produce more specific errors than a synthetic
    // "escape" decision, so we let them through here.
    return false;
  }
}

// Reject a copy source that is a symlink. `copyFileSync` and
// `readFileSync` follow symlinks by default, so a hand-crafted openclaw
// state with `skills/foo/SKILL.md` symlinked to `/etc/passwd` (or
// `workspace/SOUL.md` -> `~/.aws/credentials`) would dereference and
// rematerialize the link target inside the gini instance — defeating
// the workspace sandbox that `assertInsideWorkspaceNoSymlinkEscape`
// elsewhere relies on. The migrator imports from operator-supplied
// `--path` arguments (a tarball extract, a coworker's backup), so the
// source is not necessarily trustworthy. Refusing symlinks outright is
// simpler than a realpath escape check and matches the operator-
// authored shape of legitimate openclaw skills (no symlinks in
// bundled fixtures, no symlinks in the real backup we tested against).
// `cpSync` with `dereference: false` (Node's default) preserves
// symlinks as symlinks — copyDirShallow uses an explicit filter to
// drop them entirely so the destination never holds a dangling
// outward-pointing link either.
function isSymlinkSource(sourcePath: string): boolean {
  try {
    return lstatSync(sourcePath).isSymbolicLink();
  } catch {
    // lstat failure (missing source) falls through to the underlying
    // copy attempt, which surfaces a more specific error.
    return false;
  }
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

// Openclaw's AuthProfile shapes carry either the plaintext credential
// (`key`/`token`/`access`) or a SecretRef indirection (`keyRef` /
// `tokenRef`) pointing at an env var, file, or exec command. The
// migrator can only carry the plaintext over directly; SecretRef
// profiles need operator action on the gini side, so the loop has to
// recognize them and surface an explicit unsupported entry rather
// than silently treating them as "no credential."
interface OpenclawSecretRefLike {
  source?: string;
  provider?: string;
  id?: string;
  path?: string;
  command?: string;
}

interface AuthProfileLike {
  type?: string;
  provider?: string;
  key?: string;
  token?: string;
  access?: string;
  keyRef?: OpenclawSecretRefLike;
  tokenRef?: OpenclawSecretRefLike;
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

  // Realpath-contain the in-stateRoot openclaw.json. The
  // OPENCLAW_CONFIG_PATH env case (env override → configPath legitimately
  // lives outside stateRoot by design) is exempt — we detect it by
  // comparing the resolved configPath against the env value. Without
  // this check a hostile `<stateRoot>/openclaw.json` symlinked at
  // `~/.openclaw/openclaw.json` (or any other openclaw.json on the
  // system) would be silently followed, breaking the operator's
  // "everything came from --path" mental model and routing every
  // downstream decision (agent ids, agentDir overrides, channel
  // tokens) through a config they didn't choose.
  const envConfigOverride = process.env.OPENCLAW_CONFIG_PATH
    ? resolve(process.env.OPENCLAW_CONFIG_PATH)
    : null;
  const isEnvOverride =
    envConfigOverride !== null && resolve(source.configPath) === envConfigOverride;
  if (!isEnvOverride && escapesSourceRoot(source.stateRoot, source.configPath)) {
    unsupported.push({
      kind: "openclaw-state",
      detail: `openclaw.json at ${source.configPath} resolves outside the openclaw state root (likely a symlink). Migration refused — replace the symlink with a real config inside --path, or point OPENCLAW_CONFIG_PATH at the external file explicitly.`
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
  // Map each retained agent id to the directory we should look for
  // auth-profiles.json under. Operators can override per-agent via
  // `agents.list[].agentDir` (commonly `~` or `~/.openclaw/secrets/<id>/...`),
  // so the default `<state>/agents/<id>/agent/` is just a fallback.
  const agentDirs = new Map<string, string>();
  // Openclaw stores provider+model together as a "provider/model" string
  // (e.g. "openai/gpt-5", "anthropic/claude-3-5-sonnet"). The `primary`
  // slot of `AgentModelConfig` carries the same shape. Gini's
  // AgentRecord keeps provider and model on separate fields, so we split
  // before handing them to the migration step.
  const defaultRouting = parseOpenclawModelRouting(config.agents?.defaults?.model);
  // Track providers we've already complained about so a config with
  // dozens of anthropic agents doesn't produce dozens of duplicate
  // unsupported entries.
  const flaggedUnsupportedProviders = new Set<string>();
  const flagUnsupportedProvider = (providerName: string | undefined, agentLabel: string) => {
    if (!providerName) return;
    if (mapProviderToGini(providerName) !== null) return;
    const key = providerName.toLowerCase();
    if (flaggedUnsupportedProviders.has(key)) return;
    flaggedUnsupportedProviders.add(key);
    unsupported.push({
      kind: `provider:${providerName}`,
      detail: `Agent '${agentLabel}' uses openclaw provider '${providerName}'; gini has no native mapping and the imported agent will fall back to the instance provider until you wire one.`
    });
  };
  // Track local-flavor providers (lmstudio / vllm) that we collapse
  // onto gini's "local" provider. Gini's local provider defaults to
  // Ollama's URL (127.0.0.1:11434/v1); LMStudio listens at
  // 127.0.0.1:1234/v1 and vLLM at localhost:8000/v1. The migrator
  // doesn't carry baseUrl on per-agent overrides today, so the
  // collapsed agent inherits whatever baseUrl the instance config
  // has — Ollama by default, which silently misroutes LMStudio /
  // vLLM users to the wrong port. Surface the mismatch as an
  // unsupported entry so the operator either changes the instance
  // baseUrl or manually sets the right URL after migrating.
  const flaggedLocalFlavors = new Set<string>();
  const flagLocalFlavorMismatch = (providerName: string | undefined, agentLabel: string) => {
    if (!providerName) return;
    const normalized = providerName.toLowerCase();
    if (normalized !== "lmstudio" && normalized !== "vllm") return;
    if (flaggedLocalFlavors.has(normalized)) return;
    flaggedLocalFlavors.add(normalized);
    const defaultUrl = normalized === "lmstudio"
      ? "http://127.0.0.1:1234/v1"
      : "http://localhost:8000/v1";
    unsupported.push({
      kind: `provider:${normalized}`,
      detail: `Agent '${agentLabel}' uses openclaw provider '${normalized}'. Gini collapses it onto the 'local' provider, but the migrated agent will inherit your instance's local baseUrl (Ollama default 127.0.0.1:11434/v1). ${normalized.toUpperCase()} listens at ${defaultUrl} by default — update the gini instance config (or the migrated agent) before running it, or requests will hit the wrong port.`
    });
  };
  if (agentList.length === 0) {
    // Openclaw treats `main` as the implicit default when no list is
    // configured. We mirror that so users with the simplest config still
    // get an agent record. The bare-model gate matches the per-agent
    // branch below — model-only routing is dropped because the gini
    // runtime AND-guards on (providerName, model).
    flagUnsupportedProvider(defaultRouting.providerName, "main");
    flagLocalFlavorMismatch(defaultRouting.providerName, "main");
    if (defaultRouting.model && !defaultRouting.providerName) {
      unsupported.push({
        kind: "agent",
        detail: `Default \`agents.defaults.model: "${defaultRouting.model}"\` has no provider prefix. The implicit \`main\` agent will fall back to the instance provider. Add a \`<provider>/${defaultRouting.model}\` prefix in openclaw and re-migrate to preserve the routing.`
      });
    }
    steps.push({
      kind: "agent",
      openclawId: "main",
      name: "main",
      providerName: defaultRouting.providerName,
      model: defaultRouting.providerName ? defaultRouting.model : undefined
    });
    agentIds.push("main");
    agentDirs.set("main", join(source.agentsDir, "main", "agent"));
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
      const resolvedProvider = routing.providerName ?? defaultRouting.providerName;
      const resolvedModel = routing.model ?? defaultRouting.model;
      flagUnsupportedProvider(resolvedProvider, openclawId);
      flagLocalFlavorMismatch(resolvedProvider, openclawId);
      // resolveEffectiveContext only honors a per-agent provider
      // override when BOTH providerName and model are populated. A
      // bare `model: "gpt-5-mini"` (no slash, no defaults-provider)
      // resolves to model-only routing; the runtime silently
      // discards the model and the agent falls back to the instance
      // provider. Surface the partial routing so the operator either
      // adds a provider prefix in openclaw before re-migrating or
      // accepts the fallback knowingly; clear the orphan model on
      // the AgentRecord so the resulting state is honest about
      // what's active.
      if (resolvedModel && !resolvedProvider) {
        unsupported.push({
          kind: "agent",
          detail: `Agent '${openclawId}' has \`model: "${resolvedModel}"\` without a provider prefix. Gini's runtime ignores model-only overrides, so the imported agent will fall back to the instance provider. Add a \`<provider>/${resolvedModel}\` prefix in openclaw and re-migrate to preserve the routing.`
        });
      }
      // Fall back to the defaults block when the agent didn't supply a
      // model of its own — openclaw resolves the same way at runtime.
      // Drop the model when no provider resolved so the AgentRecord
      // doesn't pretend to honor a routing the runtime will discard.
      // Defense-in-depth: `agents.list[].agentDir` can carry an
      // absolute path or `~`-prefix the operator may not have written
      // themselves (the openclaw.json could be from a coworker's
      // backup tarball). A redirected agentDir at e.g. `~/.aws` would
      // make the auth-profiles read below escape `source.stateRoot`
      // and harvest credentials from the operator's other tools.
      // Refuse anything that resolves outside the source root and
      // surface it on the unsupported list so the operator sees the
      // skip rather than discovering it via a missing migrated agent.
      const agentDir = resolveAgentDirOverride(agent, source.agentsDir, openclawId);
      if (escapesSourceRoot(source.stateRoot, agentDir)) {
        unsupported.push({
          kind: `agent:${openclawId}`,
          detail: `Skipped agent '${openclawId}': agentDir override '${agent.agentDir ?? "(default)"}' resolves outside the openclaw state root. The migrator refuses to read auth-profiles.json from paths the operator didn't include in --path.`
        });
        continue;
      }
      steps.push({
        kind: "agent",
        openclawId,
        name: openclawId,
        providerName: resolvedProvider,
        model: resolvedProvider ? resolvedModel : undefined
      });
      agentIds.push(openclawId);
      agentDirs.set(openclawId, agentDir);
    }
  }

  // Provider API keys (per agent auth-profiles.json)
  const seenSecretEnv = new Set<string>();
  for (const agentId of agentIds) {
    const authPath = join(
      agentDirs.get(agentId) ?? join(source.agentsDir, agentId, "agent"),
      "auth-profiles.json"
    );
    if (!existsSync(authPath)) continue;
    // Leaf-symlink defense. We already containment-check `agentDir`
    // at the agents loop, but a hostile state could leave `agentDir`
    // pointing at a legitimate path inside the source root while
    // making the leaf `auth-profiles.json` a symlink to
    // `~/.aws/credentials.json` — same exfiltration shape via a
    // different vector. realpath the leaf and refuse if it escapes.
    if (escapesSourceRoot(source.stateRoot, authPath)) {
      unsupported.push({
        kind: `auth-profiles:${agentId}`,
        detail: `Skipped auth-profiles.json for agent '${agentId}': leaf resolves outside the openclaw state root (likely a symlink). The migrator only reads credential files that physically live under --path.`
      });
      continue;
    }
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
      if (!plaintext) {
        // The profile may still carry a SecretRef indirection (keyRef
        // / tokenRef) where the real value lives in an env var, a
        // file, or an exec command. We can't dereference those during
        // migration — the env var might not be set in the gini gateway
        // process, the file might be a different absolute path on a
        // different machine, the exec might not be safe to run. Push
        // an unsupported entry so the operator knows their key wasn't
        // migrated and what to do instead.
        const ref = profile.keyRef ?? profile.tokenRef;
        if (ref && typeof ref === "object") {
          const refDescription = describeSecretRef(ref);
          unsupported.push({
            kind: `provider:${profile.provider ?? giniProvider}`,
            detail: `Profile uses a SecretRef indirection (${refDescription}); migrator cannot dereference it. Set ${canonicalApiKeyEnv(giniProvider) ?? "the provider API key env var"} in ~/.gini/secrets.env manually.`
          });
        }
        continue;
      }
      // Source the canonical env var name from the provider layer
      // rather than hand-rolling `${PROVIDER}_API_KEY`. The local
      // provider uses `GINI_LOCAL_API_KEY` (per `normalizeProvider` in
      // src/provider.ts), so a hand-rolled "LOCAL_API_KEY" would land
      // in ~/.gini/secrets.env but the runtime would never read it.
      const envVar = canonicalApiKeyEnv(giniProvider);
      if (!envVar) continue;
      // Run the apply-time header-safe gate at plan time too. Otherwise
      // a malformed FIRST profile (newline in the key, control byte,
      // etc.) would claim the env-var slot in `seenSecretEnv` here,
      // and any later valid profile for the same provider would be
      // dropped into the unsupported list as a "duplicate" — even
      // though the first profile gets rejected at apply time and the
      // operator ends up with no migrated key at all. Doing the
      // check here lets a valid later profile take the slot.
      if (!isHeaderSafeApiKey(plaintext)) {
        unsupported.push({
          kind: `provider:${profile.provider ?? giniProvider}:malformed`,
          detail: `Openclaw auth profile for '${envVar}' carries a value with characters that aren't header-safe printable ASCII (newline, control byte, etc.) and would never reach the runtime via secrets.env. Skipped; a later valid profile for the same provider, if any, can take the slot.`
        });
        continue;
      }
      if (seenSecretEnv.has(envVar)) {
        // Openclaw lets operators store multiple auth profiles per
        // provider for rotation/failover; gini's secrets.env stores
        // exactly one key per env-var name. The first profile wins by
        // file-read order; surface the rest so the operator knows
        // which key they're left with and can rotate manually.
        unsupported.push({
          kind: `provider:${profile.provider ?? giniProvider}:duplicate`,
          detail: `Multiple openclaw auth profiles map to '${envVar}'. The first plaintext key was kept; additional profiles were dropped. Edit ~/.gini/secrets.env manually if you need the other one instead.`
        });
        continue;
      }
      seenSecretEnv.add(envVar);
      steps.push({ kind: "secret", envVar, valueFrom: plaintext, provider: giniProvider });
    }
  }

  // Channels → messaging bridges (Telegram + Discord only — these are
  // the bridges gini implements today; the per-channel ADRs are
  // `docs/adr/telegram-bridge.md` and `docs/adr/discord-bridge.md`).
  const channels = config.channels ?? {};
  // Openclaw's env schema is `{ shellEnv?, vars?, ...catchall<string> }`
  // — direct uppercase keys under `env` are valid (the upstream
  // resolver iterates all entries skipping just `shellEnv`/`vars`).
  // Union both shapes so configs that hand-edit
  // `env: { TELEGRAM_BOT_TOKEN: "..." }` directly migrate as readily
  // as configs nesting under `env.vars`.
  const envVars = collectOpenclawEnv(config.env);
  const dotenv = readStateDotenv(source.stateRoot);
  for (const name of Object.keys(channels)) {
    if (name === "telegram") {
      const inlineTelegram = resolveInlineChannelToken(channels[name], [
        "botToken",
        "token"
      ]);
      const token =
        envVars.TELEGRAM_BOT_TOKEN ??
        dotenv.TELEGRAM_BOT_TOKEN ??
        inlineTelegram;
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
      const inlineDiscord = resolveInlineChannelToken(channels[name], [
        "botToken",
        "token"
      ]);
      const token =
        envVars.DISCORD_BOT_TOKEN ??
        dotenv.DISCORD_BOT_TOKEN ??
        inlineDiscord;
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

  // Skills (managed root: <state>/skills/<name>/SKILL.md).
  // readdirSync follows directory symlinks, so a `<state>/skills`
  // -> `/etc` symlink would enumerate /etc and the leaf
  // `isSymlinkSource` check at apply time would pass (the leaf
  // SKILL.md isn't itself a symlink even though its parent's parent
  // is). Realpath each candidate against source.stateRoot here to
  // refuse anything that escapes via a parent-directory symlink.
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
      if (!existsSync(skillPath)) continue;
      if (escapesSourceRoot(source.stateRoot, skillPath)) {
        unsupported.push({
          kind: `skill:${name}`,
          detail: `Skipped skill '${name}': resolves outside the openclaw state root (likely a parent-directory symlink). The migrator only copies skills that physically live under --path.`
        });
        continue;
      }
      steps.push({ kind: "skill", name, sourcePath: skillPath });
    }
  }

  // Workspace bootstrap files. Same parent-symlink concern as skills:
  // `<state>/workspace` -> `~/.ssh` would lift any file there into
  // the gini workspace via the lstat-only leaf check. Validate
  // containment up front.
  if (source.workspaceRoot) {
    for (const fileName of WORKSPACE_BOOTSTRAP_FILES) {
      const filePath = join(source.workspaceRoot, fileName);
      if (!existsSync(filePath)) continue;
      if (escapesSourceRoot(source.stateRoot, filePath)) {
        unsupported.push({
          kind: `workspaceFile:${fileName}`,
          detail: `Skipped workspace bootstrap file '${fileName}': resolves outside the openclaw state root (likely a parent-directory symlink). The migrator only copies workspace files that physically live under --path.`
        });
        continue;
      }
      steps.push({ kind: "workspaceFile", name: fileName, sourcePath: filePath });
    }
  }

  // Sessions: scan <state>/agents/<id>/sessions for .jsonl transcripts
  // (skipping rotated `.reset.<timestamp>` archives). Each becomes a
  // ChatSessionRecord + N ChatMessageRecord rows on the gini side. The
  // file is read at plan time only to count messages; full content
  // streams during apply.
  for (const agentId of agentIds) {
    const sessionDir = join(source.agentsDir, agentId, "sessions");
    if (!existsSync(sessionDir)) continue;
    for (const entry of readdirSync(sessionDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionPath = join(sessionDir, entry);
      const sessionId = entry.slice(0, -".jsonl".length);
      // Refuse session paths that resolve outside the source root
      // via a parent-directory symlink (same hazard as
      // skills/workspace). The agent id is slug-validated upstream,
      // so the segment names themselves are safe; this guards
      // against a symlinked agentsDir or sessionDir.
      if (escapesSourceRoot(source.stateRoot, sessionPath)) {
        unsupported.push({
          kind: `session:${agentId}/${sessionId}`,
          detail: `Skipped openclaw session ${sessionId}: resolves outside the openclaw state root (likely a parent-directory symlink). The migrator only reads sessions that physically live under --path.`
        });
        continue;
      }
      // `countSessionMessages` now applies the same content filter as
      // the apply-time parser (text-only blocks survive), so a tool-
      // only transcript reports 0 here and we drop it from the plan
      // entirely. Surface it as an `unsupported` entry so the
      // operator still sees the file was scanned and intentionally
      // skipped, instead of silently disappearing from the report.
      const messageCount = countSessionMessages(sessionPath);
      if (messageCount === 0) {
        unsupported.push({
          kind: `session:${agentId}/${sessionId}`,
          detail: `Openclaw session ${sessionId} has no text-bearing messages (tool-only transcript or malformed JSONL); not migrated. Inspect the source JSONL in the archive zip if you need the original tool-call detail.`
        });
        continue;
      }
      steps.push({
        kind: "session",
        openclawId: agentId,
        sessionId,
        sourcePath: sessionPath,
        messageCount
      });
    }
  }

  // Memory: openclaw ships at least two memory backends. The Hindsight
  // store uses `memory_banks` + `memory_units` tables that map directly
  // to gini's. Some installs instead carry a file-chunk RAG index
  // (tables `chunks` / `files` / `embedding_cache`) — a wholly
  // different model with no clean gini target. Detect the schema and
  // surface what we found so the operator knows which path applied.
  const memoryReport = inspectOpenclawMemory(source.stateRoot, join(source.stateRoot, "memory"));
  for (const unit of memoryReport.hindsightUnits) {
    steps.push({ kind: "memoryUnit", ...unit });
  }
  if (memoryReport.note) {
    unsupported.push({ kind: "memory", detail: memoryReport.note });
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
    sessions: 0,
    sessionMessages: 0,
    memoryUnits: 0,
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
    if (step.kind === "session") {
      counts.sessions += 1;
      counts.sessionMessages += step.messageCount;
      return {
        kind: "session",
        openclawId: step.openclawId,
        sessionId: step.sessionId,
        messageCount: step.messageCount
      };
    }
    if (step.kind === "memoryUnit") {
      counts.memoryUnits += 1;
      return {
        kind: "memoryUnit",
        sourceBank: step.sourceBank,
        openclawId: step.openclawId,
        network: step.network
      };
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

// Per-instance import lock. Two `gini import apply openclaw`
// invocations against the same gini instance must NOT race — the
// in-process `mutateState` lock only serializes writers inside a
// single Node process, and `writeState` uses a fixed temp filename
// (`<state>.tmp`) without any cross-process exclusion. A parallel
// apply would either lose updates (one rename overwrites the other's
// in-flight tmp mid-stream) or land both rows into state.json with
// the planner's idempotency dedup not having seen the other's writes.
// `O_EXCL | O_CREAT` gives us a kernel-enforced atomic check-and-set
// on the lockfile name; we record the holder's PID + start time so a
// crashed previous run can be detected and cleaned up automatically
// instead of forcing the operator to grep for a stale lockfile.
interface ImportLockHandle {
  path: string;
  release: () => void;
}

function acquireImportLock(instance: string): ImportLockHandle {
  const root = instanceRoot(instance);
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, ".import-lock");
  // writeFileSync with flag "wx" (O_WRONLY | O_CREAT | O_EXCL) opens
  // the lockfile atomically AND writes the PID before closing. The
  // alternative — openSync followed by writeSync — leaves a tiny
  // userspace window where the lockfile exists empty; a peer hitting
  // EEXIST in that window would read no PID, treat the lock as stale,
  // unlink it, and proceed in parallel. Combining open + write keeps
  // the empty-file window to libc-internal microseconds (instead of
  // a userspace function call between two separate syscalls).
  const lockContent = `pid=${process.pid}\nat=${now()}\ncmd=gini import apply openclaw\n`;
  try {
    writeFileSync(lockPath, lockContent, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Stale-lock detection: read the recorded PID. If that process
    // is gone, the previous run crashed without releasing — drop the
    // lock and retry once. We deliberately do NOT loop more than
    // once: a second EEXIST after the cleanup means a third party
    // raced in, and the right thing is to surface the conflict to
    // the operator rather than spin.
    //
    // CRITICAL: when the existing lockfile has NO recorded PID we
    // refuse to unlink. The two cases that produce a no-PID lock are
    // (a) a peer process is mid-acquisition (its writeFileSync hasn't
    // flushed yet) — unlinking would corrupt active serialization;
    // (b) a peer crashed in the libc-microsecond window between
    // open and write — vanishingly rare. Conservative refuse-when-
    // uncertain is the right trade: case (b) requires manual lock
    // cleanup; case (a) preserves correctness.
    const existingPid = readImportLockPid(lockPath);
    if (existingPid === null) {
      throw new Error(
        `Import lock at ${lockPath} exists but has no recorded PID — a peer process is mid-acquisition. Retry shortly; if the lock persists with no PID after several seconds, remove it manually after confirming no migration is in progress.`
      );
    }
    if (isProcessAlive(existingPid)) {
      throw new Error(
        `Another gini import is running for instance '${instance}' (PID ${existingPid}, lock at ${lockPath}). Wait for it to finish, or stop that process and retry.`
      );
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone else cleaned up between our read and unlink — fall
      // through to the retry which will succeed or surface a real
      // conflict.
    }
    try {
      writeFileSync(lockPath, lockContent, { flag: "wx", mode: 0o600 });
    } catch (retryError) {
      throw new Error(
        `Another gini import raced into the import lock for instance '${instance}' (lock at ${lockPath}). Retry shortly; if the conflict persists, remove the lock file manually after confirming no migration is in progress.`
      );
    }
  }
  return {
    path: lockPath,
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // unlink failure (e.g., someone already removed it) is non-fatal.
      }
    }
  };
}

function readImportLockPid(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf8");
    const match = /^pid=(\d+)/m.exec(content);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
  // restarts. No --force override here on purpose: silently losing the
  // running gateway's writes is the failure mode the gate exists to
  // prevent, and an override would invite the exact foot-gun.
  // Closure that re-runs the gateway-alive check before each
  // mutateState write. The pidfile lifecycle has timing windows on
  // both ends: `gini stop` removes the file before the runtime's
  // SIGTERM drain has finished (server.ts pins
  // SERVER_DRAIN_TIMEOUT_MS=5000ms and SCHEDULER_DRAIN_TIMEOUT_MS=5000ms,
  // so the gateway may still be issuing state.json writes for up to
  // 10000ms after the pidfile is gone), and `gini start` spawns the
  // child before the child writes its own pidfile. The single
  // up-front check leaves both windows open. Re-checking inside this
  // closure narrows the race to "gateway started or finished
  // draining between the check and the atomic rename" —
  // milliseconds rather than seconds. The residual TOCTOU is
  // acknowledged; full mutual exclusion would require an OS-level
  // advisory lock the rest of gini doesn't have.
  const guardedMutate = <T>(fn: (state: RuntimeState) => T): Promise<T> => {
    const liveNow = detectRunningGateway(config.instance);
    if (liveNow) {
      throw new Error(
        `Gini gateway came up for instance '${config.instance}' (PID ${liveNow.pid}) mid-migration. Stop it with \`gini stop --instance ${config.instance}\` and re-run \`gini import apply openclaw\`.`
      );
    }
    return mutateState(config.instance, fn);
  };

  const running = detectRunningGateway(config.instance);
  if (running) {
    throw new Error(
      `Gini gateway is running for instance '${config.instance}' (PID ${running.pid}). Stop it first with \`gini stop --instance ${config.instance}\` so the migration can write state.json without racing the gateway, then re-run \`gini import apply openclaw\`.`
    );
  }

  // Cross-process serialization. `mutateState` / `writeState`
  // serialize writes only inside a single Node process; two parallel
  // `gini import apply openclaw` invocations would race on the
  // shared `<state>.tmp` filename and either corrupt state.json or
  // lose updates. Acquire an O_EXCL lockfile at the instance root
  // for the lifetime of the migration so a second concurrent process
  // fails fast with a clear message instead of clobbering the first.
  const importLock = acquireImportLock(config.instance);
  try {

  const warnings: string[] = [];
  let agentsCreated = 0;
  let bridgesCreated = 0;
  let bridgesRotated = 0;
  let skillsCopied = 0;
  let secretsWritten = 0;
  let workspaceFilesCopied = 0;
  let sessionsCreated = 0;
  let sessionMessagesCreated = 0;
  let memoryUnitsCreated = 0;
  let archivePath: string | undefined;

  // Short-circuit when there's no openclaw config to read. Otherwise
  // apply would write an "applied" ImportReport with all-zero counts
  // and (pre-fix) a phantom main agent — both of which lie to the
  // operator about what happened. We still emit a report so the
  // activity feed records the attempt; the failed status makes the
  // outcome unambiguous.
  if (!plan.source.configExists) {
    const failedReport = await guardedMutate((state: RuntimeState) =>
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
      bridgesRotated,
      skillsCopied,
      secretsWritten,
      workspaceFilesCopied,
      sessionsCreated,
      sessionMessagesCreated,
      memoryUnitsCreated,
      unsupported: plan.unsupported,
      warnings
    };
  }

  // 0) Archive the entire openclaw state root into <instance>/imports/
  // before any other migration step runs. The migration itself never
  // deletes openclaw data — we only read from source.stateRoot — but
  // the archive is the operator's insurance policy in case they later
  // wipe their ~/.openclaw thinking the migration "moved" it. The zip
  // is a verbatim snapshot they can restore from. We run zip with
  // `-y` so symlinks land as symlinks (some openclaw setups symlink
  // workspace into a separate disk) and `-q` so the progress chatter
  // doesn't pollute the migration log. A non-zero exit code throws,
  // because the safety net is non-optional — the operator explicitly
  // asked for it ("migrations should not delete data, so we will
  // still need the originals once things are moved over").
  // Mirror the per-instance secret store's mode contract: imports dir
  // 0700, archive file 0600. The archive carries a verbatim copy of
  // every plaintext credential the openclaw state held (provider keys
  // in auth-profiles.json, bot tokens in .env / inline channel config)
  // — the same material the migrator otherwise tightens via
  // writeKeyToSecretsEnv (0600 chmod) and writeSecret (FILE_MODE=0o600,
  // DIR_MODE=0o700). Writing the archive at the umask default (typically
  // 0644 file / 0755 dir) would create an exfiltration surface the rest
  // of gini explicitly avoids: anyone with read on the imports
  // directory (other local users, untrusted backup processes, an
  // accidental upload) would get every key the migrator just locked
  // down. mkdirSync's mode is only honored on initial create, so we
  // chmod after to cover the recursive=true re-create case; chmod on
  // the archive file runs after zip writes it so the result is owner-
  // read-only even if the operator's umask was permissive.
  const importsDir = join(instanceRoot(config.instance), "imports");
  mkdirSync(importsDir, { recursive: true, mode: 0o700 });
  chmodSync(importsDir, 0o700);
  const archiveStamp = now().replace(/[:.]/g, "-");
  archivePath = join(importsDir, `openclaw-${archiveStamp}.zip`);
  const zipResult = spawnSync("zip", ["-rqy", archivePath, "."], {
    cwd: source.stateRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (zipResult.error) {
    throw new Error(
      `Failed to archive openclaw state to ${archivePath}: ${zipResult.error.message}. Install \`zip\` and re-run \`gini import apply openclaw\`.`
    );
  }
  if (typeof zipResult.status === "number" && zipResult.status !== 0) {
    const stderr =
      zipResult.stderr && zipResult.stderr.length > 0
        ? zipResult.stderr.toString("utf8").trim()
        : "(no stderr)";
    throw new Error(
      `\`zip\` exited with status ${zipResult.status} while archiving ${source.stateRoot} → ${archivePath}: ${stderr}`
    );
  }
  // Append the openclaw config file when it lives OUTSIDE the state
  // root (e.g., the operator pointed OPENCLAW_CONFIG_PATH at a
  // dedicated config dir). The recursive zip above captures only
  // `source.stateRoot`; without this second pass, restoring from the
  // archive would land an openclaw state with no `openclaw.json`,
  // and the planner's `!source.configPath` guard would short-circuit
  // with "No openclaw config found". `zip -j` strips the source path
  // so the file lands at the archive root with just its basename
  // (typically `openclaw.json`), matching the location the planner
  // expects on restore.
  if (source.configPath) {
    const relativeConfig = relative(source.stateRoot, source.configPath);
    const configOutsideStateRoot =
      relativeConfig === "" || relativeConfig.startsWith("..");
    if (configOutsideStateRoot) {
      const appendResult = spawnSync(
        "zip",
        ["-jqg", archivePath, source.configPath],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      if (appendResult.error) {
        warnings.push(
          `Failed to append external openclaw config ${source.configPath} to archive (${appendResult.error.message}). Restore would need the config copied separately.`
        );
      } else if (typeof appendResult.status === "number" && appendResult.status !== 0) {
        const stderr =
          appendResult.stderr && appendResult.stderr.length > 0
            ? appendResult.stderr.toString("utf8").trim()
            : "(no stderr)";
        warnings.push(
          `\`zip\` exited with status ${appendResult.status} appending external openclaw config to archive: ${stderr}. Restore would need the config copied separately.`
        );
      }
    }
  }
  chmodSync(archivePath, 0o600);

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
    // Mirror the messaging path's header-safe gate on the api-key
    // string. shell-quoting in writeKeyToSecretsEnv keeps a newline-
    // laced value from breaking `set -a; . ~/.gini/secrets.env` at
    // source time, but the launchd plist installer (autostart.ts)
    // splits the file by newlines and copies each KEY=VALUE into
    // EnvironmentVariables — a value containing a literal newline
    // followed by `export EVIL=...` injects EVIL into the gateway's
    // launchd env. Real `sk-...` keys are header-safe printable
    // ASCII, so the gate is pure defense-in-depth with no false
    // positives.
    if (!isHeaderSafeApiKey(step.valueFrom)) {
      warnings.push(
        `Skipped secret ${step.envVar}: value contains characters that aren't header-safe printable ASCII.`
      );
      continue;
    }
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
    if (isSymlinkSource(step.sourcePath)) {
      warnings.push(
        `Skipped workspace file ${step.name}: source is a symlink and may point outside the openclaw state root. Replace the symlink with the actual content in openclaw before re-migrating.`
      );
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
    if (isSymlinkSource(step.sourcePath)) {
      warnings.push(
        `Skipped skill ${step.name}: SKILL.md is a symlink and may point outside the openclaw state root. Replace the symlink with the actual content in openclaw before re-migrating.`
      );
      continue;
    }
    try {
      mkdirSync(targetDir, { recursive: true });
      const raw = readFileSync(step.sourcePath, "utf8");
      writeFileSync(targetSkill, rewriteSkillFrontmatter(raw), { mode: 0o644 });
      // Propagate --force into the sibling-file copy so a rotated
      // skill gets a fully refreshed bundle rather than a hybrid of
      // new SKILL.md plus stale scripts/ files from the prior import.
      // The earlier copy path skipped existing destinations
      // unconditionally, which contradicted the documented --force
      // intent.
      copyDirShallow(
        dirname(step.sourcePath),
        targetDir,
        new Set(["SKILL.md"]),
        options.force === true
      );
      skillsCopied += 1;
    } catch (error) {
      warnings.push(
        `Failed to copy skill ${step.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 4) Agents. Skip if an agent with the same name already exists so
  // re-running the migrator is idempotent.
  await guardedMutate((state: RuntimeState) => {
    for (const step of plan.steps) {
      if (step.kind !== "agent") continue;
      if (state.agents.some((existing) => existing.name === step.name)) {
        warnings.push(`Skipped existing agent: ${step.name}`);
        continue;
      }
      const giniProvider = step.providerName ? mapProviderToGini(step.providerName) : null;
      // The openclaw agent had a provider routing gini doesn't natively
      // support (e.g. anthropic, google). Without a warning, the agent
      // would land with providerName: undefined, silently falling back
      // to the instance-level RuntimeConfig.provider — a subtle
      // behavior change the operator would have to discover by running
      // the migrated agent and noticing the wrong model. Surface it as
      // a warning so the agent's routing gap is visible alongside the
      // unsupported provider entry.
      if (step.providerName && !giniProvider) {
        warnings.push(
          `Agent '${step.name}' used openclaw provider '${step.providerName}'; gini has no native mapping so the migrated agent will fall back to the instance-level provider.`
        );
      }
      createAgentRecord(state, {
        name: step.name,
        providerName: giniProvider ?? undefined,
        model: step.model,
        // Pull the canonical default-agent toolset whitelist from
        // src/state/defaults so the migrator can't drift if the gini
        // baseline ever changes. New toolsets added there will land
        // on imported agents automatically.
        toolsets: [...DEFAULT_AGENT_TOOLSETS],
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
      // Gini doesn't currently expose an "edit existing bridge" verb on
      // the messaging API, and `gini messaging add` is strict-create
      // (would produce a second Discord bridge alongside the migrated
      // one). Direct the operator at the only safe in-band flow:
      // disable the dormant bridge and re-create with the desired
      // delivery channels, re-supplying the bot token from openclaw.
      // We deliberately do NOT suggest hand-editing state.json — that
      // skips the audit chain, the per-instance mutateState lock, and
      // the atomic tmp+rename, all of which exist to keep state
      // consistent. Implementing a dedicated edit verb is the right
      // long-term answer; the warning surfaces the friction in the
      // meantime.
      warnings.push(
        `Discord bridge migrated without deliveryTargets; supervisor will stay idle until you wire channels. Run \`gini messaging disable <bridge-id>\` then \`gini messaging add <name> discord <channel-id>... --bot-token <token>\` to re-create the bridge with delivery channels, supplying the same bot token openclaw used.`
      );
    }
    // First pass: decide whether we are creating or rotating, AND
    // for the create path, insert the bridge record BEFORE we touch
    // the encrypted secret store. Mirrors the canonical
    // `addMessagingBridge` ordering (record first, secret second) so
    // a crash or gateway-up trip between insert and secret write
    // leaves a visible bridge with empty `secretRefs` the operator
    // can clean up via `gini messaging disable`. The previous order
    // (writeSecret then mutateState insert) could leave an
    // encrypted file on disk with no record pointing at it — an
    // orphan that `gini messaging` can't see and the operator has
    // to grep the secrets dir to find.
    //
    // We intentionally do NOT keep a reference to the new bridge
    // object across the two mutateState calls: the second call
    // re-reads state from disk and returns a different object
    // graph. Mutating a captured reference would land on a stale
    // snapshot that gets discarded before the next write, so the
    // ref attachment appears to succeed while the metadata never
    // persists.
    const decision = await guardedMutate((state: RuntimeState) => {
      const found = state.messagingBridges.find(
        (bridge) => bridge.kind === step.bridgeKind
      );
      if (found) {
        return { kind: "existing" as const, id: found.id };
      }
      // Pre-insert the new bridge record with empty `secretRefs`.
      // The metadata defaults are the same shape we'd use after the
      // secret write — there's no harm in landing them now since
      // the bridge can't be polled without a secret anyway (the
      // supervisors gate on secretRefs.length > 0).
      const newId = id("bridge");
      const at = now();
      const metadata: Record<string, unknown> =
        step.bridgeKind === "telegram"
          ? { allowedChatIds: step.allowedChatIds ?? [], lastOffset: 0 }
          : { lastInboundExternalIds: {} };
      const item = buildMessagingBridgeRecord(state, {
        id: newId,
        name: `${step.bridgeKind} (migrated from openclaw)`,
        kind: step.bridgeKind,
        deliveryTargets: [],
        secretRefs: [],
        metadata
      });
      item.createdAt = at;
      item.updatedAt = at;
      state.messagingBridges.unshift(item);
      return { kind: "new" as const, id: newId };
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
    await guardedMutate((state: RuntimeState) => {
      const at = now();
      const metadata: Record<string, unknown> =
        step.bridgeKind === "telegram"
          ? {
              allowedChatIds: step.allowedChatIds ?? [],
              lastOffset: 0
            }
          : { lastInboundExternalIds: {} };
      // Re-find the bridge inside THIS mutateState call so the mutation
      // lands on the fresh state graph that writeState will serialize.
      // For both new and existing bridges, we now just attach the secret
      // ref + finalize metadata; the record already lives in state.
      const target = state.messagingBridges.find(
        (bridge) => bridge.id === decision.id
      );
      if (target) {
        target.secretRefs = [ref];
        // For existing/rotate: merge telegram allowedChatIds (union,
        // deduplicated) so an operator who's enrolled extra chats
        // post-migration doesn't lose them on a token rotation.
        // lastOffset / lastInboundExternalIds are preserved from the
        // existing metadata so the poller doesn't replay old updates.
        // For new: there's no existing metadata to merge with, but
        // the merge is still safe (the pre-insert step seeded the
        // canonical defaults).
        target.metadata =
          decision.kind === "existing"
            ? mergeBridgeMetadata(target.metadata, metadata, step.bridgeKind)
            : metadata;
        target.status = "configured";
        target.updatedAt = at;
        // Auto-mint a pairing code on telegram bridges that came
        // across with no allowlist. Without it the poller runs but
        // silently denies every inbound (no allowlist match, no
        // pairing code to enroll one) — the operator sees a
        // configured bridge that doesn't work. This mirrors what the
        // canonical addMessagingBridge path does for fresh creates.
        // We only auto-mint on the NEW branch; rotation against an
        // existing bridge that already has a pairing code shouldn't
        // clobber it (operator may have intentionally not paired).
        if (
          step.bridgeKind === "telegram" &&
          decision.kind === "new" &&
          (step.allowedChatIds?.length ?? 0) === 0
        ) {
          mintTelegramPairingCodeInState(state.messagingBridges, decision.id);
        }
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
    if (
      step.bridgeKind === "telegram" &&
      decision.kind === "new" &&
      (step.allowedChatIds?.length ?? 0) === 0
    ) {
      warnings.push(
        `Telegram bridge migrated with empty allow-list; auto-minted a one-shot pairing code. DM the bot the code (visible via \`gini messaging pair <bridge-id>\`) within 15 minutes to enroll your chat — otherwise re-run \`gini messaging pair <bridge-id>\` to mint a new code.`
      );
    }
    if (decision.kind === "existing") {
      bridgesRotated += 1;
    } else {
      bridgesCreated += 1;
    }
  }

  // 6) Sessions. Each openclaw session JSONL becomes one ChatSessionRecord
  // + N ChatMessageRecord rows under the gini agent the session
  // belonged to. We open ONE guardedMutate per session so the
  // ChatSessionRecord and all its messages land in a single atomic
  // state.json write — N independent writes for a 200-message session
  // would race the gateway check at every step and slow the migration
  // to a crawl. After insertion we re-stamp createdAt/updatedAt on the
  // session + each message so the UI's "recent chats" sort reflects
  // the original openclaw transcript date, not migration day.
  //
  // Idempotency: dedup by the structured `source.openclawSessionId`
  // field stored on the gini ChatSessionRecord. Earlier iterations
  // dedup'd by parsing a deterministic title prefix, but that breaks
  // the moment the operator renames the migrated chat — the live UI
  // exposes `gini chat rename` and operators commonly retitle
  // system-generated chats. Pinning provenance in the structured
  // `source` field (kind: "openclaw") survives renames without
  // touching the title cosmetic.
  const existingSessionIds = new Set<string>();
  for (const session of readState(config.instance).chatSessions) {
    if (session.source?.kind === "openclaw") {
      existingSessionIds.add(session.source.openclawSessionId);
    }
  }
  for (const step of plan.steps) {
    if (step.kind !== "session") continue;
    if (existingSessionIds.has(step.sessionId)) {
      warnings.push(
        `Skipped openclaw session ${step.sessionId}: already imported (matching gini ChatSessionRecord found).`
      );
      continue;
    }
    // Title is purely cosmetic; the dedup key lives on the
    // source.openclawSessionId field below. The title is set in the
    // openclaw shape so the operator can recognize the chat in the
    // UI without inspecting the structured field, but they're free
    // to rename it.
    const title = `Openclaw ${step.sessionId} :: ${step.openclawId}`;
    try {
      const transcript = parseOpenclawSessionTranscript(step.sourcePath);
      if (transcript.messages.length === 0) {
        warnings.push(
          `Skipped openclaw session ${step.sessionId}: no replayable messages after filtering tool blocks.`
        );
        continue;
      }
      await guardedMutate((state: RuntimeState) => {
        const owner = state.agents.find((agent) => agent.name === step.openclawId);
        const session = createChatSession(
          state,
          title,
          {
            kind: "openclaw",
            openclawSessionId: step.sessionId,
            openclawAgentId: step.openclawId
          },
          owner?.id
        );
        const firstAt = transcript.messages[0]!.createdAt;
        const lastAt = transcript.messages[transcript.messages.length - 1]!.createdAt;
        session.createdAt = transcript.headerTimestamp ?? firstAt;
        for (const message of transcript.messages) {
          const inserted = createChatMessage(state, {
            sessionId: session.id,
            role: message.role,
            content: message.content
          });
          inserted.createdAt = message.createdAt;
        }
        // createChatMessage stamps session.updatedAt = now() on every
        // insert, so the running tally overrides our rebased value.
        // Re-set it from the last openclaw timestamp after the loop.
        session.updatedAt = lastAt;
      });
      // Track the just-imported openclaw id so a malformed plan with
      // the same session listed twice doesn't accidentally bypass
      // dedup and create the second copy.
      existingSessionIds.add(step.sessionId);
      sessionsCreated += 1;
      sessionMessagesCreated += transcript.messages.length;
    } catch (error) {
      warnings.push(
        `Failed to migrate openclaw session ${step.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 7) Hindsight memory units. Insert each row into the gini
  // instance's memory.db with embedding NULL — a follow-up
  // `gini embedding reembed` pass populates vectors using the
  // configured embedding provider. We sanitize network/status
  // before insertion so an openclaw schema drift can't poison the
  // gini memory store with values the rest of the runtime won't
  // accept on read.
  //
  // Bank + agent binding is load-bearing for recall (per ADR
  // `agent-memory-isolation.md`): gini's `/api/memory/recall` and
  // every internal recall channel filter on `bank_id = ? AND
  // agent_id = ?`, where `bank_id` is `bankIdForAgent(agentId)`
  // (`bank_<agentId>`) — NEVER `bank_default`. A unit inserted with
  // `bankId = DEFAULT_BANK_ID` and `agentId = null` is queryable
  // only via the legacy migration backfill path, not via the live
  // recall surface, so a naive insert would silently make the
  // migrated Hindsight memory invisible to the gini agent that
  // owned it in openclaw.
  //
  // Resolution strategy: openclaw stores one SQLite per agent
  // (`memory/<openclaw-agent-id>.sqlite`), so the `sourceBank`
  // string we extracted at plan time (the SQLite basename minus
  // the extension) is exactly the openclaw agent id. The migrator
  // created gini AgentRecords whose `name` matches the openclaw
  // id, so a `state.agents.find((a) => a.name === sourceBank)`
  // lookup pairs the unit with the right gini agent. If no agent
  // matches (rare — the sqlite was named differently, or the
  // operator deleted the agent before importing), we fall back to
  // the default bank with `agentId: null` and emit a warning so
  // the operator knows the unit is parked and needs manual
  // reassignment before recall will surface it.
  //
  // Gini's memory.db turns foreign keys on (`PRAGMA foreign_keys
  // = ON`); `ensureAgentBank` / `ensureDefaultBank` create the
  // referenced bank rows so the insert doesn't throw "FOREIGN KEY
  // constraint failed" on a fresh instance.
  const memorySteps = plan.steps.filter(
    (step): step is Extract<MigrationStep, { kind: "memoryUnit" }> => step.kind === "memoryUnit"
  );
  if (memorySteps.length > 0) {
    // Read state once instead of inside the per-step loop so we
    // don't pound the state.json reader for every memory row.
    const stateSnapshot = readState(config.instance);
    const agentByName = new Map(stateSnapshot.agents.map((agent) => [agent.name, agent] as const));
    // Idempotency: build the set of openclaw unit ids already imported
    // in a previous apply so a re-run skips them instead of inserting
    // duplicate rows that explode the recall candidate pool. We tag
    // every migrated unit with `metadata.openclawUnitId` on insert
    // (see the metadata block below); `json_extract` lets the lookup
    // stay O(1) per step against a pre-built Set rather than O(N)
    // LIKE-scanning per step.
    const importedDb = getMemoryDb(config.instance);
    const existingOpenclawIds = new Set(
      importedDb
        .query<{ openclaw_id: string }, []>(
          "SELECT json_extract(metadata, '$.openclawUnitId') AS openclaw_id FROM memory_units WHERE json_extract(metadata, '$.openclawUnitId') IS NOT NULL"
        )
        .all()
        .map((row) => row.openclaw_id)
    );
    // Track which fallbacks we've warned about so a Hindsight DB
    // with 10000 orphan units doesn't produce 10000 identical
    // warnings.
    const warnedOrphanBanks = new Set<string>();
    for (const step of memorySteps) {
      if (existingOpenclawIds.has(step.openclawId)) {
        // Re-apply against the same Hindsight source — already imported.
        continue;
      }
      const targetAgent = agentByName.get(step.sourceBank);
      let bankId: string;
      let agentId: string | null;
      if (targetAgent) {
        bankId = ensureAgentBank(config.instance, targetAgent.id).id;
        agentId = targetAgent.id;
      } else {
        ensureDefaultBank(config.instance);
        bankId = DEFAULT_BANK_ID;
        agentId = null;
        if (!warnedOrphanBanks.has(step.sourceBank)) {
          warnedOrphanBanks.add(step.sourceBank);
          warnings.push(
            `Memory units from openclaw bank '${step.sourceBank}' have no matching gini agent (openclaw id missing from agents.list?). Units land in the default bank with agent_id NULL — \`/api/memory/recall\` will NOT surface them until you reassign agent_id manually (UPDATE memory_units SET agent_id = '<agent-id>' WHERE metadata LIKE '%"openclawBank":"${step.sourceBank}"%').`
          );
        }
      }
      try {
        insertMemoryUnit(config.instance, {
          bankId,
          agentId,
          text: step.text,
          network: coerceMemoryNetwork(step.network),
          status: coerceMemoryStatus(step.status),
          confidence: step.confidence,
          metadata: {
            ...step.metadata,
            openclawBank: step.sourceBank,
            openclawUnitId: step.openclawId
          },
          mentionedAt: step.mentionedAt
        });
        existingOpenclawIds.add(step.openclawId);
        memoryUnitsCreated += 1;
      } catch (error) {
        warnings.push(
          `Failed to migrate memory unit ${step.openclawId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // 8) Persist a single applied ImportReport so the activity feed
  // shows exactly what landed. The audit log already records every
  // creation; this gives the operator a one-row summary.
  const counts: Record<string, number> = {
    agentsCreated,
    bridgesCreated,
    bridgesRotated,
    skillsCopied,
    secretsWritten,
    workspaceFilesCopied,
    sessionsCreated,
    sessionMessagesCreated,
    memoryUnitsCreated,
    unsupported: plan.unsupported.length,
    warnings: warnings.length
  };
  const findings = [
    `Applied openclaw migration from ${source.stateRoot}`,
    `Archived openclaw state to ${archivePath}`,
    ...plan.unsupported.map((entry) => `Unsupported: ${entry.kind} — ${entry.detail}`),
    ...warnings.map((warning) => `Warning: ${warning}`)
  ];
  const report = await guardedMutate((state: RuntimeState) =>
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
    bridgesRotated,
    skillsCopied,
    secretsWritten,
    workspaceFilesCopied,
    sessionsCreated,
    sessionMessagesCreated,
    memoryUnitsCreated,
    archivePath,
    unsupported: plan.unsupported,
    warnings
  };
  } finally {
    importLock.release();
  }
}

// Walk an openclaw session JSONL and extract just the human-readable
// chat transcript: user / assistant / system messages with their text
// content blocks concatenated into a single string. Tool_use and
// tool_result blocks are deliberately dropped — the original verbatim
// transcript lives in the archive zip the migrator creates at apply
// start, so anyone who needs the full tool-call detail can still get
// at it. createdAt timestamps are preserved from the openclaw
// timestamps so the migrated chat session sorts correctly by date.
interface OpenclawTranscriptMessage {
  role: ChatMessageRecord["role"];
  content: string;
  createdAt: string;
}

interface OpenclawTranscript {
  headerTimestamp?: string;
  messages: OpenclawTranscriptMessage[];
}

function parseOpenclawSessionTranscript(sessionPath: string): OpenclawTranscript {
  const raw = readFileSync(sessionPath, "utf8");
  const messages: OpenclawTranscriptMessage[] = [];
  let headerTimestamp: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    if (type === "session" && typeof parsed.timestamp === "string") {
      headerTimestamp = parsed.timestamp;
      continue;
    }
    if (type !== "message") continue;
    const messageBlock = parsed.message;
    if (!messageBlock || typeof messageBlock !== "object") continue;
    const m = messageBlock as Record<string, unknown>;
    const rawRole = typeof m.role === "string" ? m.role : "user";
    const role: ChatMessageRecord["role"] =
      rawRole === "assistant" || rawRole === "system" ? rawRole : "user";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      content = parts.join("\n\n");
    }
    if (!content.trim()) continue;
    const createdAt = typeof parsed.timestamp === "string" ? parsed.timestamp : now();
    messages.push({ role, content, createdAt });
  }
  return { headerTimestamp, messages };
}

const VALID_NETWORKS: ReadonlySet<Network> = new Set([
  "world",
  "experience",
  "opinion",
  "observation"
]);

function coerceMemoryNetwork(value: string): Network {
  return VALID_NETWORKS.has(value as Network) ? (value as Network) : "experience";
}

const VALID_MEMORY_STATUSES: ReadonlySet<MemoryUnitStatus> = new Set([
  "proposed",
  "active",
  "archived",
  "rejected",
  "conflicted"
]);

function coerceMemoryStatus(value: string): MemoryUnitStatus {
  return VALID_MEMORY_STATUSES.has(value as MemoryUnitStatus)
    ? (value as MemoryUnitStatus)
    : "active";
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
  // child indentation bumped by two spaces. Skip when a top-level
  // `metadata:` already exists — promoting in that case would produce
  // a second sibling `metadata:` key, which is invalid YAML and the
  // gini skill loader's first match wins (silently dropping whichever
  // half landed second). Operators with both keys present should
  // hand-merge.
  const hasTopLevelMetadata = /^metadata:[ \t]*(?:\r?\n|$)/m.test(out);
  const legacy = /^openclaw:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(out);
  if (legacy && !hasTopLevelMetadata) {
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
  // Only treat the metadata value as a flow-style block when the very
  // next non-whitespace character (on the line immediately following
  // `metadata:`) is `{`. Otherwise the metadata value is block-style
  // (or absent), and scanning forward indiscriminately for a `{` would
  // match a brace belonging to a sibling field — silently rewriting
  // that field's value as if it were the metadata block.
  const afterHeader = header.index + header[0].length;
  const tail = body.slice(afterHeader);
  const peek = /^([ \t]+)\{/.exec(tail);
  if (!peek) return body;
  const blockStart = afterHeader + (peek[0].length - 1);
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
  // emitBlockYaml may throw on values the gini skill loader cannot
  // round-trip (newlines, mixed-quote strings). In that case we
  // can't safely rewrite the block — half-rewriting would be worse
  // than no rewriting — so leave the frontmatter untouched and let
  // the operator see the unconverted openclaw block on the gini
  // side. The skill will load but its openclaw metadata won't be
  // visible under metadata.gini until they hand-translate.
  let giniBody: string;
  try {
    giniBody = emitBlockYaml(inner as Record<string, unknown>, `${baseIndent}  `);
  } catch {
    return body;
  }
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
      // Gini's inline-array parser does `inner.split(",")` without
      // quote awareness, so a comma inside any element would be split
      // even when the element is quoted. When any string entry would
      // contain a comma, fall back to block style (`- value` per line)
      // which the parser handles correctly. Otherwise emit inline for
      // readability.
      const hasCommaString = value.some(
        (entry) => typeof entry === "string" && entry.includes(",")
      );
      if (allScalar && !hasCommaString) {
        lines.push(
          `${indent}${key}: [${value
            .map((entry) => yamlScalar(entry, { inInlineArray: true }))
            .join(", ")}]`
        );
        continue;
      }
      if (allScalar) {
        lines.push(`${indent}${key}:`);
        for (const entry of value) {
          lines.push(`${indent}  - ${yamlScalar(entry)}`);
        }
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

// Format a scalar for block-style YAML, targeting the gini skill loader's
// hand-rolled parseScalar. The loader at src/capabilities/skill-loader.ts
// only strips outer quotes (`value.slice(1, -1)`) and does NOT decode
// escapes of any kind — neither YAML's `''` doubling nor JSON's
// backslash sequences. Whatever sits between the outer quotes is
// returned verbatim as the string value.
//
// That makes encoding constrained: we can only quote when the content
// itself is a "clean" sequence of characters that doesn't need its own
// escaping. We pick a quote style per value:
//   - single quotes when the value contains no apostrophe
//   - double quotes when the value contains no double quote
//   - bare when no quoting is needed at all
//   - throw when both quote styles would themselves end up inside
//     the literal (no representable form for this loader)
//
// Values containing newlines or control characters also cannot
// round-trip through a one-line scalar, so those throw too. Throwing
// is preferable to silent corruption — the migrator surfaces the
// failing key in its warnings.
//
// Strings that would otherwise re-parse as a non-string scalar
// (true/false/null/~/integer/decimal) get quoted regardless. Inside an
// inline array, the loader splits on `,` without quote-awareness, so
// callers must NOT use yamlScalar for inline-array elements that
// contain commas — emitBlockYaml falls back to block style in that
// case instead.
function yamlScalar(value: unknown, options: { inInlineArray?: boolean } = {}): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value);
  if (str === "") return "''";
  if (/[\n\r\t]/.test(str) || /[\x00-\x1F\x7F]/.test(str)) {
    throw new Error(
      `Cannot encode value containing newline or control character for the gini skill loader: ${JSON.stringify(str.slice(0, 64))}`
    );
  }
  const reparsesAsScalar =
    str === "true" ||
    str === "false" ||
    str === "null" ||
    str === "~" ||
    /^-?\d+$/.test(str) ||
    /^-?\d+\.\d+$/.test(str);
  const hasParserSpecials = /[:#"'\\]|^[-?!&*|>%@`]|^\s|\s$/.test(str);
  const hasArrayComma = Boolean(options.inInlineArray) && str.includes(",");
  if (!reparsesAsScalar && !hasParserSpecials && !hasArrayComma) return str;
  const hasSingle = str.includes("'");
  const hasDouble = str.includes('"');
  if (!hasSingle) return `'${str}'`;
  if (!hasDouble) return `"${str}"`;
  throw new Error(
    `Cannot encode value containing both single and double quotes for the gini skill loader: ${JSON.stringify(str.slice(0, 64))}`
  );
}

function copyDirShallow(
  srcDir: string,
  dstDir: string,
  exclude: Set<string>,
  overwrite: boolean
): void {
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    // Dirent's isDirectory/isFile/isSymbolicLink are mutually exclusive,
    // so a top-level symlink falls into neither isDirectory nor isFile
    // and is naturally dropped here. The deeper concern is nested
    // symlinks inside a recursed directory — cpSync with
    // `dereference: false` (Node default) would preserve them as
    // outward-pointing links in the destination, leaving a dangling
    // exfiltration vector that gini tools could later read through.
    // Use cpSync's filter callback to refuse any symlink encountered
    // during the recursive walk.
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      // cpSync(..., { recursive: true }) overwrites by default; passing
      // { force: false } guards existing files when the caller hasn't
      // opted into a refresh.
      cpSync(src, dst, {
        recursive: true,
        force: overwrite,
        filter: (candidate) => !isSymlinkSource(candidate)
      });
    } else if (entry.isFile() && (overwrite || !existsSync(dst))) {
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
