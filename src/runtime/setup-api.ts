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

import { writeRuntimeConfig } from "../paths";
import { hasUsableAwsCredentials, hasUsableCodexCredentials, isValidAwsRegion, normalizeProvider, providerCatalog, providerHealth } from "../provider";
import { removeKeyFromSecretsEnv, writeKeyToSecretsEnv } from "../state/secrets-env";
import { requestAutostartRefresh } from "./autostart-refresh";
import type { ProviderConfig, RuntimeConfig } from "../types";

const SUPPORTED_PROVIDERS = ["openai", "codex", "openrouter", "deepseek", "local", "anthropic", "bedrock"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// Env-keyed providers that authenticate via an env var written to
// ~/.gini/secrets.env. `local` allows an empty key because many local
// gateways (Ollama, LM Studio) accept no-auth requests. Codex is excluded
// because it uses its own OAuth/auth.json flow. (anthropic is env-keyed but
// speaks the native Messages API, not an OpenAI-compatible surface.)
const ENV_KEY_PROVIDERS: Record<string, { envVar: string; allowEmptyKey: boolean; defaultModel: string }> = {
  openai: { envVar: "OPENAI_API_KEY", allowEmptyKey: false, defaultModel: "gpt-5.4-mini" },
  openrouter: { envVar: "OPENROUTER_API_KEY", allowEmptyKey: false, defaultModel: "openrouter/auto" },
  deepseek: { envVar: "DEEPSEEK_API_KEY", allowEmptyKey: false, defaultModel: "deepseek-v4-flash" },
  local: { envVar: "GINI_LOCAL_API_KEY", allowEmptyKey: true, defaultModel: "local/default" },
  // The key slot holds either a first-party Anthropic key (default baseUrl) or
  // a Bedrock Mantle bearer token (when baseUrl points at bedrock-mantle).
  // setSetupProvider already threads payload.baseUrl into normalizeProvider, so
  // the browser can target either endpoint with the same row.
  anthropic: { envVar: "ANTHROPIC_API_KEY", allowEmptyKey: false, defaultModel: "claude-opus-4-8" }
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
  const isRealProvider = current === "openai" || current === "codex" || current === "openrouter" || current === "local" || current === "deepseek" || current === "anthropic" || current === "bedrock";
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
    // Resolve the env var this config actually reads from: for an edit of the
    // already-active provider, honor its configured apiKeyEnv (e.g. a CLI-set
    // custom var); otherwise the canonical default. Routing the "already set?"
    // probe, the key write, and the preserved apiKeyEnv all through one
    // targetEnvVar keeps write-target == stored-config == read-source, so a
    // custom-apiKeyEnv provider can be edited/rotated from the web without
    // being rejected or silently flipped back to the canonical var.
    const existing = config.provider?.name === providerName ? config.provider : undefined;
    const targetEnvVar = existing?.apiKeyEnv ?? envKeySpec.envVar;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    // Accept a no-key payload when the env var is already set — the Edit
    // Provider dialog uses this to update just the model/baseUrl without making
    // the user re-type their key. Initial Add Provider still requires a key
    // because the env var is empty there.
    const envAlreadySet = Boolean(process.env[targetEnvVar]);
    if (!apiKey && !envKeySpec.allowEmptyKey && !envAlreadySet) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `apiKey is required for the ${providerName} provider.`
      };
    }
    if (apiKey) {
      // Persist to secrets.env so the wrapper-sourced env carries it on future
      // shell launches, and update process.env so the running gateway uses it
      // on the very next call (readers read process.env each call — no restart).
      writeKeyToSecretsEnv(targetEnvVar, apiKey);
      process.env[targetEnvVar] = apiKey;
    }

    // Default omitted model/baseUrl from the already-active provider so the
    // set-active and edit-model flows (which POST {provider, model} with no
    // baseUrl) don't silently reset a configured endpoint back to the
    // per-provider default. Add Provider targets a not-yet-active provider, so
    // `existing` is undefined there and behavior is unchanged. apiKeyEnv is
    // preserved so it stays in lockstep with the targetEnvVar the key was
    // written to.
    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : (existing?.model ?? envKeySpec.defaultModel);
    const baseUrl = typeof payload.baseUrl === "string" && payload.baseUrl.trim().length > 0
      ? payload.baseUrl.trim()
      : existing?.baseUrl;
    config.provider = normalizeProvider({
      name: providerName as ProviderConfig["name"],
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(existing?.apiKeyEnv ? { apiKeyEnv: existing.apiKeyEnv } : {})
    });
    writeRuntimeConfig(config);

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
  if (providerName === "bedrock") {
    // Like codex, bedrock holds no gini-managed key: it signs each Converse
    // request with the caller's AWS credentials (~/.aws or AWS_*). "Configured"
    // therefore means those credentials resolve — reject up front with a clear
    // hint when they don't, mirroring codex's "run codex --login" gate. Only
    // model + region are persisted (env-var NAMES, never secret values).
    if (!hasUsableAwsCredentials()) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error:
          "No AWS credentials found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure ~/.aws/credentials, then retry."
      };
    }
    const existing = config.provider?.name === "bedrock" ? config.provider : undefined;
    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : existing?.model;
    const awsRegion = typeof payload.awsRegion === "string" && payload.awsRegion.trim().length > 0
      ? payload.awsRegion.trim()
      : existing?.awsRegion;
    // The region lands in the Converse request host, so reject a malformed one
    // here (the self-tool can supply it) before it ever persists.
    if (awsRegion !== undefined && !isValidAwsRegion(awsRegion)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `awsRegion is invalid: '${awsRegion}' (must match /^[a-z0-9-]+$/, e.g. us-east-1).`
      };
    }
    config.provider = normalizeProvider({
      name: "bedrock",
      model: model ?? "",
      ...(awsRegion ? { awsRegion } : {})
    });
    writeRuntimeConfig(config);
    return { ok: true, provider: providerHealth(config), plistRefreshNeeded: false };
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
  config.provider = normalizeProvider({ name: "codex", model } as ProviderConfig);
  writeRuntimeConfig(config);
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
  // shell launches stop seeing it. When the provider being removed is the
  // active one and was configured with a custom apiKeyEnv (e.g. a Bedrock
  // bearer under BEDROCK_BEARER_TOKEN), the live token lives under that var,
  // not the canonical one — scrub it alongside the canonical var so removal
  // never leaves a usable token behind. removeKeyFromSecretsEnv is a no-op
  // when the line is already absent, so scrubbing both unconditionally (and
  // deduped) is safe.
  const activeCustomEnv =
    config.provider?.name === providerName ? config.provider?.apiKeyEnv : undefined;
  for (const envVar of new Set(
    activeCustomEnv ? [envKeySpec.envVar, activeCustomEnv] : [envKeySpec.envVar]
  )) {
    removeKeyFromSecretsEnv(envVar);
    delete process.env[envVar];
  }

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
    writeRuntimeConfig(config);
    switched = true;
  }

  return {
    ok: true,
    provider: providerHealth(config),
    switched
  };
}
