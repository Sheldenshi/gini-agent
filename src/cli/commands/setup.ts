// Interactive post-install configuration. Re-runnable. Walks an array of
// SetupStep modules — currently just providerStep. The step framework is the
// load-bearing part: each step has isComplete() so users (and scripted
// installs) can re-run `gini setup` idempotently, and run(io) so steps can
// drive their own prompts via a shared SetupIO surface.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import type { CliContext } from "../context";
import { hasFlag } from "../args";
import { configPath, writeRuntimeConfig } from "../../paths";
import { hasUsableAwsCredentials, hasUsableCodexCredentials, normalizeProvider } from "../../provider";
import {
  ensureSecretsEnvPerms,
  secretsEnvPath,
  unquoteSecretsValue,
  writeKeyToSecretsEnv
} from "../../state/secrets-env";
import type { RuntimeConfig } from "../../types";

export interface SetupIO {
  select<T>(prompt: string, choices: { label: string; value: T }[], defaultIndex?: number): Promise<T>;
  prompt(question: string, defaultValue?: string): Promise<string>;
  secret(question: string): Promise<string>;
  info(msg: string): void;
  success(msg: string): void;
  error(msg: string): void;
  isNonInteractive: boolean;
}

export interface SetupStep {
  id: string;
  title: string;
  isComplete(config: RuntimeConfig): Promise<boolean>;
  run(config: RuntimeConfig, io: SetupIO): Promise<void>;
}

const COLOR_ENABLED = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
const COLOR = COLOR_ENABLED
  ? { cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m", dim: "\x1b[2m" }
  : { cyan: "", bold: "", reset: "", dim: "" };


// Match `export NAME=value` and bare `NAME=value` — `set -a` exports either
// form, so accepting both keeps us compatible with hand-edited files.
function secretsLineRegex(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "m");
}

export function hasKeyInSecretsFile(name: string): boolean {
  const path = secretsEnvPath();
  if (!existsSync(path)) return false;
  ensureSecretsEnvPerms();
  const content = readFileSync(path, "utf8");
  const match = content.match(secretsLineRegex(name));
  if (!match) return false;
  return unquoteSecretsValue(match[1] ?? "").length > 0;
}

export function readKeyFromSecretsFile(name: string): string | null {
  const path = secretsEnvPath();
  if (!existsSync(path)) return null;
  ensureSecretsEnvPerms();
  const content = readFileSync(path, "utf8");
  const match = content.match(secretsLineRegex(name));
  if (!match) return null;
  const value = unquoteSecretsValue(match[1] ?? "");
  return value.length > 0 ? value : null;
}

// Re-export under the historical name so other CLI modules (provider,
// admin) and tests that still import `writeKeyToSecretsFile` from
// setup.ts keep working without churn. The implementation lives in
// src/state/secrets-env.ts now.
export const writeKeyToSecretsFile = writeKeyToSecretsEnv;

export interface OpenAIKeyStatus {
  source: "env" | "file" | "missing";
  value?: string;
}

// Resolve an API key from the process env (set by the user's shell) or the
// gini secrets.env file (written by a prior setup run). Generic over the env
// var name so every API-key provider shares one lookup.
export function checkApiKeyStatus(envVar: string): OpenAIKeyStatus {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) {
    return { source: "env", value: fromEnv };
  }
  const fromFile = readKeyFromSecretsFile(envVar);
  if (fromFile) return { source: "file", value: fromFile };
  return { source: "missing" };
}

export function checkOpenAIKeyStatus(): OpenAIKeyStatus {
  return checkApiKeyStatus("OPENAI_API_KEY");
}

export interface CredentialStatus {
  available: boolean;
  source: "env" | "file" | "missing";
  display: string;
}

// How a provider authenticates, which drives the credential prompt in setup:
//   api-key     — a key the user pastes; saved to secrets.env under `apiKeyEnv`
//   codex-oauth — codex CLI owns the token (~/.codex/auth.json); no key to save
//   aws         — bedrock signs with the AWS access key + secret the user enters,
//                 saved to secrets.env under AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
//   local       — OpenAI-compatible local server; key optional (most are no-auth)
export type ProviderKind = "api-key" | "codex-oauth" | "aws" | "local";

// Extra transport fields a provider needs persisted beyond name + model. Azure
// is the only one with required routing (a per-resource endpoint); bedrock takes
// an optional region; local takes a base URL. Captured during ensureCredentials
// and applied by the caller via normalizeProvider.
export interface ProviderExtraConfig {
  baseUrl?: string;
  awsRegion?: string;
  apiVersion?: string;
  deployment?: string;
  authScheme?: "api-key" | "bearer";
}

