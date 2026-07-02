import type { AuditEvent, RuntimeEvent, RuntimeState } from "../types";
import { id, now } from "./ids";

// Caller-supplied agent context for events and audits. This discriminated
// union makes "I forgot to thread agentId" a compile error rather than a
// runtime silent-fallback. Every appendEvent / addAudit call site must
// declare one of:
//   - an explicit `agentId`, OR
//   - a source id (`taskId` / `jobId` / `sessionId` / `memoryId`) the runtime
//     can resolve to an agent, OR
//   - `system: true` for events that genuinely have no agent owner
//     (instance boot, agent-lifecycle events, etc).
//
// There is intentionally no fallback to `state.activeAgentId`. The whole
// point of this type is that the "default to currently-active" branch
// caused recurring whack-a-mole attribution bugs across Phase 2; lifting
// the invariant into the type system kills the bug class.
export type AgentContext =
  | { agentId: string; system?: never }
  | { taskId: string; agentId?: string; system?: never }
  | { jobId: string; agentId?: string; system?: never }
  | { sessionId: string; agentId?: string; system?: never }
  | { system: true; agentId?: never };

// Resolve the owning agent from a caller-supplied context. Deterministic:
//   - explicit `agentId` always wins.
//   - source ids (`taskId` / `jobId` / `sessionId`) resolve via the
//     corresponding record in state.
//   - `system: true` returns undefined (stored unattributed).
//   - if a source id is provided but the record doesn't exist (deleted, race),
//     return undefined. Do NOT fall back to `state.activeAgentId`.
//
// The `memoryId` branch was removed alongside the state.memories
// consolidation — pinned memories no longer exist as a record type the
// audit emitter can attribute against. See ADR
// runtime-identity-files.md.
function resolveAgentId(state: RuntimeState, ctx: AgentContext): string | undefined {
  if ("system" in ctx && ctx.system === true) return undefined;
  if (ctx.agentId) return ctx.agentId;
  if ("taskId" in ctx && ctx.taskId) {
    const task = state.tasks.find((candidate) => candidate.id === ctx.taskId);
    return task?.agentId;
  }
  if ("jobId" in ctx && ctx.jobId) {
    const job = state.jobs.find((candidate) => candidate.id === ctx.jobId);
    return job?.agentId;
  }
  if ("sessionId" in ctx && ctx.sessionId) {
    const session = state.chatSessions.find((candidate) => candidate.id === ctx.sessionId);
    return session?.agentId;
  }
  return undefined;
}

// `agentId` is no longer part of the event input — it's resolved from the
// AgentContext parameter. taskId / jobId / runId remain payload fields
// describing what the event is about; they are persisted regardless of
// whether the inference path used them.
export type RuntimeEventInput = Omit<RuntimeEvent, "id" | "instance" | "at" | "agentId">;

export function appendEvent(
  state: RuntimeState,
  event: RuntimeEventInput,
  agent: AgentContext
): RuntimeEvent {
  const item: RuntimeEvent = {
    id: id("event"),
    instance: state.instance,
    at: now(),
    ...event,
    agentId: resolveAgentId(state, agent)
  };
  if (item.redacted === true) item.data = undefined;
  state.events.unshift(item);
  state.events = state.events.slice(0, 1000);
  return item;
}

export type AuditEventInput = Omit<AuditEvent, "id" | "instance" | "at" | "agentId">;

export function addAudit(
  state: RuntimeState,
  event: AuditEventInput,
  agent: AgentContext
): AuditEvent {
  const agentId = resolveAgentId(state, agent);
  const audit: AuditEvent = {
    id: id("audit"),
    instance: state.instance,
    at: now(),
    ...event,
    agentId
  };
  if (audit.redacted === true) audit.evidence = undefined;
  state.audit.unshift(audit);
  // Ring-buffer cap, mirroring the events cap above. addAudit is reached by
  // public, rate-limited endpoints (e.g. device-pairing create emits a
  // pairing.requested row per call), so the durable audit log must be bounded —
  // otherwise it grows without limit even after the source records are pruned.
  state.audit = state.audit.slice(0, 5000);
  // Mirror the audit row as a runtime event so the activity feed sees a
  // unified stream. Pass the same agent context so attribution stays
  // consistent across the paired records. The mirrored event inherits
  // the audit's redacted flag so appendEvent's writer drops `data` for
  // sensitive rows even though we tried to copy `evidence` across.
  appendEvent(
    state,
    {
      kind: "runtime",
      action: audit.action,
      target: audit.target,
      taskId: audit.taskId,
      runId: audit.runId,
      risk: audit.risk,
      summary: audit.action,
      data: audit.evidence,
      redacted: audit.redacted
    },
    agent
  );
  return audit;
}
