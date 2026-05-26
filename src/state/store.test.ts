import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, normalizeState } from "./store";
import type { RuntimeState } from "../types";

// Isolated state root so the test never touches ~/.gini.
const ROOT = "/tmp/gini-store-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("normalizeState toolset/tool backfill", () => {
  test("adds missing default toolsets and tools by name", () => {
    const state = createEmptyState("test-instance");
    // Simulate an older instance whose state was written before the
    // browser toolset was added: drop those entries from both arrays.
    state.toolsets = state.toolsets.filter((ts) => ts.name !== "browser");
    state.tools = state.tools.filter((tool) => tool.toolset !== "browser");
    expect(state.toolsets.some((ts) => ts.name === "browser")).toBe(false);
    expect(state.tools.some((tool) => tool.toolset === "browser")).toBe(false);

    const normalized = normalizeState("test-instance", state);

    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.navigate")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.click")).toBe(true);
  });

  test("does not duplicate existing toolsets", () => {
    const state = createEmptyState("test-instance-2");
    const beforeCount = state.toolsets.length;
    const beforeToolCount = state.tools.length;
    const normalized = normalizeState("test-instance-2", state);
    expect(normalized.toolsets.length).toBe(beforeCount);
    expect(normalized.tools.length).toBe(beforeToolCount);
  });

  test("preserves user-modified toolset rows when names already match", () => {
    const state = createEmptyState("test-instance-3");
    const fileToolset = state.toolsets.find((ts) => ts.name === "file");
    expect(fileToolset).toBeDefined();
    const customDescription = "custom user description";
    fileToolset!.description = customDescription;
    const normalized = normalizeState("test-instance-3", state);
    const after = normalized.toolsets.find((ts) => ts.name === "file");
    expect(after?.description).toBe(customDescription);
  });

  test("seeds toolsets when state.toolsets is missing entirely", () => {
    const partial = { instance: "test-instance-4" } as unknown as RuntimeState;
    const normalized = normalizeState("test-instance-4", partial);
    expect(Array.isArray(normalized.toolsets)).toBe(true);
    expect(normalized.toolsets.length).toBeGreaterThan(0);
    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
  });

  test("unions new tool names into an existing toolset row and synthesizes matching tool rows", () => {
    // Simulate an older instance whose browser toolset row was written
    // when only the original 9 browser tools existed. The toolset row
    // exists; the new tool entries (vision, hover, drag, select_option,
    // wait_for, tabs, upload_file) are missing from both toolNames and
    // the tool rows. Mark the existing toolset as "enabled" so we can
    // verify the new tool rows come up "available" matching the
    // toolset's status.
    const state = createEmptyState("test-instance-5");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    browser!.status = "enabled";
    // Drop the newer tool rows so the backfill has something to do.
    const newerNames = new Set([
      "browser.vision",
      "browser.hover",
      "browser.drag",
      "browser.select_option",
      "browser.wait_for",
      "browser.tabs",
      "browser.upload_file"
    ]);
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.has(tool.name)
    );

    const normalized = normalizeState("test-instance-5", state);
    const after = normalized.toolsets.find((ts) => ts.name === "browser")!;
    // toolNames is now the full default set, in stable order (old names
    // first, new names appended).
    expect(after.toolNames.length).toBe(17);
    for (const name of newerNames) {
      expect(after.toolNames.includes(name)).toBe(true);
    }
    // Tool rows for each new name exist and inherit the toolset's
    // enabled→available status.
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.toolset).toBe("browser");
      expect(row!.status).toBe("available");
    }
  });

  test("normalizes legacy intervalSeconds: 0 sentinel on cron-driven jobs to undefined", () => {
    // Earlier versions of the runtime stored `intervalSeconds: 0` on cron
    // jobs so the field stayed a `number`. After the type was made
    // optional, cron jobs carry no intervalSeconds at all. The normalizer
    // migrates legacy rows on load — interval jobs are left untouched.
    const state = createEmptyState("test-instance-cron-migrate");
    state.jobs = [
      // Legacy cron job: intervalSeconds: 0, cronExpression set.
      {
        id: "job_legacy_cron",
        instance: "test-instance-cron-migrate",
        name: "legacy cron",
        prompt: "x",
        intervalSeconds: 0,
        cronExpression: "0 9 * * *",
        cronTimezone: "UTC",
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-02T09:00:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      },
      // Legacy interval job: positive intervalSeconds, no cronExpression.
      {
        id: "job_legacy_interval",
        instance: "test-instance-cron-migrate",
        name: "legacy interval",
        prompt: "x",
        intervalSeconds: 60,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-01T00:01:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      }
    ];

    const normalized = normalizeState("test-instance-cron-migrate", state);

    const cronJob = normalized.jobs.find((j) => j.id === "job_legacy_cron");
    const intervalJob = normalized.jobs.find((j) => j.id === "job_legacy_interval");
    // Cron-driven row: the 0 sentinel is dropped.
    expect(cronJob?.intervalSeconds).toBeUndefined();
    expect(cronJob?.cronExpression).toBe("0 9 * * *");
    // Interval-driven row: untouched.
    expect(intervalJob?.intervalSeconds).toBe(60);
  });

  test("unions new default toolsets into existing agent_default without touching user-authored agents", () => {
    // Simulate an instance whose `agent_default` row was persisted before
    // `browser` joined the default toolsets list, alongside a
    // user-authored agent with an explicit narrow toolset pick.
    const state = createEmptyState("test-instance-agent-migrate");
    const defaultAgentRecord = state.agents.find((agent) => agent.id === "agent_default");
    expect(defaultAgentRecord).toBeDefined();
    // Pre-Phase-2 default toolsets list (no browser, no delegation).
    defaultAgentRecord!.toolsets = ["file", "terminal", "memory", "session_search"];
    const originalUpdatedAt = defaultAgentRecord!.updatedAt;
    // Pin updatedAt back in time so we can verify the migration bumped it.
    defaultAgentRecord!.updatedAt = "2025-01-01T00:00:00.000Z";
    // Add a user-authored agent with a deliberately narrow toolset.
    state.agents.push({
      id: "agent_user_custom",
      instance: "test-instance-agent-migrate",
      name: "user-custom",
      status: "inactive",
      providerName: undefined,
      model: undefined,
      toolsets: ["file"],
      messagingTargets: [],
      createdAt: originalUpdatedAt,
      updatedAt: originalUpdatedAt
    });
    // Add a legacy `profile_default` row to confirm the migration also
    // covers the legacy id.
    state.agents.push({
      id: "profile_default",
      instance: "test-instance-agent-migrate",
      name: "legacy-default",
      status: "inactive",
      providerName: undefined,
      model: undefined,
      toolsets: ["file", "terminal"],
      messagingTargets: [],
      createdAt: originalUpdatedAt,
      updatedAt: "2025-01-01T00:00:00.000Z"
    });

    const normalized = normalizeState("test-instance-agent-migrate", state);

    const migratedDefault = normalized.agents.find((agent) => agent.id === "agent_default")!;
    // Browser (and any other current default) is unioned in; pre-existing
    // entries are preserved in order.
    expect(migratedDefault.toolsets).toContain("file");
    expect(migratedDefault.toolsets).toContain("terminal");
    expect(migratedDefault.toolsets).toContain("memory");
    expect(migratedDefault.toolsets).toContain("session_search");
    expect(migratedDefault.toolsets).toContain("delegation");
    expect(migratedDefault.toolsets).toContain("browser");
    expect(migratedDefault.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");

    const migratedLegacy = normalized.agents.find((agent) => agent.id === "profile_default")!;
    expect(migratedLegacy.toolsets).toContain("browser");
    expect(migratedLegacy.toolsets).toContain("delegation");
    expect(migratedLegacy.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");

    // User-authored agent is untouched.
    const userCustom = normalized.agents.find((agent) => agent.id === "agent_user_custom")!;
    expect(userCustom.toolsets).toEqual(["file"]);
    expect(userCustom.updatedAt).toBe(originalUpdatedAt);
  });

  test("backfilled tool rows for a DISABLED toolset stay disabled", () => {
    const state = createEmptyState("test-instance-6");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    // Simulate an instance whose operator has explicitly disabled the
    // browser toolset, then trim its tool roster to the historical 9-tool
    // shape so the backfill below has work to do.
    browser!.status = "disabled";
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    const newerNames = ["browser.vision", "browser.hover"];
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.includes(tool.name)
    );

    const normalized = normalizeState("test-instance-6", state);
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.status).toBe("disabled");
    }
  });
});

