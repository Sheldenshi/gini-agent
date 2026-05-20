// Unit tests for buildToolCatalog's filtering composition.
//
// state.toolsets (enabled set) is the global "this toolset is on" filter.
// agentToolsetFilter narrows that further to an active-agent whitelist.
// Always-on tools bypass both filters so freshly cloned instances and
// tightly scoped agents can still reach the core agent capability surface:
// web_fetch, read_skill, spawn_subagent, the scheduled-job tools
// (create_job, list_jobs, update_job, delete_job, run_job), and the
// agent-capability meta-tools whose toolsets aren't in the defaults
// (cancel_task, install_skill, enable_skill, disable_skill).
// Surface-gateway tools `send_message` (toolset `messaging`) and
// `invoke_mcp` (toolset `mcp`) are deliberately NOT always-on so the
// operator's toolset enable/disable kill switch keeps working.

import { describe, expect, test } from "bun:test";
import { buildToolCatalog } from "./tool-catalog";
import { defaultToolsets } from "../state/defaults";
import type { RuntimeState, ToolsetRecord } from "../types";

function ts(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
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

const ALWAYS_ON = new Set([
  "web_fetch",
  "read_skill",
  "spawn_subagent",
  "create_job",
  "list_jobs",
  "update_job",
  "delete_job",
  "run_job",
  "cancel_task",
  "install_skill",
  "enable_skill",
  "disable_skill"
]);

describe("buildToolCatalog", () => {
  test("includes only always-on tools when no toolsets are enabled", () => {
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    for (const tool of catalog) {
      expect(ALWAYS_ON.has(tool.function.name)).toBe(true);
    }
    // Sanity: every always-on tool surfaces.
    const names = new Set(catalog.map((t) => t.function.name));
    for (const expected of ALWAYS_ON) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("fresh-default toolsets surface the always-on agent-capability tools but hide send_message/invoke_mcp", () => {
    // Pin the contract that a freshly cloned instance's default toolset
    // state advertises the agent-capability meta-tools (cancel_task,
    // install_skill, enable_skill, disable_skill) plus the
    // memory/session_search tools whose toolsets ship enabled. The
    // surface-gateway tools `send_message` and `invoke_mcp` live under
    // toolsets that ship disabled — they should NOT appear until the
    // operator enables `messaging` / `mcp`.
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z"));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    const expectedVisible = [
      "recall_memory",
      "add_memory",
      "update_memory",
      "search_history",
      "cancel_task",
      "install_skill",
      "enable_skill",
      "disable_skill"
    ];
    for (const tool of expectedVisible) {
      expect(names.has(tool)).toBe(true);
    }
    // Kill switch contract: messaging + mcp toolsets default disabled,
    // so the surface-gateway tools stay hidden in a fresh catalog.
    expect(names.has("send_message")).toBe(false);
    expect(names.has("invoke_mcp")).toBe(false);
  });

  test("enabling the messaging toolset exposes send_message", () => {
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) =>
      t.name === "messaging" ? { ...t, status: "enabled" as const } : t
    ));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("send_message")).toBe(true);
  });

  test("enabling the mcp toolset exposes invoke_mcp", () => {
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) =>
      t.name === "mcp" ? { ...t, status: "enabled" as const } : t
    ));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("invoke_mcp")).toBe(true);
  });

  test("disabling messaging toolset hides send_message (kill switch works)", () => {
    // Both messaging and mcp default disabled. This assertion is the
    // negative half of the kill-switch contract.
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z"));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("send_message")).toBe(false);
    expect(names.has("invoke_mcp")).toBe(false);
  });

  test("core meta-tools remain visible regardless of toolset state", () => {
    // cancel_task, install_skill, enable_skill, disable_skill have no
    // separate toolset to gate them — they ride alongside spawn_subagent
    // and read_skill and stay always-on.
    const stateEmpty = stateWithToolsets([]);
    const stateAllDisabled = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) => ({ ...t, status: "disabled" as const })));
    for (const state of [stateEmpty, stateAllDisabled]) {
      const names = new Set(buildToolCatalog(state).map((t) => t.function.name));
      for (const tool of ["cancel_task", "install_skill", "enable_skill", "disable_skill"]) {
        expect(names.has(tool)).toBe(true);
      }
    }
  });

  test("agent toolset filter narrows the catalog to file + always-on", () => {
    const state = stateWithToolsets([ts("file"), ts("terminal"), ts("memory")]);
    const catalog = buildToolCatalog(state, new Set(["file"]));
    for (const tool of catalog) {
      if (ALWAYS_ON.has(tool.function.name)) continue;
      // Only file.* tools should survive.
      expect(tool.toolset).toBe("file");
    }
    // file_read should be present, terminal_exec should not.
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("file_read")).toBe(true);
    expect(names.has("terminal_exec")).toBe(false);
    // Always-on tools survive even when not listed in the agent filter.
    for (const expected of ALWAYS_ON) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("run_job is always-on with toolset 'jobs' and requires jobId", () => {
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "run_job");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("jobs");
    expect(tool?.function.parameters.required).toEqual(["jobId"]);
  });

  test("agent filter for a globally-disabled toolset still produces an empty (non-always-on) catalog", () => {
    const state = stateWithToolsets([ts("file", "disabled")]);
    const catalog = buildToolCatalog(state, new Set(["file"]));
    for (const tool of catalog) {
      expect(ALWAYS_ON.has(tool.function.name)).toBe(true);
    }
  });

  test("undefined agent filter falls back to global enabled set", () => {
    const state = stateWithToolsets([ts("file"), ts("terminal")]);
    const catalog = buildToolCatalog(state, undefined);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("file_read")).toBe(true);
    expect(names.has("terminal_exec")).toBe(true);
  });
});
