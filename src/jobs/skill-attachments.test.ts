// Job skill attachments (ADR job-skill-attachments.md). Covers:
//   - create/update validation: valid names persist; unknown/disabled names
//     reject with the bad entry named; the 8-name cap; duplicates dedupe;
//     [] / null clear.
//   - fire-time injection: the dispatched prompt carries the fenced skill
//     block (single-turn AND routed fan-out paths), the spawned task is
//     stamped with the resolved skill ids, and the inline trace is written.
//   - fire-time resilience: a skill disabled (or connector-inactive) after
//     create is SKIPPED with a trace event while the fire proceeds.
//   - size cap: inlined bodies share a 32k-char budget; the overflowing
//     skill is truncated with an in-prompt read_skill pointer and a trace.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { createScheduledJob, runJobNow, updateJob } from "./index";
import { closeAllMemoryDbs, mutateState, readState, readTrace } from "../state";
import { __registerHookForTest, __resetHooksForTest } from "../hooks";
import "../hooks/builtins";
import type { RuntimeConfig, RuntimeState, SkillRecord } from "../types";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7341,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-skill-attach-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-skill-attach-test-logs",
    approvalMode: "yolo"
  };
}

function pushSkill(
  state: RuntimeState,
  skill: Partial<SkillRecord> & Pick<SkillRecord, "name">
) {
  const { name, status, source, ...rest } = skill;
  state.skills.push({
    id: `skill_${name}`,
    instance: state.instance,
    name,
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: status ?? "enabled",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    source: source ?? "bundled",
    ...rest
  });
}

async function createSession(config: RuntimeConfig, id: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    state.chatSessions.unshift({
      id,
      instance: state.instance,
      title: "skill attach session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageIds: [],
      taskIds: [],
      runIds: []
    });
  });
}

