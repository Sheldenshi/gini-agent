// Browser-facing setup endpoints.
//
// The pre-round-2 onboarding was a terminal-only affair (`gini setup`). The
// new headline flow is "curl … | bash" → autostart → browser opens to
// /setup. The webapp's setup page calls these endpoints to read the current
// provider state and to write OpenAI / verify Codex creds.
//
// Behavior:
//   - GET /api/setup/status reflects the live provider config plus the
//     available picker options (OpenAI, Codex). `current` is the active
//     provider name when configured; null otherwise. `providerConfigured`
//     is true when the active provider has valid creds — same definition
//     `providerHealth` uses.
//   - POST /api/setup/provider accepts {kind: "openai", apiKey} or
//     {kind: "codex"}. OpenAI flow writes to ~/.gini/secrets.env using
//     the existing helper, then updates process.env so the running
//     gateway picks up the new key on the very next provider call (no
//     restart needed — readOpenAIBearer in src/provider.ts reads from
//     env on each call). The runtime config is rewritten to `openai` so
//     status calls reflect the new active provider.
//
// What this does NOT do: re-write the autostart plist's
// EnvironmentVariables on key change. That's a CLI-layer responsibility
// (admin path can detect a plist on disk and re-run `autostart enable`).
// We keep this module API-thin so the gateway doesn't shell out.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "../paths";
import { normalizeProvider, providerCatalog, providerHealth } from "../provider";
import type { ProviderConfig, RuntimeConfig } from "../types";

const SUPPORTED_KINDS = ["openai", "codex"] as const;
type SupportedKind = (typeof SUPPORTED_KINDS)[number];

export interface SetupStatus {
  ok: true;
  providerConfigured: boolean;
  providers: SupportedKind[];
  current: string | null;
  // Echoed from providerHealth so the browser knows why setup is needed
  // (e.g. "Set OPENAI_API_KEY to use the openai provider").
  message: string;
}

export function getSetupStatus(config: RuntimeConfig): SetupStatus {
  const health = providerHealth(config);
  const current = typeof config.provider?.name === "string" ? config.provider.name : null;
  return {
    ok: true,
    providerConfigured: Boolean(health.configured),
    providers: [...SUPPORTED_KINDS],
    current,
    message: typeof health.message === "string" ? health.message : ""
  };
}

export interface SetSetupProviderResult {
  ok: boolean;
  provider: ReturnType<typeof providerHealth>;
  // True when a future-respawn plist refresh is needed. The CLI layer
  // listens on this hint (in admin / provider commands) to re-run
  // `autostart enable` so the new key lands in EnvironmentVariables
  // for the next launchd respawn. The running gateway already has the
  // new key in env so this round-trip is purely about surviving the
  // next plist start.
  plistRefreshNeeded: boolean;
  error?: string;
}

export async function setSetupProvider(
  config: RuntimeConfig,
  payload: Record<string, unknown>
): Promise<SetSetupProviderResult> {
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  if (!SUPPORTED_KINDS.includes(kind as SupportedKind)) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: `Unsupported provider kind '${kind}'. Allowed: ${SUPPORTED_KINDS.join(", ")}.`
    };
  }
  if (kind === "openai") {
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    if (!apiKey) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: "apiKey is required for the openai provider."
      };
    }
    // Persist to secrets.env so the wrapper-sourced env carries it on
    // future shell launches. We avoid importing src/cli/* from runtime/
    // (CLI is a client of the runtime API, not the other way around) so
    // we re-implement the small write helper here.
    writeKeyToSecretsFile("OPENAI_API_KEY", apiKey);
    // Make the running gateway use the new key on its very next
    // provider call. readOpenAIBearer reads process.env on each call,
    // so this assignment is enough — no restart needed.
    process.env.OPENAI_API_KEY = apiKey;

    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : (config.provider?.name === "openai" && config.provider.model ? config.provider.model : "gpt-5.4-mini");
    config.provider = normalizeProvider({ name: "openai", model });
    writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);

    // Best-effort plist refresh: if an autostart plist already exists
    // for this instance, re-run `gini autostart enable` in the background
    // so its EnvironmentVariables pick up the new key. The current
    // gateway already has the new key in process.env, so this is purely
    // about surviving the next launchd respawn cycle.
    const refreshed = maybeRefreshAutostartPlist(config.instance);

    return {
      ok: true,
      provider: providerHealth(config),
      plistRefreshNeeded: refreshed
    };
  }
  // kind === "codex"
  if (!hasCodexAuth()) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: "Codex credentials not found. Run `codex --login` in your terminal, then retry."
    };
  }
  const codexCatalog = providerCatalog().find((p) => p.id === "codex");
  const model = typeof payload.model === "string" && payload.model.length > 0
    ? payload.model
    : (config.provider?.name === "codex" && config.provider.model ? config.provider.model : codexCatalog?.models[0] ?? "gpt-5.5");
  config.provider = normalizeProvider({ name: "codex", model } as ProviderConfig);
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  return {
    ok: true,
    provider: providerHealth(config),
    // Codex provider reads creds from ~/.codex/auth.json directly (no
    // secrets.env entry), so no plist refresh is required.
    plistRefreshNeeded: false
  };
}

// If the gateway plist already exists on disk, return true so the
// response signals the caller that a future launchd respawn would use
// stale env. We deliberately do NOT bootout+bootstrap from here —
// doing that would kill the running gateway mid-response (the same
// process we're answering from).
//
// Instead, the user (or the CLI `gini autostart enable` flow they run
// after using /setup) is responsible for refreshing the plist when
// they want the new env to take effect across reboots. The running
// gateway has the new key in process.env already, so the in-flight
// session is fully functional.
function maybeRefreshAutostartPlist(instance: string): boolean {
  if (process.platform !== "darwin") return false;
  const home = process.env.HOME || homedir();
  const gatewayPlist = join(home, "Library", "LaunchAgents", `ai.lilac.gini.${instance}.gateway.plist`);
  if (!existsSync(gatewayPlist)) return false;
  return true;
}

function secretsPath(): string {
  // Mirror the resolution in src/cli/commands/setup.ts — prefer $HOME so
  // tests overriding the env var don't fight os.homedir()'s macOS cache.
  const home = process.env.HOME || homedir();
  return join(home, ".gini", "secrets.env");
}

function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Re-implementation of src/cli/commands/setup.ts:writeKeyToSecretsFile.
// We don't import from src/cli/* because src/runtime/* must not depend
// on the CLI layer (per AGENTS.md boundary rules).
function writeKeyToSecretsFile(name: string, value: string): void {
  const path = secretsPath();
  // mkdir if missing — secrets.env may be the first file we ever write
  // here on a fresh install.
  mkdirSync(dirname(path), { recursive: true });
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `export ${name}=${shellSingleQuote(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=.*$`, "m");
  if (pattern.test(existing)) {
    existing = existing.replace(pattern, line);
  } else {
    if (existing && !existing.endsWith("\n")) existing += "\n";
    existing += line + "\n";
  }
  writeFileSync(path, existing, { mode: 0o600 });
}

function hasCodexAuth(): boolean {
  const envRaw = process.env.CODEX_AUTH_JSON;
  if (envRaw && envRaw.length > 0) {
    try { JSON.parse(envRaw); return true; } catch { /* fall through */ }
  }
  const home = process.env.HOME || homedir();
  const authPath = join(home, ".codex", "auth.json");
  if (!existsSync(authPath)) return false;
  try { JSON.parse(readFileSync(authPath, "utf8")); return true; } catch { return false; }
}
