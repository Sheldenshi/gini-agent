import type { AuditEvent, RuntimeEvent, RuntimeState } from "../types";
import { id, now } from "./ids";

// Infer the originating agent from a record linked to the event/audit row.
// Order of fallback: explicit caller value -> task.agentId -> job.agentId ->
// the runtime's currently active agent. Returns undefined when no source
// resolves, which preserves the "system / unattributable" case.
//
// The jobId fallback matters because scheduler-driven job lifecycle events
// run outside the active-agent context (a scheduled fire after the user
// switches agents would otherwise be misattributed). The owning job carries
// the stamp; this fallback honors it without each call site re-resolving.
function inferAgentId(
  state: RuntimeState,
  explicit: string | undefined,
  taskId: string | undefined,
  jobId: string | undefined
): string | undefined {
  if (explicit) return explicit;
  if (taskId) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (task?.agentId) return task.agentId;
  }
  if (jobId) {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.agentId) return job.agentId;
  }
  return state.activeAgentId;
}

export function appendEvent(
  state: RuntimeState,
  event: Omit<RuntimeEvent, "id" | "instance" | "at">
): RuntimeEvent {
  const item: RuntimeEvent = {
    id: id("event"),
    instance: state.instance,
    at: now(),
    ...event,
    agentId: inferAgentId(state, event.agentId, event.taskId, event.jobId)
  };
  state.events.unshift(item);
  state.events = state.events.slice(0, 1000);
  return item;
}

// addAudit accepts an optional `jobId` in its parameter shape (not persisted
// on AuditEvent — see AuditEvent type). The id is consulted only as a
// last-resort fallback in inferAgentId for job-lifecycle audits whose call
// site doesn't already pass an explicit `agentId`. Existing call sites that
// stamp `agentId` directly continue to take precedence.
export function addAudit(
  state: RuntimeState,
  event: Omit<AuditEvent, "id" | "instance" | "at"> & { jobId?: string }
): AuditEvent {
  const { jobId: jobIdFallback, ...persisted } = event;
  const audit: AuditEvent = {
    id: id("audit"),
    instance: state.instance,
    at: now(),
    ...persisted,
    agentId: inferAgentId(state, persisted.agentId, persisted.taskId, jobIdFallback)
  };
  state.audit.unshift(audit);
  appendEvent(state, {
    kind: "runtime",
    action: audit.action,
    target: audit.target,
    taskId: audit.taskId,
    runId: audit.runId,
    risk: audit.risk,
    summary: audit.action,
    data: audit.evidence,
    agentId: audit.agentId,
    jobId: jobIdFallback
  });
  return audit;
}
