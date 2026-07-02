import type { RuntimeConfig } from "../types";
import { buildDailyUsage, readState, type DayUsage } from "../state";
import { redactDevice } from "../governance/pairing";
import { status } from "./index";

// Daily token-usage rollup for the home chart. Reads the durable usage ledger
// (not task.cost), so it captures all generative spend — chat, jobs,
// subagents, memory, titles, vision — and survives task pruning. `days` is
// clamped to a sane window; agentId scopes to one agent (unattributed overhead
// is included in every agent view). See ADR usage-accounting.md.
export function dailyUsage(
  config: RuntimeConfig,
  opts: { days?: number; agentId?: string } = {}
): DayUsage[] {
  const state = readState(config.instance);
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 14), 1), 90);
  return buildDailyUsage(state.usageLedger ?? [], days, opts.agentId);
}

export function mobileBootstrap(config: RuntimeConfig) {
  const state = publicState(config);
  return {
    runtime: status(config),
    instance: config.instance,
    tasks: state.tasks,
    authorizations: state.authorizations,
    setupRequests: state.setupRequests,
    skills: state.skills,
    jobs: state.jobs,
    connectors: state.connectors,
    improvements: state.improvements,
    devices: state.devices,
    toolsets: state.toolsets,
    tools: state.tools,
    subagents: state.subagents,
    mcpServers: state.mcpServers,
    messagingBridges: state.messagingBridges,
    importReports: state.importReports,
    agents: state.agents,
    activeAgentId: state.activeAgentId,
    relays: state.relays,
    notifications: state.notifications,
    events: state.events,
    jobRuns: state.jobRuns,
    chatSessions: state.chatSessions,
    chatMessages: state.chatMessages.filter((m) => m.kind !== "tool_transcript"),
    messagingMessages: state.messagingMessages,
    runs: state.runs,
    planSteps: state.planSteps
  };
}

export function publicState(config: RuntimeConfig) {
  const state = readState(config.instance);
  // pairingRequests is intentionally omitted: no client reads it off /api/state
  // (the admin panel uses the GET /api/pairing/requests admin route), and a
  // raw row carries the bindHash. Pull it OUT of the spread — `...state` would
  // otherwise re-include the raw rows. `pairingCodes`/`devices` are spread then
  // overridden with redacted forms below.
  const { pairingRequests: _omitted, ...rest } = state;
  void _omitted;
  return {
    ...rest,
    chatMessages: state.chatMessages.filter((m) => m.kind !== "tool_transcript"),
    pairingCodes: state.pairingCodes.map((pairing) => ({
      id: pairing.id,
      instance: pairing.instance,
      status: pairing.status,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
      claimedAt: pairing.claimedAt,
      claimedByDeviceId: pairing.claimedByDeviceId
    })),
    devices: state.devices.map(redactDevice)
  };
}
