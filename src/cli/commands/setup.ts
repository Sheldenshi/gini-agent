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
import { writeConfigAtomic } from "../../paths";
import { hasUsableCodexCredentials, normalizeProvider } from "../../provider";
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

export function checkOpenAIKeyStatus(): OpenAIKeyStatus {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0) {
    return { source: "env", value: process.env.OPENAI_API_KEY };
  }
  const fromFile = readKeyFromSecretsFile("OPENAI_API_KEY");
  if (fromFile) return { source: "file", value: fromFile };
  return { source: "missing" };
}

export interface CredentialStatus {
  available: boolean;
  source: "env" | "file" | "missing";
  display: string;
}

export interface ProviderModule {
  id: "openai" | "codex";
  label: string;
  description: string;
  defaultModel: string;
  suggestedModels: string[];
  checkCredentials(): CredentialStatus;
  ensureCredentials(io: SetupIO): Promise<boolean>;
}

// Single source of truth for "are codex credentials usable?" — the runtime
// helper resolves CODEX_AUTH_JSON as a filesystem path (matching the gateway
// and providerHealth probes), so this CLI flow can't drift from what the
// runtime actually accepts. We still distinguish env vs file as the source
// for display purposes by checking whether CODEX_AUTH_JSON drove the lookup.
function checkCodexCredentialsStatus(): CredentialStatus {
  if (!hasUsableCodexCredentials({ name: "codex", model: "gpt-5.5" })) {
    return { available: false, source: "missing", display: "✗ missing — run codex --login" };
  }
  const envPath = process.env.CODEX_AUTH_JSON;
  if (envPath && envPath.length > 0) {
    return { available: true, source: "env", display: "✓ in CODEX_AUTH_JSON env" };
  }
  return { available: true, source: "file", display: "✓ ~/.codex/auth.json" };
}

const openaiProvider: ProviderModule = {
  id: "openai",
  label: "OpenAI",
  description: "API key — sk-...",
  defaultModel: "gpt-5.4-mini",
  suggestedModels: ["gpt-5.4-mini", "gpt-5.4", "gpt-4o"],
  checkCredentials(): CredentialStatus {
    const status = checkOpenAIKeyStatus();
    if (status.source === "env") return { available: true, source: "env", display: "✓ in env" };
    if (status.source === "file") return { available: true, source: "file", display: "✓ saved" };
    return { available: false, source: "missing", display: "✗ missing" };
  },
  async ensureCredentials(io: SetupIO): Promise<boolean> {
    const status = checkOpenAIKeyStatus();
    if (status.source === "missing") {
      return promptAndSaveApiKey(io);
    }
    if (status.source === "env") {
      io.info("Using OPENAI_API_KEY from your environment.");
      if (status.value) writeKeyToSecretsFile("OPENAI_API_KEY", status.value);
      return true;
    }
    io.info("Found existing OpenAI key in ~/.gini/secrets.env.");
    return true;
  }
};

const codexProvider: ProviderModule = {
  id: "codex",
  label: "OpenAI Codex",
  description: "Use existing codex --login auth (~/.codex/auth.json)",
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
            { label: "Reauthenticate (run codex --login)", value: "reauth" as const },
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
          { label: "Run codex --login now", value: "login" as const },
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

function runCodexLogin(io: SetupIO): boolean {
  const result = spawnSync("codex", ["--login"], { stdio: "inherit" });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      io.error("codex CLI not found — install it from https://github.com/openai/codex then run codex --login");
    } else {
      io.error(`Failed to run codex --login: ${err.message}`);
    }
    return false;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    io.error(`codex --login exited with status ${result.status}.`);
    return false;
  }
  return true;
}

const PROVIDERS: ProviderModule[] = [openaiProvider, codexProvider];

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

async function runNonInteractive(config: RuntimeConfig, io: SetupIO): Promise<void> {
  // Precedence: codex > openai. Codex uses existing OAuth/API key files and
  // needs no prompt, so we prefer it when both are available in a --yes run.
  const codexStatus = codexProvider.checkCredentials();
  const openaiStatus = openaiProvider.checkCredentials();

  if (codexStatus.available) {
    const model = config.provider?.name === "codex" && config.provider.model
      ? config.provider.model
      : codexProvider.defaultModel;
    config.provider = normalizeProvider({ name: "codex", model });
    writeConfigAtomic(config.instance, config);
    io.success(`Auto-configured: codex (${model}), credentials from ${codexStatus.source === "env" ? "CODEX_AUTH_JSON env" : "~/.codex/auth.json"}`);
    return;
  }

  if (openaiStatus.available) {
    const status = checkOpenAIKeyStatus();
    if (status.source === "env" && status.value) {
      writeKeyToSecretsFile("OPENAI_API_KEY", status.value);
    }
    const model = config.provider?.name === "openai" && config.provider.model
      ? config.provider.model
      : openaiProvider.defaultModel;
    config.provider = normalizeProvider({ name: "openai", model });
    writeConfigAtomic(config.instance, config);
    io.success(`Auto-configured: openai (${model}), key from ${status.source === "env" ? "env" : "secrets.env"}`);
    return;
  }

  throw new Error(
    "No provider credentials found. Set OPENAI_API_KEY in your environment, write it to ~/.gini/secrets.env, set CODEX_AUTH_JSON, or run codex --login (~/.codex/auth.json), then re-run `gini setup --yes`."
  );
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
    const ok = await current.ensureCredentials(io);
    if (!ok) {
      io.info("Aborted.");
    }
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
  writeConfigAtomic(config.instance, config);
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

  const ok = await provider.ensureCredentials(io);
  if (!ok) {
    io.info("Aborted.");
    return;
  }

  const model = await selectModelForProvider(io, provider, null, false);
  const chosenModel = model ?? provider.defaultModel;
  config.provider = normalizeProvider({ name: provider.id, model: chosenModel });
  writeConfigAtomic(config.instance, config);
  io.success(`Provider set to ${provider.id} (${chosenModel}).`);
}

async function promptAndSaveApiKey(io: SetupIO): Promise<boolean> {
  const apiKey = await io.secret("Enter your OpenAI API key (sk-...):");
  if (!apiKey) {
    io.error("No API key entered. Skipping.");
    return false;
  }
  if (!apiKey.startsWith("sk-")) {
    io.error("API key doesn't look like an OpenAI key (expected to start with sk-). Continuing anyway.");
  }
  writeKeyToSecretsFile("OPENAI_API_KEY", apiKey);
  io.success("Saved API key to ~/.gini/secrets.env (mode 0600).");
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
export const __testing = { openaiProvider, codexProvider, PROVIDERS };

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
