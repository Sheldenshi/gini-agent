// Unit coverage for the mcp_call branch of dispatchToolCall.
//
// The dispatcher converts a `mcp_call` invocation into an
// invokeMcpTool call. We stub fetch at the HTTP transport so the test
// stays hermetic: no network, no spawned subprocess. The test covers:
//   - happy-path call returns the flattened content string
//   - oversized content is truncated and tagged
//   - unknown server name produces a structured error envelope
//   - missing required args throw before reaching the network

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, createMcpServerRecord, createTask, readState, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";

const ROOT = mkdtempSync(join(tmpdir(), "gini-mcp-dispatch-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  // Build the task directly on state — submitTask would also kick off the
  // chat-task loop, and we only need the row for the dispatcher to
  // attribute audits to.
  const task = createTask(config.instance, "dispatch test");
  await mutateState(config.instance, (state) => {
    upsertTask(state, task);
  });
  return task.id;
}

async function addServer(instance: string, opts: { name: string; url?: string; status?: "configured" | "error" | "disabled" }): Promise<string> {
  const result = await mutateState(instance, (state) => createMcpServerRecord(state, {
    name: opts.name,
    command: "",
    args: [],
    envKeys: [],
    exposedTools: [],
    transport: "http",
    url: opts.url ?? "https://example.test/mcp",
    headers: {}
  }));
  if (opts.status && opts.status !== "configured") {
    await mutateState(instance, (state) => {
      const s = state.mcpServers.find((m) => m.id === result.id);
      if (s) s.status = opts.status!;
    });
  }
  return result.id;
}

function sseResponse(body: object): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}

describe("mcp_call dispatch", () => {
  test("returns flattened text content on happy path", async () => {
    const instance = `mcp-dispatch-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear" });
    const taskId = await newTask(config);
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const id = init?.body ? JSON.parse(String(init.body)).id : 0;
      return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "[{\"id\":\"LIN-1\",\"title\":\"hi\"}]" }] } });
    }) as unknown as typeof fetch;
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "list_issues", arguments: {} }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("LIN-1");
    }
  });

  test("truncates content above 12000 chars", async () => {
    const instance = `mcp-trunc-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear" });
    const taskId = await newTask(config);
    const big = "x".repeat(20_000);
    globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
      const id = init?.body ? JSON.parse(String(init.body)).id : 0;
      return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: big }] } });
    }) as unknown as typeof fetch;
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "list_issues" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result.length).toBe(12_000 + "\n... (truncated)".length);
      expect(result.result.endsWith("(truncated)")).toBe(true);
    }
  });

  test("returns structured error for unknown server", async () => {
    const instance = `mcp-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "nope", tool: "x" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Unknown MCP server");
    }
  });

  test("throws on missing required args", async () => {
    const instance = `mcp-args-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    await expect(dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ tool: "x" }))).rejects.toThrow(/server/);
  });

  test("rejects when server is not configured", async () => {
    const instance = `mcp-status-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await addServer(instance, { name: "linear", status: "error" });
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "mcp_call", "call_1", JSON.stringify({ server: "linear", tool: "x" }));
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("not configured");
    }
  });
});

describe("request_connector dispatch", () => {
  test("returns structured error for unknown provider", async () => {
    const instance = `req-connector-unknown-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "not-a-real-provider", reason: "test" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Unknown provider");
    }
  });

  test("fast-path returns proceed message when provider already healthy", async () => {
    const instance = `req-connector-existing-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Seed a healthy linear connector directly on state.
    await mutateState(instance, (state) => {
      const at = new Date().toISOString();
      state.connectors.push({
        id: "id_linear_existing",
        instance: state.instance,
        name: "Linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      });
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "linear", reason: "list issues" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("already connected");
    }
    // No approval should have been created.
    const state = readState(instance);
    expect(state.approvals.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("creates a pending connector.request approval when no connector exists", async () => {
    const instance = `req-connector-pending-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_42",
      JSON.stringify({ provider: "linear", reason: "list my open issues" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.approvals.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("linear");
      expect(approval!.status).toBe("pending");
      expect(approval!.payload.provider).toBe("linear");
      expect(approval!.payload.providerLabel).toBe("Linear");
      expect(approval!.payload.toolCallId).toBe("call_42");
      expect(approval!.payload.reason).toBe("list my open issues");
    }
  });
});
