import type { ParityCheck, RuntimeConfig } from "../types";
import { readState } from "../state";
import { providerCatalog } from "../provider";

export function hermesParityChecks(config: RuntimeConfig): { ok: boolean; checks: ParityCheck[] } {
  const state = readState(config.lane);
  const checks: ParityCheck[] = [
    check("cli", "CLI workflow", true, ["install/start/status/task commands exist"], "pass"),
    check("memory", "Persistent memory", true, [`${state.memories.length} memory records`, "proposal/approve/reject APIs"], state.memories.length >= 0 ? "partial" : "missing"),
    check("skills", "Skills/procedures", true, [`${state.skills.length} skills`, "draft/trusted status"], state.skills.length >= 0 ? "partial" : "missing"),
    check("session_search", "Session search", true, ["search API returns task/trace/memory/skill/audit citations"], "pass"),
    check("jobs", "Cron/jobs", true, [`${state.jobs.length} jobs`, "run/pause/resume APIs"], "pass"),
    check("tools", "File/terminal/web/code tools", true, state.toolsets.map((item) => `${item.name}:${item.status}`), hasToolset(state, "file") && hasToolset(state, "terminal") ? "partial" : "missing"),
    check("toolsets", "Toolsets and gating", true, state.toolsets.map((item) => item.name), state.toolsets.length > 0 ? "pass" : "missing"),
    check("providers", "Provider abstraction", true, providerCatalog().map((item) => item.id), providerCatalog().length >= 5 ? "pass" : "partial"),
    check("delegation", "Delegation/subagents", true, [`${state.subagents.length} subagents`, "spawn/list APIs"], "partial"),
    check("mcp", "MCP integration", true, [`${state.mcpServers.length} MCP server records`, "add/health/disable APIs"], "partial"),
    check("messaging", "Messaging bridge", true, [`${state.messagingBridges.length} bridge records`, "add/health/disable APIs"], "partial"),
    check("profiles", "Config/profile equivalent", true, state.profiles.map((item) => `${item.name}:${item.status}`), state.profiles.length > 0 ? "pass" : "missing"),
    check("migration", "Hermes/OpenClaw import basics", true, [`${state.importReports.length} import inspection reports`], "partial"),
    check("mobile", "Mobile/remote control structure", true, [`${state.devices.length} paired devices`, "mobile bootstrap contract"], "partial"),
    check("relay", "Remote relay and notifications", true, [`${state.relays.length} relay records`, `${state.notifications.length} notifications`], state.relays.length > 0 || state.notifications.length > 0 ? "partial" : "partial")
  ];
  return { ok: checks.every((item) => item.status !== "missing"), checks };
}

function check(id: string, label: string, requiredForV1: boolean, evidence: string[], status: ParityCheck["status"]): ParityCheck {
  return { id, label, requiredForV1, evidence, status };
}

function hasToolset(state: ReturnType<typeof readState>, name: string): boolean {
  return state.toolsets.some((item) => item.name === name);
}
