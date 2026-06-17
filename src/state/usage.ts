import type { CostRecord, Instance, RuntimeState, UsageContext } from "../types";
import { mutateState } from "./store";

// Local-calendar day key (YYYY-MM-DD) for a timestamp. The home usage chart
// buckets by local day, so recording the same way keeps the ledger and chart
// in agreement and lets the read path return pre-bucketed daily totals.
export function localDayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function numOr0(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Pure rollup: fold one generative call's cost into the matching daily bucket,
// mutating state.usageLedger in place. Keyed by (day, source, agentId,
// provider, model). Exposed for unit tests; recordUsage wraps it in
// mutateState. A call with zero recorded tokens contributes nothing.
export function applyUsage(state: RuntimeState, context: UsageContext, cost: CostRecord, at: number): void {
  const input = numOr0(cost.inputTokens);
  const output = numOr0(cost.outputTokens);
  const total = numOr0(cost.totalTokens) || input + output;
  if (input === 0 && output === 0 && total === 0) return;
  state.usageLedger ??= [];
  const day = localDayKey(at);
  const provider = String(cost.provider);
  const model = cost.model;
  const usd = numOr0(cost.estimatedUsd);
  const entry = state.usageLedger.find(
    (e) =>
      e.day === day &&
      e.source === context.source &&
      e.agentId === context.agentId &&
      e.provider === provider &&
      e.model === model
  );
  if (entry) {
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.totalTokens += total;
    entry.estimatedUsd += usd;
    entry.calls += 1;
    return;
  }
  state.usageLedger.push({
    day,
    source: context.source,
    agentId: context.agentId,
    provider,
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    estimatedUsd: usd,
    calls: 1
  });
}

// Record one generative call's token usage into the durable per-day ledger.
// Fire-and-forget friendly: provider entry points `void recordUsage(...)` so it
// never adds latency to or fails the provider response. A missing cost record
// (unpriced/usage-less call) is a no-op.
export async function recordUsage(
  instance: Instance,
  context: UsageContext,
  cost: CostRecord | undefined,
  at: number = Date.now()
): Promise<void> {
  if (!cost) return;
  await mutateState(instance, (state) => {
    applyUsage(state, context, cost, at);
  });
}
