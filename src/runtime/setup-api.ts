// Browser-facing setup endpoints.
//
// Onboarding used to be a terminal-only affair (`gini setup`). The
// current headline flow is "curl … | bash" → autostart → browser opens
// to /setup. The webapp's setup page calls these endpoints to read the
// current provider state and to write OpenAI / verify Codex creds.
//
// Behavior:
//   - GET /api/setup/status reflects the live provider config plus the
//     available picker options (OpenAI, Codex). `current` is the active
//     provider name when configured; null otherwise. `providerConfigured`
//     is true when the active provider has valid creds — same definition
//     `providerHealth` uses.
//   - POST /api/setup/provider accepts {provider: "openai", apiKey} or
//     {provider: "codex"}. OpenAI flow writes to ~/.gini/secrets.env using
//     the existing helper, then updates process.env so the running
//     gateway picks up the new key on the very next provider call (no
//     restart needed — readOpenAIBearer in src/provider.ts reads from
//     env on each call). The runtime config is rewritten to `openai` so
//     status calls reflect the new active provider. The field is named
//     `provider` (not `kind`) to match the CLI surface — `gini provider
//     set <name>` already uses this terminology. Note: this is the model
//     provider (echo/openai/anthropic/codex), distinct from the connector
//     provider concept introduced by ADR connector-provider-spec-compliance.md.
//
// What this DOES do for plist refresh: when an OpenAI key is written
// and a gateway plist exists on disk, this module calls
// requestAutostartRefresh (src/runtime/autostart-refresh.ts), which
// writes a marker file and self-signals SIGTERM. The gateway's SIGTERM
// handler then drains in-flight responses, consumes the marker, and
// execs a detached `gini autostart enable --kind gateway` as the last
// thing before process.exit(0). That child re-registers the plist
// with fresh EnvironmentVariables read from secrets.env.
//
// The hand-off goes via marker + SIGTERM rather than a direct
// in-process spawn for two reasons: (1) we need Bun's `server.stop`
// drain to finish writing this very response before launchctl
// bootouts the gateway, and (2) the in-process gate in
// autostart-refresh.ts ensures only self-signaled SIGTERMs trigger a
// respawn — an external `gini stop` must NOT bring the gateway back.
// We keep the module API-thin: no shelling out from the request
// handler itself; the actual launchctl interaction is the detached
// child's responsibility.

import { writeFileSync } from "node:fs";
import { configPath, loadConfig } from "../paths";
import { hasUsableCodexCredentials, normalizeProvider, normalizeRetentionValue, providerCatalog, providerHealth } from "../provider";
import { removeKeyFromSecretsEnv, writeKeyToSecretsEnv } from "../state/secrets-env";
import { requestAutostartRefresh } from "./autostart-refresh";
import type { ProviderConfig, RuntimeConfig } from "../types";

// Read the latest persisted `promptCacheRetention` from disk for the
// named provider. The gateway loads `config` once at boot and reuses
// that in-memory snapshot for every request handler, so a CLI write
// (`gini provider set --prompt-cache-retention 24h`) that lands while
// the gateway is running will be invisible to the in-memory snapshot.
// If a UI save then ran the preservation off that stale snapshot, the
// next writeFileSync would erase the CLI-written value. Re-reading the
// disk just for this ZDR-relevant field closes that window without
// taking a dependency on a full config reload (other fields stay
// owned by their original surfaces).
//
// On a disk-read failure (malformed JSON, transient EACCES) the helper
// falls back to the in-memory snapshot for the same-provider case
// instead of fail-open returning undefined. Fail-open would let a
// corrupted-config write silently erase a ZDR-relevant retention
// bucket the operator still believes is in effect; the in-memory
// value is the last good state we know about, so preserving it is
// strictly safer than dropping it.
function diskPromptCacheRetention(instance: string, providerName: string, inMemoryConfig: RuntimeConfig): string | undefined {
  try {
    const onDisk = loadConfig(instance);
    if (onDisk.provider?.name === providerName) {
      const onDiskValue = normalizeRetentionValue(onDisk.provider.promptCacheRetention);
      if (onDiskValue !== undefined) return onDiskValue;
    }
  } catch {
    // Disk read failed — fall through to the in-memory fallback below
    // rather than dropping the field on the floor.
  }
  if (inMemoryConfig.provider?.name === providerName) {
    return normalizeRetentionValue(inMemoryConfig.provider.promptCacheRetention);
  }
  return undefined;
}

