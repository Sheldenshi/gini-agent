import { describe, expect, test } from "bun:test";
import { createEmptyState, createImprovementProposal, createMemory, createPromotionProposal, createTask, decidePromotion, taskCounts } from "./state";

describe("state primitives", () => {
  test("creates lane-aware task records", () => {
    const task = createTask("sandbox", "remember useful context");
    expect(task.lane).toBe("sandbox");
    expect(task.status).toBe("queued");
    expect(task.tracePath).toContain("/sandbox/traces/");
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

  test("promotion proposals are explicit review records", () => {
    const state = createEmptyState("sandbox");
    const proposal = createPromotionProposal(state, {
      candidateRef: "abc123",
      evidencePath: "/tmp/evidence.json",
      summary: "Promote tested candidate",
      rollbackPlan: "Restore snapshot snap_1"
    });
    const approved = decidePromotion(state, proposal.id, "approve");
    expect(approved.status).toBe("approved");
    expect(state.audit.some((event) => event.action === "promotion.approved")).toBe(true);
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
