// Unit tests for the memory-tool dispatch surface:
//   - `recall_memory` (read-only on-demand recall)
//   - `add_memory` (proposed by default)
//   - `update_memory` (edit in place)
//
// We seed the SQLite memory store with a few hand-crafted units to exercise
// the recall path, and exercise the legacy MemoryRecord CRUD path for add /
// update.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import {
  bankIdForAgent,
  closeAllMemoryDbs,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  createTask,
  mutateState,
  readState,
  upsertTask
} from "../state";
import { echoEmbed } from "../embeddings";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-memory-dispatch-test";
const TEST_AGENT = "agent_test";
const TEST_BANK = bankIdForAgent(TEST_AGENT);

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  process.env.GINI_RERANKER_PROVIDER = "none";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// Seed an active agent so resolveEffectiveContext returns one — the
// legacy memory CRUD path refuses to write when no agent is active.
async function seedAgent(config: RuntimeConfig): Promise<void> {
  await mutateState(config.instance, (state) => {
    if (!state.agents.find((a) => a.id === TEST_AGENT)) {
      state.agents.push({
        id: TEST_AGENT,
        instance: state.instance,
        name: "test",
        providerName: "echo",
        model: "gini-echo-v0",
        toolsets: [],
        messagingTargets: [],
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    }
    state.activeAgentId = TEST_AGENT;
  });
}

async function seedTask(config: RuntimeConfig): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined, TEST_AGENT);
    upsertTask(state, task);
    return task.id;
  });
}

function stateWithToolsets(toolsets: ToolsetRecord[]): RuntimeState {
  return {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [], approvals: [], audit: [], memories: [], skills: [], jobs: [],
    connectors: [], improvements: [], pairingCodes: [], devices: [],
    promotions: [], snapshots: [], tools: [], toolsets, subagents: [],
    mcpServers: [], messagingBridges: [], importReports: [], agents: [],
    activeAgentId: undefined, relays: [], notifications: [], events: [],
    jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
    runs: [], planSteps: []
  };
}

describe("memory tool registration", () => {
  test("recall_memory registers with toolset 'memory' and requires query", () => {
    const ts: ToolsetRecord = {
      id: "toolset_memory",
      instance: "test",
      name: "memory",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "recall_memory");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("memory");
    expect(tool?.function.parameters.required).toEqual(["query"]);
  });

  test("add_memory registers with toolset 'memory' and requires content", () => {
    const ts: ToolsetRecord = {
      id: "toolset_memory",
      instance: "test",
      name: "memory",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "add_memory");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("memory");
    expect(tool?.function.parameters.required).toEqual(["content"]);
  });

  test("update_memory registers with toolset 'memory' and requires memoryId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_memory",
      instance: "test",
      name: "memory",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "update_memory");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("memory");
    expect(tool?.function.parameters.required).toEqual(["memoryId"]);
  });
});