export interface ProviderModule {
  id: "openai" | "codex" | "anthropic" | "bedrock" | "azure" | "openrouter" | "requesty" | "deepseek" | "local";
  kind: ProviderKind;
  label: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  // The env var holding the key for api-key/local providers; undefined for
  // codex (CLI-owned) and bedrock (AWS chain).
  apiKeyEnv?: string;
  checkCredentials(): CredentialStatus;
  // Resolve/capture credentials. Returns false when the user aborts. Mutates
  // `extra` in place with any transport config the provider needs persisted.
  ensureCredentials(io: SetupIO, extra: ProviderExtraConfig): Promise<boolean>;
}

// Single source of truth for "are codex credentials usable?" — the runtime
// helper resolves CODEX_AUTH_JSON as a filesystem path (matching the gateway
// and providerHealth probes), so this CLI flow can't drift from what the
// runtime actually accepts. We still distinguish env vs file as the source
// for display purposes by checking whether CODEX_AUTH_JSON drove the lookup.
function checkCodexCredentialsStatus(): CredentialStatus {
  if (!hasUsableCodexCredentials({ name: "codex", model: "gpt-5.5" })) {
    return { available: false, source: "missing", display: "✗ missing — run codex login" };
  }
  const envPath = process.env.CODEX_AUTH_JSON;
  if (envPath && envPath.length > 0) {
    return { available: true, source: "env", display: "✓ in CODEX_AUTH_JSON env" };
  }
  return { available: true, source: "file", display: "✓ ~/.codex/auth.json" };
}

// Build an API-key provider module (openai, anthropic, openrouter, deepseek,
// azure). They differ only in label/models/env var and, for azure, the extra
// transport prompts — the credential resolution (env → secrets.env → prompt) is
// shared. `keyHint` describes the expected key shape; `extraPrompts` collects
// any per-provider transport config into the shared `extra` object.
function apiKeyProvider(spec: {
  id: ProviderModule["id"];
  label: string;
  description: string;
  apiKeyEnv: string;
  defaultModel: string;
  suggestedModels: string[];
  keyHint: string;
  extraPrompts?: (io: SetupIO, extra: ProviderExtraConfig) => Promise<boolean>;
}): ProviderModule {
  return {
    id: spec.id,
    kind: "api-key",
    label: spec.label,
    description: spec.description,
    apiKeyEnv: spec.apiKeyEnv,
    defaultModel: spec.defaultModel,
    suggestedModels: spec.suggestedModels,
    checkCredentials(): CredentialStatus {
      const status = checkApiKeyStatus(spec.apiKeyEnv);
      if (status.source === "env") return { available: true, source: "env", display: "✓ in env" };
      if (status.source === "file") return { available: true, source: "file", display: "✓ saved" };
      return { available: false, source: "missing", display: "✗ missing" };
    },
    async ensureCredentials(io: SetupIO, extra: ProviderExtraConfig): Promise<boolean> {
      const status = checkApiKeyStatus(spec.apiKeyEnv);
      if (status.source === "env") {
        io.info(`Using ${spec.apiKeyEnv} from your environment.`);
        if (status.value) writeKeyToSecretsFile(spec.apiKeyEnv, status.value);
      } else if (status.source === "file") {
        io.info(`Found existing ${spec.label} key in ~/.gini/secrets.env.`);
      } else {
        const ok = await promptAndSaveApiKey(io, spec.apiKeyEnv, spec.label, spec.keyHint);
        if (!ok) return false;
      }
      // Capture any extra transport config (azure endpoint/deployment, etc.).
      if (spec.extraPrompts) return spec.extraPrompts(io, extra);
      return true;
    }
  };
}

const openaiProvider: ProviderModule = apiKeyProvider({
  id: "openai",
  label: "OpenAI",
  description: "API key — sk-...",
  apiKeyEnv: "OPENAI_API_KEY",
  defaultModel: "gpt-5.4-mini",
  suggestedModels: ["gpt-5.4-mini", "gpt-5.4", "gpt-4o"],
  keyHint: "sk-"
});

const anthropicProvider: ProviderModule = apiKeyProvider({
  id: "anthropic",
  label: "Anthropic",
  description: "First-party Claude API key — sk-ant-...",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  defaultModel: "claude-opus-4-8",
  suggestedModels: ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  keyHint: "sk-ant-"
});

const openrouterProvider: ProviderModule = apiKeyProvider({
  id: "openrouter",
  label: "OpenRouter",
  description: "Multi-model router — sk-or-...",
  apiKeyEnv: "OPENROUTER_API_KEY",
  defaultModel: "openrouter/auto",
  suggestedModels: ["openrouter/auto"],
  keyHint: "sk-or-"
});

const requestyProvider: ProviderModule = apiKeyProvider({
  id: "requesty",
  label: "Requesty",
  description: "Multi-model router — rqsty-sk-...",
  apiKeyEnv: "REQUESTY_API_KEY",
  defaultModel: "openai/gpt-4o-mini",
  suggestedModels: ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-opus-4-8"],
  keyHint: "rqsty-sk-"
});

