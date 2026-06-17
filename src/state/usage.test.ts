import { describe, expect, it } from "bun:test";
import type { CostRecord, RuntimeState, UsageContext } from "../types";
import { applyUsage, localDayKey } from "./usage";

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
