import type { RuntimeConfig } from "../types";
import { addAudit, createMemory, mutateState, now } from "../state";
import { resolveEffectiveContext } from "../execution/effective-context";

export async function createMemoryFromInput(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => {
    // Phase C — stamp the active agent on every new MemoryRecord so the
    // pinned-memory block and /api/memory listings show the right agent's
    // pool. Reject loud when no agent is active so we don't silently leak
    // into a default pool.
    const effective = resolveEffectiveContext(state, config);
    if (!effective.agentId) throw new Error("Cannot create memory: no active agent.");
    return createMemory(state, {
      agentId: effective.agentId,
      content: String(input.content ?? ""),
      confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
      status: String(input.status ?? "active") === "proposed" ? "proposed" : "active",
      sensitivity: input.sensitivity === "sensitive" ? "sensitive" : "normal",
      provenance: String(input.provenance ?? "Created by user")
    });
  });
}

export async function updateMemory(config: RuntimeConfig, memoryId: string, statusValue: "active" | "rejected") {
  return mutateState(config.instance, (state) => {
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
  return mutateState(config.instance, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (typeof input.content === "string") memory.content = input.content;
    if (typeof input.confidence === "number") memory.confidence = Math.max(0, Math.min(1, input.confidence));
    if (input.sensitivity === "normal" || input.sensitivity === "sensitive") memory.sensitivity = input.sensitivity;
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "memory.edited",
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId,
      evidence: { sensitivity: memory.sensitivity }
    });
    return memory;
  });
}

export async function archiveMemory(config: RuntimeConfig, memoryId: string) {
  return mutateState(config.instance, (state) => {
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
