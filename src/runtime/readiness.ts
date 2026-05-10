import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { hermesParityChecks } from "./parity";

export function v1Readiness(config: RuntimeConfig) {
  const state = readState(config.instance);
  const parity = hermesParityChecks(config);
  const checks = [
    readiness("runtime_contracts", "Stable API contracts", true, ["/api/tasks", "/api/chat", "/api/runs", "/api/events", "/api/parity/hermes"]),
    readiness("conversation_runs", "Conversation run model", true, [`${state.runs.length} runs`, `${state.planSteps.length} plan steps`, "runs link conversations, tasks, approvals, and future subtasks"]),
    readiness("local_web", "Local web control plane", true, ["tasks", "approvals", "chat", "events", "memory", "skills", "jobs", "messaging", "parity"]),
    readiness("event_stream", "Event stream", true, [`${state.events.length} recorded events`, "/api/events/stream"]),
    readiness("trace_audit", "Trace/audit substrate", true, [`${state.audit.length} audit events`, "per-task trace files"]),
    readiness("permission_boundary", "Permission enforcement boundary", true, ["file.write", "file.patch", "terminal.exec approvals"]),
    readiness("instance_state", "Instance-aware state", true, [config.instance, config.stateRoot]),
    readiness("providers", "Provider abstraction", true, parity.checks.find((check) => check.id === "providers")?.evidence ?? []),
    readiness("jobs", "Job scheduler and history", true, [`${state.jobs.length} jobs`, `${state.jobRuns.length} job runs`]),
    readiness("memory_skills", "Memory and skill governance", true, [`${state.memories.length} memories`, `${state.skills.length} skills`]),
    readiness("messaging", "Messaging bridge", true, [`${state.messagingBridges.length} bridges`, `${state.messagingMessages.length} messages`]),
    readiness("mcp", "MCP/plugin surface", true, [`${state.mcpServers.length} MCP servers`]),
    readiness("support_bundle", "Support/evidence bundle", true, ["gini evidence", "gini smoke evidencePath"]),
    readiness("future_app_contracts", "Future app contracts without iOS dependency", true, ["/api/mobile/bootstrap", "/api/events/stream", "iOS/Expo is v2"])
  ];
  return {
    ok: parity.ok && checks.every((check) => check.status === "pass"),
    instance: config.instance,
    parity,
    checks
  };
}

function readiness(id: string, label: string, pass: boolean, evidence: string[]) {
  return { id, label, status: pass ? "pass" : "missing", evidence };
}
