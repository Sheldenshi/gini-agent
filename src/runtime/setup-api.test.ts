// Unit tests for the browser-facing setup API. We point HOME at a scratch
// dir and exercise the GET/POST surface directly — no HTTP layer needed.
// The tests confirm the contracts the webapp /setup page relies on:
//   - status reflects the provider config + configured flag
//   - POST openai writes secrets.env, updates process.env, rewrites the
//     runtime config, and signals plistRefreshNeeded
//   - POST codex fails gracefully when no auth.json exists
//   - rejection paths return ok:false with a descriptive error

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetupStatus, setSetupProvider } from "./setup-api";
import { loadConfig } from "../paths";
import type { RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function scratch(): { home: string; stateRoot: string; cleanup: () => void } {
  const root = `/tmp/gini-setup-api-tests/${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const stateRoot = join(home, ".gini");
  return {
    home,
    stateRoot,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("setup-api", () => {
  let env: {
    HOME?: string;
    GINI_STATE_ROOT?: string;
    OPENAI_API_KEY?: string;
    CODEX_AUTH_JSON?: string;
    GINI_PROVIDER?: string;
    GINI_MODEL?: string;
  };
  let s: ReturnType<typeof scratch>;
  let config: RuntimeConfig;

  let prevSkipRefresh: string | undefined;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
      GINI_PROVIDER: process.env.GINI_PROVIDER,
      GINI_MODEL: process.env.GINI_MODEL
    };
    s = scratch();
    process.env.HOME = s.home;
    process.env.GINI_STATE_ROOT = s.stateRoot;
    delete process.env.OPENAI_API_KEY;
    // Scrub provider/model env so the test's assertions about the
    // platform default ("codex"/gpt-5.5) are not skewed by an ambient
    // GINI_PROVIDER=echo or similar in the caller's shell.
    delete process.env.GINI_PROVIDER;
    delete process.env.GINI_MODEL;
    // Point CODEX_AUTH_JSON at a non-existent scratch path so the codex
    // credential probe in providerHealth() resolves into the test
    // sandbox instead of falling back to ~/.codex/auth.json on the
    // developer machine. node:os homedir() is initialized once at
    // process start in Bun and ignores later mutations to process.env.HOME,
    // so overriding HOME in beforeEach is NOT enough on a dev machine
    // with a real ~/.codex/auth.json — the resolved path would still
    // be the real one and providerConfigured would flip true.
    process.env.CODEX_AUTH_JSON = join(s.stateRoot, "nonexistent-codex-auth.json");
    // Prevent the setSetupProvider path from spawning a real detached
    // `gini autostart enable` subprocess during tests — the production
    // path schedules one to refresh the launchd plist's EnvironmentVariables,
    // but tests assert the contract without firing a real refresh.
    prevSkipRefresh = process.env.GINI_SKIP_PLIST_REFRESH;
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    config = loadConfig(`setup-api-${tag()}`);
  });

  afterEach(() => {
    if (env.HOME === undefined) delete process.env.HOME; else process.env.HOME = env.HOME;
    if (env.GINI_STATE_ROOT === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = env.GINI_STATE_ROOT;
    if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (env.CODEX_AUTH_JSON === undefined) delete process.env.CODEX_AUTH_JSON;
    else process.env.CODEX_AUTH_JSON = env.CODEX_AUTH_JSON;
    if (env.GINI_PROVIDER === undefined) delete process.env.GINI_PROVIDER;
    else process.env.GINI_PROVIDER = env.GINI_PROVIDER;
    if (env.GINI_MODEL === undefined) delete process.env.GINI_MODEL;
    else process.env.GINI_MODEL = env.GINI_MODEL;
    if (prevSkipRefresh === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
    else process.env.GINI_SKIP_PLIST_REFRESH = prevSkipRefresh;
    s.cleanup();
  });

  test("status: providerConfigured reflects the codex platform default on a fresh instance", () => {
    const status = getSetupStatus(config);
    expect(status.ok).toBe(true);
    expect(status.providers).toEqual(["openai", "codex", "openrouter", "deepseek", "local"]);
    // Platform default is "codex". providerHealth treats codex as
    // configured when the runtime can find an auth.json; in this
    // scratch env there is none (CODEX_AUTH_JSON is scrubbed in
    // beforeEach), so providerConfigured is false and the browser
    // /setup gate still asks the user to finish onboarding.
    expect(status.current).toBe("codex");
    expect(status.providerConfigured).toBe(false);
  });

  test("POST openai with apiKey writes secrets.env, sets process.env, updates config", async () => {
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test-abcd1234" });
    expect(result.ok).toBe(true);
    // plistRefreshNeeded only flips true when a gateway plist exists for
    // this instance — we don't write one in tests. The dedicated
    // "plist already exists" test below covers that branch.
    expect(result.plistRefreshNeeded).toBe(false);
    // secrets.env wrote the key (shell-escaped form).
    const secretsPath = join(s.home, ".gini", "secrets.env");
    expect(existsSync(secretsPath)).toBe(true);
    const body = readFileSync(secretsPath, "utf8");
    expect(body).toContain("OPENAI_API_KEY=");
    expect(body).toContain("sk-test-abcd1234");
    // process.env is hot — the running gateway picks this up on its next
    // provider call without a restart.
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-abcd1234");
    // Config got rewritten with provider name=openai.
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(cfg.provider?.name).toBe("openai");
    // Re-checking status now reports configured.
    const status = getSetupStatus(config);
    expect(status.providerConfigured).toBe(true);
    expect(status.current).toBe("openai");
  });

  test("POST openai without apiKey returns ok:false", async () => {
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("apiKey is required");
  });

  test("POST codex fails when no auth.json exists", async () => {
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Codex credentials not found");
  });

  test("POST codex succeeds when ~/.codex/auth.json is present and parseable", async () => {
    const codexDir = join(s.home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    // Both codex paths (the codexAuthPath resolution in provider.ts and the
    // gate in setSetupProvider) must agree on what CODEX_AUTH_JSON points
    // at. beforeEach scrubs it to a non-existent sandbox file so the dev
    // machine's real ~/.codex/auth.json doesn't leak in; point it at the
    // test fixture we just wrote so both helpers resolve to the same path.
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(result.plistRefreshNeeded).toBe(false);
    // Pins the helper-divergence regression: a previous version of
    // hasCodexAuth treated CODEX_AUTH_JSON as raw JSON and silently fell
    // back to ~/.codex/auth.json, so result.ok was true for the wrong
    // reason and the embedded provider record reported configured=false.
    expect(result.provider.configured).toBe(true);
    expect(result.provider.provider.name).toBe("codex");
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(cfg.provider?.name).toBe("codex");
  });

  test("POST codex succeeds during openai→codex switch even when OPENAI_API_KEY is set", async () => {
    // Pins a one-directional false negative: codexAuthPath() used to
    // honor provider.apiKeyEnv unconditionally. During an openai→codex
    // switch the on-disk config still names openai with
    // apiKeyEnv="OPENAI_API_KEY". With OPENAI_API_KEY=sk-... in env,
    // codexAuthPath would resolve to the literal sk-... string, miss
    // ~/.codex/auth.json, and report no codex credentials. The fix
    // ignores apiKeyEnv whenever the probed provider is not codex.
    const codexDir = join(s.home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-auth" }));
    process.env.CODEX_AUTH_JSON = authPath;
    // Seed an openai config with the stale apiKeyEnv that triggers the bug.
    config.provider = { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" };
    process.env.OPENAI_API_KEY = "sk-fake-openai";
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(result.provider.configured).toBe(true);
    expect(result.provider.provider.name).toBe("codex");
  });

  test("POST unknown provider rejects with descriptive error", async () => {
    const result = await setSetupProvider(config, { provider: "anthropic" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported provider");
  });

  test("plistRefreshNeeded:true when an autostart plist already exists (macOS only)", async () => {
    if (process.platform !== "darwin") {
      // Linux: function returns false regardless.
      const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test" });
      expect(result.plistRefreshNeeded).toBe(false);
      return;
    }
    // Create a fake plist file at the path the function probes. It's in
    // the real $HOME (not the scratch home) because setup-api reads
    // process.env.HOME, which is overridden in beforeEach.
    const home = s.home;
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    const gatewayPlist = join(launchAgents, `ai.lilaclabs.gini.${config.instance}.gateway.plist`);
    writeFileSync(gatewayPlist, "<?xml version=\"1.0\"?>\n");
    try {
      const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test" });
      expect(result.ok).toBe(true);
      expect(result.plistRefreshNeeded).toBe(true);
    } finally {
      rmSync(gatewayPlist, { force: true });
    }
  });

  test("POST openai chmods existing secrets.env to 0600 even if it was 0644", async () => {
    // Reproduces MEDIUM-8: writeFileSync's `mode` option only applies on
    // file creation. If secrets.env pre-existed with 0644 (hand-edited or
    // restored from a backup), the write would leave it world-readable.
    const secretsPath = join(s.home, ".gini", "secrets.env");
    mkdirSync(join(s.home, ".gini"), { recursive: true });
    writeFileSync(secretsPath, "# stale\n");
    chmodSync(secretsPath, 0o644);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o644);
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-mode-test" });
    expect(result.ok).toBe(true);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  test("re-POSTing openai overwrites the previous key in secrets.env (no duplicate lines)", async () => {
    await setSetupProvider(config, { provider: "openai", apiKey: "sk-first" });
    await setSetupProvider(config, { provider: "openai", apiKey: "sk-second" });
    const secretsPath = join(s.home, ".gini", "secrets.env");
    const body = readFileSync(secretsPath, "utf8");
    const lines = body.split("\n").filter((l) => l.includes("OPENAI_API_KEY="));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("sk-second");
    expect(process.env.OPENAI_API_KEY).toBe("sk-second");
  });

  test("POST openai preserves an existing promptCacheRetention from disk", async () => {
    // The web setup form has no UI for `promptCacheRetention`, so a
    // model swap or apiKey rotation via the setup screen must not
    // silently strip the field. Seed the persisted config with a "24h"
    // bucket, then POST a model change with no retention in the
    // payload; assert the field survives the rewrite. This is the
    // ZDR-relevant carry-forward contract — silently flipping an
    // operator off "24h" on an unrelated save would invalidate their
    // documented data-retention posture without explicit action.
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const seeded = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    seeded.provider = { name: "openai", model: "gpt-5.5", promptCacheRetention: "24h" };
    writeFileSync(cfgPath, `${JSON.stringify(seeded, null, 2)}\n`);
    config.provider = seeded.provider;
    const result = await setSetupProvider(config, { provider: "openai", model: "gpt-5.4", apiKey: "sk-preserve" });
    expect(result.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider?.name).toBe("openai");
    expect(persisted.provider?.model).toBe("gpt-5.4");
    expect(persisted.provider?.promptCacheRetention).toBe("24h");
  });

  test("POST openai with disk-cleared promptCacheRetention does not resurrect from in-memory snapshot", async () => {
    // Disk is authoritative when readable: a successful disk read
    // returns whatever's there, including undefined. So if an operator
    // deliberately cleared the field on disk (via `gini provider set
    // --prompt-cache-retention ""` from another terminal) while the
    // gateway still has "24h" in its boot-time snapshot, the UI save
    // must NOT resurrect "24h" from in-memory. Pin that contract here
    // so a future fallback-widening to "use in-memory whenever it's
    // set" doesn't quietly reintroduce the clear-resurrection bug.
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const seeded = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    seeded.provider = { name: "openai", model: "gpt-5.5" };
    writeFileSync(cfgPath, `${JSON.stringify(seeded, null, 2)}\n`);
    // In-memory snapshot still has the stale "24h" the operator just
    // cleared on disk from another process.
    config.provider = { name: "openai", model: "gpt-5.5", promptCacheRetention: "24h" };
    const result = await setSetupProvider(config, { provider: "openai", model: "gpt-5.5", apiKey: "sk-clear" });
    expect(result.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider?.promptCacheRetention).toBeUndefined();
  });
});
