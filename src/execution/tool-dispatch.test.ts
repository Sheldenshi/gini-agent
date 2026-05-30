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
import { dispatchToolCall, ToolDisplayError } from "./tool-dispatch";

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
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
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
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("linear");
      expect(approval!.status).toBe("pending");
      expect(approval!.payload.provider).toBe("linear");
      expect(approval!.payload.providerLabel).toBe("Linear");
      expect(approval!.payload.toolCallId).toBe("call_42");
      expect(approval!.payload.reason).toBe("list my open issues");
      // The model's `reason` is persisted verbatim on both the approval
      // row and the payload — no runtime templating.
      expect(approval!.reason).toBe("list my open issues");
    }
  });

  test("setupSkill provider: rejects request_connector when no prior read_skill is in task history", async () => {
    // google-oauth-desktop declares `setupSkill: "google-workspace-setup"`.
    // The dispatcher must refuse the bare shortcut and direct the model at
    // the setup skill, which owns the multi-step prerequisite flow.
    const instance = `req-connector-gated-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_1",
      JSON.stringify({ provider: "google-oauth-desktop", reason: "connect google" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("google-workspace-setup");
      expect(parsed.error).toContain("read_skill");
    }
    // The gate must short-circuit BEFORE any approval row is created.
    const state = readState(instance);
    expect(state.setupRequests.filter((a) => a.taskId === taskId).length).toBe(0);
  });

  test("setupSkill provider: proceeds when task history contains a read_skill for the setup skill", async () => {
    // Once the model has read the setup skill body, the eventual
    // request_connector call (whether emitted by the skill itself or by
    // the model after following the instructions) must pass the gate.
    const instance = `req-connector-allowed-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Seed the task's toolCallState with an assistant message whose
    // tool_calls includes a read_skill for "google-workspace-setup".
    await mutateState(instance, (state) => {
      const task = state.tasks.find((t) => t.id === taskId)!;
      task.toolCallState = {
        toolsHash: "test",
        iterations: 1,
        pending: [],
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "rs_1",
                type: "function",
                function: {
                  name: "read_skill",
                  arguments: JSON.stringify({ name: "google-workspace-setup" })
                }
              }
            ]
          },
          {
            role: "tool",
            tool_call_id: "rs_1",
            content: "(skill body)"
          }
        ]
      };
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_2",
      JSON.stringify({ provider: "google-oauth-desktop", reason: "Paste OAuth Desktop credentials for project gini-123" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("google-oauth-desktop");
      expect(approval!.payload.provider).toBe("google-oauth-desktop");
    }
  });

  test("setupSkill provider: proceeds when read_skill is in this turn's in-flight workingMessages (not yet persisted)", async () => {
    // The chat-task loop only writes `task.toolCallState.messages` when
    // pausing for approval. Within a single task run, an earlier
    // read_skill call lives only in the loop's local workingMessages
    // until then. The gate must consult workingMessages (passed via
    // the messageHistory arg) so the model isn't told to re-read the
    // skill it just read in the same turn.
    const instance = `req-connector-inflight-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Deliberately do NOT seed task.toolCallState — the read_skill
    // evidence only exists in the in-flight buffer the loop passes in.
    const inflight = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "rs_inflight",
            type: "function",
            function: {
              name: "read_skill",
              arguments: JSON.stringify({ name: "google-workspace-setup" })
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "rs_inflight",
        content: "(skill body)"
      }
    ];
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_inflight",
      JSON.stringify({ provider: "google-oauth-desktop", reason: "Paste OAuth Desktop credentials for project gini-456" }),
      inflight
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("google-oauth-desktop");
    }
  });

  test("non-setupSkill provider: gate does not apply regardless of read_skill history", async () => {
    // Back-compat: providers without `setupSkill` (linear, generic, etc.)
    // must keep the existing direct-approval shape. The gate only fires
    // when the provider declares a setup skill.
    const instance = `req-connector-bypass-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // No toolCallState — confirms the gate doesn't accidentally block
    // providers that never had a setup skill in the first place.
    const result = await dispatchToolCall(
      config,
      taskId,
      "request_connector",
      "call_3",
      JSON.stringify({ provider: "linear", reason: "list my open issues" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.setupRequests.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval!.action).toBe("connector.request");
      expect(approval!.target).toBe("linear");
    }
  });
});

describe("web_search dispatch", () => {
  test("no connector throws ToolDisplayError: verbose steering to the model, calm info line to the user", async () => {
    const instance = `web-search-no-connector-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Fresh instance has no brave-search/exa connector, so the dispatch
    // throws before touching the network or resolving any secret.
    let thrown: unknown;
    try {
      await dispatchToolCall(config, taskId, "web_search", "call_1", JSON.stringify({ query: "latest bun version" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolDisplayError);
    const err = thrown as ToolDisplayError;
    // The model still receives the full steering so it calls
    // request_connector and doesn't guess URLs with web_fetch.
    expect(err.message).toContain("request_connector");
    expect(err.message).toContain("Do NOT fall back to web_fetch");
    // The user only sees a short, neutral line.
    expect(err.displayMessage).toBe("No search provider connected.");
    expect(err.displaySeverity).toBe("info");
  });
});
