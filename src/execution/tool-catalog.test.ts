// Unit tests for buildToolCatalog's filtering composition.
//
// state.toolsets (enabled set) is the global "this toolset is on" filter.
// agentToolsetFilter narrows that further to an active-agent whitelist.
// Always-on tools bypass both filters so freshly cloned instances and
// tightly scoped agents can still reach the core agent capability surface:
// web_fetch, read_skill, spawn_subagent, the scheduled-job tools
// (create_job, list_jobs, update_job, delete_job, run_job), mcp_call,
// request_connector, browser_fill_secrets, request_messaging_bridge,
// and the agent-capability meta-tools whose toolsets aren't in the
// defaults (cancel_task, install_skill, enable_skill, disable_skill,
// edit_soul, edit_user_profile). The surface-gateway tool `send_message`
// (toolset `messaging`) is deliberately NOT always-on so the operator's
// toolset enable/disable kill switch keeps working; the sibling
// `request_messaging_bridge` IS always-on because it's a meta-tool
// (renders an onboarding card; doesn't egress data) and the chat
// onboarding path needs to be reachable on fresh instances.

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
    tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
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
  "mcp_call",
  "request_connector",
  // browser_fill_secrets is the meta-tool path for asking the user
  // to type a value into a DOM field on the agent's browser tab. It
  // never types anything itself (it just renders a chat card), so
  // it lives outside the "browser" toolset's kill switch — same
  // logic as request_connector being outside the "connectors"
  // toolset.
  "browser_fill_secrets",
  // The chat-side messaging lifecycle meta-tools. Same always-on
  // rationale as request_connector / browser_fill_secrets — they
  // surface UI cards or read state, never egress data on their own.
  // The surface-gateway send_message tool stays GATED by the
  // messaging toolset (operators flip the toolset to disable
  // outbound DM autonomy without losing the onboarding / inventory
  // / pairing / removal affordances).
  "request_messaging_bridge",
  "list_messaging_bridges",
  "list_messaging_pairings",
  "wait_for_messaging_pair",
  "request_messaging_pairing",
  "request_remove_messaging_bridge",
  "cancel_task",
  "install_skill",
  "enable_skill",
  "disable_skill",
  // Identity-file edit tools live under the "identity" toolset which is
  // not in defaults; always-on so a fresh instance can propose SOUL.md /
  // USER.md edits. The propose-vs-approve file split is the gate.
  "edit_soul",
  "edit_user_profile"
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

  test("fresh-default toolsets surface the always-on agent-capability tools plus send_message", () => {
    // Pin the contract that a freshly cloned instance's default toolset
    // state advertises the agent-capability meta-tools (cancel_task,
    // install_skill, enable_skill, disable_skill) plus the
    // memory/session_search tools. All shipped toolsets default enabled,
    // so the surface-gateway tool `send_message` is also visible.
    // `mcp_call` is always-on (no toolset gate).
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z"));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    const expectedVisible = [
      "recall_memory",
      "search_history",
      "cancel_task",
      "install_skill",
      "enable_skill",
      "disable_skill",
      "mcp_call",
      "request_connector",
      "send_message"
    ];
    for (const tool of expectedVisible) {
      expect(names.has(tool)).toBe(true);
    }
    // add_memory and update_memory were dropped as part of the
    // state.memories consolidation. See ADR
    // runtime-identity-files.md.
    expect(names.has("add_memory")).toBe(false);
    expect(names.has("update_memory")).toBe(false);
  });

  test("disabling messaging toolset hides send_message (kill switch works)", () => {
    // messaging defaults enabled. Flip it to disabled to verify the
    // kill switch still removes send_message from the catalog.
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) =>
      t.name === "messaging" ? { ...t, status: "disabled" as const } : t
    ));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("send_message")).toBe(false);
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

  test("skill-script-derived tools surface when their bundled skill is enabled", () => {
    // Skill-script tools (Anthropic Agent Skills `scripts/` convention) are
    // not in the static TOOL_DEFS — they're appended at catalog-build time
    // from `state.skills[*].scripts[*]`. Always-on regardless of toolset
    // state so a fresh instance with no toggles still exposes them.
    const state = stateWithToolsets([]);
    state.skills.push({
      id: "skill_linear",
      instance: "test",
      name: "linear",
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      manifestPath: "/repo/skills/integrations/linear/SKILL.md",
      source: "bundled",
      scripts: [
        {
          file: "scripts/attach.ts",
          tool: {
            name: "linear_attach_image",
            description: "Attach a chat-uploaded image to a Linear issue.",
            parameters: {
              type: "object",
              properties: { issue: { type: "string" }, uploadId: { type: "string" } },
              required: ["issue", "uploadId"]
            }
          }
        }
      ]
    });
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "linear_attach_image");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skill_script");
    expect(tool?.function.parameters.required).toEqual(["issue", "uploadId"]);
  });

  test("user-imported skill scripts are NOT exposed (trust boundary)", () => {
    // Only bundled skills' scripts are trusted. A user-imported skill that
    // declares a script must not get its tool wired into the catalog —
    // running arbitrary code from a third-party install needs a separate
    // trust review.
    const state = stateWithToolsets([]);
    state.skills.push({
      id: "skill_user",
      instance: "test",
      name: "evil-linear",
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      manifestPath: "/home/user/.gini/instances/x/skills/evil-linear/SKILL.md",
      source: "user",
      scripts: [
        {
          file: "scripts/evil.ts",
          tool: {
            name: "evil_tool",
            description: "Should never appear.",
            parameters: { type: "object", properties: {} }
          }
        }
      ]
    });
    const catalog = buildToolCatalog(state);
    expect(catalog.find((t) => t.function.name === "evil_tool")).toBeUndefined();
  });

  test("disabled bundled skills do not expose their scripts", () => {
    const state = stateWithToolsets([]);
    state.skills.push({
      id: "skill_linear",
      instance: "test",
      name: "linear",
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "disabled",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      manifestPath: "/repo/skills/integrations/linear/SKILL.md",
      source: "bundled",
      scripts: [
        {
          file: "scripts/attach.ts",
          tool: {
            name: "linear_attach_image",
            description: "Attach a chat-uploaded image to a Linear issue.",
            parameters: { type: "object", properties: {} }
          }
        }
      ]
    });
    const catalog = buildToolCatalog(state);
    expect(catalog.find((t) => t.function.name === "linear_attach_image")).toBeUndefined();
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

  describe("identity tool descriptions", () => {
    // The descriptions of `edit_user_profile` and `edit_soul` carry the
    // bulk of the in-prompt steering. Pin the key clauses so a future
    // rewrite that drops them surfaces as a test failure instead of
    // silently regressing model behavior.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);

    test("edit_user_profile description names the H2 sections and the soft cap", () => {
      const tool = catalog.find((t) => t.function.name === "edit_user_profile");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      // H2 section convention (Identity, Preferences, Background, Goals).
      expect(desc).toContain("## Identity");
      expect(desc).toContain("## Preferences");
      // Set preferred over append.
      expect(desc).toContain('Prefer `action: "set"`');
      // Declarative-not-imperative phrasing rule.
      expect(desc).toContain("facts ABOUT the user");
      // Budget awareness clause.
      expect(desc).toContain("soft cap");
      // SKIP-list keyword (a single representative entry is enough).
      expect(desc).toContain("task progress");
      // Don't-narrate / short ack rule.
      expect(desc).toContain("Got it");
      // USER/SOUL partition: communication preferences route here, not to
      // edit_soul. A representative imperative-form example pins the rule
      // so a future rewrite that drops the preference branch surfaces.
      expect(desc).toContain("preferences");
      expect(desc).toContain("be more concise");
    });

    test("edit_soul description names the H2 sections and the soft cap", () => {
      const tool = catalog.find((t) => t.function.name === "edit_soul");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      expect(desc).toContain("## Voice");
      expect(desc).toContain("## Style");
      expect(desc).toContain('Prefer `action: "set"`');
      expect(desc).toContain("Voice is terse");
      expect(desc).toContain("soft cap");
      // USER/SOUL partition: SOUL fires only on explicit persona
      // assignment, not on USER preferences about communication.
      expect(desc).toContain("persona");
      expect(desc).toContain("You are");
    });
  });
});
