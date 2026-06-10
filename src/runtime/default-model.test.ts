// Tests for the default-model write path (src/runtime/default-model.ts).
// The contract under test: a successful save updates BOTH the instance
// provider (config.provider, persisted to config.json) and agent_default's
// provider/model override — the override is what the default chat resolves
// through, so writing only the config would leave chats on the old model.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setDefaultModel } from "./default-model";
import { install } from "./index";
import { loadConfig } from "../paths";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

describe("setDefaultModel", () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let config: RuntimeConfig;

  beforeEach(async () => {
    root = `/tmp/gini-default-model-tests/${tag()}`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      GINI_LOG_ROOT: process.env.GINI_LOG_ROOT,
      GINI_PROVIDER: process.env.GINI_PROVIDER,
      GINI_MODEL: process.env.GINI_MODEL,
      CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GINI_SKIP_PLIST_REFRESH: process.env.GINI_SKIP_PLIST_REFRESH
    };
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
    process.env.GINI_STATE_ROOT = join(root, "state");
    process.env.GINI_LOG_ROOT = join(root, "logs");
    delete process.env.GINI_PROVIDER;
    delete process.env.GINI_MODEL;
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    // Point codex auth at a real scratch file so the codex branch counts as
    // configured without touching the developer's ~/.codex/auth.json.
    const codexAuth = join(root, "codex-auth.json");
    writeFileSync(codexAuth, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "test-token", account_id: "acct" } }));
    process.env.CODEX_AUTH_JSON = codexAuth;
    delete process.env.OPENAI_API_KEY;
    config = loadConfig(`default-model-${tag()}`);
    // install() creates state.json and seeds agent_default from
    // config.provider (codex platform default).
    await install(config);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("updates config.provider AND agent_default's override", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const result = await setDefaultModel(config, { provider: "openai", model: "gpt-5.4" });
    expect(result.ok).toBe(true);

    // Instance layer: persisted config carries the new pair.
    expect(config.provider.name).toBe("openai");
    expect(config.provider.model).toBe("gpt-5.4");
    const persisted = loadConfig(config.instance);
    expect(persisted.provider.name).toBe("openai");
    expect(persisted.provider.model).toBe("gpt-5.4");

    // Agent layer: the default agent's override mirrors it, so the default
    // chat (which resolves through the override) actually moves.
    const agent = readState(config.instance).agents.find((a) => a.id === "agent_default");
    expect(agent?.providerName).toBe("openai");
    expect(agent?.model).toBe("gpt-5.4");
  });

  test("a blank model resolves to the provider default and the resolved value lands on the agent", async () => {
    const result = await setDefaultModel(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    // setSetupProvider keeps the existing codex model (the platform default)
    // when none is supplied; the agent mirror must carry the RESOLVED model,
    // never an empty string (setAgentProvider rejects half-set pairs).
    expect(config.provider.model).not.toBe("");
    const agent = readState(config.instance).agents.find((a) => a.id === "agent_default");
    expect(agent?.providerName).toBe("codex");
    expect(agent?.model).toBe(config.provider.model);
  });

  test("a failed provider save leaves agent_default untouched", async () => {
    const before = readState(config.instance).agents.find((a) => a.id === "agent_default");
    // openai without a key (and no stored key) is rejected by setSetupProvider.
    const result = await setDefaultModel(config, { provider: "openai", model: "gpt-5.4" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("apiKey is required");
    const after = readState(config.instance).agents.find((a) => a.id === "agent_default");
    expect(after?.providerName).toBe(before?.providerName);
    expect(after?.model).toBe(before?.model);
  });

  test("pins override-less agents to the previous default and leaves pinned agents untouched", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    await mutateState(config.instance, (state) => {
      // An agent without an override resolves through config.provider live;
      // one with an override is already a snapshot.
      state.agents.push({
        id: "agent_following",
        instance: config.instance,
        name: "Following",
        status: "active",
        toolsets: [],
        messagingTargets: [],
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z"
      });
      state.agents.push({
        id: "agent_pinned",
        instance: config.instance,
        name: "Pinned",
        status: "active",
        providerName: "bedrock",
        model: "us.amazon.nova-pro-v1:0",
        toolsets: [],
        messagingTargets: [],
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z"
      });
    });

    const result = await setDefaultModel(config, { provider: "openai", model: "gpt-5.4" });
    expect(result.ok).toBe(true);
    const agents = readState(config.instance).agents;
    // The follower keeps the model it was actually using — the PREVIOUS
    // default (codex platform default), pinned, not the new one.
    const following = agents.find((a) => a.id === "agent_following");
    expect(following?.providerName).toBe("codex");
    expect(following?.model).toBe("gpt-5.5");
    // An existing pin is never rewritten.
    const pinned = agents.find((a) => a.id === "agent_pinned");
    expect(pinned?.providerName).toBe("bedrock");
    expect(pinned?.model).toBe("us.amazon.nova-pro-v1:0");
    // The default agent mirrors the new pair.
    const defaultAgent = agents.find((a) => a.id === "agent_default");
    expect(defaultAgent?.providerName).toBe("openai");
    expect(defaultAgent?.model).toBe("gpt-5.4");
  });

  test("mirrors onto the legacy profile_default id when the instance pre-dates the rename", async () => {
    await mutateState(config.instance, (state) => {
      const agent = state.agents.find((a) => a.id === "agent_default");
      if (!agent) throw new Error("default agent missing after install");
      agent.id = "profile_default";
      state.activeAgentId = "profile_default";
    });
    const result = await setDefaultModel(config, { provider: "codex", model: "gpt-5.5" });
    expect(result.ok).toBe(true);
    const agent = readState(config.instance).agents.find((a) => a.id === "profile_default");
    expect(agent?.providerName).toBe("codex");
    expect(agent?.model).toBe("gpt-5.5");
  });

  test("succeeds with no default agent row — config alone drives the fallback", async () => {
    await mutateState(config.instance, (state) => {
      state.agents = state.agents.filter((a) => a.id !== "agent_default" && a.id !== "profile_default");
    });
    const result = await setDefaultModel(config, { provider: "codex", model: "gpt-5.5" });
    expect(result.ok).toBe(true);
    expect(loadConfig(config.instance).provider.model).toBe("gpt-5.5");
  });

  test("rejects an unsupported provider", async () => {
    const result = await setDefaultModel(config, { provider: "echo", model: "gini-echo-v0" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported provider");
  });

  test("ignores credential/transport fields smuggled into the payload", async () => {
    // The endpoint is selection-only: an apiKey in the body must not be
    // written anywhere. Without a key (and none stored) the openai save
    // fails — proof the smuggled key was dropped rather than applied.
    const result = await setDefaultModel(config, {
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "sk-smuggled"
    });
    expect(result.ok).toBe(false);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