const deepseekProvider: ProviderModule = apiKeyProvider({
  id: "deepseek",
  label: "DeepSeek",
  description: "API key — sk-...",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  defaultModel: "deepseek-v4-flash",
  suggestedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  keyHint: "sk-"
});

const azureProvider: ProviderModule = apiKeyProvider({
  id: "azure",
  label: "Azure OpenAI",
  description: "Deployment on your Azure resource",
  apiKeyEnv: "AZURE_OPENAI_API_KEY",
  defaultModel: "gpt-5.5",
  suggestedModels: ["gpt-5.5", "gpt-5.4", "gpt-4o", "gpt-4o-mini", "o3-mini"],
  keyHint: "",
  // Azure has no default endpoint: it routes per deployment on the user's
  // resource, so a base URL is required and the deployment/api-version/auth
  // scheme refine the path. Mirrors the `gini provider set azure` flags.
  async extraPrompts(io: SetupIO, extra: ProviderExtraConfig): Promise<boolean> {
    const baseUrl = (await io.prompt("Azure resource endpoint (https://<resource>.openai.azure.com):")).trim();
    if (!baseUrl) {
      io.error("Azure requires a resource endpoint. Aborting.");
      return false;
    }
    if (!baseUrl.startsWith("https://")) {
      io.error("The Azure endpoint must be an https:// URL (the key is sent on every request). Aborting.");
      return false;
    }
    extra.baseUrl = baseUrl;
    const deployment = (await io.prompt("Deployment name [defaults to the model id]:", "")).trim();
    if (deployment) extra.deployment = deployment;
    const apiVersion = (await io.prompt("API version [GA default]:", "")).trim();
    if (apiVersion) extra.apiVersion = apiVersion;
    const scheme = await io.select(
      "Auth scheme:",
      [
        { label: "api-key (resource key)", value: "api-key" as const },
        { label: "bearer (Entra token)", value: "bearer" as const }
      ],
      0
    );
    extra.authScheme = scheme;
    return true;
  }
});

const codexProvider: ProviderModule = {
  id: "codex",
  kind: "codex-oauth",
  label: "OpenAI Codex",
  description: "Use existing codex login auth (~/.codex/auth.json)",
  defaultModel: "gpt-5.5",
  suggestedModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"],
  checkCredentials(): CredentialStatus {
    return checkCodexCredentialsStatus();
  },
  async ensureCredentials(io: SetupIO): Promise<boolean> {
    while (true) {
      const status = checkCodexCredentialsStatus();
      if (status.available) {
        io.info(`OpenAI Codex credentials: ${status.display}`);
        const action = await io.select(
          "What would you like to do?",
          [
            { label: "Use existing credentials", value: "use" as const },
            { label: "Reauthenticate (run codex login)", value: "reauth" as const },
            { label: "Cancel", value: "cancel" as const }
          ],
          0
        );
        if (action === "use") return true;
        if (action === "cancel") return false;
        const ok = runCodexLogin(io);
        if (!ok) return false;
        const recheck = checkCodexCredentialsStatus();
        if (recheck.available) return true;
        io.error("Codex credentials still missing after login. Aborting.");
        return false;
      }

      io.info(`OpenAI Codex credentials: ${status.display}`);
      const action = await io.select(
        "What would you like to do?",
        [
          { label: "Run codex login now", value: "login" as const },
          { label: "I've already logged in elsewhere — re-check", value: "recheck" as const },
          { label: "Cancel", value: "cancel" as const }
        ],
        0
      );
      if (action === "cancel") return false;
      if (action === "login") {
        const ok = runCodexLogin(io);
        if (!ok) return false;
        const recheck = checkCodexCredentialsStatus();
        if (recheck.available) return true;
        io.error("Codex credentials still missing after login. Aborting.");
        return false;
      }
      // action === "recheck" → loop again
    }
  }
};

// `spawn` is injectable so tests can pin the exact argv without launching
// the real codex CLI (which would start an interactive OAuth flow).
function runCodexLogin(io: SetupIO, spawn: typeof spawnSync = spawnSync): boolean {
  // `login` is a codex CLI subcommand, not a flag — `codex --login` is
  // rejected by the CLI, so the argv must be the bare subcommand.
  const result = spawn("codex", ["login"], { stdio: "inherit" });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      io.error("codex CLI not found — install it from https://github.com/openai/codex then run codex login");
    } else {
      io.error(`Failed to run codex login: ${err.message}`);
    }
    return false;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    io.error(`codex login exited with status ${result.status}.`);
    return false;
  }
  return true;
}

