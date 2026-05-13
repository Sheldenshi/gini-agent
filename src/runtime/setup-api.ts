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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, projectRoot } from "../paths";
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

    // Schedule plist refresh AFTER the response flushes. The detached
    // child will bootout+bootstrap the gateway; launchd respawns us
    // with the new OPENAI_API_KEY baked into EnvironmentVariables so
    // future crashes/respawns see the new key.
    const refreshed = scheduleAutostartRefresh(config.instance);

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

// Schedule a plist refresh AFTER the current HTTP response flushes.
// Returns true when a refresh was scheduled, false otherwise (non-darwin
// or no autostart plist on disk).
//
// Why a detached subprocess: refreshing the plist means
// `launchctl bootout` of the gateway service, which kills us — the
// process answering the HTTP request. If we did it inline, the response
// would never reach the browser. Instead we:
//   1. Return the HTTP response immediately (caller flushes JSON).
//   2. setImmediate (fires after the response handler returns) spawns
//      a detached `bun run gini autostart enable --instance <inst>`
//      child that inherits no parent ties (own pgid, ignore SIGTERM
//      relay from us, stdin closed).
//   3. The detached child runs bootout+bootstrap. We get killed; launchd
//      respawns us with the new EnvironmentVariables containing the new
//      OPENAI_API_KEY. The web service is not touched (the autostart
//      enable enumerates both kinds, so we ALSO bootout/bootstrap the
//      web service — which is fine because the user is currently in
//      /setup, then router.replace('/') hits the BFF which retries with
//      lazy file-based runtime URL/token. They'll see a brief loading
//      state but no broken nav.)
//
// The caller still surfaces `plistRefreshNeeded:true` for diagnostic
// transparency; the difference vs. round 2 is that the refresh now
// actually happens.
function scheduleAutostartRefresh(instance: string): boolean {
  if (process.platform !== "darwin") return false;
  const home = process.env.HOME || homedir();
  const gatewayPlist = join(home, "Library", "LaunchAgents", `ai.lilac.gini.${instance}.gateway.plist`);
  if (!existsSync(gatewayPlist)) return false;

  // Tests set GINI_SKIP_PLIST_REFRESH=1 to assert that the gateway
  // *would* refresh without actually firing a detached `bun run gini
  // autostart enable` subprocess (which would touch the developer's
  // real LaunchAgents dir). The return value still flips true so the
  // contract is observable.
  if (process.env.GINI_SKIP_PLIST_REFRESH === "1") return true;

  // setImmediate fires after the current task — the request handler —
  // returns, but before any new I/O turns. By the time it fires Bun.serve
  // has already started flushing the JSON response to the client. We add
  // a tiny extra delay (200ms) to make sure the response bytes hit the
  // socket buffer before we tell launchctl to bootout the gateway.
  setImmediate(() => {
    setTimeout(() => {
      try {
        // --kind gateway: only refresh the gateway plist. The web service
        // doesn't consume OPENAI_API_KEY directly (no Next.js code reads
        // process.env.OPENAI_API_KEY), so its plist env doesn't need to
        // change. Critically, NOT bootouting the web service keeps the
        // browser's redirect-to-/ working immediately after this call —
        // the user's session never sees a dead web server. The BFF's
        // lazy file-based runtime URL/token (web/src/lib/runtime.ts)
        // picks up the new gateway port when launchd respawns it.
        const child = spawn(process.execPath, ["run", "gini", "autostart", "enable", "--instance", instance, "--kind", "gateway"], {
          cwd: projectRoot(),
          // detached:true puts the child in its own process group so a
          // SIGTERM landing on the gateway doesn't propagate. We also
          // unref so the gateway's event loop doesn't wait on this
          // child (which doesn't matter much because we're about to be
          // killed, but is hygienic).
          detached: true,
          stdio: "ignore",
          env: { ...process.env, GINI_INSTANCE: instance }
        });
        child.unref();
      } catch {
        // Best-effort. If spawn fails (e.g. PATH oddity) the user can
        // still re-run `gini autostart enable` manually. We don't have a
        // good place to log this — the gateway is already exiting from
        // launchd's perspective on next bootout — so we swallow.
      }
    }, 200);
  });
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
