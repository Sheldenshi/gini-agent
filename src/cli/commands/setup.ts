// Interactive post-install configuration. Re-runnable. Walks an array of
// SetupStep modules — currently just providerStep. The step framework is the
// load-bearing part: each step has isComplete() so users (and scripted
// installs) can re-run `gini setup` idempotently, and run(io) so steps can
// drive their own prompts via a shared SetupIO surface.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import type { CliContext } from "../context";
import { hasFlag } from "../args";
import { configPath } from "../../paths";
import { normalizeProvider } from "../../provider";
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

const SUGGESTED_OPENAI_MODELS = ["gpt-5.4-mini", "gpt-5.4", "gpt-4o"] as const;
const DEFAULT_OPENAI_MODEL = SUGGESTED_OPENAI_MODELS[0];

function secretsPath(): string {
  // Prefer $HOME so tests that override the env var see the override.
  // os.homedir() caches the platform's getpwuid result on macOS and won't
  // pick up a runtime HOME change.
  const home = process.env.HOME || homedir();
  return join(home, ".gini", "secrets.env");
}

function ensureSecretsPerms(): void {
  const path = secretsPath();
  if (!existsSync(path)) return;
  try { chmodSync(path, 0o600); } catch { /* ignore — best-effort tightening */ }
}

// POSIX-safe single-quote escaping. Closes the literal string, inserts an
// escaped quote, reopens. The single-quoted shell form is fully literal —
// `$`, backticks, and backslashes pass through unchanged.
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Undo single-quote escaping written by writeKeyToSecretsFile. Inverse of
// shellSingleQuote: strip surrounding quotes, replace each `'\''` with `'`.
function unquoteSecretsValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

// Match `export NAME=value` and bare `NAME=value` — `set -a` exports either
// form, so accepting both keeps us compatible with hand-edited files.
function secretsLineRegex(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "m");
}

export function hasKeyInSecretsFile(name: string): boolean {
  const path = secretsPath();
  if (!existsSync(path)) return false;
  ensureSecretsPerms();
  const content = readFileSync(path, "utf8");
  const match = content.match(secretsLineRegex(name));
  if (!match) return false;
  return unquoteSecretsValue(match[1] ?? "").length > 0;
}

export function readKeyFromSecretsFile(name: string): string | null {
  const path = secretsPath();
  if (!existsSync(path)) return null;
  ensureSecretsPerms();
  const content = readFileSync(path, "utf8");
  const match = content.match(secretsLineRegex(name));
  if (!match) return null;
  const value = unquoteSecretsValue(match[1] ?? "");
  return value.length > 0 ? value : null;
}