// Bedrock signs every Converse request with AWS SigV4 over the AWS access key +
// secret the user enters here (written to secrets.env under the standard AWS_*
// names). gini does NOT read ~/.aws. "Configured" means those keys resolve from
// the env. An optional region refines the endpoint (defaults resolve at request
// time).
const bedrockProvider: ProviderModule = {
  id: "bedrock",
  kind: "aws",
  label: "Amazon Bedrock",
  description: "AWS access key — Claude, Nova, Llama…",
  defaultModel: "us.anthropic.claude-opus-4-8",
  suggestedModels: [
    "us.anthropic.claude-opus-4-8",
    "us.anthropic.claude-sonnet-4-6",
    "us.amazon.nova-pro-v1:0",
    "us.meta.llama4-scout-17b-instruct-v1:0"
  ],
  checkCredentials(): CredentialStatus {
    if (hasUsableAwsCredentials()) {
      return { available: true, source: "env", display: "✓ AWS keys set" };
    }
    return { available: false, source: "missing", display: "✗ no AWS keys (enter your access key + secret)" };
  },
  async ensureCredentials(io: SetupIO, extra: ProviderExtraConfig): Promise<boolean> {
    // When the keys aren't already in the env (a prior add or the user's shell),
    // prompt for them and persist to secrets.env so future shells + the gateway
    // both sign with them. gini never reads ~/.aws.
    if (!hasUsableAwsCredentials()) {
      const accessKeyId = (await io.prompt("AWS Access Key ID (AKIA…):")).trim();
      if (!accessKeyId) {
        io.error("No AWS Access Key ID entered. Aborting.");
        return false;
      }
      const secretAccessKey = (await io.secret("AWS Secret Access Key:")).trim();
      if (!secretAccessKey) {
        io.error("No AWS Secret Access Key entered. Aborting.");
        return false;
      }
      writeKeyToSecretsFile("AWS_ACCESS_KEY_ID", accessKeyId);
      writeKeyToSecretsFile("AWS_SECRET_ACCESS_KEY", secretAccessKey);
      process.env.AWS_ACCESS_KEY_ID = accessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
      io.success("Saved AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to ~/.gini/secrets.env (mode 0600).");
    } else {
      // Keys already resolve. If they're only in the live shell env (not yet in
      // secrets.env), persist them — the autostart plist refresh reads secrets.env,
      // so an env-only pair would be lost on the next launchd respawn. Mirrors the
      // api-key providers' env-source persistence.
      const ak = checkApiKeyStatus("AWS_ACCESS_KEY_ID");
      const sk = checkApiKeyStatus("AWS_SECRET_ACCESS_KEY");
      if (ak.source === "env" && ak.value && sk.source === "env" && sk.value) {
        writeKeyToSecretsFile("AWS_ACCESS_KEY_ID", ak.value);
        writeKeyToSecretsFile("AWS_SECRET_ACCESS_KEY", sk.value);
        io.info("Saved the AWS keys from your environment to ~/.gini/secrets.env (mode 0600).");
      } else {
        io.info("Using the AWS keys already set in your environment.");
      }
    }
    const region = (await io.prompt("AWS region [blank → AWS_REGION / us-east-1]:", "")).trim();
    if (region) extra.awsRegion = region;
    return true;
  }
};

// Local OpenAI-compatible server (Ollama, LM Studio, vLLM, …). No-auth is the
// common case, so the key is optional; the base URL is what setup needs.
const localProvider: ProviderModule = {
  id: "local",
  kind: "local",
  label: "Local",
  description: "OpenAI-compatible server (Ollama, LM Studio, vLLM)",
  apiKeyEnv: "GINI_LOCAL_API_KEY",
  defaultModel: "local/default",
  suggestedModels: ["local/default"],
  checkCredentials(): CredentialStatus {
    const status = checkApiKeyStatus("GINI_LOCAL_API_KEY");
    if (status.source === "env") return { available: true, source: "env", display: "✓ key in env" };
    if (status.source === "file") return { available: true, source: "file", display: "✓ key saved" };
    // No-auth local gateways are valid — local is "available" without a key.
    return { available: true, source: "missing", display: "no key (no-auth gateway)" };
  },
  async ensureCredentials(io: SetupIO, extra: ProviderExtraConfig): Promise<boolean> {
    const baseUrl = (await io.prompt("Local server base URL:", "http://127.0.0.1:11434/v1")).trim();
    if (baseUrl) extra.baseUrl = baseUrl;
    const key = (await io.secret("API key if your server requires one (blank for no-auth):")).trim();
    if (key) {
      writeKeyToSecretsFile("GINI_LOCAL_API_KEY", key);
      io.success("Saved local API key to ~/.gini/secrets.env (mode 0600).");
    }
    return true;
  }
};

const PROVIDERS: ProviderModule[] = [
  openaiProvider,
  codexProvider,
  anthropicProvider,
  bedrockProvider,
  azureProvider,
  openrouterProvider,
  requestyProvider,
  deepseekProvider,
  localProvider
];

