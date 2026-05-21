// Tests for src/capabilities/agents.ts. The hot spot is createAgent: it
// must inherit provider/toolsets/etc from the default agent when the
// caller (e.g. the CLI) doesn't pass them — but it must NOT copy memory
// or hindsight content. Agents start with an empty pool.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, useAgent } from "./agents";
import { install } from "../runtime";
import {
  bankIdForAgent,
  ensureAgentBank,
  getBank,
  insertMemoryUnit,
  listMemoryUnits,
  mutateState,
  readState
} from "../state";
import type { RuntimeConfig } from "../types";

function buildConfig(workspaceRoot: string, instance: string, stateRoot: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "codex", model: "gpt-5.5" },
    workspaceRoot,
    stateRoot,
    logRoot: `${stateRoot}-logs`
  };
}

describe("createAgent", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-create-agent-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-create-agent-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("inherits provider/model from the default agent when caller omits them", async () => {
    const config = buildConfig(workspaceRoot, "create-agent-inherit", root);
    install(config);
    // install() seeds the default agent from config.provider, but does so
    // via a fire-and-forget mutateState. Wait for it to settle so the
    // inheritance read sees the seeded value rather than the undefined
    // pre-seed state.
    await mutateState(config.instance, (state) => {
      const defaultAgent = state.agents.find((agent) => agent.id === "agent_default");
      if (!defaultAgent) throw new Error("default agent missing after install");
      // Belt-and-braces: force the seeded values in case the install()
      // seed hasn't landed in this state snapshot.
      defaultAgent.providerName = "codex";
      defaultAgent.model = "gpt-5.5";
      defaultAgent.toolsets = ["file", "terminal"];
      defaultAgent.messagingTargets = ["local"];
      return defaultAgent;
    });

    const created = await createAgent(config, { name: "inherited" });
    expect(created.providerName).toBe("codex");
    expect(created.model).toBe("gpt-5.5");
    // Inherits the default agent's existing toolsets and also unions in
    // the current desired defaults so a sibling created on an old instance
    // (whose default-agent toolsets pre-date a new addition like `browser`)
    // doesn't silently miss the new tool family.
    expect(created.toolsets).toContain("file");
    expect(created.toolsets).toContain("terminal");
    expect(created.toolsets).toContain("memory");
    expect(created.toolsets).toContain("session_search");
    expect(created.toolsets).toContain("delegation");
    expect(created.toolsets).toContain("browser");
    expect(created.messagingTargets).toEqual(["local"]);
  });

  test("explicit overrides win over default-agent inheritance", async () => {
    const config = buildConfig(workspaceRoot, "create-agent-override", root);
    install(config);
    await mutateState(config.instance, (state) => {
      const defaultAgent = state.agents.find((agent) => agent.id === "agent_default");
      if (!defaultAgent) throw new Error("default agent missing after install");
      defaultAgent.providerName = "codex";
      defaultAgent.model = "gpt-5.5";
      defaultAgent.toolsets = ["file"];
      return defaultAgent;
    });

    const created = await createAgent(config, {
      name: "overridden",
      providerName: "openai",
      model: "gpt-4o",
      toolsets: ["terminal"]
    });
    expect(created.providerName).toBe("openai");
    expect(created.model).toBe("gpt-4o");
    expect(created.toolsets).toEqual(["terminal"]);
  });

  test("deleteAgent removes the agent, its memories, and its hindsight bank", async () => {
    const config = buildConfig(workspaceRoot, "delete-agent-cascade", root);
    install(config);

    const created = await createAgent(config, { name: "scratch" });
    // Bank already created by createAgent → ensureAgentBank. Stamp a
    // hindsight unit and a legacy MemoryRecord onto the new agent so the
    // cascade has something concrete to clean up.
    ensureAgentBank(config.instance, created.id);
    insertMemoryUnit(config.instance, {
      bankId: bankIdForAgent(created.id),
      agentId: created.id,
      text: "scratch hindsight",
      network: "experience"
    });
    await mutateState(config.instance, (state) => {
      state.memories.push({
        id: "mem_scratch_only",
        instance: config.instance,
        agentId: created.id,
        content: "scratch memory",
        status: "active",
        sensitivity: "normal",
        confidence: 1,
        provenance: "test fixture",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01"
      });
      return null;
    });

    const result = await deleteAgent(config, created.id);
    expect(result.ok).toBe(true);
    expect(result.id).toBe(created.id);
    expect(result.memoriesArchived).toBe(1);
    expect(result.unitsDeleted).toBe(1);
    expect(result.bankDeleted).toBe(true);

    const after = readState(config.instance);
    expect(after.agents.find((agent) => agent.id === created.id)).toBeUndefined();
    expect(after.memories.find((memory) => memory.id === "mem_scratch_only")).toBeUndefined();
    expect(getBank(config.instance, bankIdForAgent(created.id))).toBeNull();
    expect(listMemoryUnits(config.instance, bankIdForAgent(created.id))).toEqual([]);
    expect(after.audit.some((event) => event.action === "agent.deleted" && event.target === created.id)).toBe(true);
  });

  test("deleteAgent resolves by name", async () => {
    const config = buildConfig(workspaceRoot, "delete-agent-by-name", root);
    install(config);
    const created = await createAgent(config, { name: "by-name" });
    const result = await deleteAgent(config, "by-name");
    expect(result.id).toBe(created.id);
    const after = readState(config.instance);
    expect(after.agents.find((agent) => agent.name === "by-name")).toBeUndefined();
  });

  test("deleteAgent refuses to delete the default agent", async () => {
    const config = buildConfig(workspaceRoot, "delete-agent-default", root);
    install(config);
    await expect(deleteAgent(config, "agent_default")).rejects.toThrow(
      "Cannot delete the default agent."
    );
  });

  test("deleteAgent refuses to delete the active agent", async () => {
    const config = buildConfig(workspaceRoot, "delete-agent-active", root);
    install(config);
    const created = await createAgent(config, { name: "active-one" });
    await useAgent(config, created.id);
    await expect(deleteAgent(config, created.id)).rejects.toThrow(
      "Cannot delete the active agent; switch to another agent first."
    );
  });

  test("deleteAgent throws when the agent does not exist", async () => {
    const config = buildConfig(workspaceRoot, "delete-agent-missing", root);
    install(config);
    await expect(deleteAgent(config, "agent_does_not_exist")).rejects.toThrow(
      "Agent not found: agent_does_not_exist"
    );
  });

  test("does not copy memories from the default agent (clean memory)", async () => {
    const config = buildConfig(workspaceRoot, "create-agent-clean-memory", root);
    install(config);
    // Stamp a memory on the default agent.
    await mutateState(config.instance, (state) => {
      const defaultAgent = state.agents.find((agent) => agent.id === "agent_default");
      if (!defaultAgent) throw new Error("default agent missing after install");
      state.memories.push({
        id: "mem_default_only",
        instance: config.instance,
        agentId: defaultAgent.id,
        content: "should not leak",
        status: "active",
        sensitivity: "normal",
        confidence: 1,
        provenance: "test fixture",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01"
      });
      return defaultAgent;
    });

    const created = await createAgent(config, { name: "fresh" });
    const after = readState(config.instance);
    const ownedByNewAgent = after.memories.filter((memory) => memory.agentId === created.id);
    expect(ownedByNewAgent).toEqual([]);
    // And the original memory on the default agent stays put.
    const ownedByDefault = after.memories.filter((memory) => memory.id === "mem_default_only");
    expect(ownedByDefault.length).toBe(1);
  });
});
