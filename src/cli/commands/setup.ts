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
  select<T>(prompt: string, choices: { label: string; value: T }[]): Promise<T>;
  prompt(question: string, defaultValue?: string): Promise<string>;
  secret(question: string): Promise<string>;
  info(msg: string): void;
  success(msg: string): void;
  error(msg: string): void;
}

export interface SetupStep {
  id: string;
  title: string;
  isComplete(config: RuntimeConfig): Promise<boolean>;
  run(config: RuntimeConfig, io: SetupIO): Promise<void>;
}

function secretsPath(): string {
  return join(homedir(), ".gini", "secrets.env");
}

function hasKeyInSecretsFile(name: string): boolean {
  const path = secretsPath();
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  return new RegExp(`^\\s*export\\s+${name}=`, "m").test(content);
}

function readKeyFromSecretsFile(name: string): string | null {
  const path = secretsPath();
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const match = content.match(new RegExp(`^\\s*export\\s+${name}="([^"]*)"`, "m"));
  return match?.[1] ?? null;
}

function writeKeyToSecretsFile(name: string, value: string): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `export ${name}="${value}"`;
  const pattern = new RegExp(`^\\s*export\\s+${name}=.*$`, "m");
  if (pattern.test(existing)) {
    existing = existing.replace(pattern, line);
  } else {
    if (existing && !existing.endsWith("\n")) existing += "\n";
    existing += line + "\n";
  }
  writeFileSync(path, existing, { mode: 0o600 });
  // chmod needed in case the file pre-existed with looser perms (our
  // writeFileSync `mode` only applies on create).
  chmodSync(path, 0o600);
}

export const providerStep: SetupStep = {
  id: "provider",
  title: "LLM provider",
  async isComplete(config) {
    if (!config.provider?.name) return false;
    if (config.provider.name === "openai") {
      if (process.env.OPENAI_API_KEY) return true;
      return hasKeyInSecretsFile("OPENAI_API_KEY");
    }
    return true;
  },
  async run(config, io) {
    const choice = await io.select("Pick a provider:", [
      { label: "OpenAI", value: "openai" as const }
    ]);

    if (choice === "openai") {
      let apiKey = process.env.OPENAI_API_KEY ?? "";
      const existingFromFile = readKeyFromSecretsFile("OPENAI_API_KEY");

      if (apiKey) {
        io.info("Using OPENAI_API_KEY from your environment.");
      } else if (existingFromFile) {
        const reuse = await io.prompt("Found existing key in ~/.gini/secrets.env. Use it? [Y/n]", "Y");
        if (reuse.toLowerCase().startsWith("y")) {
          apiKey = existingFromFile;
        }
      }

      if (!apiKey) {
        apiKey = await io.secret("Enter your OpenAI API key (sk-...):");
        if (!apiKey.startsWith("sk-")) {
          io.error("API key doesn't look like an OpenAI key (expected to start with sk-). Continuing anyway.");
        }
        writeKeyToSecretsFile("OPENAI_API_KEY", apiKey);
        io.success("Saved API key to ~/.gini/secrets.env (mode 0600).");
      }

      const model = await io.prompt("Which model?", "gpt-5.4-mini");

      config.provider = normalizeProvider({ name: "openai", model });
      writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
      io.success(`Provider set to openai (${model}).`);
    }
  }
};

const STEPS: SetupStep[] = [providerStep];

interface DisposableIO extends SetupIO {
  close(): void;
}

function makeReadlineIO(): DisposableIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    async select<T>(prompt: string, choices: { label: string; value: T }[]): Promise<T> {
      while (true) {
        console.log(prompt);
        for (let i = 0; i < choices.length; i += 1) {
          console.log(`  ${i + 1}. ${choices[i]!.label}`);
        }
        const answer = (await rl.question(`\nChoose [1]: `)).trim();
        if (answer === "") return choices[0]!.value;
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
    success(msg: string) { console.log(msg); },
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
        // \r or \n = enter
        if (code === 13 || code === 10) {
          cleanup();
          process.stdout.write("\n");
          resolveSecret(buf.trim());
          return;
        }
        // Ctrl-C
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          rejectSecret(new Error("Cancelled"));
          return;
        }
        // Ctrl-D on empty buffer = EOF
        if (code === 4 && buf.length === 0) {
          cleanup();
          process.stdout.write("\n");
          resolveSecret("");
          return;
        }
        // Backspace / Delete
        if (code === 8 || code === 127) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        // Ignore other control chars
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
    async select() { return refuse("select"); },
    async prompt() { return refuse("prompt"); },
    async secret() { return refuse("secret"); },
    info(msg) { console.log(msg); },
    success(msg) { console.log(msg); },
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
      console.log(`\n— ${step.title} —`);
      await step.run(ctx.config, io);
    }

    console.log("\nDone. Run `gini start` to start.\n");
  } finally {
    io.close();
  }
}
