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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  test("GINI_PROVIDER=echo throws and leaves the existing config byte-identical on disk", async () => {
    // Echo is a test-only provider, reachable only through the
    // ephemeral smoke path (src/cli/args.ts) which bypasses install_.
    // A user-facing `gini install` with GINI_PROVIDER=echo must throw
    // the same kind of validation error as a bogus provider, and must
    // not touch the existing on-disk config.
    const instance = "echo-rejected";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMtime = statSync(cfgPath).mtimeMs;
    process.env.GINI_PROVIDER = "echo";
    await expect(install_(makeCtx(instance))).rejects.toThrow(/is not a recognized provider/);
    expect(readFileSync(cfgPath).equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).mtimeMs).toBe(beforeMtime);
  });

  test("GINI_MODEL alone on existing config updates the model in place", async () => {
    // Symmetry with defaultConfig(): fresh configs honor GINI_MODEL
    // even when GINI_PROVIDER is unset, so existing configs must too.
    // The provider name and apiKeyEnv stay as they were.
    const instance = "model-only-update";
    seedInstanceConfig(instance, { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
    process.env.GINI_MODEL = "gpt-5.6";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("openai");
    expect(cfg.provider.model).toBe("gpt-5.6");
    expect(cfg.provider.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  test("pre-existing config + no env vars leaves provider byte-identical on disk", async () => {
    // install() always rewrites config.json on every call
    // (src/runtime/index.ts), so the file's mtime WILL advance even
    // when the content is unchanged — mtime is not a usable invariant
    // here. Byte equality is the meaningful pin: a regression where
    // the no-env branch silently mutated fields would show up as a
    // bytes diff. Seed a config matching the install()-produced shape
    // so the installer's own write is a content no-op, leaving any
    // byte drift attributable to the env-override branch.
    const instance = "no-env-preserved";
    seedFullyFormedInstanceConfig(instance, {
      provider: { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" }
    });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    await install_(makeCtx(instance));
    const afterBytes = readFileSync(cfgPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).size).toBe(beforeBytes.length);
  });

  test("GINI_PROVIDER=bogus throws and leaves the existing config byte-identical on disk", async () => {
    const instance = "bogus-provider";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMtime = statSync(cfgPath).mtimeMs;
    process.env.GINI_PROVIDER = "bogus";
    await expect(install_(makeCtx(instance))).rejects.toThrow(/is not a recognized provider/);
    // Validation runs before ctx.config materializes (no loadConfig, no
    // install() write). The on-disk file must therefore be both
    // byte-identical AND mtime-unchanged from what we seeded.
    expect(readFileSync(cfgPath).equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).mtimeMs).toBe(beforeMtime);
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

// Seeds a config in the exact field order that loadConfig() + install()
// would produce, so a subsequent install_() call rewrites it
// byte-for-byte identically. Required by byte-equality assertions: the
// minimal seedInstanceConfig() omits approvalMode, which the merge in
// loadConfig() adds, so a normal seed always changes bytes on the
// installer's unconditional rewrite. This helper matches the merged shape.
function seedFullyFormedInstanceConfig(
  instance: string,
  overrides: { provider: ProviderConfig; approvalMode?: RuntimeConfig["approvalMode"] }
): void {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  const instanceDir = join(stateRoot, "instances", instance);
  mkdirSync(instanceDir, { recursive: true });
  // Key order matches the spread in loadConfig() (defaults then parsed
  // then explicit overrides). defaultConfig key order is:
  //   instance, port, token, provider, workspaceRoot, stateRoot, logRoot, approvalMode
  // JSON.stringify preserves insertion order, so reproduce it here.
  const cfg: RuntimeConfig = {
    instance,
    port: 7400,
    token: "seed-token",
    provider: overrides.provider,
    workspaceRoot: join(instanceDir, "workspace"),
    stateRoot: instanceDir,
    logRoot: join(instanceDir, "logs"),
    approvalMode: overrides.approvalMode ?? "auto"
  };
  writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

function readPersistedConfig(instance: string): RuntimeConfig {
  return JSON.parse(readFileSync(persistedConfigPath(instance), "utf8")) as RuntimeConfig;
}

function persistedConfigPath(instance: string): string {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  return join(stateRoot, "instances", instance, "config.json");
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
