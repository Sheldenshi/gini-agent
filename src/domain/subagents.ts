import { submitTask } from "../agent";
import type { RuntimeConfig } from "../types";
import { appendTrace, createSubagentRecord, mutateState, now, readState } from "../state";

export async function spawnSubagent(config: RuntimeConfig, input: Record<string, unknown>) {
  const prompt = String(input.prompt ?? "");
  if (!prompt) throw new Error("Subagent prompt is required.");
  const toolsets = Array.isArray(input.toolsets) ? input.toolsets.map(String) : ["file", "terminal", "memory", "session_search"];
  const parentTaskId = typeof input.parentTaskId === "string" ? input.parentTaskId : undefined;
  const name = String(input.name ?? "Subagent");

  const subagent = await mutateState(config.lane, (state) => createSubagentRecord(state, { name, prompt, parentTaskId, toolsets }));
  const task = await submitTask(config, prompt, undefined, parentTaskId, subagent.id);
  await mutateState(config.lane, (state) => {
    const item = state.subagents.find((candidate) => candidate.id === subagent.id);
    if (!item) return;
    item.taskId = task.id;
    item.status = "running";
    item.updatedAt = now();
  });
  appendTrace(config.lane, task.id, {
    type: "tool",
    message: "Subagent spawned",
    data: { subagentId: subagent.id, parentTaskId, toolsets }
  });
  return { ...subagent, taskId: task.id, status: "running" };
}

export async function refreshSubagents(config: RuntimeConfig) {
  return mutateState(config.lane, (state) => {
    for (const subagent of state.subagents) {
      if (!subagent.taskId || subagent.status === "completed" || subagent.status === "failed") continue;
      const task = state.tasks.find((item) => item.id === subagent.taskId);
      if (!task) continue;
      if (task.status === "completed") {
        subagent.status = "completed";
        subagent.completedAt = now();
        subagent.summary = task.summary;
        subagent.updatedAt = subagent.completedAt;
      }
      if (task.status === "failed") {
        subagent.status = "failed";
        subagent.completedAt = now();
        subagent.error = task.error;
        subagent.updatedAt = subagent.completedAt;
      }
    }
    return state.subagents;
  });
}

export async function listSubagents(config: RuntimeConfig) {
  await refreshSubagents(config);
  return readState(config.lane).subagents;
}
