import { describe, expect, test } from "bun:test";
import { createEmptyState, createImprovementProposal, createMemory, createTask, taskCounts } from "./state";

describe("state primitives", () => {
  test("creates lane-aware task records", () => {
    process.env.GINI_STATE_ROOT = "/tmp/gini-test-state";
    const task = createTask("sandbox", "remember useful context");
    expect(task.lane).toBe("sandbox");
    expect(task.status).toBe("queued");
    expect(task.tracePath).toContain("/tmp/gini-test-state/sandbox/traces/");
  });

  test("memory proposals are inspectable before activation", () => {
    const state = createEmptyState("dev");
    const memory = createMemory(state, {
      content: "Gini keeps receipts.",
      scope: "project",
      confidence: 0.8,
      status: "proposed",
      sensitivity: "normal",
      provenance: "test"
    });
    expect(memory.status).toBe("proposed");
    expect(state.memories[0]?.id).toBe(memory.id);
  });

  test("improvement proposals are governed before application", () => {
    const state = createEmptyState("sandbox");
    const proposal = createImprovementProposal(state, {
      kind: "skill",
      title: "Add review skill",
      rationale: "Trace showed repeated review steps.",
      sourceTraceIds: ["trace_a"],
      payload: { name: "review", steps: ["Inspect trace"] }
    });
    expect(proposal.status).toBe("proposed");
    expect(state.improvements[0]?.id).toBe(proposal.id);
    expect(state.audit[0]?.action).toBe("improvement.proposed");
  });

  test("task counts include all statuses", () => {
    const counts = taskCounts([
      createTask("dev", "one"),
      { ...createTask("dev", "two"), status: "completed" },
      { ...createTask("dev", "three"), status: "waiting_approval" }
    ]);
    expect(counts.queued).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.waiting_approval).toBe(1);
    expect(counts.failed).toBe(0);
  });
});
