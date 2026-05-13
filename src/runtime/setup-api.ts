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
// What this DOES do for plist refresh: when an OpenAI key is written and
// a gateway plist exists on disk, this module calls
// requestAutostartRefresh (src/runtime/autostart-refresh.ts) which
// writes a marker file and self-signals SIGTERM. The gateway's SIGTERM
// handler then drains in-flight responses, consumes the marker, and
// execs a detached `gini autostart enable --kind gateway` as the last
// thing before process.exit(0). That child re-registers the plist with
// fresh EnvironmentVariables read from secrets.env. Round-3 wired the
// hand-off; round-4 hardened it (response drain ordering, SIGTERM
// idempotency, in-process gate to block external-SIGTERM respawns).
// We still keep the module API-thin: no shelling out from the request
// handler itself; the actual launchctl interaction is the detached
// child's responsibility.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "../paths";
import { normalizeProvider, providerCatalog, providerHealth } from "../provider";
import { requestAutostartRefresh } from "./autostart-refresh";
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
  // Echo is "configured" in the providerHealth sense (no creds needed)
  // but it's a stub that does nothing useful — it's not a valid choice
  // for browser onboarding. Anyone on echo needs to pick a real
  // provider in /setup. Other configured providers (openai with key,
  // codex with auth.json) pass through.
  const isRealProvider = current === "openai" || current === "codex" || current === "openrouter" || current === "local";
  const providerConfigured = isRealProvider && Boolean(health.configured);
  return {
    ok: true,
    providerConfigured,
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

    // Request plist refresh via a marker file + SIGTERM. The previous
    // approach (setImmediate → setTimeout(200ms) → detached spawn) was a
    // heuristic — a slow client could still be mid-read when launchctl
    // bootouts the gateway, breaking the user's POST response mid-flush.
    // The new approach hooks the actual response lifecycle: we self-
    // signal SIGTERM so Bun's `server.stop(true)` drains in-flight
    // responses (including this one) before our SIGTERM handler reads
    // the marker and execs the refresh as the very last thing on the
    // way out. See src/runtime/autostart-refresh.ts.
    const refreshed = requestAutostartRefresh(config.instance);

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
  // Codex switching DOES require a plist refresh: the gateway's config.json
  // is the source of truth for which provider it boots with, and that's
  // already updated. But the plist still has GINI_INSTANCE etc — no env
  // change. The reason to refresh is if a prior openai run wrote
  // OPENAI_API_KEY into the plist env and the user has now switched to
  // codex; the stale key is harmless (codex ignores it). So we skip the
  // refresh on codex.
  return {
    ok: true,
    provider: providerHealth(config),
    plistRefreshNeeded: false
  };
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
  // writeFileSync's `mode` option only applies on file CREATION. If the
  // file pre-existed with 0644 (e.g. a user hand-edited it), the write
  // above keeps that permission. Explicit chmod ensures mode 0600 on
  // every write so secrets aren't world-readable.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
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
