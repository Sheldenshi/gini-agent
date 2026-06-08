// Coverage for the self-config / introspection registry and its direct-tool
// dispatch surface.
//
// The registry (self-registry.ts) is the single source of truth for the
// self-config operation BEHAVIOR (handler + tag + audit). Each capability is
// exposed to the agent loop as a direct deferred tool whose NAME is the op
// name; dispatch routes the self tool cases through dispatchSelfOp. The
// dispatch-level tests exercise the route-by-tag logic (query sync, mutate
// gated-vs-auto) against a seeded RuntimeConfig + state, reusing the same
// fixture shape as tool-dispatch.test.ts. Args are passed at TOP LEVEL (no
// {name, args} envelope) — that is the contract this file pins.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  test("SELF_OPERATIONS carries the 25 expected ops with name, summary, tag, handler", () => {
    expect(SELF_OPERATIONS.length).toBe(25);
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
      "add_mcp_server",
      "create_agent",
      "delete_agent",
      "disable_toolset",
      "enable_toolset",
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills",
      "list_toolsets",
      "remove_connector",
      "remove_mcp_server",
      "remove_provider",
      "rename_agent",
      "rollback_skill",
      "rotate_connector",
      "set_approval_mode",
      "set_auto_approve_commands",
      "set_dangerous_patterns",
      "set_provider",
      "test_skill",
      "update_self",
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
      "list_skills",
      "list_toolsets"
    ]);
    expect(mutates).toEqual([
      "add_mcp_server",
      "create_agent",
      "delete_agent",
      "disable_toolset",
      "enable_toolset",
      "remove_connector",
      "remove_mcp_server",
      "remove_provider",
      "rename_agent",
      "rollback_skill",
      "rotate_connector",
      "set_approval_mode",
      "set_auto_approve_commands",
      "set_dangerous_patterns",
      "set_provider",
      "test_skill",
      "update_self",
      "use_agent"
    ]);
  });

  test("findSelfOperation resolves known names and rejects unknown ones", () => {
    expect(findSelfOperation("nope")).toBeUndefined();
    expect(findSelfOperation("get_self")).toBeDefined();
    expect(findSelfOperation("set_provider")?.tag).toBe("mutate");
  });

  test("test_skill is tagged mutate because it records a pass/fail counter on the skill", () => {
    expect(findSelfOperation("test_skill")?.tag).toBe("mutate");
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
      const parsed = JSON.parse(result.result) as {
        ok: boolean;
        instance: string;
        approvalSettings: { approvalMode: string; autoApproveCommands: unknown[]; dangerousTerminalPatterns: unknown[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.instance).toBe(instance);
      // get_self now exposes the full approval picture so the model can
      // read the allowlist before a replace via set_auto_approve_commands.
      expect(parsed.approvalSettings.approvalMode).toBe("auto");
      expect(Array.isArray(parsed.approvalSettings.autoApproveCommands)).toBe(true);
      expect(Array.isArray(parsed.approvalSettings.dangerousTerminalPatterns)).toBe(true);
    }
  });

  test("list_toolsets resolves synchronously with the instance toolsets", async () => {
    const instance = `self-toolsets-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "list_toolsets", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; toolsets: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.toolsets)).toBe(true);
    }
  });

  test("list_skills takes its filter args at top level (no {name,args} envelope)", async () => {
    const instance = `self-skills-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const skillDir = join(ROOT, instance, "skills", "scripted");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "scripts", "run.ts"), "console.log('{}')");
    await mutateState(config.instance, (state) => {
      state.skills.push({
        id: "skill_scripted",
        instance: config.instance,
        name: "scripted",
        description: "Scripted skill",
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
        source: "user",
        manifestPath: join(skillDir, "SKILL.md")
      });
    });
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
      const parsed = JSON.parse(result.result) as { ok: boolean; skills: Array<{ name: string; scripts?: string[] }> };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.skills)).toBe(true);
      expect(parsed.skills.find((skill) => skill.name === "scripted")?.scripts).toEqual(["run"]);
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

  test("set_provider forwards azure routing fields (apiVersion/deployment/authScheme) to the config", async () => {
    const instance = `self-setprov-azure-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    // setSetupProvider writes the api key to $HOME/.gini/secrets.env and may
    // probe for an autostart plist — sandbox HOME and skip the refresh so this
    // test never touches the real home dir or spawns a launchd refresh.
    const originalHome = process.env.HOME;
    const originalKey = process.env.OPENAI_API_KEY;
    const originalSkip = process.env.GINI_SKIP_PLIST_REFRESH;
    const sandboxHome = mkdtempSync(join(tmpdir(), "gini-self-azure-home-"));
    process.env.HOME = sandboxHome;
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-azure-key",
          baseUrl: "https://lilac-labs-w.openai.azure.com",
          apiVersion: "2024-12-01-preview",
          deployment: "gpt-5.4",
          authScheme: "api-key"
        })
      );
      expect(result.kind).toBe("sync");
      expect(config.provider.name).toBe("openai");
      expect(config.provider.baseUrl).toBe("https://lilac-labs-w.openai.azure.com");
      expect(config.provider.apiVersion).toBe("2024-12-01-preview");
      expect(config.provider.deployment).toBe("gpt-5.4");
      expect(config.provider.authScheme).toBe("api-key");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalSkip === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
      else process.env.GINI_SKIP_PLIST_REFRESH = originalSkip;
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  test("set_provider clears azure routing when blank transport fields are passed", async () => {
    const instance = `self-setprov-clear-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    config.provider = {
      name: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://lilac-labs-w.openai.azure.com",
      apiVersion: "2024-12-01-preview",
      deployment: "gpt-5.4",
      authScheme: "api-key"
    };
    const taskId = await newTask(config);
    const originalHome = process.env.HOME;
    const originalKey = process.env.OPENAI_API_KEY;
    const originalSkip = process.env.GINI_SKIP_PLIST_REFRESH;
    const sandboxHome = mkdtempSync(join(tmpdir(), "gini-self-azclear-home-"));
    process.env.HOME = sandboxHome;
    process.env.OPENAI_API_KEY = "sk-existing";
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    try {
      // The agent passes blank transport fields to clear Azure routing — the
      // present-blank values clear, swapping back to standard OpenAI.
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({ provider: "openai", baseUrl: "", apiVersion: "", deployment: "" })
      );
      expect(result.kind).toBe("sync");
      expect(config.provider.name).toBe("openai");
      expect(config.provider.baseUrl).toBe("https://api.openai.com/v1");
      expect(config.provider.apiVersion).toBeUndefined();
      expect(config.provider.deployment).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalSkip === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
      else process.env.GINI_SKIP_PLIST_REFRESH = originalSkip;
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  test("auto-resolving a self.config op scrubs secret args from the resolved approval payload", async () => {
    const instance = `self-scrub-payload-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_provider",
      "call_1",
      JSON.stringify({ provider: "echo", apiKey: "sk-super-secret" })
    );
    expect(result.kind).toBe("sync");
    // The handler ran on approval (the real apiKey reached setSetupProvider),
    // but the now-resolved authorization row served to clients must not retain
    // the credential — executeApprovedAction redacts payload.args after the run.
    const state = readState(instance);
    const approval = state.authorizations.find(
      (a) => a.action === "self.config" && (a.payload.opName as string) === "set_provider"
    );
    expect(approval).toBeDefined();
    const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
    expect(payloadArgs?.apiKey).toBe("[redacted]");
    // Non-secret args still survive so the historical row stays legible.
    expect(payloadArgs?.provider).toBe("echo");
  });

  test("set_approval_mode auto-resolves in auto mode and lands the side effect on config", async () => {
    const instance = `self-approval-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_approval_mode",
      "call_1",
      JSON.stringify({ mode: "yolo" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; approvalMode?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.approvalMode).toBe("yolo");
    }
    // updateAutoApproveSettings mutates the live config object in-process.
    expect(config.approvalMode).toBe("yolo");
  });

  test("set_approval_mode rejects an invalid mode without throwing", async () => {
    const instance = `self-approval-bad-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_approval_mode",
      "call_1",
      JSON.stringify({ mode: "nope" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    // The bad call left the config's mode untouched.
    expect(config.approvalMode).toBe("auto");
  });

  test("disable_toolset auto-resolves in auto mode and flips the toolset status", async () => {
    const instance = `self-toolset-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_toolset",
      "call_1",
      JSON.stringify({ toolset: "browser" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; status?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe("disabled");
    }
    const state = readState(instance);
    expect(state.toolsets.find((t) => t.name === "browser")?.status).toBe("disabled");
  });

  test("disable_toolset gates as pending in strict mode with payload.opName set", async () => {
    const instance = `self-toolset-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_toolset",
      "call_1",
      JSON.stringify({ toolset: "browser" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval?.action).toBe("self.config");
      expect(approval?.payload.opName).toBe("disable_toolset");
    }
  });

  test("set_auto_approve_commands replaces the allowlist in auto mode", async () => {
    const instance = `self-allowlist-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: ["git status", "ls"] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; autoApproveCommands?: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.autoApproveCommands).toEqual(["git status", "ls"]);
    }
    // updateAutoApproveSettings mutates the live config object in-process.
    expect(config.autoApproveCommands).toEqual(["git status", "ls"]);
  });

  test("set_auto_approve_commands rejects a non-array 'patterns' without throwing", async () => {
    const instance = `self-allowlist-bad-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: "git " })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    expect(config.autoApproveCommands).toBeUndefined();
  });

  test("set_auto_approve_commands rejects non-string elements without wiping the saved list", async () => {
    const instance = `self-allowlist-nonstring-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    config.autoApproveCommands = ["git status"];
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: [123] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    // The setter was never called, so the saved allowlist is untouched —
    // a [123] payload must NOT silently overwrite it with an empty list.
    expect(config.autoApproveCommands).toEqual(["git status"]);
  });

  test("set_dangerous_patterns rejects non-string elements without wiping the saved list", async () => {
    const instance = `self-danger-nonstring-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    config.dangerousTerminalPatterns = ["rm -rf"];
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_dangerous_patterns",
      "call_1",
      JSON.stringify({ patterns: [123] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    expect(config.dangerousTerminalPatterns).toEqual(["rm -rf"]);
  });

  test("rotate_connector rejects a supplied purpose that doesn't exist on the connector", async () => {
    const instance = `self-rotate-badpurpose-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    // Seed a connector with a single secret slot named "token". The handler
    // checks the supplied purpose against the connector's secretRefs BEFORE
    // calling updateConnector, so it never reaches the secret-write path.
    await mutateState(instance, (state) => {
      state.connectors.push({
        id: "conn_rotate_1",
        instance,
        name: "rotate-test",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [{ purpose: "token", path: "conn_rotate_1/token" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "unknown",
        source: "user"
      });
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "rotate_connector",
      "call_1",
      JSON.stringify({ connector: "conn_rotate_1", token: "new-secret", purpose: "ghost" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("ghost");
    }
    // The bogus purpose did NOT get appended as a new secret slot.
    const after = readState(instance).connectors.find((c) => c.id === "conn_rotate_1");
    expect(after?.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
  });

  test("test_skill routes through the seam and reports a missing skill as {ok:false}", async () => {
    const instance = `self-testskill-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "test_skill",
      "call_1",
      JSON.stringify({ skillId: "does_not_exist" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
  });
});
