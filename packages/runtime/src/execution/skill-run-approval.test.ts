// End-to-end tests for the skill_run approval gate: scripts a skill
// declares under `metadata.gini.requires.approval` always pause for an
// explicit user Approve/Deny — regardless of approval mode — while
// ungated scripts stay on the plain sync path. See ADR
// skill-script-approval-gating.md.
//
// Driven through the chat-task loop with the echo provider's stubbed
// tool-calling responses, same as approval-mode.test.ts: submit a task,
// let the model "call" skill_run, then verify the task outcome, the
// authorization row, and the audit trail. The gated script writes a
// marker file so execution (or its absence) is observable on disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { submitTask, decideApproval } from "../agent";
import { readState, mutateState } from "../state";
import type { RuntimeConfig, RuntimeState, Task } from "../types";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-skill-run-approval-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-skill-run-approval-test-logs",
    ...opts
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

async function waitForFinalTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach a final terminal state within ${timeoutMs}ms`);
}

// The gated script proves execution by writing args.marker to disk and
// echoes a JSON result the model would read back.
const SCRIPT_SOURCE = `
const buf = [];
for await (const c of Bun.stdin.stream()) buf.push(c);
const args = JSON.parse(Buffer.concat(buf).toString("utf8") || "{}");
if (args.marker) await Bun.write(args.marker, "ran");
process.stdout.write(JSON.stringify({ ok: true, echoed: args.value ?? null }));
`;

// Seed an enabled on-disk skill named `caller` whose scripts dir ships
// gated.ts (listed in requiresApprovalScripts) and plain.ts (ungated).
async function seedSkill(instance: string, skillsRoot: string): Promise<void> {
  const scriptsDir = join(skillsRoot, "caller", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, "gated.ts"), SCRIPT_SOURCE);
  writeFileSync(join(scriptsDir, "plain.ts"), SCRIPT_SOURCE);
  await mutateState(instance, (state: RuntimeState) => {
    state.skills.push({
      id: "skill_caller",
      instance: state.instance,
      name: "caller",
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
      source: "bundled",
      manifestPath: join(skillsRoot, "caller", "SKILL.md"),
      requiresApprovalScripts: ["gated"]
    });
  });
}

describe("skill_run approval gate", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-skill-run-approval-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("gated script pauses for approval even in yolo mode, with payload + args preview", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-run-ws-"));
    const config = buildConfig(workspaceRoot, "gate-yolo", { approvalMode: "yolo" });
    await seedSkill(config.instance, join(workspaceRoot, "skills"));
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_g", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skill: "caller", script: "gated", args: { value: 7 } }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "run the gated script", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    const state = readState(config.instance);
    const approval = state.authorizations.find((a) => a.taskId === task.id);
    expect(approval).toBeDefined();
    expect(approval?.action).toBe("skill.run");
    expect(approval?.target).toBe("caller/gated");
    expect(approval?.risk).toBe("high");
    expect(approval?.status).toBe("pending");
    // The card's reason carries the compact args preview the user reads.
    expect(approval?.reason).toContain("Run skill script caller/gated");
    expect(approval?.reason).toContain('"value":7');
    expect(approval?.payload).toMatchObject({
      skillName: "caller",
      scriptName: "gated",
      scriptArgs: { value: 7 },
      toolCallId: "call_g"
    });

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("approve executes the script and resumes the task", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-run-ws-"));
    const config = buildConfig(workspaceRoot, "gate-approve", { approvalMode: "yolo" });
    await seedSkill(config.instance, join(workspaceRoot, "skills"));
    const provider = normalizeProvider(config.provider);
    const marker = join(workspaceRoot, "gated-ran.txt");

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_g", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skill: "caller", script: "gated", args: { marker, value: 7 } }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "ran it", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "run the gated script", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(existsSync(marker)).toBe(false);

    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(existsSync(marker)).toBe(true);

    const state = readState(config.instance);
    const runAudits = state.audit.filter((a) => a.action === "skill.run" && a.taskId === task.id);
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]?.target).toBe("caller/gated");
    expect(runAudits[0]?.evidence?.ok).toBe(true);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("deny fails the task without running the script", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-run-ws-"));
    const config = buildConfig(workspaceRoot, "gate-deny", { approvalMode: "yolo" });
    await seedSkill(config.instance, join(workspaceRoot, "skills"));
    const provider = normalizeProvider(config.provider);
    const marker = join(workspaceRoot, "gated-ran.txt");

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_g", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skill: "caller", script: "gated", args: { marker } }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "run the gated script", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    await decideApproval(config, paused.approvalIds[0]!, "deny");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("Approval denied: caller/gated");
    expect(existsSync(marker)).toBe(false);

    const state = readState(config.instance);
    expect(state.audit.filter((a) => a.action === "skill.run" && a.taskId === task.id)).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("ungated script runs sync with no authorization row, even in strict mode", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-run-ws-"));
    const config = buildConfig(workspaceRoot, "gate-plain", { approvalMode: "strict" });
    await seedSkill(config.instance, join(workspaceRoot, "skills"));
    const provider = normalizeProvider(config.provider);
    const marker = join(workspaceRoot, "plain-ran.txt");

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_p", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skill: "caller", script: "plain", args: { marker } }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "ran it", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "run the plain script", { mode: "chat" });
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(existsSync(marker)).toBe(true);
    expect(readState(config.instance).authorizations.filter((a) => a.taskId === task.id)).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("approve fails the tool result cleanly when the skill was disabled after the pause", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-skill-run-ws-"));
    const config = buildConfig(workspaceRoot, "gate-disabled", { approvalMode: "yolo" });
    await seedSkill(config.instance, join(workspaceRoot, "skills"));
    const provider = normalizeProvider(config.provider);
    const marker = join(workspaceRoot, "gated-ran.txt");

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_g", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skill: "caller", script: "gated", args: { marker } }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "could not run it", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "run the gated script", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    await mutateState(config.instance, (state: RuntimeState) => {
      const skill = state.skills.find((s) => s.name === "caller");
      if (skill) skill.status = "disabled";
    });

    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    // The model gets a clean { ok: false } tool result and finishes its
    // turn; the script never ran.
    expect(finished.status).toBe("completed");
    expect(existsSync(marker)).toBe(false);

    const state = readState(config.instance);
    const runAudits = state.audit.filter((a) => a.action === "skill.run" && a.taskId === task.id);
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]?.evidence?.ok).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