function providerById(id: string | undefined): ProviderModule | undefined {
  if (!id) return undefined;
  return PROVIDERS.find((p) => p.id === id);
}

function renderCurrentState(config: RuntimeConfig): void {
  const provider = config.provider;
  const module = providerById(provider?.name);
  if (!module) {
    console.log(`  Provider:    (not set)`);
    console.log(`  Model:       (not set)`);
    console.log(`  Credentials: (not set)`);
    console.log("");
    return;
  }
  const cred = module.checkCredentials();
  const modelLabel = provider?.model ? provider.model : "(not set)";
  console.log(`  Provider:    ${module.label}`);
  console.log(`  Model:       ${modelLabel}`);
  console.log(`  Credentials: ${cred.display}`);
  console.log("");
}

export const providerStep: SetupStep = {
  id: "provider",
  title: "LLM provider",
  async isComplete(config) {
    const module = providerById(config.provider?.name);
    if (!module) return false;
    return module.checkCredentials().available;
  },
  async run(config, io) {
    console.log("◆ LLM provider");
    console.log("  Configure how gini connects to your chat model.\n");
    renderCurrentState(config);

    if (io.isNonInteractive) {
      await runNonInteractive(config, io);
      return;
    }

    const currentModule = providerById(config.provider?.name);
    const isConfigured = currentModule ? currentModule.checkCredentials().available : false;

    if (isConfigured && currentModule) {
      await runConfiguredFlow(config, io, currentModule);
      return;
    }

    await runFreshFlow(config, io);
  }
};

// Providers auto-configurable in a --yes run, in precedence order. Codex first
// (existing OAuth/key files, no prompt), then the API-key providers whose key is
// already in env/secrets.env, then bedrock (AWS chain). azure and local are
// excluded: both need interactive transport input (azure's resource endpoint,
// local's base URL) that a non-interactive run can't gather, so they only set
// up through the interactive picker.
const AUTO_CONFIGURABLE: ProviderModule[] = [
  codexProvider,
  openaiProvider,
  anthropicProvider,
  openrouterProvider,
  requestyProvider,
  deepseekProvider,
  bedrockProvider
];

async function runNonInteractive(config: RuntimeConfig, io: SetupIO): Promise<void> {
  for (const provider of AUTO_CONFIGURABLE) {
    const status = provider.checkCredentials();
    if (!status.available) continue;

    const model = config.provider?.name === provider.id && config.provider.model
      ? config.provider.model
      : provider.defaultModel;

    // For API-key providers, persist a key found only in the live env into
    // secrets.env so future shells (loading via the wrapper) pick it up.
    if (provider.kind === "api-key" && provider.apiKeyEnv) {
      const key = checkApiKeyStatus(provider.apiKeyEnv);
      if (key.source === "env" && key.value) writeKeyToSecretsFile(provider.apiKeyEnv, key.value);
    }
    // Bedrock signs with the AWS access key + secret; persist a live-env pair into
    // secrets.env the same way so future shells + the gateway keep signing.
    if (provider.kind === "aws") {
      const ak = checkApiKeyStatus("AWS_ACCESS_KEY_ID");
      const sk = checkApiKeyStatus("AWS_SECRET_ACCESS_KEY");
      if (ak.source === "env" && ak.value && sk.source === "env" && sk.value) {
        writeKeyToSecretsFile("AWS_ACCESS_KEY_ID", ak.value);
        writeKeyToSecretsFile("AWS_SECRET_ACCESS_KEY", sk.value);
      }
    }

    config.provider = normalizeProvider({ name: provider.id, model });
    writeRuntimeConfig(config);
    io.success(`Auto-configured: ${provider.id} (${model}), ${describeCredentialSource(provider, status)}`);
    return;
  }

  throw new Error(
    "No provider credentials found. Set OPENAI_API_KEY in your environment, write it to ~/.gini/secrets.env, set CODEX_AUTH_JSON, or run codex login (~/.codex/auth.json), then re-run `gini setup --yes`."
  );
}

// Human-readable credential source for the auto-config success line.
function describeCredentialSource(provider: ProviderModule, status: CredentialStatus): string {
  if (provider.kind === "codex-oauth") {
    return `credentials from ${status.source === "env" ? "CODEX_AUTH_JSON env" : "~/.codex/auth.json"}`;
  }
  if (provider.kind === "aws") return "AWS keys from env";
  return `key from ${status.source === "env" ? "env" : "secrets.env"}`;
}

