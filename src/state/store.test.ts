import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, normalizeState, writeState } from "./store";
import { readSecret, writeSecret } from "./secrets";
import { bindingsForCredentials, resolveSkillEnv } from "../integrations/connectors";
import type { ConnectorRecord, RuntimeConfig, RuntimeState, SkillRecord } from "../types";

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

  test("unions web_search into a default agent persisted at the post-browser snapshot", () => {
    // An instance created after `browser` joined the defaults but before
    // `web_search` did carries exactly this 8-entry whitelist. The
    // migration must recognize it as uncustomized and add web_search —
    // otherwise the web_search tool stays invisible to the model.
    const state = createEmptyState("test-instance-web-search-migrate");
    const agent = state.agents.find((a) => a.id === "agent_default")!;
    agent.toolsets = ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp", "browser"];
    agent.updatedAt = "2025-01-01T00:00:00.000Z";

    const normalized = normalizeState("test-instance-web-search-migrate", state);
    const after = normalized.agents.find((a) => a.id === "agent_default")!;
    expect(after.toolsets).toContain("web_search");
    expect(after.toolsets).toContain("browser");
    expect(after.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");
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

describe("normalizeState approval -> authorization/setup-request migration", () => {
  test("partitions a legacy approvals array by action", () => {
    const at = new Date().toISOString();
    const state = createEmptyState("test-approval-split");
    // Simulate a pre-split state file: drop the new arrays, install a
    // mixed `approvals` array.
    const legacy = [
      {
        id: "approval_1",
        instance: "test-approval-split",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "/tmp/x",
        risk: "medium",
        reason: "write a file",
        payload: { path: "/tmp/x" }
      },
      {
        id: "approval_2",
        instance: "test-approval-split",
        status: "approved",
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        risk: "low",
        reason: "sign in",
        payload: {}
      },
      {
        id: "approval_3",
        instance: "test-approval-split",
        status: "denied",
        createdAt: at,
        updatedAt: at,
        action: "connector.request",
        target: "openai",
        risk: "medium",
        reason: "enter creds",
        payload: { provider: "openai" }
      },
      {
        id: "approval_4",
        instance: "test-approval-split",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "browser.fill_secret",
        target: "https://login.example.com",
        risk: "high",
        reason: "type password",
        payload: { slots: [] }
      }
    ];
    const legacyState = state as RuntimeState & { approvals?: unknown };
    legacyState.approvals = legacy as unknown;
    // Force the new arrays empty so the migration path runs.
    (legacyState as { authorizations?: unknown }).authorizations = undefined;
    (legacyState as { setupRequests?: unknown }).setupRequests = undefined;

    const normalized = normalizeState("test-approval-split", state);

    expect((normalized as unknown as { approvals?: unknown }).approvals).toBeUndefined();
    expect(normalized.authorizations).toHaveLength(1);
    expect(normalized.authorizations[0]!.id).toBe("approval_1");
    expect(normalized.authorizations[0]!.action).toBe("file.write");

    expect(normalized.setupRequests).toHaveLength(3);
    const byId = new Map(normalized.setupRequests.map((row) => [row.id, row]));
    expect(byId.get("approval_2")!.action).toBe("browser.connect");
    expect(byId.get("approval_2")!.status).toBe("completed");
    expect(byId.get("approval_3")!.action).toBe("connector.request");
    expect(byId.get("approval_3")!.status).toBe("cancelled");
    expect(byId.get("approval_4")!.action).toBe("browser.fill_secret");
    expect(byId.get("approval_4")!.status).toBe("pending");
    // Risk is structurally absent from SetupRequest.
    expect((byId.get("approval_4") as { risk?: unknown }).risk).toBeUndefined();
  });

  test("is a no-op when the legacy field is absent", () => {
    const state = createEmptyState("test-approval-noop");
    expect((state as RuntimeState & { approvals?: unknown }).approvals).toBeUndefined();
    const normalized = normalizeState("test-approval-noop", state);
    expect(normalized.authorizations).toEqual([]);
    expect(normalized.setupRequests).toEqual([]);
    expect((normalized as unknown as { approvals?: unknown }).approvals).toBeUndefined();
  });
});

describe("normalizeState provider-keyed → typed-named-credential migration", () => {
  // Build a pre-migration state: provider-keyed linear + google-oauth-desktop
  // + a generic connector, plus a user skill that requires + grants them.
  // Secrets are written to disk so the migration's purpose re-key can be
  // verified to preserve values.
  function seedPreMigration(instance: string): RuntimeState {
    const state = createEmptyState(instance);
    const at = new Date().toISOString();

    const linearRef = writeSecret(instance, "id_linear", "token", "lin_api_secret");
    const gwsIdRef = writeSecret(instance, "id_gws", "client_id", "gws-client-id");
    const gwsSecretRef = writeSecret(instance, "id_gws", "client_secret", "gws-client-secret");
    const genericRef = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-secret");

    const connectors: ConnectorRecord[] = [
      {
        id: "id_linear",
        instance,
        name: "Linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [linearRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      },
      {
        id: "id_gws",
        instance,
        name: "Google",
        provider: "google-oauth-desktop",
        status: "configured",
        scopes: [],
        secretRefs: [gwsIdRef, gwsSecretRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      },
      {
        id: "id_generic",
        instance,
        name: "My Service",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [genericRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      }
    ];
    // Replace the default demo connector list with our seeded set.
    state.connectors = connectors;

    const skill: SkillRecord = {
      id: "skill_user_1",
      instance,
      name: "my-linear-skill",
      description: "User skill referencing linear + generic",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "user",
      // Declares the env vars so the generic requires conversion can match the
      // generic credential (MY_API_KEY) by env coverage rather than guessing.
      prerequisites: { env: ["LINEAR_API_KEY", "MY_API_KEY"] },
      requiredConnectors: [{ provider: "linear" }, { provider: "generic" }],
      grantedConnectors: ["linear", "generic"]
    };
    state.skills = [skill];
    return state;
  }

  function configFor(instance: string): RuntimeConfig {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("types + names connectors, preserves secrets, converts skills, and is idempotent", async () => {
    const instance = "test-cred-migrate";
    const state = seedPreMigration(instance);
    const normalized = normalizeState(instance, state);

    const linear = normalized.connectors.find((c) => c.id === "id_linear")!;
    expect(linear.type).toBe("api-key");
    expect(linear.name).toBe("LINEAR_API_KEY");
    expect(linear.metadata?.mcp).toEqual({
      url: "https://mcp.linear.app/mcp",
      name: "linear",
      headerName: "Authorization",
      scheme: "Bearer"
    });
    // The secret purpose is NOT re-keyed: it stays "token" so the Linear probe
    // (resolveSecret "token") and bindingsForCredentials (secretRefs[0].purpose)
    // both keep working.
    expect(linear.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
    const linearRef = linear.secretRefs.find((r) => r.purpose === "token")!;
    expect(readSecret(instance, linearRef)).toBe("lin_api_secret");
    // The api-key still resolves under its name via the binding layer.
    expect(bindingsForCredentials(normalized, ["LINEAR_API_KEY"])).toEqual({
      LINEAR_API_KEY: { credentialId: "id_linear", purpose: "token" }
    });

    const gws = normalized.connectors.find((c) => c.id === "id_gws")!;
    expect(gws.type).toBe("oauth2");
    expect(gws.name).toBe("google-workspace-oauth");
    expect(gws.metadata?.envMap).toEqual({
      client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
    });
    // oauth2 keeps its purposes (client_id/client_secret) — values intact.
    expect(readSecret(instance, gws.secretRefs.find((r) => r.purpose === "client_id")!)).toBe("gws-client-id");
    expect(readSecret(instance, gws.secretRefs.find((r) => r.purpose === "client_secret")!)).toBe("gws-client-secret");
    // GOOGLE_WORKSPACE_CLI_CLIENT_ID actually RESOLVES through the full env
    // path (not just a read-back of the envMap). resolveSkillEnv reads the
    // instance off disk, so persist the migrated state first. The migrated
    // skill is a user skill that grants google-workspace-oauth, so
    // resolveSkillEnv injects it.
    writeState(instance, normalized);
    const gwsSkill: SkillRecord = {
      ...normalized.skills.find((s) => s.id === "skill_user_1")!,
      requiredCredentials: ["google-workspace-oauth"],
      grantedConnectors: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID", "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"] }
    };
    const gwsEnv = await resolveSkillEnv(configFor(instance), gwsSkill);
    expect(gwsEnv).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "gws-client-id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "gws-client-secret"
    });

    const generic = normalized.connectors.find((c) => c.id === "id_generic")!;
    expect(generic.type).toBe("api-key");
    expect(generic.name).toBe("MY_API_KEY");
    expect(readSecret(instance, generic.secretRefs[0]!)).toBe("generic-secret");

    const skill = normalized.skills.find((s) => s.id === "skill_user_1")!;
    expect(skill.requiredCredentials).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);
    expect(skill.grantedConnectors).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);

    // Exactly one summary audit row.
    const summary = normalized.audit.filter((a) => a.action === "connector.migration.typed_credentials");
    expect(summary.length).toBe(1);

    // Marker set.
    const marker = (normalized as unknown as { migrations?: { connectorsTypedCredentials?: string } }).migrations?.connectorsTypedCredentials;
    expect(typeof marker).toBe("string");

    // Idempotent: a second pass changes nothing material and adds no new
    // migration audit row.
    const second = normalizeState(instance, normalized);
    expect(second.connectors.find((c) => c.id === "id_linear")!.name).toBe("LINEAR_API_KEY");
    expect(second.connectors.find((c) => c.id === "id_linear")!.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
    expect(second.audit.filter((a) => a.action === "connector.migration.typed_credentials").length).toBe(1);
    expect(second.skills.find((s) => s.id === "skill_user_1")!.requiredCredentials).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);
  });

  test("a skill requiring linear with NO linear connector still converts (static canonical table)", () => {
    const instance = "test-cred-no-connector";
    const state = createEmptyState(instance);
    // No linear connector at all — only the seeded demo. The skill still must
    // get its provider-keyed requirement converted to the canonical name.
    const at = new Date().toISOString();
    const skill: SkillRecord = {
      id: "skill_needs_linear",
      instance,
      name: "needs-linear",
      description: "Requires linear but no connector exists",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "user",
      requiredConnectors: [{ provider: "linear" }]
    };
    state.skills = [skill];
    const normalized = normalizeState(instance, state);
    expect(normalized.skills.find((s) => s.id === "skill_needs_linear")!.requiredCredentials).toEqual(["LINEAR_API_KEY"]);
  });

  test("renames TWO colliding generic LINEAR_API_KEY records to _2 and _3 (loops to first free)", () => {
    const instance = "test-cred-collision";
    const state = createEmptyState(instance);
    const at = new Date().toISOString();

    const linearRef = writeSecret(instance, "id_linear", "token", "lin_api_secret");
    const dupRef = writeSecret(instance, "id_dup", "LINEAR_API_KEY", "generic-dup-secret");
    const dup2Ref = writeSecret(instance, "id_dup2", "LINEAR_API_KEY", "generic-dup2-secret");

    const mk = (id: string, name: string, provider: string, refs: ConnectorRecord["secretRefs"]): ConnectorRecord => ({
      id,
      instance,
      name,
      provider,
      status: "configured",
      scopes: [],
      secretRefs: refs,
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "user"
    });
    state.connectors = [
      mk("id_linear", "Linear", "linear", [linearRef]),
      mk("id_dup", "Dup", "generic", [dupRef]),
      mk("id_dup2", "Dup2", "generic", [dup2Ref])
    ];

    const normalized = normalizeState(instance, state);

    // Template-typed linear keeps the canonical name.
    expect(normalized.connectors.find((c) => c.id === "id_linear")!.name).toBe("LINEAR_API_KEY");
    // First generic dup → _2.
    const dup = normalized.connectors.find((c) => c.id === "id_dup")!;
    expect(dup.type).toBe("api-key");
    expect(dup.name).toBe("LINEAR_API_KEY_2");
    expect(readSecret(instance, dup.secretRefs[0]!)).toBe("generic-dup-secret");
    // Second generic dup loops past the now-claimed _2 to the first free _3.
    const dup2 = normalized.connectors.find((c) => c.id === "id_dup2")!;
    expect(dup2.type).toBe("api-key");
    expect(dup2.name).toBe("LINEAR_API_KEY_3");
    expect(readSecret(instance, dup2.secretRefs[0]!)).toBe("generic-dup2-secret");
    // All three credential names are unique (no duplicate produced).
    const names = normalized.connectors.filter((c) => c.type).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // A collision audit per renamed record.
    const collisions = normalized.audit.filter((a) => a.action === "connector.migration_collision");
    expect(collisions.length).toBe(2);
    expect(collisions.map((c) => (c.evidence as { to?: string }).to).sort()).toEqual([
      "LINEAR_API_KEY_2",
      "LINEAR_API_KEY_3"
    ]);
  });

  test("leaves presence-only providers (demo) untyped", () => {
    const instance = "test-cred-presence";
    const state = createEmptyState(instance);
    // createEmptyState seeds a demo connector — leave it as-is.
    const normalized = normalizeState(instance, state);
    const demo = normalized.connectors.find((c) => c.provider === "demo");
    expect(demo).toBeDefined();
    expect(demo!.type).toBeUndefined();
  });
});
