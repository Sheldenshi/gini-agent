import { describe, expect, it } from "bun:test";
import type { CostRecord, RuntimeState, UsageContext, UsageLedgerEntry } from "../types";
import { applyUsage, buildDailyUsage, localDayKey } from "./usage";

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