async function runConfiguredFlow(config: RuntimeConfig, io: SetupIO, current: ProviderModule): Promise<void> {
  const action = await io.select(
    "What would you like to do?",
    [
      { label: "Keep current configuration", value: "keep" as const },
      { label: "Update credentials", value: "credentials" as const },
      { label: "Change model", value: "model" as const },
      { label: "Switch provider", value: "switch" as const },
      { label: "Cancel", value: "cancel" as const }
    ],
    0
  );

  if (action === "keep") {
    io.success("Kept current configuration.");
    return;
  }
  if (action === "cancel") {
    io.info("Aborted.");
    return;
  }
  if (action === "credentials") {
    const extra: ProviderExtraConfig = {};
    const ok = await current.ensureCredentials(io, extra);
    if (!ok) {
      io.info("Aborted.");
      return;
    }
    // Re-saving credentials can also re-capture transport config (azure
    // endpoint, bedrock region, local base URL); persist it with the existing
    // model so a credential refresh doesn't drop the routing.
    const model = config.provider?.model ?? current.defaultModel;
    config.provider = normalizeProvider({ name: current.id, model, ...extra });
    writeRuntimeConfig(config);
    io.success(`Updated ${current.label} credentials.`);
    return;
  }
  if (action === "switch") {
    await runFreshFlow(config, io);
    return;
  }
  // action === "model"
  const currentModel = config.provider?.model;
  const newModel = await selectModelForProvider(io, current, currentModel ?? null, true);
  if (newModel === null) return;
  config.provider = normalizeProvider({ name: current.id, model: newModel });
  writeRuntimeConfig(config);
  io.success(`Provider set to ${current.id} (${newModel}).`);
}

async function runFreshFlow(config: RuntimeConfig, io: SetupIO): Promise<void> {
  const chosen = await io.select(
    "Select provider:",
    PROVIDERS.map((p) => ({
      label: `${p.label}  ${COLOR.dim}— ${p.description}${COLOR.reset}`,
      value: p.id
    })),
    0
  );
  const provider = PROVIDERS.find((p) => p.id === chosen);
  if (!provider) {
    io.info("Aborted.");
    return;
  }
  io.info(`\n→ ${provider.label} selected.\n`);

  const extra: ProviderExtraConfig = {};
  const ok = await provider.ensureCredentials(io, extra);
  if (!ok) {
    io.info("Aborted.");
    return;
  }

  const model = await selectModelForProvider(io, provider, null, false);
  const chosenModel = model ?? provider.defaultModel;
  config.provider = normalizeProvider({ name: provider.id, model: chosenModel, ...extra });
  writeRuntimeConfig(config);
  io.success(`Provider set to ${provider.id} (${chosenModel}).`);
}

async function promptAndSaveApiKey(io: SetupIO, envVar: string, label: string, keyHint: string): Promise<boolean> {
  const hint = keyHint ? ` (${keyHint}...)` : "";
  const apiKey = await io.secret(`Enter your ${label} API key${hint}:`);
  if (!apiKey) {
    io.error("No API key entered. Skipping.");
    return false;
  }
  if (keyHint && !apiKey.startsWith(keyHint)) {
    io.error(`API key doesn't look like a ${label} key (expected to start with ${keyHint}). Continuing anyway.`);
  }
  writeKeyToSecretsFile(envVar, apiKey);
  io.success(`Saved ${envVar} to ~/.gini/secrets.env (mode 0600).`);
  return true;
}

// Returns null when the user picks "skip" (model unchanged). Returns the
// model name otherwise.
async function selectModelForProvider(
  io: SetupIO,
  module: ProviderModule,
  currentModel: string | null,
  allowSkip: boolean
): Promise<string | null> {
  const choices: { label: string; value: string }[] = [];
  for (const model of module.suggestedModels) {
    let label: string = model;
    if (model === currentModel) label += "  ← currently in use";
    else if (model === module.defaultModel && !currentModel) label += "  ← recommended";
    choices.push({ label, value: model });
  }
  choices.push({ label: "Enter custom model name", value: "__custom__" });
  if (allowSkip) {
    choices.push({ label: "Skip (keep current)", value: "__skip__" });
  } else {
    choices.push({ label: "Skip (use recommended)", value: "__skip__" });
  }

  // Default in update mode is "Skip"; in fresh mode it's the recommended
  // model (index 0).
  const defaultIndex = allowSkip ? choices.length - 1 : 0;
  const chosen = await io.select("\nSelect default model:", choices, defaultIndex);

  if (chosen === "__skip__") {
    if (allowSkip && currentModel) {
      io.info(`Keeping model ${currentModel}.`);
      return null;
    }
    return module.defaultModel;
  }
  if (chosen === "__custom__") {
    const custom = await io.prompt("Enter model name", currentModel ?? module.defaultModel);
    return custom.trim() || (currentModel ?? module.defaultModel);
  }
  return chosen;
}

// Exported for tests.
export const __testing = {
  openaiProvider,
  codexProvider,
  anthropicProvider,
  bedrockProvider,
  azureProvider,
  openrouterProvider,
  requestyProvider,
  deepseekProvider,
  localProvider,
  PROVIDERS,
  AUTO_CONFIGURABLE,
  runCodexLogin
};

