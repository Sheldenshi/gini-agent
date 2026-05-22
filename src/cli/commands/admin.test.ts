// Unit tests for `gini install` provider env-override behavior. We point
// HOME and GINI_STATE_ROOT at a scratch dir so the real on-disk config
// never gets touched, then call install_() directly to exercise the
// provider rewrite branch in isolation. The source of truth is the
// persisted config.json after the call.
//
// Coverage focus:
//   - The four (provider-changed, model-set) × (provider-unchanged,
//     model-unset) combinations of GINI_PROVIDER / GINI_MODEL.
//   - The legacy ~/.gini/lanes/<inst>/config.json migration path.
//   - The fresh-install path (no pre-existing config) for both
//     "env vars set" and "env vars unset → platform default".
//   - The validation error path for unrecognized GINI_PROVIDER.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { ProviderConfig, RuntimeConfig } from "../../types";
import { install_ } from "./admin";
import { loadConfig } from "../../paths";

describe("install_ provider env override", () => {
  let scratchHome: string;
  let originalHome: string | undefined;
  let originalState: string | undefined;
  let originalLogRoot: string | undefined;
  let originalProvider: string | undefined;
  let originalModel: string | undefined;
  let originalInstance: string | undefined;
  let originalWorkspace: string | undefined;
  let originalPort: string | undefined;

  beforeEach(() => {
    scratchHome = `/tmp/gini-admin-cli-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(scratchHome, { recursive: true });
    originalHome = process.env.HOME;
    originalState = process.env.GINI_STATE_ROOT;
    originalLogRoot = process.env.GINI_LOG_ROOT;
    originalProvider = process.env.GINI_PROVIDER;
    originalModel = process.env.GINI_MODEL;
    originalInstance = process.env.GINI_INSTANCE;
    originalWorkspace = process.env.GINI_WORKSPACE;
    originalPort = process.env.GINI_PORT;
    process.env.HOME = scratchHome;
    process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
    // Keep the workspace inside the scratch dir so install() doesn't try
    // to materialize anything outside the test sandbox.
    process.env.GINI_WORKSPACE = join(scratchHome, "workspace");
    delete process.env.GINI_INSTANCE;
    delete process.env.GINI_LOG_ROOT;
    delete process.env.GINI_PROVIDER;
    delete process.env.GINI_MODEL;
    delete process.env.GINI_PORT;
  });

  afterEach(() => {
    restore("HOME", originalHome);
    restore("GINI_STATE_ROOT", originalState);
    restore("GINI_LOG_ROOT", originalLogRoot);
    restore("GINI_PROVIDER", originalProvider);
    restore("GINI_MODEL", originalModel);
    restore("GINI_INSTANCE", originalInstance);
    restore("GINI_WORKSPACE", originalWorkspace);
    restore("GINI_PORT", originalPort);
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("codex → openai with GINI_PROVIDER=openai GINI_MODEL=gpt-5.4 rewrites provider", async () => {
    const instance = "switch-to-openai";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    process.env.GINI_PROVIDER = "openai";
    process.env.GINI_MODEL = "gpt-5.4";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" });
  });

  test("openai → codex without GINI_MODEL uses codex default and clears apiKeyEnv", async () => {
    const instance = "switch-to-codex";
    seedInstanceConfig(instance, { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
    process.env.GINI_PROVIDER = "codex";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.5");
    // apiKeyEnv must be unset for codex — the stale "OPENAI_API_KEY"
    // value from the previous openai config would otherwise survive
    // and confuse downstream consumers.
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("codex → codex with GINI_MODEL=gpt-5.6 only updates the model", async () => {
    const instance = "same-codex-new-model";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    process.env.GINI_PROVIDER = "codex";
    process.env.GINI_MODEL = "gpt-5.6";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.6");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("codex → codex with NO GINI_MODEL preserves an existing custom model", async () => {
    // A user with codex/gpt-custom must not have their model clobbered
    // to gpt-5.5 by a re-run of `gini install` with the same provider.
    const instance = "preserve-custom-model";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-custom" });
    process.env.GINI_PROVIDER = "codex";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-custom");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("pre-existing config + no env vars leaves provider untouched on disk", async () => {
    const instance = "no-env-preserved";
    seedInstanceConfig(instance, { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
  });

  test("GINI_PROVIDER=bogus throws and leaves the existing config untouched", async () => {
    const instance = "bogus-provider";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    process.env.GINI_PROVIDER = "bogus";
    await expect(install_(makeCtx(instance))).rejects.toThrow(/is not a recognized provider/);
    // Validation runs before ctx.config materializes, so the on-disk
    // file must be byte-identical to what we seeded.
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "codex", model: "gpt-5.5" });
  });

  test("legacy ~/.gini/lanes/<inst>/config.json gets migrated AND rewritten by env override", async () => {
    // Pins the legacy-migration race: loadConfig moves the legacy
    // config into ~/.gini/instances/<inst>/, then the env-override
    // branch must still rewrite it. A previous version of install_
    // snapshotted existsSync(configPath) BEFORE ctx.config triggered
    // the migration and skipped the rewrite.
    const instance = "legacy-migrate";
    const stateRoot = process.env.GINI_STATE_ROOT!;
    const lanesDir = join(stateRoot, "lanes", instance);
    mkdirSync(lanesDir, { recursive: true });
    const legacyCfg: Partial<RuntimeConfig> = {
      instance,
      port: 7400,
      token: "legacy-token",
      provider: { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot: join(lanesDir, "workspace"),
      stateRoot: lanesDir,
      logRoot: join(lanesDir, "logs")
    };
    writeFileSync(join(lanesDir, "config.json"), `${JSON.stringify(legacyCfg, null, 2)}\n`);
    process.env.GINI_PROVIDER = "codex";
    process.env.GINI_MODEL = "gpt-5.5";
    await install_(makeCtx(instance));
    // Legacy dir should be gone after migration.
    expect(existsSync(join(stateRoot, "lanes", instance))).toBe(false);
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "codex", model: "gpt-5.5", apiKeyEnv: undefined });
  });

  test("fresh install with GINI_PROVIDER=openai lands on openai via defaultConfig", async () => {
    const instance = "fresh-openai";
    process.env.GINI_PROVIDER = "openai";
    process.env.GINI_MODEL = "gpt-5.4";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" });
  });

  test("fresh install with no env vars lands on the codex/gpt-5.5 platform default", async () => {
    const instance = "fresh-default";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.5");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function seedInstanceConfig(
  instance: string,
  provider: ProviderConfig
): void {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  const instanceDir = join(stateRoot, "instances", instance);
  mkdirSync(instanceDir, { recursive: true });
  const cfg: Partial<RuntimeConfig> = {
    instance,
    port: 7400,
    token: "seed-token",
    provider,
    workspaceRoot: join(instanceDir, "workspace"),
    stateRoot: instanceDir,
    logRoot: join(instanceDir, "logs")
  };
  writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

function readPersistedConfig(instance: string): RuntimeConfig {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  const cfgPath = join(stateRoot, "instances", instance, "config.json");
  return JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
}

function makeCtx(instance: string): CliContext {
  // install_ resolves the instance via parseInstance(ctx.rawArgs), so
  // we must pass --instance in rawArgs. ctx.config is wired as a
  // lazy getter that calls loadConfig(instance) — same shape as the
  // real CLI entry in src/cli/index.ts.
  const rawArgs = ["install", "--instance", instance];
  let cached: RuntimeConfig | null = null;
  return {
    get config(): RuntimeConfig {
      // Lazy resolution mirrors the real CLI getter in src/cli/index.ts:
      // ctx.config materializes on first access so loadConfig sees the
      // process.env state at that moment (matters for tests that mutate
      // GINI_PROVIDER / GINI_STATE_ROOT in beforeEach).
      if (!cached) cached = loadConfig(instance);
      return cached;
    },
    cliArgs: rawArgs,
    command: "install",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
