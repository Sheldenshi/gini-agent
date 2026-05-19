// Tests for the Slice 4 subagent runtime: spawn_subagent tool dispatch,
// nesting-depth cap, end-to-end summary propagation, and parent-cancel
// cascade.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { cancelTask, submitTask } from "../agent";
import { mutateState, readState } from "../state";
import type { RuntimeConfig, Task } from "../types";
import { MAX_SUBAGENT_DEPTH, spawnSubagent, subagentDepth } from "./subagents";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-subagent-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-subagent-test-logs",
    // Keep these tests on the gated path; they assert pause + cascade
    // behavior that needs an approval row to land.
    approvalMode: "strict"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 8000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")
    ) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("subagent runtime (Slice 4)", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-subagent-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-subagent-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  test("spawn_subagent tool creates a record + child task with the right system prompt and constraints", async () => {
    const config = buildConfig(workspaceRoot, "subagent-spawn");
    const provider = normalizeProvider(config.provider);

    // Parent turn 1: model calls spawn_subagent.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({
              name: "research",
              prompt: "find a thing",
              system_prompt: "You are a research assistant. Be terse.",
              toolsets: ["file"],
              skills: ["apple-notes"]
            })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn: it just answers directly.
    setEchoToolCallingResponse({
      provider,
      text: "found one thing",
      toolCalls: [],
      finishReason: "stop"
    });
    // Parent turn 2: final answer.
    setEchoToolCallingResponse({
      provider,
      text: "Subagent reports: found one thing",
      toolCalls: [],
      finishReason: "stop"
    });

    const parent = await submitTask(config, "delegate this", { mode: "chat" });
    const finished = await waitForTerminal(config, parent.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Subagent reports: found one thing");

    const state = readState(config.instance);
    expect(state.subagents.length).toBe(1);
    const sub = state.subagents[0]!;
    expect(sub.name).toBe("research");
    expect(sub.prompt).toBe("find a thing");
    expect(sub.systemPrompt).toBe("You are a research assistant. Be terse.");
    expect(sub.toolsetIds).toEqual(["file"]);
    expect(sub.skillNames).toEqual(["apple-notes"]);
    expect(sub.parentTaskId).toBe(parent.id);
    expect(sub.taskId).toBeDefined();
    expect(sub.status).toBe("completed");
    expect(sub.resultSummary).toBe("found one thing");

    // The child task linked to the subagent should be a chat-mode task.
    const childTask = state.tasks.find((t) => t.id === sub.taskId);
    expect(childTask).toBeDefined();
    expect(childTask?.mode).toBe("chat");
    expect(childTask?.subagentId).toBe(sub.id);
    expect(childTask?.parentTaskId).toBe(parent.id);

    // The audit trail should include subagent.spawn (medium risk).
    const spawnAudits = state.audit.filter((a) => a.action === "subagent.spawn");
    expect(spawnAudits.length).toBe(1);
    expect(spawnAudits[0]?.risk).toBe("medium");
    expect(spawnAudits[0]?.taskId).toBe(parent.id);
  });

  test("nesting depth cap rejects spawning past depth 3", async () => {
    const config = buildConfig(workspaceRoot, "subagent-depth");

    // Synthesize a depth-3 ancestor chain in state directly (simpler than
    // running 4 nested chat loops). subagentDepth walks parentTaskId; tasks
    // must each carry a subagentId to count as a subagent ancestor.
    const built = await mutateState(config.instance, (state) => {
      const ids: string[] = [];
      let parentTaskId: string | undefined = undefined;
      for (let i = 0; i < 3; i += 1) {
        const subagentId = `sub_${i}`;
        const taskId = `task_${i}`;
        state.subagents.unshift({
          id: subagentId,
          instance: state.instance,
          name: `level-${i}`,
          prompt: "",
          status: "running",
          parentTaskId,
          taskId,
          toolsets: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          systemPrompt: ""
        });
        state.tasks.unshift({
          id: taskId,
          title: `level-${i}`,
          input: "",
          status: "running",
          instance: state.instance,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tracePath: "",
          auditIds: [],
          approvalIds: [],
          memoryIds: [],
          skillIds: [],
          parentTaskId,
          subagentId,
          mode: "chat"
        });
        ids.push(taskId);
        parentTaskId = taskId;
      }
      return { ids };
    });

    // The deepest existing task is at depth 3 (3 ancestors with subagentId).
    const state = readState(config.instance);
    const deepest = built.ids[built.ids.length - 1]!;
    expect(subagentDepth(state, deepest)).toBe(3);

    // Spawning from the deepest task should be rejected.
    let caught: Error | undefined;
    try {
      await spawnSubagent(config, {
        name: "too-deep",
        prompt: "shouldn't run",
        parentTaskId: deepest
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("max_subagent_depth_exceeded");
    // No new subagent record was created beyond the synthetic 3.
    const after = readState(config.instance);
    expect(after.subagents.length).toBe(3);
  });

  test("MAX_SUBAGENT_DEPTH constant is 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  test("cancelling the parent task cancels in-flight subagent descendants", async () => {
    const config = buildConfig(workspaceRoot, "subagent-cancel");
    const provider = normalizeProvider(config.provider);

    // Parent: spawn a subagent. Subagent then makes a tool call to file_write
    // which gates on approval — the subagent task pauses, we cancel the
    // parent, and the cascade should hit the child task.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_spawn",
          type: "function",
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({ name: "writer", prompt: "write a file" })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    // Subagent turn 1: tries to write.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: {
            name: "file_write",
            arguments: JSON.stringify({ path: "out.txt", content: "ok" })
          }
        }
      ],
      finishReason: "tool_calls"
    });

    const parent = await submitTask(config, "delegate a write", { mode: "chat" });

    // Wait for the subagent task to pause on the file_write approval.
    const deadline = Date.now() + 8000;
    let pausedSubTaskId: string | undefined;
    while (Date.now() < deadline) {
      const state = readState(config.instance);
      const sub = state.subagents.find((s) => s.parentTaskId === parent.id);
      if (sub && sub.taskId) {
        const subTask = state.tasks.find((t) => t.id === sub.taskId);
        if (subTask?.status === "waiting_approval") {
          pausedSubTaskId = subTask.id;
          break;
        }
      }
      await Bun.sleep(20);
    }
    expect(pausedSubTaskId).toBeDefined();

    // Cancel the parent — should cascade to the child.
    await cancelTask(config, parent.id);

    // Wait for the cascade + the parent's chat-task loop to settle so
    // the test root isn't torn down with in-flight mutateState calls.
    const settleDeadline = Date.now() + 5000;
    while (Date.now() < settleDeadline) {
      const state = readState(config.instance);
      const childTask = state.tasks.find((t) => t.id === pausedSubTaskId);
      const parentTask = state.tasks.find((t) => t.id === parent.id);
      const parentSettled =
        parentTask?.status === "cancelled" ||
        parentTask?.status === "failed" ||
        parentTask?.status === "completed";
      if (childTask?.status === "cancelled" && parentSettled) {
        break;
      }
      await Bun.sleep(20);
    }

    const stateAfter = readState(config.instance);
    const child = stateAfter.tasks.find((t) => t.id === pausedSubTaskId);
    expect(child?.status).toBe("cancelled");
    const subRecord = stateAfter.subagents.find((s) => s.parentTaskId === parent.id);
    expect(subRecord?.status).toBe("cancelled");
  });
});
