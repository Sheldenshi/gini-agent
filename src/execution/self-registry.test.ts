// Coverage for the self-config / introspection registry and its direct-tool
// dispatch surface.
//
// The registry (self-registry.ts) is the single source of truth for the
// self-config operation BEHAVIOR (handler + tag + audit). Each capability is
// exposed to the agent loop as a direct deferred tool whose NAME is the op
// name; dispatch routes the 9 tool cases through dispatchSelfOp. The
// dispatch-level tests exercise the route-by-tag logic (query sync, mutate
// gated-vs-auto) against a seeded RuntimeConfig + state, reusing the same
// fixture shape as tool-dispatch.test.ts. Args are passed at TOP LEVEL (no
// {name, args} envelope) — that is the contract this file pins.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";
import { findSelfOperation, SELF_OPERATIONS } from "./self-registry";

const ROOT = mkdtempSync(join(tmpdir(), "gini-self-registry-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

function buildConfig(instance: string, approvalMode: RuntimeConfig["approvalMode"] = "auto"): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    approvalMode,
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  const task = createTask(config.instance, "self-registry test");
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "self-registry test session");
    task.chatSessionId = session.id;
    upsertTask(state, task);
  });
  return task.id;
}

describe("self operation registry", () => {
  test("SELF_OPERATIONS carries the 9 expected ops with name, summary, tag, handler", () => {
    expect(SELF_OPERATIONS.length).toBe(9);
    for (const op of SELF_OPERATIONS) {
      expect(typeof op.name).toBe("string");
      expect(op.name.length).toBeGreaterThan(0);
      expect(typeof op.summary).toBe("string");
      expect(op.summary.length).toBeGreaterThan(0);
      expect(["query", "mutate"]).toContain(op.tag);
      expect(typeof op.handler).toBe("function");
    }
    const names = SELF_OPERATIONS.map((op) => op.name).sort();
    expect(names).toEqual([
      "create_agent",
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills",
      "set_provider",
      "use_agent"
    ]);
  });

  test("the query/mutate split matches the gating contract", () => {
    const queries = SELF_OPERATIONS.filter((op) => op.tag === "query").map((op) => op.name).sort();
    const mutates = SELF_OPERATIONS.filter((op) => op.tag === "mutate").map((op) => op.name).sort();
    expect(queries).toEqual([
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills"
    ]);
    expect(mutates).toEqual(["create_agent", "set_provider", "use_agent"]);
  });

  test("findSelfOperation resolves known names and rejects unknown ones", () => {
    expect(findSelfOperation("nope")).toBeUndefined();
    expect(findSelfOperation("get_self")).toBeDefined();
    expect(findSelfOperation("set_provider")?.tag).toBe("mutate");
  });
});

describe("direct self tools — query", () => {
  test("get_self resolves synchronously with the instance snapshot", async () => {
    const instance = `self-get-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "get_self", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; instance: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.instance).toBe(instance);
    }
  });

  test("list_skills takes its filter args at top level (no {name,args} envelope)", async () => {
    const instance = `self-skills-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    // Top-level args, NOT nested under `args`.
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_skills",
      "call_1",
      JSON.stringify({ status: "enabled" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; skills: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.skills)).toBe(true);
    }
  });
});

describe("direct self tools — mutate", () => {
  test("create_agent gates as pending in strict mode with payload.opName set", async () => {
    const instance = `self-create-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    // Args at top level — the direct tool's name IS the op name.
    const result = await dispatchToolCall(
      config,
      taskId,
      "create_agent",
      "call_1",
      JSON.stringify({ name: "Athena" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval?.action).toBe("self.config");
      expect(approval?.status).toBe("pending");
      // The approval payload carries the op name + top-level args, so the
      // executeApprovedAction self.config branch re-runs the right handler.
      expect(approval?.payload.opName).toBe("create_agent");
      const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
      expect(payloadArgs?.name).toBe("Athena");
    }
  });

  test("create_agent auto-resolves in auto mode and lands the side effect", async () => {
    const instance = `self-create-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "create_agent",
      "call_1",
      JSON.stringify({ name: "Athena" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; agent?: { name: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.agent?.name).toBe("Athena");
    }
    const state = readState(instance);
    expect(state.agents.some((a) => a.name === "Athena")).toBe(true);
  });

  test("set_provider gates as pending in strict mode and carries top-level args in the payload", async () => {
    const instance = `self-setprov-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_provider",
      "call_1",
      JSON.stringify({ provider: "echo" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval?.action).toBe("self.config");
      expect(approval?.payload.opName).toBe("set_provider");
      const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
      expect(payloadArgs?.provider).toBe("echo");
    }
  });
});
