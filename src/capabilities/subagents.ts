// Subagent orchestration.
//
// Slice 4: subagents are constrained child tasks. spawnSubagent creates a
// SubagentRecord, submits a chat-mode child task whose system prompt,
// toolset whitelist, and skill whitelist are taken from the record, and
// returns the record. The chat-task agent loop reads the linked subagent
// at runtime via getSubagentForTask and applies the constraints.
//
// The legacy single-arg spawn shape ({ name, prompt, toolsets? }) is
// preserved for back-compat with existing CLI calls — when systemPrompt
// is not provided, a generic "focused subagent" preamble is used.

import { cancelTask, submitTask } from "../agent";
import type { RuntimeConfig, RuntimeState, SubagentRecord, Task } from "../types";
import {
  appendTrace,
  createSubagentRecord,
  mutateState,
  now,
  readState
} from "../state";

// Default system prompt for a subagent when the caller doesn't provide one.
// Keep it short and behavioral: the model gets the user-facing `prompt` as
// its task input, plus the trusted-skill block and tool catalog as usual.
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  "You are a focused subagent inside the Gini runtime. " +
  "Your scope is the single task delegated to you by the parent agent. " +
  "Use the available tools to complete it, then return a concise final answer. " +
  "Do not spawn further subagents unless explicitly told to. " +
  "Stay within the toolsets and skills exposed in your system prompt.";

export interface SpawnSubagentInput {
  name?: string;
  prompt?: string;
  systemPrompt?: string;
  toolsets?: string[];
  skills?: string[];
  // Internal: when an agent loop spawns a child via the spawn_subagent tool,
  // it passes the parent task id so the SubagentRecord and the child task
  // both link back. Not part of the public API surface.
  parentTaskId?: string;
}

// Walk the parentTaskId chain back from `taskId` and return the depth in
// terms of subagent nesting (i.e. count of ancestor tasks that have a
// `subagentId`). The root user-submitted task has depth 0; a subagent
// spawned by it produces depth 1; grandchildren depth 2; etc.
export function subagentDepth(state: RuntimeState, taskId: string | undefined): number {
  let depth = 0;
  let cursor = taskId;
  // Cap the walk to avoid infinite loops if data is corrupted.
  for (let i = 0; i < 32 && cursor; i += 1) {
    const task = state.tasks.find((t) => t.id === cursor);
    if (!task) break;
    if (task.subagentId) depth += 1;
    cursor = task.parentTaskId;
  }
  return depth;
}

export const MAX_SUBAGENT_DEPTH = 3;

// Public spawner. Accepts an `input` bag (HTTP body / tool-call args).
// Returns the SubagentRecord (status "running" once the child task is
// submitted; legacy callers don't await completion).
export async function spawnSubagent(
  config: RuntimeConfig,
  input: SpawnSubagentInput | Record<string, unknown>
): Promise<SubagentRecord & { taskId: string }> {
  const prompt = String((input as SpawnSubagentInput).prompt ?? "");
  if (!prompt) throw new Error("Subagent prompt is required.");
  const name = String((input as SpawnSubagentInput).name ?? "Subagent");
  const systemPrompt =
    typeof (input as SpawnSubagentInput).systemPrompt === "string" && (input as SpawnSubagentInput).systemPrompt!.length > 0
      ? (input as SpawnSubagentInput).systemPrompt!
      : DEFAULT_SUBAGENT_SYSTEM_PROMPT;
  const toolsetIds = Array.isArray((input as SpawnSubagentInput).toolsets)
    ? (input as SpawnSubagentInput).toolsets!.map(String)
    : undefined;
  const skillNames = Array.isArray((input as SpawnSubagentInput).skills)
    ? (input as SpawnSubagentInput).skills!.map(String)
    : undefined;
  const parentTaskId =
    typeof (input as SpawnSubagentInput).parentTaskId === "string"
      ? (input as SpawnSubagentInput).parentTaskId
      : undefined;

  // Depth cap. We compute against a snapshot — race-free enough for the PoC
  // because the chain only grows as ancestors complete, and depth is
  // monotonic with respect to task creation order.
  if (parentTaskId) {
    const state = readState(config.instance);
    const depth = subagentDepth(state, parentTaskId);
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `max_subagent_depth_exceeded: parent chain already at depth ${depth} (cap ${MAX_SUBAGENT_DEPTH}).`
      );
    }
  }

  // Default toolsets list mirrors the legacy spawnSubagent default for
  // back-compat. We persist it on the record as the *advertised* toolsets;
  // the chat-task loop's filtering is governed by `toolsetIds` (which may
  // be undefined to mean "inherit").
  const advertisedToolsets = toolsetIds ?? ["file", "terminal", "memory", "session_search"];

  const subagent = await mutateState(config.instance, (state) =>
    createSubagentRecord(state, {
      name,
      prompt,
      parentTaskId,
      toolsets: advertisedToolsets,
      systemPrompt,
      toolsetIds,
      skillNames
    })
  );

  const task = await submitTask(config, prompt, {
    mode: "chat",
    parentTaskId,
    subagentId: subagent.id
  });

  await mutateState(config.instance, (state) => {
    const item = state.subagents.find((candidate) => candidate.id === subagent.id);
    if (!item) return;
    item.taskId = task.id;
    item.status = "running";
    item.updatedAt = now();
  });

  appendTrace(config.instance, task.id, {
    type: "tool",
    message: "Subagent spawned",
    data: {
      subagentId: subagent.id,
      parentTaskId,
      toolsetIds,
      skillNames,
      systemPromptBytes: systemPrompt.length
    }
  });

  return { ...subagent, taskId: task.id, status: "running", systemPrompt, toolsetIds, skillNames };
}

