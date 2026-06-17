import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { CostRecord, RuntimeState, Task, UsageContext, UsageLedgerEntry } from "../types";
import { applyUsage, backfillUsageLedger, backfillUsageLedgerOnce, buildDailyUsage, localDayKey } from "./usage";
import { createEmptyState, readState, writeState } from "./store";

function emptyLedgerState(): RuntimeState {
  return { usageLedger: [] } as unknown as RuntimeState;
}

const at = new Date(2026, 5, 17, 12, 0, 0).getTime(); // Jun 17 2026 local

function cost(over: Partial<CostRecord>): CostRecord {
  return { provider: "codex", model: "gpt-5.5", ...over };
}

describe("localDayKey", () => {
  it("formats the local calendar day", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 30).getTime())).toBe("2026-01-05");
  });
});

describe("applyUsage", () => {
  const ctx: UsageContext = { source: "chat", agentId: "agent_default" };

  it("creates a bucket then sums into it by (day, source, agentId, provider, model)", () => {
    const state = emptyLedgerState();
    applyUsage(state, ctx, cost({ inputTokens: 100, outputTokens: 10, estimatedUsd: 0.001 }), at);
    applyUsage(state, ctx, cost({ inputTokens: 50, outputTokens: 5, estimatedUsd: 0.0005 }), at);
    expect(state.usageLedger).toHaveLength(1);
    expect(state.usageLedger[0]).toMatchObject({
      day: "2026-06-17",
      source: "chat",
      agentId: "agent_default",
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
      calls: 2
    });
    expect(state.usageLedger[0].estimatedUsd).toBeCloseTo(0.0015, 6);
  });

  it("splits buckets across different sources and days", () => {
    const state = emptyLedgerState();
    applyUsage(state, { source: "chat" }, cost({ inputTokens: 100, outputTokens: 10 }), at);
    applyUsage(state, { source: "memory" }, cost({ inputTokens: 200, outputTokens: 20 }), at);
    const nextDay = new Date(2026, 5, 18, 9, 0, 0).getTime();
    applyUsage(state, { source: "chat" }, cost({ inputTokens: 1, outputTokens: 1 }), nextDay);
    expect(state.usageLedger).toHaveLength(3);
    const memory = state.usageLedger.find((e) => e.source === "memory");
    expect(memory?.inputTokens).toBe(200);
  });

  it("derives totalTokens from input+output when the cost record omits it", () => {
    const state = emptyLedgerState();
    applyUsage(state, ctx, cost({ inputTokens: 7, outputTokens: 3 }), at);
    expect(state.usageLedger[0].totalTokens).toBe(10);
  });

  it("ignores a zero-token call", () => {
    const state = emptyLedgerState();
    applyUsage(state, ctx, cost({ inputTokens: 0, outputTokens: 0 }), at);
    expect(state.usageLedger).toHaveLength(0);
  });
});

describe("buildDailyUsage", () => {
  const now = new Date(2026, 5, 17, 12, 0, 0).getTime(); // Jun 17 2026
  function entry(over: Partial<UsageLedgerEntry>): UsageLedgerEntry {
    return {
      day: "2026-06-17",
      source: "chat",
      provider: "codex",
      model: "gpt-5.5",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      calls: 1,
      ...over
    };
  }

  it("returns `days` buckets oldest→newest ending today", () => {
    const out = buildDailyUsage([], 14, undefined, now);
    expect(out).toHaveLength(14);
    expect(out[13].day).toBe("2026-06-17");
    expect(out[0].day).toBe("2026-06-04");
    expect(new Date(out[13].dayStart).getHours()).toBe(0);
  });

  it("sums tokens/usd into the right day and exposes a per-source breakdown", () => {
    const ledger = [
      entry({ day: "2026-06-17", source: "chat", inputTokens: 100, outputTokens: 10, totalTokens: 110, estimatedUsd: 0.01 }),
      entry({ day: "2026-06-17", source: "memory", inputTokens: 200, outputTokens: 20, totalTokens: 220, estimatedUsd: 0.02 }),
      entry({ day: "2026-06-15", source: "chat", inputTokens: 5, outputTokens: 1, totalTokens: 6, estimatedUsd: 0.001 })
    ];
    const out = buildDailyUsage(ledger, 14, undefined, now);
    const today = out[13];
    expect(today).toMatchObject({ input: 300, output: 30, total: 330 });
    expect(today.estimatedUsd).toBeCloseTo(0.03, 6);
    expect(today.bySource.memory?.input).toBe(200);
    expect(today.bySource.chat?.input).toBe(100);
    expect(out[11].input).toBe(5); // Jun 15 = index 11
  });

  it("scopes to an agent but keeps unattributed (shared) spend in every view", () => {
    const ledger = [
      entry({ source: "chat", agentId: "agent_a", inputTokens: 100, totalTokens: 100 }),
      entry({ source: "chat", agentId: "agent_b", inputTokens: 999, totalTokens: 999 }),
      entry({ source: "aux", inputTokens: 5, totalTokens: 5 }) // no agentId → shared
    ];
    const out = buildDailyUsage(ledger, 7, "agent_a", now);
    expect(out[6].input).toBe(105); // agent_a (100) + shared (5); agent_b excluded
  });

  it("drops ledger entries outside the window", () => {
    const out = buildDailyUsage([entry({ day: "2026-01-01", inputTokens: 9, totalTokens: 9 })], 14, undefined, now);
    expect(out.reduce((s, d) => s + d.input, 0)).toBe(0);
  });
});

