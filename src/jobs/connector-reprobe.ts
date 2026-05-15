// Periodic re-probe job (ADR connector-provider-spec-compliance.md § Probe contract).
//
// Walks every connector in state and dispatches its provider's probe
// when the per-provider interval has elapsed. Health transitions
// (healthy↔unhealthy) emit an audit event so the trail records when a
// connector flipped state outside an explicit `gini connector health`
// call.
//
// Intentionally separate from the job scheduler: re-probes don't claim
// an instance lock and don't run a Task. They are a maintenance pass
// the runtime owns directly.

import type { RuntimeConfig } from "../types";
import { addAudit, mutateState, readState } from "../state";
import { getProvider } from "../integrations/connectors/registry";
import { checkConnector } from "../integrations/connectors";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes per ADR connector-provider-spec-compliance.md

export interface ReprobeReport {
  considered: number;
  probed: number;
  transitioned: Array<{ id: string; from: string; to: string; provider: string }>;
}

export async function runConnectorReprobe(config: RuntimeConfig): Promise<ReprobeReport> {
  const state = readState(config.instance);
  const report: ReprobeReport = { considered: 0, probed: 0, transitioned: [] };
  const at = Date.now();

  for (const connector of state.connectors) {
    // Skip tombstoned records — a successful re-probe would write back
    // health: "healthy" + status: "configured", undoing a deliberate
    // disconnect of an auto-source connector.
    if (connector.status === "disabled") continue;
    report.considered += 1;
    const module = getProvider(connector.provider);
    if (!module?.probe) continue;
    const interval = module.probeIntervalMs ?? DEFAULT_INTERVAL_MS;
    const last = connector.lastHealthAt ? Date.parse(connector.lastHealthAt) : 0;
    if (Number.isFinite(last) && at - last < interval) continue;
    const before = connector.health;
    let probedRecord;
    try {
      probedRecord = await checkConnector(config, connector.id);
      report.probed += 1;
    } catch {
      // checkConnector itself is best-effort; failures end up surfaced as
      // `health: "unhealthy"` with the error message. A throw here would be
      // an unexpected internal error — log it once via audit and continue.
      await mutateState(config.instance, (s) => {
        addAudit(s, {
          actor: "runtime",
          action: "connector.reprobe.error",
          target: connector.id,
          risk: "low",
          evidence: { provider: connector.provider }
        });
      });
      continue;
    }
    if (probedRecord.health !== before) {
      report.transitioned.push({
        id: connector.id,
        from: before,
        to: probedRecord.health,
        provider: connector.provider
      });
      await mutateState(config.instance, (s) => {
        addAudit(s, {
          actor: "runtime",
          action: "connector.health.transition",
          target: connector.id,
          risk: probedRecord.health === "unhealthy" ? "medium" : "low",
          evidence: {
            provider: connector.provider,
            from: before,
            to: probedRecord.health,
            message: probedRecord.message
          }
        });
      });
    }
  }
  return report;
}
