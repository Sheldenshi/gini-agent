import type { RuntimeConfig } from "../types";
import { addAudit, mutateState, now, readState } from "../state";

export function listToolsets(config: RuntimeConfig) {
  const state = readState(config.lane);
  return { toolsets: state.toolsets, tools: state.tools };
}

export async function setToolsetStatus(config: RuntimeConfig, name: string, status: "enabled" | "disabled") {
  return mutateState(config.lane, (state) => {
    const toolset = state.toolsets.find((item) => item.name === name || item.id === name);
    if (!toolset) throw new Error(`Toolset not found: ${name}`);
    toolset.status = status;
    toolset.updatedAt = now();
    for (const tool of state.tools.filter((item) => item.toolset === toolset.name)) {
      tool.status = status === "enabled" ? "available" : "disabled";
      tool.updatedAt = now();
    }
    addAudit(state, {
      actor: "user",
      action: `toolset.${status}`,
      target: toolset.name,
      risk: "medium",
      evidence: { toolNames: toolset.toolNames, scopes: toolset.scopes }
    });
    return toolset;
  });
}