describe("job skill attachments", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-skill-attach-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-attach-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    closeAllMemoryDbs();
    __resetHooksForTest();
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  describe("create/update validation", () => {
    test("valid skillNames persist on the JobRecord", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-valid");
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "google-calendar", body: "calendar recipe" });
        pushSkill(state, { name: "google-gmail", body: "gmail recipe" });
      });
      const job = await createScheduledJob(config, {
        name: "briefing",
        prompt: "morning briefing",
        intervalSeconds: 60,
        skillNames: ["google-calendar", "google-gmail"]
      });
      expect(job.skillNames).toEqual(["google-calendar", "google-gmail"]);
      // Round-trips through the state file.
      expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.skillNames)
        .toEqual(["google-calendar", "google-gmail"]);
    });

    test("an empty skillNames array normalizes to absent", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-empty");
      const job = await createScheduledJob(config, {
        name: "plain",
        prompt: "x",
        intervalSeconds: 60,
        skillNames: []
      });
      expect(job.skillNames).toBeUndefined();
    });

    test("duplicate skill names persist deduped and inline once per unique name", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-dupe");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_dupe";
      await createSession(config, session);
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "google-calendar", body: "calendar recipe" });
      });
      const job = await createScheduledJob(config, {
        name: "dupes",
        prompt: "go",
        intervalSeconds: 60,
        chatSessionId: session,
        skillNames: ["google-calendar", "google-calendar"]
      });
      expect(job.skillNames).toEqual(["google-calendar"]);

      await runJobNow(config, job.id, "manual");

      const task = readState(config.instance).tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      const occurrences = task!.input.split('<skill name="google-calendar"').length - 1;
      expect(occurrences).toBe(1);
    });

    test("an unknown skill name rejects, naming the bad entry", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-unknown");
      await expect(
        createScheduledJob(config, {
          name: "bad",
          prompt: "x",
          intervalSeconds: 60,
          skillNames: ["no-such-skill"]
        })
      ).rejects.toThrow('skillNames entry "no-such-skill" does not match any enabled skill');
    });

    test("a disabled skill name rejects, naming the bad entry", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-disabled");
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "dormant", status: "disabled" });
      });
      await expect(
        createScheduledJob(config, {
          name: "bad",
          prompt: "x",
          intervalSeconds: 60,
          skillNames: ["dormant"]
        })
      ).rejects.toThrow('skillNames entry "dormant" does not match any enabled skill');
    });

    test("more than 8 skill names rejects (per-fire prompt-growth cap)", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-cap");
      await expect(
        createScheduledJob(config, {
          name: "bad",
          prompt: "x",
          intervalSeconds: 60,
          skillNames: ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
        })
      ).rejects.toThrow("skillNames may list at most 8 skills");
    });

    test("non-string entries reject", async () => {
      const config = buildConfig(workspaceRoot, "attach-create-nonstring");
      await expect(
        createScheduledJob(config, {
          name: "bad",
          prompt: "x",
          intervalSeconds: 60,
          skillNames: [42]
        })
      ).rejects.toThrow("skillNames entries must be non-empty strings");
    });

    test("updateJob replaces the list, [] clears, null clears, unknown rejects", async () => {
      const config = buildConfig(workspaceRoot, "attach-update");
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "alpha" });
        pushSkill(state, { name: "beta" });
      });
      const job = await createScheduledJob(config, {
        name: "swap",
        prompt: "x",
        intervalSeconds: 60,
        skillNames: ["alpha"]
      });

      // Full replacement — no merge with the prior list.
      const replaced = await updateJob(config, job.id, { skillNames: ["beta"] });
      expect(replaced.skillNames).toEqual(["beta"]);

      // [] clears.
      const cleared = await updateJob(config, job.id, { skillNames: [] });
      expect(cleared.skillNames).toBeUndefined();

      // null clears too.
      await updateJob(config, job.id, { skillNames: ["beta"] });
      const nulled = await updateJob(config, job.id, { skillNames: null });
      expect(nulled.skillNames).toBeUndefined();

      // Unknown name rejects and leaves the record untouched.
      await updateJob(config, job.id, { skillNames: ["alpha"] });
      await expect(
        updateJob(config, job.id, { skillNames: ["nope"] })
      ).rejects.toThrow('skillNames entry "nope" does not match any enabled skill');
      expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.skillNames)
        .toEqual(["alpha"]);
    });
  });

  describe("fire-time injection", () => {
    test("the dispatched prompt carries the fenced skill block, task.skillIds, and the inline trace", async () => {
      const config = buildConfig(workspaceRoot, "attach-fire");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_fire";
      await createSession(config, session);
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "google-calendar", body: "Use `gws calendar events list` for today's events." });
      });
      const job = await createScheduledJob(config, {
        name: "briefing",
        prompt: "morning briefing",
        intervalSeconds: 60,
        chatSessionId: session,
        skillNames: ["google-calendar"]
      });

      await runJobNow(config, job.id, "manual");

      const state = readState(config.instance);
      const task = state.tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      expect(task!.input).toContain("Attached skill instructions (operator-registered");
      expect(task!.input).toContain('<skill name="google-calendar" version="1">');
      expect(task!.input).toContain("Use `gws calendar events list` for today's events.");
      expect(task!.input).toContain("</skill>");
      expect(task!.input).toContain("morning briefing");
      // The resolved skill id is stamped onto the spawned task.
      expect(task!.skillIds).toContain("skill_google-calendar");
      // The inline summary trace landed on the task.
      const trace = readTrace(config.instance, task!.id);
      const inlined = trace.find((entry) => entry.message === "Job skill attachments inlined");
      expect(inlined).toBeDefined();
      expect(inlined?.data?.skills).toEqual([{ name: "google-calendar", version: 1 }]);
    });

    test("a job without skillNames dispatches a prompt with no skill block (byte-identical assembly)", async () => {
      const config = buildConfig(workspaceRoot, "attach-fire-none");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_none";
      await createSession(config, session);
      const job = await createScheduledJob(config, {
        name: "plain",
        prompt: "just the prompt",
        intervalSeconds: 60,
        chatSessionId: session
      });

      await runJobNow(config, job.id, "manual");

      const task = readState(config.instance).tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      expect(task!.input).toContain("just the prompt");
      expect(task!.input).not.toContain("Attached skill instructions");
    });

    test("a skill disabled after create is skipped with a trace while the fire proceeds", async () => {
      const config = buildConfig(workspaceRoot, "attach-fire-skip");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_skip";
      await createSession(config, session);
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "fleeting", body: "ephemeral recipe" });
      });
      const job = await createScheduledJob(config, {
        name: "resilient",
        prompt: "carry on",
        intervalSeconds: 60,
        chatSessionId: session,
        skillNames: ["fleeting"]
      });
      // The skill goes away between create and fire.
      await mutateState(config.instance, (state) => {
        const skill = state.skills.find((s) => s.name === "fleeting");
        if (skill) skill.status = "disabled";
      });

      await runJobNow(config, job.id, "manual");

      const task = readState(config.instance).tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      expect(task!.input).toContain("carry on");
      expect(task!.input).not.toContain("Attached skill instructions");
      const trace = readTrace(config.instance, task!.id);
      const skip = trace.find((entry) =>
        entry.message?.includes("Job skill attachment skipped: fleeting")
      );
      expect(skip).toBeDefined();
    });

    test("a connector-inactive skill is skipped with a trace while the fire proceeds", async () => {
      const config = buildConfig(workspaceRoot, "attach-fire-inactive");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_inactive";
      await createSession(config, session);
      await mutateState(config.instance, (state) => {
        // Enabled but inactive: requires a credential no connector satisfies.
        pushSkill(state, { name: "gated", body: "gated recipe", requiredCredentials: ["MISSING_KEY"] });
      });
      const job = await createScheduledJob(config, {
        name: "gated-job",
        prompt: "carry on",
        intervalSeconds: 60,
        chatSessionId: session,
        skillNames: ["gated"]
      });

      await runJobNow(config, job.id, "manual");

      const task = readState(config.instance).tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      expect(task!.input).not.toContain("gated recipe");
      const trace = readTrace(config.instance, task!.id);
      const skip = trace.find((entry) =>
        entry.message?.includes("Job skill attachment skipped: gated")
      );
      expect(skip).toBeDefined();
      expect(skip?.message).toContain("inactive");
    });

    test("inlined bodies share the 32k-char budget; the overflowing skill truncates with a trace", async () => {
      const config = buildConfig(workspaceRoot, "attach-fire-truncate");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const session = "session_attach_trunc";
      await createSession(config, session);
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "big-a", body: "A".repeat(20_000) });
        pushSkill(state, { name: "big-b", body: "B".repeat(20_000) });
      });
      const job = await createScheduledJob(config, {
        name: "hefty",
        prompt: "go",
        intervalSeconds: 60,
        chatSessionId: session,
        skillNames: ["big-a", "big-b"]
      });

      await runJobNow(config, job.id, "manual");

      const task = readState(config.instance).tasks.find((t) => t.jobId === job.id);
      expect(task).toBeDefined();
      // big-a inlined in full; big-b cut to the remaining 12k of the budget.
      expect(task!.input).toContain("A".repeat(20_000));
      expect(task!.input).toContain("B".repeat(12_000));
      expect(task!.input).not.toContain("B".repeat(12_001));
      expect(task!.input).toContain('call read_skill("big-b") for the full instructions');
      const trace = readTrace(config.instance, task!.id);
      const truncation = trace.find((entry) =>
        entry.message?.includes("Job skill attachment truncated: big-b")
      );
      expect(truncation).toBeDefined();
    });

    test("routed fan-out workers carry the fenced skill block too", async () => {
      const config = buildConfig(workspaceRoot, "attach-fanout");
      const provider = normalizeProvider(config.provider);
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });
      const sessionA = "session_route_a";
      await createSession(config, sessionA);
      await mutateState(config.instance, (state) => {
        pushSkill(state, { name: "google-gmail", body: "Use `gws gmail messages list` for new mail." });
      });

      __registerHookForTest("test-attach-fanout", async () => ({
        kind: "context",
        buckets: { alpha: [{ text: "alpha item", untrusted: true }] },
        state: { alpha: { cursor: "a1" } }
      }));

      const job = await createScheduledJob(config, {
        name: "watch",
        intervalSeconds: 60,
        prompt: "handle the concern",
        preRunHook: { handlerId: "test-attach-fanout", config: {} },
        skillNames: ["google-gmail"]
      });
      await mutateState(config.instance, (state) => {
        const item = state.jobs.find((j) => j.id === job.id);
        if (item) item.routes = { alpha: { chatSessionId: sessionA } };
      });

      await runJobNow(config, job.id, "manual");

      const worker = readState(config.instance).tasks.find((t) => t.chatSessionId === sessionA);
      expect(worker).toBeDefined();
      expect(worker!.input).toContain('<skill name="google-gmail" version="1">');
      expect(worker!.input).toContain("Use `gws gmail messages list` for new mail.");
      expect(worker!.input).toContain("alpha item");
      // The inline trace landed on the worker task.
      const trace = readTrace(config.instance, worker!.id);
      expect(trace.some((entry) => entry.message === "Job skill attachments inlined")).toBe(true);
    });
  });
});
