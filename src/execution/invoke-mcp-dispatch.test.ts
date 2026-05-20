// Tests for the invoke_mcp dispatch surface. Exercises tool
// registration, the approval-gate path under approvalMode=strict, and
// the validation errors for missing/invalid serverId / toolName.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { createTask, mutateState, readState, upsertTask } from "../state";
import { addMcpServer } from "../integrations/mcp";
import { riskForTool } from "./tool-risk";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-invoke-mcp-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string, approvalMode: "strict" | "auto" = "strict"): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`,
    approvalMode
  };
}

async function seedTask(config: RuntimeConfig): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, "test");
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

describe("invoke_mcp registration", () => {
  test("registers under toolset 'mcp' and requires serverId+toolName", () => {
    const ts: ToolsetRecord = {
      id: "toolset_mcp",
      instance: "test",
      name: "mcp",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "invoke_mcp");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("mcp");
    expect(tool?.function.parameters.required).toEqual(["serverId", "toolName"]);
  });

  test("invoke_mcp is classified high-risk via the substring heuristic", () => {
    expect(riskForTool("invoke_mcp")).toBe("high");
  });
});

describe("invoke_mcp dispatch", () => {
  test("creates a pending approval in strict mode", async () => {
    const config = makeConfig("invoke-mcp-strict", "strict");
    const server = await addMcpServer(config, {
      name: "test-mcp",
      command: "/bin/echo",
      args: [],
      exposedTools: ["do_thing"]
    });
    // The MCP server's default status is "configured" after add. Force
    // it explicitly so we don't depend on the addMcpServer side-effect
    // ordering.
    await mutateState(config.instance, (state) => {
      const live = state.mcpServers.find((s) => s.id === server.id);
      if (live) live.status = "configured";
    });
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "invoke_mcp",
      "call_invoke_strict",
      JSON.stringify({ serverId: server.id, toolName: "do_thing", input: { foo: 1 } })
    );
    expect(result.kind).toBe("pending");

    const approvals = readState(config.instance).approvals;
    const pending = approvals.find((a) => a.action === "mcp.invoke" && a.status === "pending");
    expect(pending).toBeDefined();
    expect(pending?.target).toBe(server.id);
    expect(pending?.payload.toolName).toBe("do_thing");
    expect(pending?.payload.toolCallId).toBe("call_invoke_strict");
    expect(pending?.payload.input).toEqual({ foo: 1 });
  });

  test("rejects missing serverId", async () => {
    const config = makeConfig("invoke-mcp-no-server", "strict");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "invoke_mcp", "call_no_s", JSON.stringify({ toolName: "x" }))
    ).rejects.toThrow(/serverId/);
  });

  test("rejects missing toolName", async () => {
    const config = makeConfig("invoke-mcp-no-tool", "strict");
    const server = await addMcpServer(config, {
      name: "test-mcp",
      command: "/bin/echo",
      args: []
    });
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "invoke_mcp",
        "call_no_t",
        JSON.stringify({ serverId: server.id })
      )
    ).rejects.toThrow(/toolName/);
  });

  test("rejects unknown server", async () => {
    const config = makeConfig("invoke-mcp-bad-server", "strict");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "invoke_mcp",
        "call_bad_s",
        JSON.stringify({ serverId: "mcp_nope", toolName: "any" })
      )
    ).rejects.toThrow(/MCP server not found/);
  });

  test("rejects tool name outside exposedTools whitelist", async () => {
    const config = makeConfig("invoke-mcp-not-exposed", "strict");
    const server = await addMcpServer(config, {
      name: "test-mcp",
      command: "/bin/echo",
      args: [],
      exposedTools: ["only_this"]
    });
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "invoke_mcp",
        "call_bad_tn",
        JSON.stringify({ serverId: server.id, toolName: "other" })
      )
    ).rejects.toThrow(/MCP tool is not exposed/);
  });
});
