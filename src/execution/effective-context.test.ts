// Unit tests for resolveEffectiveContext. The bundle is purely functional —
// it takes a RuntimeState + RuntimeConfig and returns an EffectiveContext —
// so these tests build state in memory without touching disk.

import { describe, expect, test } from "bun:test";
import { resolveEffectiveContext } from "./effective-context";
import type {
  AgentRecord,
  MessagingBridgeRecord,
  ProviderConfig,
  RuntimeConfig,
  RuntimeState,
  ToolsetRecord
} from "../types";

function buildAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_default",
    instance: "test",
    name: "default",
    status: "active",
    providerName: undefined,
    model: undefined,
    toolsets: [],
    memoryScopes: ["user", "project"],
    messagingTargets: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function buildToolset(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
  return {
    id: `toolset_${name}`,
    instance: "test",
    name,
    description: "",
    status,
    toolNames: [],
    scopes: ["task"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function buildBridge(name: string, deliveryTargets: string[]): MessagingBridgeRecord {
  return {
    id: `bridge_${name}`,
    instance: "test",
    name,
    kind: "demo",
    status: "configured",
    deliveryTargets,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function buildState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const base: RuntimeState = {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [],
    approvals: [],
    audit: [],
    memories: [],
    skills: [],
    jobs: [],
    connectors: [],
    improvements: [],
    pairingCodes: [],
    devices: [],
    promotions: [],
    snapshots: [],
    tools: [],
    toolsets: [],
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    agents: [],
    activeAgentId: undefined,
    relays: [],
    notifications: [],
    events: [],
    jobRuns: [],
    chatSessions: [],
    chatMessages: [],
    messagingMessages: [],
    runs: [],
    planSteps: []
  };
  return { ...base, ...overrides };
}

function buildConfig(provider: ProviderConfig = { name: "echo", model: "gini-echo-v0" }): RuntimeConfig {
  return {
    instance: "test",
    port: 7338,
    token: "test",
    provider,
    workspaceRoot: "/tmp/effective-context-ws",
    stateRoot: "/tmp/effective-context-state",
    logRoot: "/tmp/effective-context-logs"
  };
}

describe("resolveEffectiveContext", () => {
  test("falls back to instance provider when no active agent", () => {
    const state = buildState();
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("instance");
    expect(ctx.provider).toBe(config.provider);
    expect(ctx.toolsetFilter).toBeUndefined();
    expect(ctx.messagingTargetFilter).toBeUndefined();
    expect(ctx.warnings).toEqual([]);
    expect(ctx.agentId).toBeUndefined();
  });

  test("agent provider override wins when both providerName and model are set", () => {
    const agent = buildAgent({ providerName: "openai", model: "gpt-5.4" });
    const state = buildState({ agents: [agent], activeAgentId: agent.id });
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("agent");
    expect(ctx.provider.name).toBe("openai");
    expect(ctx.provider.model).toBe("gpt-5.4");
    expect(ctx.agentId).toBe(agent.id);
  });

  test("agent without providerName falls back to instance provider", () => {
    const agent = buildAgent({ providerName: undefined, model: undefined });
    const state = buildState({ agents: [agent], activeAgentId: agent.id });
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("instance");
    expect(ctx.provider).toBe(config.provider);
  });

  test("agent toolset whitelist intersects with state, warns on unknown", () => {
    const agent = buildAgent({ toolsets: ["file", "unknown_toolset"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("file"), buildToolset("terminal")]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.toolsetFilter).toBeDefined();
    expect(ctx.toolsetFilter?.has("file")).toBe(true);
    // Unknown IDs stay in the filter so a later toolset add transparently
    // takes effect.
    expect(ctx.toolsetFilter?.has("unknown_toolset")).toBe(true);
    expect(ctx.warnings).toContain("agent references unknown toolset 'unknown_toolset'");
  });

  test("agent toolset whitelist warns on disabled", () => {
    const agent = buildAgent({ toolsets: ["mcp"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("mcp", "disabled")]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.toolsetFilter?.has("mcp")).toBe(true);
    expect(ctx.warnings).toContain("agent references disabled toolset 'mcp'");
  });

  test("messaging target whitelist warns on unknown target", () => {
    const agent = buildAgent({ messagingTargets: ["local", "slack"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      messagingBridges: [buildBridge("demo", ["local"])]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.messagingTargetFilter?.has("local")).toBe(true);
    expect(ctx.messagingTargetFilter?.has("slack")).toBe(true);
    expect(ctx.warnings).toContain("agent references unknown messaging target 'slack'");
    // Known target should not surface a warning.
    expect(ctx.warnings).not.toContain("agent references unknown messaging target 'local'");
  });

  test("no warnings when agent fields all resolve cleanly", () => {
    const agent = buildAgent({
      providerName: "openai",
      model: "gpt-5.4",
      toolsets: ["file"],
      messagingTargets: ["local"]
    });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("file")],
      messagingBridges: [buildBridge("demo", ["local"])]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.warnings).toEqual([]);
    expect(ctx.providerSource).toBe("agent");
  });
});
