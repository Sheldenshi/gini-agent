import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAudit, createEmptyState, createImprovementProposal, createMemory, createPromotionProposal, createTask, decidePromotion, mutateState, readState, taskCounts } from "./state";

describe("state primitives", () => {
  test("creates instance-aware task records", () => {
    const task = createTask("sandbox", "remember useful context");
    expect(task.instance).toBe("sandbox");
    expect(task.status).toBe("queued");
    expect(task.tracePath).toContain("/sandbox/traces/");
  });

  test("memory proposals are inspectable before activation", () => {
    const state = createEmptyState("dev");
    const memory = createMemory(state, {
      content: "Gini keeps receipts.",
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

  test("mutateState serializes concurrent writers per instance", async () => {
    // Without per-instance serialization, two async tasks that each call
    // mutateState can interleave their read-modify-write windows on the same
    // file. The earlier writer's append is silently lost — last writer wins.
    // The promise-chain queue in store.ts ensures every appended record
    // survives even when N writers fire in parallel.
    const root = "/tmp/gini-state-locking-test";
    const instance = "store-locking" as const;
    rmSync(root, { recursive: true, force: true });
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_unused, index) =>
        // Wrap with Promise.resolve().then() so each starts on a separate
        // microtask tick — this is the worst case for an unserialized RMW.
        Promise.resolve().then(() =>
          mutateState(instance, (state) => {
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

    const records = readState(instance).audit.filter((event) => event.action === "store.locking.test");
    expect(records.length).toBe(N);
    const targets = new Set(records.map((event) => event.target));
    expect(targets.size).toBe(N);
  });

  test("readState migrates legacy `lane` fields to `instance` on every record", async () => {
    // Older state.json files persisted a `lane` field at the top level and on
    // every record. After the rename we rewrite to `instance` on first read.
    // mutateState's read-modify-write cycle persists the cleaned shape on the
    // next mutation — this test forces that round-trip and inspects disk.
    const root = mkdtempSync(join(tmpdir(), "gini-lane-migrate-"));
    const previousState = process.env.GINI_STATE_ROOT;
    const previousLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    try {
      const instance = "legacy-fields";
      const dir = join(root, "instances", instance);
      mkdirSync(dir, { recursive: true });
      const legacyState = {
        version: 1,
        lane: instance,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        tasks: [
          {
            id: "task_legacy",
            title: "legacy",
            input: "legacy",
            status: "completed",
            lane: instance,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
            tracePath: `${dir}/traces/task_legacy.jsonl`,
            auditIds: [],
            approvalIds: [],
            memoryIds: [],
            skillIds: []
          }
        ],
        audit: [
          { id: "audit_legacy", lane: instance, at: "2025-01-01T00:00:00.000Z", actor: "user", action: "legacy.event", target: "x", risk: "low" }
        ]
      };
      writeFileSync(join(dir, "state.json"), JSON.stringify(legacyState, null, 2));

      // First read should rename in memory.
      const loaded = readState(instance);
      expect(loaded.instance).toBe(instance);
      expect((loaded as unknown as { lane?: unknown }).lane).toBeUndefined();
      expect(loaded.tasks[0]?.instance).toBe(instance);
      expect((loaded.tasks[0] as unknown as { lane?: unknown }).lane).toBeUndefined();
      expect(loaded.audit[0]?.instance).toBe(instance);
      expect((loaded.audit[0] as unknown as { lane?: unknown }).lane).toBeUndefined();

      // A subsequent mutation should persist the cleaned shape to disk.
      await mutateState(instance, (state) => {
        addAudit(state, { actor: "user", action: "post.migration", target: "marker", risk: "low" });
      });
      const onDiskRaw = readFileSync(join(dir, "state.json"), "utf8");
      const onDisk = JSON.parse(onDiskRaw);
      expect(onDisk.lane).toBeUndefined();
      expect(onDisk.instance).toBe(instance);
      expect(onDisk.tasks[0].lane).toBeUndefined();
      expect(onDisk.tasks[0].instance).toBe(instance);
      expect(onDisk.audit.every((event: { lane?: unknown; instance: string }) => event.lane === undefined && event.instance === instance)).toBe(true);

      // Idempotent: a second readState on the cleaned file is a no-op.
      const reloaded = readState(instance);
      expect((reloaded as unknown as { lane?: unknown }).lane).toBeUndefined();
      expect(reloaded.instance).toBe(instance);
    } finally {
      if (previousState === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = previousState;
      if (previousLog === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = previousLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