describe("backfillDefaultAgentToolsets", () => {
  test("legacy state with the prior default whitelist gains messaging and mcp", () => {
    const state = createEmptyState("test-instance-agent-backfill-legacy");
    const agent = state.agents.find((a) => a.id === "agent_default");
    expect(agent).toBeDefined();
    // Simulate an upgraded instance whose default agent still carries
    // the prior whitelist (pre-messaging/mcp addition).
    agent!.toolsets = ["file", "terminal", "memory", "session_search", "delegation"];

    const normalized = normalizeState("test-instance-agent-backfill-legacy", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after).toBeDefined();
    expect(after!.toolsets).toContain("messaging");
    expect(after!.toolsets).toContain("mcp");
    // Original entries preserved.
    for (const name of ["file", "terminal", "memory", "session_search", "delegation"]) {
      expect(after!.toolsets).toContain(name);
    }
    // Audit row landed so the backfill is traceable.
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled" && e.target === "agent_default"
    );
    expect(audit).toBeDefined();
    expect((audit?.evidence as { added?: string[] })?.added).toEqual(["messaging", "mcp"]);
  });

  test("customized state (user removed terminal) is left untouched", () => {
    const state = createEmptyState("test-instance-agent-backfill-custom");
    const agent = state.agents.find((a) => a.id === "agent_default");
    expect(agent).toBeDefined();
    // User removed `terminal` — list no longer matches the prior default
    // exactly, so the migration should leave it alone.
    agent!.toolsets = ["file", "memory", "session_search", "delegation"];

    const normalized = normalizeState("test-instance-agent-backfill-custom", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after).toBeDefined();
    expect(after!.toolsets).toEqual(["file", "memory", "session_search", "delegation"]);
    expect(after!.toolsets).not.toContain("messaging");
    expect(after!.toolsets).not.toContain("mcp");
    // No backfill audit row written.
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled" && e.target === "agent_default"
    );
    expect(audit).toBeUndefined();
  });

  test("fresh state without an agent_default row is a no-op", () => {
    const state = createEmptyState("test-instance-agent-backfill-noagent");
    // Replace the seeded default with a differently-named agent so the
    // lookup misses entirely.
    state.agents = [{
      id: "agent_other",
      instance: "test-instance-agent-backfill-noagent",
      name: "other",
      status: "active",
      providerName: undefined,
      model: undefined,
      toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
      messagingTargets: [],
      createdAt: state.agents[0].createdAt,
      updatedAt: state.agents[0].updatedAt
    }];
    state.activeAgentId = "agent_other";

    const normalized = normalizeState("test-instance-agent-backfill-noagent", state);
    // The non-default agent is untouched even though its whitelist
    // matches the prior default set — the migration only targets
    // `agent_default`.
    const other = normalized.agents.find((a) => a.id === "agent_other");
    expect(other!.toolsets).toEqual(["file", "terminal", "memory", "session_search", "delegation"]);
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audit).toBeUndefined();
  });

  test("already-migrated state (messaging + mcp present) is idempotent", () => {
    const state = createEmptyState("test-instance-agent-backfill-idempotent");
    // createEmptyState seeds the new default which already includes
    // `messaging` and `mcp`. No backfill should fire.
    const before = state.agents.find((a) => a.id === "agent_default")!.toolsets.slice();
    expect(before).toContain("messaging");
    expect(before).toContain("mcp");

    const normalized = normalizeState("test-instance-agent-backfill-idempotent", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after!.toolsets).toEqual(before);
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audit).toBeUndefined();

    // Running normalizeState a second time on the already-migrated state
    // is still a no-op — no second audit row appears.
    const renormalized = normalizeState("test-instance-agent-backfill-idempotent", normalized);
    const audits = renormalized.audit.filter(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audits.length).toBe(0);
  });
});
describe("dropDeadMemoryImprovements", () => {
  test("strips improvements with the legacy kind: memory and audits each removal", () => {
    const state = createEmptyState("legacy-memory-improvements");
    // Inject legacy proposals via the dynamic shape — the type-level
    // ImprovementKind dropped "memory" alongside the state.memories
    // consolidation, but persisted state files still carry them.
    state.improvements = [
      ...state.improvements,
      {
        id: "imp_mem_1",
        instance: state.instance,
        // Cast through unknown because the field is no longer typed.
        kind: "memory" as unknown as "skill",
        title: "remember preferences",
        rationale: "legacy",
        status: "proposed",
        sourceTaskId: undefined,
        sourceTraceIds: [],
        payload: { content: "x" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "imp_skill_1",
        instance: state.instance,
        kind: "skill",
        title: "real skill",
        rationale: "ok",
        status: "proposed",
        sourceTaskId: undefined,
        sourceTraceIds: [],
        payload: { name: "real skill" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const normalized = normalizeState(state.instance, state);

    // The legacy memory proposal is gone; the skill proposal stays.
    expect(normalized.improvements.find((p) => p.id === "imp_mem_1")).toBeUndefined();
    expect(normalized.improvements.find((p) => p.id === "imp_skill_1")).toBeDefined();

    // The removal landed an audit row so operators can see why the
    // proposal disappeared.
    const audit = normalized.audit.find(
      (event) => event.action === "improvement.memory-kind.removed" && event.target === "imp_mem_1"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.title).toBe("remember preferences");
  });
});
