import type { RuntimeConfig } from "../types";
import { addAudit, createMemory, mutateState, now } from "../state";

export async function createMemoryFromInput(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.lane, (state) => createMemory(state, {
    content: String(input.content ?? ""),
    scope: normalizeScope(input.scope),
    confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
    status: String(input.status ?? "active") === "proposed" ? "proposed" : "active",
    sensitivity: input.sensitivity === "sensitive" ? "sensitive" : "normal",
    provenance: String(input.provenance ?? "Created by user")
  }));
}

export async function updateMemory(config: RuntimeConfig, memoryId: string, statusValue: "active" | "rejected") {
  return mutateState(config.lane, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    memory.status = statusValue;
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `memory.${statusValue === "active" ? "approved" : "rejected"}`,
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId
    });
    return memory;
  });
}

export async function editMemory(config: RuntimeConfig, memoryId: string, input: Record<string, unknown>) {
  return mutateState(config.lane, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (typeof input.content === "string") memory.content = input.content;
    if (typeof input.scope === "string") memory.scope = normalizeScope(input.scope);
    if (typeof input.confidence === "number") memory.confidence = Math.max(0, Math.min(1, input.confidence));
    if (input.sensitivity === "normal" || input.sensitivity === "sensitive") memory.sensitivity = input.sensitivity;
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "memory.edited",
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId,
      evidence: { scope: memory.scope, sensitivity: memory.sensitivity }
    });
    return memory;
  });
}

export async function archiveMemory(config: RuntimeConfig, memoryId: string) {
  return mutateState(config.lane, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    memory.status = "archived";
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "memory.archived",
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId
    });
    return memory;
  });
}

function normalizeScope(value: unknown): "user" | "project" | "device" | "temporary" {
  return value === "user" || value === "device" || value === "temporary" ? value : "project";
}
