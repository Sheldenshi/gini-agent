import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { redactDevice } from "../governance/pairing";
import { status } from "./index";

export function mobileBootstrap(config: RuntimeConfig) {
  const state = publicState(config);
  return {
    runtime: status(config),
    instance: config.instance,
    tasks: state.tasks,
    approvals: state.approvals,
    memories: state.memories,
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
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    relays: state.relays,
    notifications: state.notifications,
    events: state.events,
    jobRuns: state.jobRuns,
    chatSessions: state.chatSessions,
    chatMessages: state.chatMessages,
    messagingMessages: state.messagingMessages,
    runs: state.runs,
    planSteps: state.planSteps
  };
}

export function publicState(config: RuntimeConfig) {
  const state = readState(config.instance);
  return {
    ...state,
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
