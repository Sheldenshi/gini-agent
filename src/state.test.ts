import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { addAudit, createEmptyState, createImprovementProposal, createMemory, createPromotionProposal, createTask, decidePromotion, mutateState, readState, taskCounts } from "./state";

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

  test("mutateState serializes concurrent writers per lane", async () => {
    // Without per-lane serialization, two async tasks that each call
    // mutateState can interleave their read-modify-write windows on the same
    // file. The earlier writer's append is silently lost — last writer wins.
    // The promise-chain queue in store.ts ensures every appended record
    // survives even when N writers fire in parallel.
    const root = "/tmp/gini-state-locking-test";
    const lane = "store-locking" as const;
    rmSync(`${root}/${lane}`, { recursive: true, force: true });
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_unused, index) =>
        // Wrap with Promise.resolve().then() so each starts on a separate
        // microtask tick — this is the worst case for an unserialized RMW.
        Promise.resolve().then(() =>
          mutateState(lane, (state) => {
            addAudit(state, {
              actor: "user",
              action: "store.locking.test",
              target: `record-${index}`,
              risk: "low"
            });
          })
        )
      )
    );

    const records = readState(lane).audit.filter((event) => event.action === "store.locking.test");
    expect(records.length).toBe(N);
    const targets = new Set(records.map((event) => event.target));
    expect(targets.size).toBe(N);
  });
});