export function writeKeyToSecretsFile(name: string, value: string): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `export ${name}=${shellSingleQuote(value)}`;
  // Replace both `export NAME=...` and bare `NAME=...` forms.
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=.*$`, "m");
  if (pattern.test(existing)) {
    existing = existing.replace(pattern, line);
  } else {
    if (existing && !existing.endsWith("\n")) existing += "\n";
    existing += line + "\n";
  }
  writeFileSync(path, existing, { mode: 0o600 });
  ensureSecretsPerms();
}

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

function providerDisplayName(name: string): string {
  if (name === "openai") return "OpenAI";
  if (name === "codex") return "Codex OAuth";
  if (name === "openrouter") return "OpenRouter";
  if (name === "local") return "Local";
  return name;
}

function keyStatusLine(status: OpenAIKeyStatus): string {
  if (status.source === "env") return "✓ in env";
  if (status.source === "file") return "✓ saved";
  return "✗ missing";
}

function renderCurrentState(config: RuntimeConfig): void {
  const provider = config.provider;
  const configuredOpenAI = provider?.name === "openai";
  const providerLabel = configuredOpenAI ? "OpenAI" : "(not set)";
  const modelLabel = configuredOpenAI && provider?.model ? provider.model : "(not set)";
  const keyStatus = configuredOpenAI ? keyStatusLine(checkOpenAIKeyStatus()) : "(not set)";
  console.log(`  Provider:    ${providerLabel}`);
  console.log(`  Model:       ${modelLabel}`);
  console.log(`  API key:     ${keyStatus}`);
  console.log("");
}

export const providerStep: SetupStep = {
  id: "provider",
  title: "LLM provider",
  async isComplete(config) {
    // Only the openai provider has a real configuration. The `echo` default
    // is a placeholder — we want setup to run for it. Other providers
    // (codex/openrouter/local) aren't reachable through this flow yet, so
    // we treat them as needing setup too.
    if (config.provider?.name !== "openai") return false;
    return checkOpenAIKeyStatus().source !== "missing";
  },
  async run(config, io) {
    console.log("◆ LLM provider");
    console.log("  Configure how gini connects to your chat model.\n");
    renderCurrentState(config);

    const provider = config.provider;
    const isConfigured = provider?.name === "openai" && checkOpenAIKeyStatus().source !== "missing";

    if (io.isNonInteractive) {
      await runNonInteractive(config, io);
      return;
    }

    if (isConfigured) {
      await runConfiguredFlow(config, io);
      return;
    }

    await runFreshFlow(config, io);
  }
};

async function runNonInteractive(config: RuntimeConfig, io: SetupIO): Promise<void> {
  const status = checkOpenAIKeyStatus();
  if (status.source === "missing") {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in your environment or write it to ~/.gini/secrets.env, then re-run `gini setup --yes`."
    );
  }
  // If the key only lives in env, persist it to secrets.env so the wrapper
  // can pick it up on future shells.
  if (status.source === "env" && status.value) {
    writeKeyToSecretsFile("OPENAI_API_KEY", status.value);
  }
  const model = config.provider?.name === "openai" && config.provider.model
    ? config.provider.model
    : DEFAULT_OPENAI_MODEL;
  config.provider = normalizeProvider({ name: "openai", model });
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  io.success(`Auto-configured: openai (${model}), key from ${status.source === "env" ? "env" : "secrets.env"}`);
}

async function runConfiguredFlow(config: RuntimeConfig, io: SetupIO): Promise<void> {
  const action = await io.select(
    "What would you like to do?",
    [
      { label: "Keep current configuration", value: "keep" as const },
      { label: "Re-enter API key", value: "rekey" as const },
      { label: "Change model", value: "model" as const },
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
  if (action === "rekey") {
    await promptAndSaveApiKey(io);
    return;
  }
  // action === "model"
  const currentModel = config.provider?.model;
  const newModel = await selectModel(io, currentModel ?? null, true);
  if (newModel === null) return;
  config.provider = normalizeProvider({ name: "openai", model: newModel });
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  io.success(`Provider set to openai (${newModel}).`);
}

async function runFreshFlow(config: RuntimeConfig, io: SetupIO): Promise<void> {
  const chosen = await io.select(
    "Select provider:",
    [{ label: "OpenAI", value: "openai" as const }],
    0
  );
  if (chosen !== "openai") return;
  io.info("\n→ OpenAI selected.\n");

  const status = checkOpenAIKeyStatus();
  if (status.source === "missing") {
    await promptAndSaveApiKey(io);
  } else if (status.source === "env") {
    io.info("Using OPENAI_API_KEY from your environment.");
    if (status.value) writeKeyToSecretsFile("OPENAI_API_KEY", status.value);
  } else {
    io.info("Found existing OpenAI key in ~/.gini/secrets.env.");
  }

  const model = await selectModel(io, null, false);
  const chosenModel = model ?? DEFAULT_OPENAI_MODEL;
  config.provider = normalizeProvider({ name: "openai", model: chosenModel });
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  io.success(`Provider set to openai (${chosenModel}).`);
}

async function promptAndSaveApiKey(io: SetupIO): Promise<void> {
  const apiKey = await io.secret("Enter your OpenAI API key (sk-...):");
  if (!apiKey) {
    io.error("No API key entered. Skipping.");
    return;
  }
  if (!apiKey.startsWith("sk-")) {
    io.error("API key doesn't look like an OpenAI key (expected to start with sk-). Continuing anyway.");
  }
  writeKeyToSecretsFile("OPENAI_API_KEY", apiKey);
  io.success("Saved API key to ~/.gini/secrets.env (mode 0600).");
}

// Returns null when the user picks "skip" (model unchanged). Returns the
// model name otherwise.
async function selectModel(io: SetupIO, currentModel: string | null, allowSkip: boolean): Promise<string | null> {
  const choices: { label: string; value: string }[] = [];
  for (const model of SUGGESTED_OPENAI_MODELS) {
    let label: string = model;
    if (model === currentModel) label += "  ← currently in use";
    else if (model === DEFAULT_OPENAI_MODEL && !currentModel) label += "  ← recommended";
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
    return DEFAULT_OPENAI_MODEL;
  }
  if (chosen === "__custom__") {
    const custom = await io.prompt("Enter model name", currentModel ?? DEFAULT_OPENAI_MODEL);
    return custom.trim() || (currentModel ?? DEFAULT_OPENAI_MODEL);
  }
  return chosen;
}

const STEPS: SetupStep[] = [providerStep];

interface DisposableIO extends SetupIO {
  close(): void;
}

function makeReadlineIO(): DisposableIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    isNonInteractive: false,
    async select<T>(prompt: string, choices: { label: string; value: T }[], defaultIndex = 0): Promise<T> {
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

    console.log("\nDone. Run `gini start` to start.\n");
  } finally {
    io.close();
  }
}