describe("recall_memory dispatch", () => {
  test("returns a compact JSON summary with seeded units", async () => {
    const instance = "memory-recall-happy";
    const config = makeConfig(instance);
    await seedAgent(config);
    ensureDefaultBank(instance);
    ensureAgentBank(instance, TEST_AGENT);
    const target = insertMemoryUnit(instance, {
      bankId: TEST_BANK,
      agentId: TEST_AGENT,
      text: "alpha bravo charlie delta echo",
      embedding: echoEmbed("alpha bravo charlie delta echo"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "recall_memory",
      "call_recall",
      JSON.stringify({ query: "alpha bravo charlie delta echo" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as {
        units: number;
        totalTokens: number;
        excerpts: Array<{ id: string; content: string; score: number }>;
      };
      expect(parsed.units).toBeGreaterThan(0);
      const excerpt = parsed.excerpts.find((e) => e.id === target.id);
      expect(excerpt).toBeDefined();
    }

    // Audit row pinned to the recall.
    const audit = readState(instance).audit.find((event) => event.action === "memory.recalled");
    expect(audit).toBeDefined();
  });

  test("rejects empty query", async () => {
    const instance = "memory-recall-empty";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "recall_memory", "call_recall_empty", JSON.stringify({}))
    ).rejects.toThrow(/query/);
  });
});

describe("add_memory dispatch", () => {
  test("writes a proposed-status memory and emits memory.added audit", async () => {
    const instance = "memory-add-happy";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "add_memory",
      "call_add",
      JSON.stringify({ content: "User prefers dark mode." })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Proposed memory mem_/);
      expect(result.result).toMatch(/status: proposed/);
    }

    const state = readState(instance);
    const memory = state.memories.find((m) => m.content === "User prefers dark mode.");
    expect(memory).toBeDefined();
    expect(memory?.status).toBe("proposed");

    const audit = state.audit.find((event) => event.action === "memory.added" && event.actor === "agent");
    expect(audit).toBeDefined();
    expect(audit?.evidence?.memoryId).toBe(memory?.id);
    expect(audit?.evidence?.status).toBe("proposed");
  });

  test("ignores caller-supplied status override (always proposed)", async () => {
    const instance = "memory-add-override";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "add_memory",
      "call_add_override",
      JSON.stringify({ content: "Sneaky fact", status: "active" })
    );
    expect(result.kind).toBe("sync");

    const memory = readState(instance).memories.find((m) => m.content === "Sneaky fact");
    expect(memory?.status).toBe("proposed");
  });

  test("rejects missing content", async () => {
    const instance = "memory-add-bad";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "add_memory", "call_add_bad", JSON.stringify({}))
    ).rejects.toThrow(/content/);
  });
});

describe("update_memory dispatch", () => {
  test("edits content and emits the canonical memory.edited audit", async () => {
    const instance = "memory-update-happy";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    // Seed an existing memory via the dispatch path.
    const addRes = await dispatchToolCall(
      config,
      taskId,
      "add_memory",
      "call_add_for_update",
      JSON.stringify({ content: "Original content" })
    );
    expect(addRes.kind).toBe("sync");
    const memoryBefore = readState(instance).memories.find((m) => m.content === "Original content");
    expect(memoryBefore).toBeDefined();

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_memory",
      "call_update",
      JSON.stringify({ memoryId: memoryBefore!.id, content: "Updated content" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(new RegExp(memoryBefore!.id));
      expect(result.result).toMatch(/content/);
    }

    const memoryAfter = readState(instance).memories.find((m) => m.id === memoryBefore!.id);
    expect(memoryAfter?.content).toBe("Updated content");

    // editMemory writes the canonical row (actor=user, risk=medium). The
    // update_memory tool wrapper does NOT layer a second agent-attributed
    // row — the medium-risk row is the safeguard; a low-risk agent row
    // would just obscure it. Pin both: at least one canonical row exists,
    // and no agent-attributed `memory.edited` row exists for this target.
    const audits = readState(instance).audit.filter(
      (event) => event.action === "memory.edited" && event.target === memoryBefore!.id
    );
    expect(audits.length).toBeGreaterThan(0);
    const canonical = audits.find((event) => event.actor === "user" && event.risk === "medium");
    expect(canonical).toBeDefined();
    const agentDuplicate = audits.find((event) => event.actor === "agent");
    expect(agentDuplicate).toBeUndefined();
  });

  test("rejects missing memoryId", async () => {
    const instance = "memory-update-no-id";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_memory",
        "call_update_no_id",
        JSON.stringify({ content: "x" })
      )
    ).rejects.toThrow(/memoryId/);
  });

  test("rejects empty patch", async () => {
    const instance = "memory-update-empty";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_memory",
        "call_update_empty",
        JSON.stringify({ memoryId: "mem_nope" })
      )
    ).rejects.toThrow(/at least one field/);
  });

  test("surfaces error for unknown memoryId", async () => {
    const instance = "memory-update-missing";
    const config = makeConfig(instance);
    await seedAgent(config);
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_memory",
        "call_update_missing",
        JSON.stringify({ memoryId: "mem_nope", content: "x" })
      )
    ).rejects.toThrow(/Memory not found/);
  });
});
