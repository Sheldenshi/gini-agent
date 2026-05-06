import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { status } from "../domain/runtime";
import { redactDevice } from "../domain/pairing";

export function mobileBootstrap(config: RuntimeConfig) {
  const state = publicState(config);
  return {
    runtime: status(config),
    lane: config.lane,
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
    notifications: state.notifications
  };
}

export function publicState(config: RuntimeConfig) {
  const state = readState(config.lane);
  return {
    ...state,
    pairingCodes: state.pairingCodes.map((pairing) => ({
      id: pairing.id,
      lane: pairing.lane,
      status: pairing.status,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
      claimedAt: pairing.claimedAt,
      claimedByDeviceId: pairing.claimedByDeviceId
    })),
    devices: state.devices.map(redactDevice)
  };
}