const STEPS: SetupStep[] = [providerStep];

interface DisposableIO extends SetupIO {
  close(): void;
}

function makeReadlineIO(): DisposableIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    isNonInteractive: false,
    async select<T>(prompt: string, choices: { label: string; value: T }[], defaultIndex = 0): Promise<T> {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        try {
          return await tuiSelect(prompt, choices, defaultIndex, rl);
        } catch {
          // Fall through to numbered fallback on unexpected TUI failure.
        }
      }
      while (true) {
        console.log(prompt);
        for (let i = 0; i < choices.length; i += 1) {
          console.log(`  ${i + 1}. ${choices[i]!.label}`);
        }
        const defaultLabel = defaultIndex >= 0 && defaultIndex < choices.length
          ? `default: ${defaultIndex + 1}`
          : "default: 1";
        const range = choices.length === 1 ? "1" : `1-${choices.length}`;
        const answer = (await rl.question(`\n  Choice [${range}] (${defaultLabel}): `)).trim();
        if (answer === "") {
          const idx = defaultIndex >= 0 && defaultIndex < choices.length ? defaultIndex : 0;
          return choices[idx]!.value;
        }
        const num = Number(answer);
        if (Number.isInteger(num) && num >= 1 && num <= choices.length) {
          return choices[num - 1]!.value;
        }
        const byLabel = choices.find((c) => c.label.toLowerCase() === answer.toLowerCase());
        if (byLabel) return byLabel.value;
        console.log(`Invalid choice. Enter a number 1-${choices.length} or a label.\n`);
      }
    },
    async prompt(question: string, defaultValue?: string): Promise<string> {
      const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${question}${suffix} `)).trim();
      if (answer === "" && defaultValue !== undefined) return defaultValue;
      return answer;
    },
    async secret(question: string): Promise<string> {
      return readSecret(question, rl);
    },
    info(msg: string) { console.log(msg); },
    success(msg: string) { console.log(`✓ ${msg}`); },
    error(msg: string) { console.error(msg); },
    close() { rl.close(); }
  };
}

// Arrow-key TUI menu. TTY-only — caller falls back to numbered selection on
// throw. Like readSecret, we pause readline so it doesn't race us for stdin
// bytes.
async function tuiSelect<T>(
  prompt: string,
  choices: { label: string; value: T }[],
  defaultIndex: number,
  rl: readline.Interface
): Promise<T> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("tuiSelect requires a TTY");
  }
  if (choices.length === 0) {
    throw new Error("tuiSelect requires at least one choice");
  }
  const startIndex = defaultIndex >= 0 && defaultIndex < choices.length ? defaultIndex : 0;
  let cursor = startIndex;

  rl.pause();
  process.stdout.write("\x1b[?25l");

  const trimmedPrompt = prompt.replace(/^\n+/, "");
  const leadingNewlines = prompt.slice(0, prompt.length - trimmedPrompt.length);
  if (leadingNewlines) process.stdout.write(leadingNewlines);

  let renderedLines = 0;

  const render = (firstPass: boolean): void => {
    if (!firstPass && renderedLines > 0) {
      for (let i = 0; i < renderedLines; i += 1) {
        process.stdout.write("\x1b[1A\x1b[2K");
      }
    }
    const lines: string[] = [];
    lines.push(trimmedPrompt);
    lines.push("");
    for (let i = 0; i < choices.length; i += 1) {
      const isSelected = i === cursor;
      if (isSelected) {
        lines.push(`${COLOR.cyan}  → ●${COLOR.reset} ${COLOR.bold}${choices[i]!.label}${COLOR.reset}`);
      } else {
        lines.push(`    ○ ${choices[i]!.label}`);
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  };

  render(true);

  return new Promise<T>((resolveChoice, rejectChoice) => {
    // The Escape key is `\x1b`, but arrow keys also begin with `\x1b` and
    // arrive as a multi-byte sequence (`\x1b[A`, `\x1bOA`, etc.). When a
    // chunk is exactly `\x1b` we can't immediately tell which it is, so we
    // wait 50ms for the rest of the sequence; if nothing arrives, treat it
    // as a standalone Escape press.
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
      process.stdin.removeListener("data", onData);
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
      rl.resume();
    };

    const selectAt = (idx: number): void => {
      cursor = idx;
      render(false);
      finish();
      resolveChoice(choices[cursor]!.value);
    };

    const handleSequence = (seq: string): void => {
      if (seq === "\x1b[A" || seq === "\x1bOA") {
        cursor = (cursor - 1 + choices.length) % choices.length;
        render(false);
        return;
      }
      if (seq === "\x1b[B" || seq === "\x1bOB") {
        cursor = (cursor + 1) % choices.length;
        render(false);
        return;
      }
    };

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString("utf8");

      if (escTimer && str.length > 0) {
        clearTimeout(escTimer);
        escTimer = null;
        if (str.startsWith("[") || str.startsWith("O")) {
          handleSequence("\x1b" + str);
          return;
        }
        cursor = startIndex;
        render(false);
        finish();
        resolveChoice(choices[cursor]!.value);
        return;
      }

      if (str === "\x1b") {
        escTimer = setTimeout(() => {
          escTimer = null;
          cursor = startIndex;
          render(false);
          finish();
          resolveChoice(choices[cursor]!.value);
        }, 50);
        return;
      }

      if (str.startsWith("\x1b[") || str.startsWith("\x1bO")) {
        handleSequence(str);
        return;
      }

      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          selectAt(cursor);
          return;
        }
        if (code === 3) {
          finish();
          process.stdout.write("\n");
          process.exit(130);
          return;
        }
        if (ch === "k") {
          cursor = (cursor - 1 + choices.length) % choices.length;
          render(false);
          continue;
        }
        if (ch === "j") {
          cursor = (cursor + 1) % choices.length;
          render(false);
          continue;
        }
        if (code >= 49 && code <= 57) {
          const idx = code - 49;
          if (idx < choices.length) {
            selectAt(idx);
            return;
          }
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    // Defensive: surface unexpected stream errors so the caller can fall back.
    const onError = (err: Error): void => {
      process.stdin.removeListener("error", onError);
      finish();
      rejectChoice(err);
    };
    process.stdin.once("error", onError);
  });
}

// Read a line without echoing it. Falls back to plain readline (with a
// warning) if stdin isn't a TTY — secret prompts shouldn't reach this path
// in non-interactive mode, but the guard keeps an accidental pipe from
// hanging on setRawMode.
async function readSecret(question: string, rl: readline.Interface): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.warn("(warning: stdin is not a TTY; your input will be visible)");
    return (await rl.question(`${question} `)).trim();
  }
  // Pause readline while we steal raw stdin — otherwise readline keeps
  // listening too and the byte stream gets split between the two consumers.
  rl.pause();
  process.stdout.write(`${question} `);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolveSecret, rejectSecret) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      const str = chunk.toString("utf8");
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          cleanup();
          process.stdout.write("\n");
          resolveSecret(buf.trim());
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          rejectSecret(new Error("Cancelled"));
          return;
        }
        if (code === 4 && buf.length === 0) {
          cleanup();
          process.stdout.write("\n");
          resolveSecret("");
          return;
        }
        if (code === 8 || code === 127) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue;
        buf += ch;
        process.stdout.write("*");
      }
    };
    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      process.stdin.pause();
      rl.resume();
    };
    process.stdin.on("data", onData);
  });
}

function makeNonInteractiveIO(): DisposableIO {
  const refuse = (kind: string): never => {
    throw new Error(`gini setup --non-interactive: ${kind} prompt is not allowed. Provide all required values via env (e.g. OPENAI_API_KEY) and re-run.`);
  };
  return {
    isNonInteractive: true,
    async select() { return refuse("select"); },
    async prompt() { return refuse("prompt"); },
    async secret() { return refuse("secret"); },
    info(msg) { console.log(msg); },
    success(msg) { console.log(`✓ ${msg}`); },
    error(msg) { console.error(msg); },
    close() { /* no-op */ }
  };
}

export async function setup(ctx: CliContext): Promise<void> {
  const force = hasFlag(ctx.rawArgs, "--force");
  const nonInteractive = hasFlag(ctx.rawArgs, "--yes") || hasFlag(ctx.rawArgs, "--non-interactive");

  if (!process.stdin.isTTY && !nonInteractive) {
    console.error("Refusing to run interactively without a TTY. Pass --yes to run non-interactively (will fail loudly if input is needed).");
    process.exit(1);
  }

  const io: DisposableIO = nonInteractive ? makeNonInteractiveIO() : makeReadlineIO();
  try {
    console.log(`\nSetting up gini-agent (instance: ${ctx.config.instance})\n`);

    for (const step of STEPS) {
      const done = await step.isComplete(ctx.config);
      if (done && !force) {
        io.info(`${step.title}: already configured (use --force to redo)`);
        continue;
      }
      try {
        await step.run(ctx.config, io);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n${message}`);
        process.exit(1);
      }
    }

    // If autostart is enabled for this instance, refresh the plist so any
    // secrets.env values just written land in EnvironmentVariables for
    // the next launchd respawn. The running gateway (if any) already has
    // the new env via process.env. No-op on non-macOS or when autostart
    // isn't enabled.
    const { maybeRefreshAutostart } = await import("./autostart");
    const refreshed = await maybeRefreshAutostart(ctx.config.instance);
    if (refreshed.refreshed) {
      io.info("Autostart plist refreshed.");
    }

    console.log("\nDone. Run `gini start` to start.\n");
  } finally {
    io.close();
  }
}
