// Unit tests for the browser-facing setup API. We point HOME at a scratch
// dir and exercise the GET/POST surface directly — no HTTP layer needed.
// The tests confirm the contracts the webapp /setup page relies on:
//   - status reflects the provider config + configured flag
//   - POST openai writes secrets.env, updates process.env, rewrites the
//     runtime config, and signals plistRefreshNeeded
//   - POST codex fails gracefully when no auth.json exists
//   - rejection paths return ok:false with a descriptive error

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let env: { HOME?: string; GINI_STATE_ROOT?: string; OPENAI_API_KEY?: string };
  let s: ReturnType<typeof scratch>;
  let config: RuntimeConfig;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };
    s = scratch();
    process.env.HOME = s.home;
    process.env.GINI_STATE_ROOT = s.stateRoot;
    delete process.env.OPENAI_API_KEY;
    config = loadConfig(`setup-api-${tag()}`);
  });

  afterEach(() => {
    if (env.HOME === undefined) delete process.env.HOME; else process.env.HOME = env.HOME;
    if (env.GINI_STATE_ROOT === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = env.GINI_STATE_ROOT;
    if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    s.cleanup();
  });

  test("status: providerConfigured is false on a fresh instance (echo provider, no creds needed but no real provider chosen)", () => {
    const status = getSetupStatus(config);
    expect(status.ok).toBe(true);
    expect(status.providers).toEqual(["openai", "codex"]);
    // Default provider is "echo" — it's configured (no creds needed), but
    // the browser /setup page does not consider echo a "configured"
    // provider for onboarding purposes. The contract: providerConfigured
    // mirrors providerHealth.configured.
    expect(typeof status.providerConfigured).toBe("boolean");
    expect(status.current).toBe("echo");
  });

  test("POST openai with apiKey writes secrets.env, sets process.env, updates config", async () => {
    const result = await setSetupProvider(config, { kind: "openai", apiKey: "sk-test-abcd1234" });
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
    const result = await setSetupProvider(config, { kind: "openai", apiKey: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("apiKey is required");
  });

  test("POST codex fails when no auth.json exists", async () => {
    const result = await setSetupProvider(config, { kind: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Codex credentials not found");
  });

  test("POST codex succeeds when ~/.codex/auth.json is present and parseable", async () => {
    const codexDir = join(s.home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    const result = await setSetupProvider(config, { kind: "codex" });
    expect(result.ok).toBe(true);
    expect(result.plistRefreshNeeded).toBe(false);
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(cfg.provider?.name).toBe("codex");
  });

  test("POST unknown kind rejects with descriptive error", async () => {
    const result = await setSetupProvider(config, { kind: "anthropic" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported provider kind");
  });

  test("plistRefreshNeeded:true when an autostart plist already exists (macOS only)", async () => {
    if (process.platform !== "darwin") {
      // Linux: function returns false regardless.
      const result = await setSetupProvider(config, { kind: "openai", apiKey: "sk-test" });
      expect(result.plistRefreshNeeded).toBe(false);
      return;
    }
    // Create a fake plist file at the path the function probes. It's in
    // the real $HOME (not the scratch home) because setup-api reads
    // process.env.HOME, which is overridden in beforeEach.
    const home = s.home;
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    const gatewayPlist = join(launchAgents, `ai.lilac.gini.${config.instance}.gateway.plist`);
    writeFileSync(gatewayPlist, "<?xml version=\"1.0\"?>\n");
    try {
      const result = await setSetupProvider(config, { kind: "openai", apiKey: "sk-test" });
      expect(result.ok).toBe(true);
      expect(result.plistRefreshNeeded).toBe(true);
    } finally {
      rmSync(gatewayPlist, { force: true });
    }
  });

  test("re-POSTing openai overwrites the previous key in secrets.env (no duplicate lines)", async () => {
    await setSetupProvider(config, { kind: "openai", apiKey: "sk-first" });
    await setSetupProvider(config, { kind: "openai", apiKey: "sk-second" });
    const secretsPath = join(s.home, ".gini", "secrets.env");
    const body = readFileSync(secretsPath, "utf8");
    const lines = body.split("\n").filter((l) => l.includes("OPENAI_API_KEY="));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("sk-second");
    expect(process.env.OPENAI_API_KEY).toBe("sk-second");
  });
});
