// Tests for install_skill / enable_skill / disable_skill dispatch.
// Exercises tool registration plus the happy-path lifecycle (install,
// disable, re-enable) and validation errors.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { sep } from "node:path";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig, RuntimeState, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-skill-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
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
    tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
    connectors: [], improvements: [], pairingCodes: [], devices: [],
    promotions: [], snapshots: [], tools: [], toolsets, subagents: [],
    mcpServers: [], messagingBridges: [], importReports: [], agents: [],
    activeAgentId: undefined, relays: [], notifications: [], events: [],
    jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
    runs: [], planSteps: []
  };
}

const SKILL_BODY = `---
name: dispatch-test-skill
description: Synthetic skill for dispatch tests.
trigger: When dispatch tests fire.
---

# Dispatch test skill

This skill is created from inside the unit test suite. It does nothing
useful — its body just needs to parse so the manifest validator accepts
it.

## Steps

1. Do nothing.
2. Confirm nothing happened.
`;

describe("skill tool registration", () => {
  test("install_skill registers under 'skills' and requires body", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "install_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["body"]);
  });

  test("enable_skill registers under 'skills' and requires skillId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "enable_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["skillId"]);
  });

  test("disable_skill registers under 'skills' and requires skillId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "disable_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["skillId"]);
  });
});

describe("install_skill dispatch", () => {
  test("lands a minimal SKILL.md and emits skill.installed audit", async () => {
    const config = makeConfig("install-skill-happy");
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_install",
      JSON.stringify({ body: SKILL_BODY })
    );
    expect(result.kind).toBe("sync");
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    if (result.kind === "sync") {
      expect(result.result).toContain(skill!.id);
    }

    // User installs land flat in the instance skills root — no grouping
    // subfolder (and specifically not a "user" one). Category folders are a
    // bundled-skill convention, so a flat user skill carries no category.
    expect(skill!.manifestPath?.endsWith(`${sep}skills${sep}dispatch-test-skill${sep}SKILL.md`)).toBe(true);
    expect(skill!.manifestPath).not.toContain(`${sep}skills${sep}user${sep}`);
    expect(skill!.category).toBeUndefined();

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "skill.installed" && event.actor === "agent" && event.target === skill!.id
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.skillId).toBe(skill!.id);
    expect(audit?.evidence?.name).toBe("dispatch-test-skill");
  });

  test("stays flat even when a category arg is passed", async () => {
    const config = makeConfig("install-skill-category");
    const taskId = await seedTask(config);

    // A stray `category` arg is ignored — user skills never nest.
    const result = await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_install_cat",
      JSON.stringify({ body: SKILL_BODY, category: "team-tools" })
    );
    expect(result.kind).toBe("sync");
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    expect(skill!.manifestPath?.endsWith(`${sep}skills${sep}dispatch-test-skill${sep}SKILL.md`)).toBe(true);
    expect(skill!.manifestPath).not.toContain(`${sep}skills${sep}team-tools${sep}`);
    expect(skill!.category).toBeUndefined();
  });

  test("rejects missing body", async () => {
    const config = makeConfig("install-skill-no-body");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "install_skill", "call_no_body", JSON.stringify({}))
    ).rejects.toThrow(/body/);
  });
});

describe("enable_skill / disable_skill dispatch", () => {
  test("disable_skill flips status and writes a disable audit", async () => {
    const config = makeConfig("skill-disable-happy");
    const taskId = await seedTask(config);
    // Install the skill so we have something to flip.
    await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_pre_install",
      JSON.stringify({ body: SKILL_BODY })
    );
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();

    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_skill",
      "call_disable",
      JSON.stringify({ skillId: skill!.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Disabled skill");
      expect(result.result).toContain(skill!.id);
    }

    const after = readState(config.instance).skills.find((s) => s.id === skill!.id);
    expect(after?.status).toBe("disabled");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "skill.disabled" && event.target === skill!.id
    );
    expect(audit).toBeDefined();
  });

  test("enable_skill flips status back to enabled", async () => {
    const config = makeConfig("skill-enable-happy");
    const taskId = await seedTask(config);
    await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_pre_install2",
      JSON.stringify({ body: SKILL_BODY })
    );
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    // Disable first.
    await dispatchToolCall(
      config,
      taskId,
      "disable_skill",
      "call_disable2",
      JSON.stringify({ skillId: skill!.id })
    );
    // Then re-enable.
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_enable",
      JSON.stringify({ skillId: skill!.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Enabled skill");
    }
    const after = readState(config.instance).skills.find((s) => s.id === skill!.id);
    expect(after?.status).toBe("enabled");
  });

  test("enable_skill rejects unknown skill id", async () => {
    const config = makeConfig("skill-enable-unknown");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "enable_skill",
        "call_bad",
        JSON.stringify({ skillId: "skill_nope" })
      )
    ).rejects.toThrow(/Skill not found/);
  });
});