const SUPPORTED_PROVIDERS = ["openai", "codex", "openrouter", "deepseek", "local"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// OpenAI-compatible providers that authenticate via an env var written to
// ~/.gini/secrets.env. `local` allows an empty key because many local
// gateways (Ollama, LM Studio) accept no-auth requests. Codex is excluded
// because it uses its own OAuth/auth.json flow.
const ENV_KEY_PROVIDERS: Record<string, { envVar: string; allowEmptyKey: boolean; defaultModel: string }> = {
  openai: { envVar: "OPENAI_API_KEY", allowEmptyKey: false, defaultModel: "gpt-5.4-mini" },
  openrouter: { envVar: "OPENROUTER_API_KEY", allowEmptyKey: false, defaultModel: "openrouter/auto" },
  deepseek: { envVar: "DEEPSEEK_API_KEY", allowEmptyKey: false, defaultModel: "deepseek-v4-flash" },
  local: { envVar: "GINI_LOCAL_API_KEY", allowEmptyKey: true, defaultModel: "local/default" }
};

export interface SetupStatus {
  ok: true;
  providerConfigured: boolean;
  providers: SupportedProvider[];
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
  const isRealProvider = current === "openai" || current === "codex" || current === "openrouter" || current === "local" || current === "deepseek";
  const providerConfigured = isRealProvider && Boolean(health.configured);
  return {
    ok: true,
    providerConfigured,
    providers: [...SUPPORTED_PROVIDERS],
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
  // Field name is `provider` to match the CLI (`gini provider set ...`).
  const providerName = typeof payload.provider === "string" ? payload.provider : "";
  if (!SUPPORTED_PROVIDERS.includes(providerName as SupportedProvider)) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: `Unsupported provider '${providerName}'. Allowed: ${SUPPORTED_PROVIDERS.join(", ")}.`
    };
  }
  const envKeySpec = ENV_KEY_PROVIDERS[providerName];
  if (envKeySpec) {
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    // Accept a no-key payload when the env var is already set — the Edit
    // Provider dialog uses this to update just the default model without
    // making the user re-type their key. Initial Add Provider still
    // requires a key because the env var is empty there.
    const envAlreadySet = Boolean(process.env[envKeySpec.envVar]);
    if (!apiKey && !envKeySpec.allowEmptyKey && !envAlreadySet) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `apiKey is required for the ${providerName} provider.`
      };
    }
    if (apiKey) {
      // Persist to secrets.env so the wrapper-sourced env carries it on
      // future shell launches. The shared writer lives in src/state/ —
      // both CLI and runtime are allowed to depend on src/state/.
      writeKeyToSecretsEnv(envKeySpec.envVar, apiKey);
      // Make the running gateway use the new key on its very next
      // provider call. readOpenAIBearer reads process.env on each call,
      // so this assignment is enough — no restart needed.
      process.env[envKeySpec.envVar] = apiKey;
    }

    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : (config.provider?.name === providerName && config.provider.model ? config.provider.model : envKeySpec.defaultModel);
    const baseUrl = typeof payload.baseUrl === "string" && payload.baseUrl.trim().length > 0
      ? payload.baseUrl.trim()
      : undefined;
    // Preserve `promptCacheRetention` from the latest persisted provider
    // config when the same provider name is being re-saved. The web
    // setup form has no UI for the field, so without this any unrelated
    // save (model swap, baseUrl edit) would silently strip the retention
    // bucket the operator chose by hand. ZDR-relevant per the OpenAI
    // prompt-caching docs, so the rewrite cannot drop it. Source the
    // value from disk (not from in-memory config) so an interleaving CLI
    // write that happened after gateway boot is not clobbered.
    const carriedValue = diskPromptCacheRetention(config.instance, providerName, config);
    const carriedRetention = carriedValue !== undefined ? { promptCacheRetention: carriedValue } : {};
    config.provider = normalizeProvider({
      name: providerName as ProviderConfig["name"],
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...carriedRetention
    });
    writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);

    // Request plist refresh via a marker file + SIGTERM. A simpler
    // approach (setImmediate → setTimeout(200ms) → detached spawn)
    // would be a heuristic — a slow client could still be mid-read
    // when launchctl bootouts the gateway, breaking the user's POST
    // response mid-flush. Hooking the actual response lifecycle
    // instead: we self-signal SIGTERM so Bun's `server.stop(false)`
    // drains in-flight responses (including this one) before our
    // SIGTERM handler reads the marker and execs the refresh as the
    // very last thing on the way out. See
    // src/runtime/autostart-refresh.ts.
    const refreshed = apiKey ? requestAutostartRefresh(config.instance) : false;

    return {
      ok: true,
      provider: providerHealth(config),
      plistRefreshNeeded: refreshed
    };
  }
  // providerName === "codex"
  if (!hasUsableCodexCredentials(config.provider)) {
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
  // Same disk-sourced preservation as the env-keyed branch above — a
  // codex re-save (e.g. model swap) shouldn't drop a
  // `promptCacheRetention` an operator set via the CLI between gateway
  // boot and now. The codex backend currently rejects the field, but
  // per the ProviderConfig doc-comment the runtime is a transparent
  // forwarder so future backend support works without code changes.
  const carriedValue = diskPromptCacheRetention(config.instance, "codex", config);
  const carriedRetention = carriedValue !== undefined ? { promptCacheRetention: carriedValue } : {};
  config.provider = normalizeProvider({ name: "codex", model, ...carriedRetention } as ProviderConfig);
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

export interface RemoveSetupProviderResult {
  ok: boolean;
  provider: ReturnType<typeof providerHealth>;
  // True when removal flipped the gateway off the named provider, so the
  // active row in /api/status now reflects whatever we fell back to.
  switched: boolean;
  error?: string;
}

// Disconnect an env-keyed provider: scrub its bearer from process.env +
// secrets.env, and, when removing the currently-active provider, fall
// back to codex if codex auth is available so the gateway stays usable.
// Codex itself isn't removable through the UI because ~/.codex/auth.json
// is owned by the `codex` CLI — the user manages it via codex --logout.
// Local has no key to remove; the gate below mirrors that.
export function removeSetupProvider(
  config: RuntimeConfig,
  providerName: string
): RemoveSetupProviderResult {
  if (providerName === "codex") {
    return {
      ok: false,
      provider: providerHealth(config),
      switched: false,
      error: "Codex is managed by the codex CLI. Run `codex --logout` to sign out."
    };
  }
  const envKeySpec = ENV_KEY_PROVIDERS[providerName];
  if (!envKeySpec || providerName === "local") {
    return {
      ok: false,
      provider: providerHealth(config),
      switched: false,
      error: `Cannot remove provider '${providerName}'.`
    };
  }

  // Wipe the bearer from both stores so the running process and future
  // shell launches stop seeing it. removeKeyFromSecretsEnv is a no-op if
  // the file or the line is already absent — safe to call unconditionally.
  removeKeyFromSecretsEnv(envKeySpec.envVar);
  delete process.env[envKeySpec.envVar];

  let switched = false;
  if (config.provider?.name === providerName) {
    // The instance was using this provider — falling back to codex when
    // its OAuth is on disk keeps the gateway in a working state. Otherwise
    // we drop to echo, which is harmless (deterministic stub) and at least
    // doesn't crash on the next call.
    if (hasUsableCodexCredentials()) {
      const codexCatalog = providerCatalog().find((p) => p.id === "codex");
      config.provider = normalizeProvider({
        name: "codex",
        model: codexCatalog?.models[0] ?? "gpt-5.5"
      } as ProviderConfig);
    } else {
      config.provider = normalizeProvider({ name: "echo", model: "gini-echo-v0" });
    }
    writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
    switched = true;
  }

  return {
    ok: true,
    provider: providerHealth(config),
    switched
  };
}
