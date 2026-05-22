// Subprocess tests for `gini setup`. The interactive read-secret path
// requires a real TTY, so these tests exercise only the non-TTY refusal
// and the --non-interactive (--yes) short-circuit. Real prompts are
// validated by manual smoke through the curl|bash installer.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  __testing,
  checkOpenAIKeyStatus,
  hasKeyInSecretsFile,
  readKeyFromSecretsFile,
  writeKeyToSecretsFile
} from "./commands/setup";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: "ignore" | "pipe";
  stdinData?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn("bun", ["run", CLI_PATH, ...opts.args], {
      cwd: PROJECT_ROOT,
      env: opts.env,
      stdio: [opts.stdin ?? "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (opts.stdin === "pipe" && opts.stdinData !== undefined) {
      child.stdin?.write(opts.stdinData);
      child.stdin?.end();
    }
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-setup-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("gini setup", () => {
  test("--non-interactive without provider configured and no credentials exits 1", async () => {
    const stateRoot = scratch("no-key");
    const home = scratch("no-key-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
  }, 30_000);

  test("--non-interactive with OPENAI_API_KEY in env and provider preconfigured exits 0", async () => {
    const stateRoot = scratch("preconfigured");
    const home = scratch("preconfigured-home");
    const instance = "dev";
    const instanceDir = join(stateRoot, "instances", instance);
    mkdirSync(instanceDir, { recursive: true });
    const seedConfig = {
      instance,
      port: 7337,
      token: "test-token",
      provider: {
        name: "openai",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY"
      },
      workspaceRoot: join(instanceDir, "workspace"),
      stateRoot: instanceDir,
      logRoot: join(instanceDir, "logs")
    };
    writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(seedConfig, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-test"
    };
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already configured");
    expect(result.stdout).toContain("Done.");
  }, 30_000);

  test("--non-interactive with fresh echo config and OPENAI_API_KEY in env auto-configures openai", async () => {
    const stateRoot = scratch("fresh-yes");
    const home = scratch("fresh-yes-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-test-fresh-123"
    };
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Auto-configured");
    expect(result.stdout).toContain("openai");
    const configPath = join(stateRoot, "instances", instance, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { provider?: { name?: string; model?: string } };
    expect(config.provider?.name).toBe("openai");
    expect(config.provider?.model).toBe("gpt-5.4-mini");
    // The non-interactive flow persists the env key to secrets.env with
    // mode 0600 so future shells (loading via the wrapper) pick it up.
    const secretsPath = join(home, ".gini", "secrets.env");
    expect(existsSync(secretsPath)).toBe(true);
    const mode = statSync(secretsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  test("--non-interactive with fresh echo config and NO OPENAI_API_KEY exits 1 with helpful message", async () => {
    const stateRoot = scratch("fresh-yes-nokey");
    const home = scratch("fresh-yes-nokey-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    // No stack trace in user-facing output.
    expect(result.stderr).not.toContain("    at ");
    // Config should NOT have been mutated to openai.
    const configPath = join(stateRoot, "instances", instance, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { provider?: { name?: string } };
      expect(config.provider?.name).not.toBe("openai");
    }
  }, 30_000);

  test("--non-interactive chmods a pre-existing 0644 secrets.env to 0600", async () => {
    const stateRoot = scratch("chmod-fix");
    const home = scratch("chmod-fix-home");
    const instance = "dev";
    const giniDir = join(home, ".gini");
    mkdirSync(giniDir, { recursive: true });
    const secretsPath = join(giniDir, "secrets.env");
    writeFileSync(secretsPath, "");
    chmodSync(secretsPath, 0o644);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-chmod-test"
    };
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const mode = statSync(secretsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  test("non-TTY without --yes refuses", async () => {
    const stateRoot = scratch("no-tty");
    const home = scratch("no-tty-home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--state-root", stateRoot],
      env,
      stdin: "pipe",
      stdinData: ""
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to run interactively without a TTY");
    void existsSync(stateRoot);
  }, 30_000);
});

describe("secrets.env helpers (direct)", () => {
  function withHome<T>(fn: (home: string) => T): T {
    const home = scratch("secrets-direct-home");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      return fn(home);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  }

  test("key with $, \", backtick characters round-trips identically", () => {
    withHome((home) => {
      const original = `sk-test"with$dollar\`and\\backslash`;
      writeKeyToSecretsFile("OPENAI_API_KEY", original);
      const readBack = readKeyFromSecretsFile("OPENAI_API_KEY");
      expect(readBack).toBe(original);
      // Permissions should be tightened on every touch.
      const path = join(home, ".gini", "secrets.env");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  test("key with embedded single quote round-trips identically", () => {
    withHome(() => {
      const original = `sk-key'with'singles`;
      writeKeyToSecretsFile("OPENAI_API_KEY", original);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBe(original);
    });
  });

  test("empty value: OPENAI_API_KEY=\"\" → hasKeyInSecretsFile returns false", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `export OPENAI_API_KEY=""\n`, { mode: 0o600 });
      expect(hasKeyInSecretsFile("OPENAI_API_KEY")).toBe(false);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBeNull();
    });
  });

  test("bare form OPENAI_API_KEY=value (no export) is accepted", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `OPENAI_API_KEY=sk-bare-form\n`, { mode: 0o600 });
      expect(hasKeyInSecretsFile("OPENAI_API_KEY")).toBe(true);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBe("sk-bare-form");
    });
  });

  test("checkOpenAIKeyStatus reports env source when env is set", () => {
    withHome(() => {
      const old = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-from-env";
      try {
        const status = checkOpenAIKeyStatus();
        expect(status.source).toBe("env");
        expect(status.value).toBe("sk-from-env");
      } finally {
        if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
      }
    });
  });

  test("checkOpenAIKeyStatus reports missing when neither env nor file has a value", () => {
    withHome(() => {
      const old = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        expect(checkOpenAIKeyStatus().source).toBe("missing");
      } finally {
        if (old !== undefined) process.env.OPENAI_API_KEY = old;
      }
    });
  });

  test("chmods pre-existing 0644 secrets.env to 0600 on read", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `export OPENAI_API_KEY='sk-loose'\n`);
      chmodSync(path, 0o644);
      // Reading should tighten perms.
      readKeyFromSecretsFile("OPENAI_API_KEY");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});

describe("codexProvider.checkCredentials (direct)", () => {
  function withCodexEnv<T>(home: string, env: { CODEX_AUTH_JSON?: string }, fn: () => T): T {
    const oldHome = process.env.HOME;
    const oldEnv = process.env.CODEX_AUTH_JSON;
    process.env.HOME = home;
    if (env.CODEX_AUTH_JSON === undefined) {
      delete process.env.CODEX_AUTH_JSON;
    } else {
      process.env.CODEX_AUTH_JSON = env.CODEX_AUTH_JSON;
    }
    try {
      return fn();
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldEnv === undefined) delete process.env.CODEX_AUTH_JSON; else process.env.CODEX_AUTH_JSON = oldEnv;
    }
  }

  test("no env and no file → returns missing", () => {
    const home = scratch("codex-direct-missing");
    withCodexEnv(home, {}, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });

  test("CODEX_AUTH_JSON parseable → returns env", () => {
    const home = scratch("codex-direct-env");
    withCodexEnv(home, { CODEX_AUTH_JSON: "{}" }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(true);
      expect(status.source).toBe("env");
    });
  });

  test("~/.codex/auth.json parseable → returns file", () => {
    const home = scratch("codex-direct-file");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    withCodexEnv(home, {}, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(true);
      expect(status.source).toBe("file");
    });
  });

  test("~/.codex/auth.json invalid JSON → returns missing", () => {
    const home = scratch("codex-direct-invalid");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "not json {");
    withCodexEnv(home, {}, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });

  test("CODEX_AUTH_JSON invalid JSON → returns missing (when no file)", () => {
    const home = scratch("codex-direct-invalid-env");
    withCodexEnv(home, { CODEX_AUTH_JSON: "not json {" }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });
});

describe("gini setup --yes codex precedence", () => {
  test("CODEX_AUTH_JSON set and fresh config → lands on codex with default model", async () => {
    // Platform default is codex/gpt-5.5, and CODEX_AUTH_JSON satisfies the
    // credential check, so `gini setup --yes` reports the codex provider
    // step as already configured and leaves the config pointing at codex.
    const stateRoot = scratch("codex-yes");
    const home = scratch("codex-yes-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      CODEX_AUTH_JSON: "{}"
    };
    delete env.OPENAI_API_KEY;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const cfgPath = join(stateRoot, "instances", instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: { name?: string; model?: string } };
    expect(cfg.provider?.name).toBe("codex");
    expect(cfg.provider?.model).toBe("gpt-5.5");
  }, 30_000);

  test("CODEX_AUTH_JSON and OPENAI_API_KEY both set → picks codex (precedence)", async () => {
    const stateRoot = scratch("codex-precedence");
    const home = scratch("codex-precedence-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      CODEX_AUTH_JSON: "{}",
      OPENAI_API_KEY: "sk-also-set"
    };
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const cfgPath = join(stateRoot, "instances", instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: { name?: string } };
    expect(cfg.provider?.name).toBe("codex");
  }, 30_000);

  test("neither CODEX_AUTH_JSON nor OPENAI_API_KEY set → exits 1 naming all three sources", async () => {
    const stateRoot = scratch("codex-none");
    const home = scratch("codex-none-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_AUTH_JSON;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain("CODEX_AUTH_JSON");
    expect(result.stderr).toContain("~/.codex/auth.json");
  }, 30_000);
});