// Refresh subagent statuses by joining against their child tasks. Pulls
// summary/error onto resultSummary/resultError so callers don't need to
// resolve the task separately.
export async function refreshSubagents(config: RuntimeConfig): Promise<SubagentRecord[]> {
  return mutateState(config.instance, (state) => {
    for (const subagent of state.subagents) {
      if (!subagent.taskId) continue;
      if (
        subagent.status === "completed" ||
        subagent.status === "failed" ||
        subagent.status === "cancelled"
      ) {
        continue;
      }
      const task = state.tasks.find((item) => item.id === subagent.taskId);
      if (!task) continue;
      if (task.status === "completed") {
        subagent.status = "completed";
        subagent.completedAt = now();
        subagent.summary = task.summary;
        subagent.resultSummary = task.summary;
        subagent.updatedAt = subagent.completedAt;
      } else if (task.status === "failed") {
        subagent.status = "failed";
        subagent.completedAt = now();
        subagent.error = task.error;
        subagent.resultError = task.error;
        subagent.updatedAt = subagent.completedAt;
      } else if (task.status === "cancelled") {
        subagent.status = "cancelled";
        subagent.completedAt = now();
        subagent.error = subagent.error ?? "Cancelled";
        subagent.resultError = subagent.resultError ?? "Cancelled";
        subagent.updatedAt = subagent.completedAt;
      }
    }
    return state.subagents;
  });
}

export async function listSubagents(config: RuntimeConfig): Promise<SubagentRecord[]> {
  await refreshSubagents(config);
  return readState(config.instance).subagents;
}

// Cancel a running subagent by cancelling its underlying child task. The
// next refreshSubagents tick will mirror the cancelled task into the
// SubagentRecord. If the subagent has no taskId yet (still queued in the
// micro-window between createSubagentRecord and submitTask), we set the
// status directly to "cancelled".
export async function cancelSubagent(config: RuntimeConfig, subagentId: string): Promise<SubagentRecord> {
  const stage = await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) throw new Error(`Subagent not found: ${subagentId}`);
    return { taskId: sub.taskId, status: sub.status };
  });
  if (stage.taskId && stage.status !== "completed" && stage.status !== "failed" && stage.status !== "cancelled") {
    try {
      await cancelTask(config, stage.taskId);
    } catch {
      // Race: the task was finalized between read and cancel. Fall through
      // to refresh and let the join sync the record.
    }
  }
  await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) return;
    if (sub.status !== "completed" && sub.status !== "failed") {
      sub.status = "cancelled";
      sub.completedAt = sub.completedAt ?? now();
      sub.updatedAt = sub.completedAt;
    }
  });
  await refreshSubagents(config);
  const final = readState(config.instance).subagents.find((item) => item.id === subagentId);
  if (!final) throw new Error(`Subagent disappeared: ${subagentId}`);
  return final;
}

// Resolve the SubagentRecord for a given task, or undefined if the task
// isn't a subagent child. Used by the chat-task loop to apply constraints.
export function getSubagentForTask(state: RuntimeState, task: Task): SubagentRecord | undefined {
  if (!task.subagentId) return undefined;
  return state.subagents.find((item) => item.id === task.subagentId);
}

// Apply terminal status to the SubagentRecord linked to a task. Called from
// the chat-task loop right after the task transitions to a terminal state
// so the parent's polling loop sees the result on the next tick without
// waiting for an external refresh.
export async function syncSubagentFromTask(config: RuntimeConfig, task: Task): Promise<void> {
  if (!task.subagentId) return;
  await mutateState(config.instance, (state) => {
    const sub = state.subagents.find((item) => item.id === task.subagentId);
    if (!sub) return;
    if (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled") return;
    if (task.status === "completed") {
      sub.status = "completed";
      sub.completedAt = now();
      sub.summary = task.summary;
      sub.resultSummary = task.summary;
      sub.updatedAt = sub.completedAt;
    } else if (task.status === "failed") {
      sub.status = "failed";
      sub.completedAt = now();
      sub.error = task.error;
      sub.resultError = task.error;
      sub.updatedAt = sub.completedAt;
    } else if (task.status === "cancelled") {
      sub.status = "cancelled";
      sub.completedAt = now();
      sub.error = sub.error ?? "Cancelled";
      sub.resultError = sub.resultError ?? "Cancelled";
      sub.updatedAt = sub.completedAt;
    }
  });
}