describe("backfillUsageLedger", () => {
  function task(over: Partial<Task> & { id: string; status: Task["status"] }): Task {
    return {
      title: "t",
      input: "",
      createdAt: "2026-06-17T10:00:00Z",
      updatedAt: "2026-06-17T10:00:00Z",
      ...over
    } as Task;
  }

  function ledgerState(tasks: Task[]): RuntimeState {
    return { tasks, usageLedger: [] } as unknown as RuntimeState;
  }

  it("seeds terminal task.cost rows, derives source, and recomputes missing USD", () => {
    const state = ledgerState([
      task({
        id: "t1",
        status: "completed",
        agentId: "agent_default",
        cost: { provider: "anthropic", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 20 }
      }),
      task({ id: "t2", status: "completed", jobId: "job_1", cost: { provider: "codex", model: "gpt-5.5", inputTokens: 5, outputTokens: 1 } }),
      task({ id: "t3", status: "completed", parentTaskId: "t1", cost: { provider: "codex", model: "gpt-5.5", inputTokens: 7, outputTokens: 2 } })
    ]);
    backfillUsageLedger(state);
    const chat = state.usageLedger.find((e) => e.source === "chat");
    expect(chat).toMatchObject({ inputTokens: 100, outputTokens: 20, source: "chat", agentId: "agent_default" });
    // opus 4.8 = $5/$25 per MTok → 100 in + 20 out = $0.001, recomputed from undefined.
    expect(chat?.estimatedUsd).toBeCloseTo(0.001, 9);
    expect(state.usageLedger.find((e) => e.source === "job")?.inputTokens).toBe(5);
    expect(state.usageLedger.find((e) => e.source === "subagent")?.inputTokens).toBe(7);
  });

  it("skips non-terminal tasks (they record forward) and cost-less/zero rows", () => {
    const state = ledgerState([
      task({ id: "r", status: "running", cost: { provider: "codex", model: "gpt-5.5", inputTokens: 999, outputTokens: 9 } }),
      task({ id: "n", status: "completed" }),
      task({ id: "z", status: "completed", cost: { provider: "codex", model: "gpt-5.5", inputTokens: 0, outputTokens: 0 } })
    ]);
    backfillUsageLedger(state);
    expect(state.usageLedger).toHaveLength(0);
  });

  it("preserves an already-priced estimatedUsd instead of recomputing", () => {
    const state = ledgerState([
      task({ id: "p", status: "completed", cost: { provider: "anthropic", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 20, estimatedUsd: 99 } })
    ]);
    backfillUsageLedger(state);
    expect(state.usageLedger[0].estimatedUsd).toBe(99);
  });
});

describe("backfillUsageLedgerOnce (boot: persisted + idempotent)", () => {
  const ROOT = "/tmp/gini-usage-backfill-test";
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  });
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("seeds the ledger once, persists the marker, and never re-seeds", async () => {
    const instance = "backfill-test";
    const state = createEmptyState(instance);
    state.tasks.push({
      id: "t1",
      title: "x",
      input: "",
      status: "completed",
      createdAt: "2026-06-17T10:00:00Z",
      updatedAt: "2026-06-17T10:00:00Z",
      agentId: "agent_default",
      cost: { provider: "codex", model: "gpt-5.5", inputTokens: 100, outputTokens: 10 }
    } as unknown as Task);
    writeState(instance, state);

    await backfillUsageLedgerOnce(instance);
    const after1 = readState(instance);
    expect(after1.usageLedger).toHaveLength(1);
    expect(after1.usageLedger[0]).toMatchObject({ source: "chat", inputTokens: 100, outputTokens: 10 });
    expect(after1.usageLedgerBackfilledAt).toBeTruthy();

    // A second boot must NOT re-seed (the run-once marker guards it).
    await backfillUsageLedgerOnce(instance);
    expect(readState(instance).usageLedger).toHaveLength(1);
  });
});
