import type { AgentRecord, Instance, ToolRecord, ToolsetRecord } from "../types";

export function defaultToolsets(instance: Instance, at: string): ToolsetRecord[] {
  return [
    {
      id: "toolset_file",
      instance,
      name: "file",
      description: "Workspace file read, search, list, and approval-gated write operations.",
      status: "enabled",
      toolNames: ["file.read", "file.search", "file.list", "file.write"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_terminal",
      instance,
      name: "terminal",
      description: "Approval-gated shell execution with timeout and trace evidence.",
      status: "enabled",
      toolNames: ["terminal.exec"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_memory",
      instance,
      name: "memory",
      description: "Inspectable memory proposal, activation, retrieval, and rejection flows.",
      status: "enabled",
      toolNames: ["memory.search", "memory.propose", "memory.activate"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_session_search",
      instance,
      name: "session_search",
      description: "Search prior tasks, traces, memories, skills, and audit events with source links.",
      status: "enabled",
      toolNames: ["session.search"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_delegation",
      instance,
      name: "delegation",
      description: "Spawn isolated subagent tasks with toolset limits and trace linkage.",
      status: "enabled",
      toolNames: ["delegate.task"],
      scopes: ["task", "job", "skill"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_mcp",
      instance,
      name: "mcp",
      description: "Expose selected external MCP tools through configured server records.",
      status: "disabled",
      toolNames: ["mcp.invoke"],
      scopes: ["task", "job", "skill", "subagent", "mcp"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_messaging",
      instance,
      name: "messaging",
      description: "Bridge task input and notifications to configured messaging channels.",
      status: "disabled",
      toolNames: ["message.send"],
      scopes: ["job", "messaging"],
      createdAt: at,
      updatedAt: at
    }
  ];
}

export function defaultTools(instance: Instance, at: string): ToolRecord[] {
  return defaultToolsets(instance, at).flatMap((toolset) => toolset.toolNames.map((name) => ({
    id: `tool_${name.replaceAll(".", "_")}`,
    instance,
    name,
    description: `${name} from ${toolset.name} toolset`,
    toolset: toolset.name,
    status: toolset.status === "enabled" ? "available" : "disabled",
    risk: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send") ? "high" : "low",
    requiresApproval: name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send"),
    createdAt: at,
    updatedAt: at
  } satisfies ToolRecord)));
}

export function defaultAgent(instance: Instance, at: string): AgentRecord {
  // providerName/model intentionally left undefined here. The seeding
  // step in createEmptyState / normalizeState populates them from
  // RuntimeConfig.provider on first run (or on the one-time migration
  // away from the legacy echo defaults). Leaving them undefined here
  // means an agent created via this helper without further seeding
  // simply falls back to the instance provider in
  // resolveEffectiveContext.
  return {
    id: "agent_default",
    instance,
    name: "default",
    status: "active",
    providerName: undefined,
    model: undefined,
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryScopes: ["user", "project", "device", "temporary"],
    messagingTargets: [],
    createdAt: at,
    updatedAt: at
  };
}
