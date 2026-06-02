// Self-config / self-introspection operation registry.
//
// Each self-config capability is exposed to the chat-task agent loop as a
// DIRECT deferred tool (see tool-catalog.ts): its name + one-line summary
// surface in the system-prompt on-demand index, and the model loads the
// schema via load_tools before calling the tool by name. This registry stays
// the single source of truth for the OPERATION BEHAVIOR — the catalog entry
// carries the schema/description the model sees, while the handler + tag +
// audit live here. Keeping the live full-schema tool count low (which weak
// local providers need) is now the deferral mechanism's job, not a facade's.
//
// Each SelfOperation is the single source of truth for one capability: its
// summary, its tag (query => sync read; mutate => routed through the approval
// seam), its handler, and its JSON Schema (the catalog mirrors this schema in
// the tool's function.parameters). Adding a capability = registering an op
// here plus a matching catalog entry.
//
// Layering: this module is a leaf. It must NOT import from agent.ts or
// tool-dispatch.ts (tool-dispatch imports this registry; agent.ts imports
// findSelfOperation to re-run a mutate handler on approval). The low-risk
// audit write is inlined below against ../state so the registry pulls in no
// helper that transitively re-enters agent.ts and forms a cycle.

import type { ApprovalMode, RuntimeConfig, RuntimeState } from "../types";
import { addAudit, appendTrace, mutateState, now, readState } from "../state";
import { status as runtimeStatus, updateAutoApproveSettings } from "../runtime";
import { providerCatalogWithStatus } from "../provider";
import { setSetupProvider, removeSetupProvider } from "../runtime/setup-api";
import { listAgents, useAgent as useAgentCapability, createAgent as createAgentCapability, deleteAgent } from "../capabilities/agents";
import { listSkills } from "../capabilities/skills";
import { listToolsets, setToolsetStatus } from "../capabilities/toolsets";

export interface SelfOperation {
  name: string;
  summary: string;
  // query => synchronous read, runs inline; mutate => routed through the
  // approval seam (PolicyAction "self.config") so strict-mode operators can
  // gate provider/agent changes.
  tag: "query" | "mutate";
  // JSON Schema for the op's args — same shape a tool's function.parameters
  // carries. The catalog entry for this op mirrors this schema in its
  // function.parameters; this field is the canonical source it is copied from.
  schema: Record<string, unknown>;
  handler: (config: RuntimeConfig, taskId: string, args: Record<string, unknown>) => Promise<string>;
}

// Low-risk audit write, inlined here to keep the registry a leaf module (the
// shared helper in tool-dispatch.ts depends on findTask from agent.ts, which
// would re-enter the agent module and form an import cycle). Resolves the
// owning task inline against state instead of via findTask. This is a
// best-effort audit that runs after the handler already computed its result;
// a task deleted mid-flight quietly skips the row rather than throwing and
// sinking the handler's output.
async function recordLowRiskAudit(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  target: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = state.tasks.find((task) => task.id === taskId);
    if (!item) return;
    addAudit(
      state,
      {
        actor: "runtime",
        action,
        target,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
}

// ---------------- Operation handlers ----------------

async function getSelf(config: RuntimeConfig, taskId: string): Promise<string> {
  const snapshot = runtimeStatus(config);
  const state = readState(config.instance);
  const counts = {
    agents: state.agents.length,
    skills: state.skills.length,
    skillsEnabled: state.skills.filter((s) => s.status === "enabled").length,
    jobs: state.jobs.length,
    activeJobs: snapshot.activeJobs,
    mcpServers: state.mcpServers.length,
    messagingBridges: state.messagingBridges.length,
    connectors: state.connectors.length,
    memoryUnits: snapshot.memoryUnits,
    pendingApprovals: snapshot.pendingApprovals
  };
  const envelope = {
    ok: true,
    instance: snapshot.instance,
    port: snapshot.port,
    version: snapshot.version,
    approvalMode: config.approvalMode ?? "auto",
    approvalSettings: {
      approvalMode: config.approvalMode ?? "auto",
      autoApproveCommands: config.autoApproveCommands ?? [],
      dangerousTerminalPatterns: config.dangerousTerminalPatterns ?? []
    },
    provider: snapshot.provider,
    activeAgent: snapshot.activeAgent,
    counts
  };
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Got self snapshot",
    data: { instance: snapshot.instance, provider: snapshot.provider.provider.name, agent: snapshot.activeAgent?.name }
  });
  await recordLowRiskAudit(config, taskId, "self.get", snapshot.instance, {
    provider: snapshot.provider.provider.name,
    activeAgentId: snapshot.activeAgent?.id
  });
  return JSON.stringify(envelope);
}

async function listProviders(config: RuntimeConfig, taskId: string): Promise<string> {
  const catalog = providerCatalogWithStatus(config.provider?.name);
  const providers = catalog.map((item) => ({
    id: item.id,
    name: item.name,
    displayName: item.displayName,
    auth: item.auth,
    baseUrl: item.baseUrl,
    models: item.models,
    capabilities: item.capabilities,
    costHint: item.costHint,
    configured: item.configured,
    isActive: item.name === config.provider?.name
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed providers",
    data: { count: providers.length, active: config.provider?.name }
  });
  await recordLowRiskAudit(config, taskId, "provider.listed", "providers", {
    count: providers.length,
    configured: providers.filter((p) => p.configured).length
  });
  return JSON.stringify({ ok: true, activeProvider: config.provider?.name, activeModel: config.provider?.model, providers });
}

async function listAgentsOp(config: RuntimeConfig, taskId: string): Promise<string> {
  const { activeAgentId, agents } = listAgents(config);
  const summary = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    isActive: agent.id === activeAgentId,
    providerName: agent.providerName,
    model: agent.model,
    toolsets: agent.toolsets,
    messagingTargets: agent.messagingTargets,
    createdAt: agent.createdAt
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed agents",
    data: { count: summary.length, active: activeAgentId }
  });
  await recordLowRiskAudit(config, taskId, "agent.listed", "agents", {
    count: summary.length,
    active: activeAgentId
  });
  return JSON.stringify({ ok: true, activeAgentId, agents: summary });
}

async function listSkillsOp(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const statusFilter = typeof args.status === "string" && args.status !== "all" ? args.status : undefined;
  const nameContains = typeof args.nameContains === "string" ? args.nameContains.toLowerCase() : undefined;
  const all = listSkills(config);
  const filtered = all.filter((skill) => {
    if (statusFilter && skill.status !== statusFilter) return false;
    if (nameContains && !skill.name.toLowerCase().includes(nameContains)) return false;
    return true;
  });
  const summary = filtered.map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category ?? "user",
    status: skill.status,
    trigger: skill.trigger ?? "",
    description: skill.description ?? "",
    manifestPath: skill.manifestPath ?? null
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed skills",
    data: { total: all.length, returned: summary.length, statusFilter, nameContains }
  });
  await recordLowRiskAudit(config, taskId, "skill.listed", "skills", {
    total: all.length,
    returned: summary.length,
    statusFilter,
    nameContains
  });
  return JSON.stringify({ ok: true, total: all.length, skills: summary });
}

async function listMcpServers(config: RuntimeConfig, taskId: string): Promise<string> {
  const state = readState(config.instance);
  const servers = state.mcpServers.map((server) => ({
    id: server.id,
    name: server.name,
    transport: server.transport ?? "stdio",
    status: server.status,
    exposedTools: server.exposedTools,
    toolCount: server.tools?.length ?? 0,
    lastHealthAt: server.lastHealthAt ?? null,
    message: server.message ?? null,
    url: server.url ?? null
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed MCP servers",
    data: { count: servers.length }
  });
  await recordLowRiskAudit(config, taskId, "mcp.listed", "mcp", { count: servers.length });
  return JSON.stringify({ ok: true, servers });
}

async function listConnectors(config: RuntimeConfig, taskId: string): Promise<string> {
  const state = readState(config.instance);
  const connectors = state.connectors.map((connector) => ({
    id: connector.id,
    name: connector.name,
    provider: connector.provider,
    status: connector.status,
    health: connector.health,
    scopes: connector.scopes,
    source: connector.source ?? "user",
    lastHealthAt: connector.lastHealthAt ?? null,
    message: connector.message ?? null
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed connectors",
    data: { count: connectors.length }
  });
  await recordLowRiskAudit(config, taskId, "connector.listed", "connectors", { count: connectors.length });
  return JSON.stringify({ ok: true, connectors });
}

async function setProvider(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  // When the caller omits `provider`, keep the current one and only
  // patch model/baseUrl. setSetupProvider requires a provider name in
  // its payload, so default to the active one to keep the API path
  // accepting the no-switch case.
  const targetProvider = typeof args.provider === "string" && args.provider.trim().length > 0
    ? args.provider.trim()
    : config.provider?.name;
  if (!targetProvider) {
    return JSON.stringify({ ok: false, error: "set_provider requires a 'provider' when no provider is currently active." });
  }
  const payload: Record<string, unknown> = { provider: targetProvider };
  if (typeof args.model === "string" && args.model.trim().length > 0) payload.model = args.model.trim();
  if (typeof args.baseUrl === "string" && args.baseUrl.trim().length > 0) payload.baseUrl = args.baseUrl.trim();
  if (typeof args.apiKey === "string" && args.apiKey.trim().length > 0) payload.apiKey = args.apiKey.trim();
  const result = await setSetupProvider(config, payload);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: result.ok ? "Switched provider" : "Provider switch failed",
    data: {
      provider: targetProvider,
      model: typeof payload.model === "string" ? payload.model : undefined,
      ok: result.ok,
      error: result.error
    }
  });
  await recordLowRiskAudit(config, taskId, "provider.set", targetProvider, {
    ok: result.ok,
    model: typeof payload.model === "string" ? payload.model : undefined,
    plistRefreshNeeded: result.plistRefreshNeeded,
    error: result.error
  });
  return JSON.stringify({
    ok: result.ok,
    provider: result.provider,
    plistRefreshNeeded: result.plistRefreshNeeded,
    error: result.error
  });
}

async function setApprovalMode(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const mode = typeof args.mode === "string" ? args.mode.trim() : "";
  if (!["strict", "auto", "yolo"].includes(mode)) {
    return JSON.stringify({ ok: false, error: "set_approval_mode requires 'mode' to be one of: strict, auto, yolo." });
  }
  const result = updateAutoApproveSettings(config, { approvalMode: mode as ApprovalMode });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Set approval mode",
    data: { approvalMode: result.approvalMode }
  });
  await recordLowRiskAudit(config, taskId, "approval_mode.set", result.approvalMode, {
    approvalMode: result.approvalMode
  });
  return JSON.stringify({ ok: true, approvalMode: result.approvalMode });
}

async function useAgent(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const idOrName = typeof args.agentId === "string" ? args.agentId.trim() : "";
  if (!idOrName) {
    return JSON.stringify({ ok: false, error: "use_agent requires an 'agentId' (id or name)." });
  }
  try {
    const agent = await useAgentCapability(config, idOrName);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Switched active agent",
      data: { agentId: agent.id, name: agent.name }
    });
    await recordLowRiskAudit(config, taskId, "agent.activated", agent.id, {
      name: agent.name
    });
    return JSON.stringify({
      ok: true,
      activeAgentId: agent.id,
      agent: {
        id: agent.id,
        name: agent.name,
        providerName: agent.providerName,
        model: agent.model
      }
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function createAgent(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return JSON.stringify({ ok: false, error: "create_agent requires a 'name'." });
  }
  try {
    const record = await createAgentCapability(config, {
      name,
      providerName: typeof args.providerName === "string" ? args.providerName : undefined,
      model: typeof args.model === "string" ? args.model : undefined,
      toolsets: Array.isArray(args.toolsets) ? args.toolsets : undefined
    });
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Created agent",
      data: { agentId: record.id, name: record.name }
    });
    await recordLowRiskAudit(config, taskId, "agent.created", record.id, {
      name: record.name,
      providerName: record.providerName,
      model: record.model
    });
    return JSON.stringify({
      ok: true,
      agent: {
        id: record.id,
        name: record.name,
        providerName: record.providerName,
        model: record.model,
        toolsets: record.toolsets
      },
      note: "Agent created but NOT activated. Call use_agent to switch."
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function listToolsetsOp(config: RuntimeConfig, taskId: string): Promise<string> {
  const { toolsets } = listToolsets(config);
  const summary = toolsets.map((toolset) => ({
    id: toolset.id,
    name: toolset.name,
    status: toolset.status,
    description: toolset.description ?? "",
    toolNames: toolset.toolNames
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed toolsets",
    data: { count: summary.length }
  });
  await recordLowRiskAudit(config, taskId, "toolset.listed", "toolsets", { count: summary.length });
  return JSON.stringify({ ok: true, toolsets: summary });
}

async function enableToolset(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = typeof args.toolset === "string" ? args.toolset.trim() : "";
  if (!name) {
    return JSON.stringify({ ok: false, error: "enable_toolset requires a 'toolset' (name or id)." });
  }
  try {
    const toolset = await setToolsetStatus(config, name, "enabled");
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Enabled toolset",
      data: { toolset: toolset.name }
    });
    await recordLowRiskAudit(config, taskId, "toolset.enabled", toolset.name, { status: toolset.status });
    return JSON.stringify({ ok: true, toolset: toolset.name, status: toolset.status });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function disableToolset(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = typeof args.toolset === "string" ? args.toolset.trim() : "";
  if (!name) {
    return JSON.stringify({ ok: false, error: "disable_toolset requires a 'toolset' (name or id)." });
  }
  try {
    const toolset = await setToolsetStatus(config, name, "disabled");
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Disabled toolset",
      data: { toolset: toolset.name }
    });
    await recordLowRiskAudit(config, taskId, "toolset.disabled", toolset.name, { status: toolset.status });
    return JSON.stringify({ ok: true, toolset: toolset.name, status: toolset.status });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function deleteAgentOp(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const idOrName = typeof args.agentId === "string" ? args.agentId.trim() : "";
  if (!idOrName) {
    return JSON.stringify({ ok: false, error: "delete_agent requires an 'agentId' (id or name)." });
  }
  try {
    const result = await deleteAgent(config, idOrName);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Deleted agent",
      data: { agentId: result.id, unitsDeleted: result.unitsDeleted }
    });
    await recordLowRiskAudit(config, taskId, "agent.deleted", result.id, {
      unitsDeleted: result.unitsDeleted,
      bankDeleted: result.bankDeleted
    });
    return JSON.stringify({
      ok: true,
      agentId: result.id,
      unitsDeleted: result.unitsDeleted,
      bankDeleted: result.bankDeleted
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function removeProvider(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const provider = typeof args.provider === "string" ? args.provider.trim() : "";
  if (!provider) {
    return JSON.stringify({ ok: false, error: "remove_provider requires a 'provider' name." });
  }
  const result = removeSetupProvider(config, provider);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: result.ok ? "Removed provider" : "Provider removal failed",
    data: { provider, ok: result.ok, switched: result.switched, error: result.error }
  });
  await recordLowRiskAudit(config, taskId, "provider.removed", provider, {
    ok: result.ok,
    switched: result.switched,
    error: result.error
  });
  return JSON.stringify({ ok: result.ok, switched: result.switched, error: result.error });
}

async function setAutoApproveCommands(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!Array.isArray(args.patterns)) {
    return JSON.stringify({ ok: false, error: "set_auto_approve_commands requires 'patterns' to be an array of strings." });
  }
  const patterns = args.patterns.filter((p): p is string => typeof p === "string");
  const result = updateAutoApproveSettings(config, { patterns });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Set auto-approve commands",
    data: { count: result.patterns.length }
  });
  await recordLowRiskAudit(config, taskId, "auto_approve_commands.set", "auto_approve_commands", {
    count: result.patterns.length
  });
  return JSON.stringify({ ok: true, autoApproveCommands: result.patterns });
}

async function setDangerousPatterns(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!Array.isArray(args.patterns)) {
    return JSON.stringify({ ok: false, error: "set_dangerous_patterns requires 'patterns' to be an array of strings." });
  }
  const patterns = args.patterns.filter((p): p is string => typeof p === "string");
  const result = updateAutoApproveSettings(config, { dangerousTerminalPatterns: patterns });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Set dangerous terminal patterns",
    data: { count: result.dangerousTerminalPatterns.length }
  });
  await recordLowRiskAudit(config, taskId, "dangerous_patterns.set", "dangerous_patterns", {
    count: result.dangerousTerminalPatterns.length
  });
  return JSON.stringify({ ok: true, dangerousTerminalPatterns: result.dangerousTerminalPatterns });
}

// ---------------- Registry ----------------

export const SELF_OPERATIONS: SelfOperation[] = [
  {
    name: "get_self",
    summary: "Compact snapshot of Gini's runtime: instance, port, version, active provider/model, active agent, approval mode, resource counts.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => getSelf(config, taskId)
  },
  {
    name: "list_providers",
    summary: "LLM provider catalog with which is active and which have credentials configured.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => listProviders(config, taskId)
  },
  {
    name: "list_agents",
    summary: "Agents on this instance with per-agent provider/model overrides, toolset whitelists, and which is active.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => listAgentsOp(config, taskId)
  },
  {
    name: "list_skills",
    summary: "Installed skills with id, name, category, status, and trigger phrase. Filter by status or nameContains.",
    tag: "query",
    schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["enabled", "disabled", "archived", "all"],
          description: "Filter by status. Defaults to 'all'.",
          default: "all"
        },
        nameContains: { type: "string", description: "Optional case-insensitive substring filter on the skill name." }
      }
    },
    handler: (config, taskId, args) => listSkillsOp(config, taskId, args)
  },
  {
    name: "list_mcp_servers",
    summary: "Registered MCP servers with transport, status, and exposed tool count.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => listMcpServers(config, taskId)
  },
  {
    name: "list_connectors",
    summary: "Registered connectors (claude-code, codex, linear, …) with provider, status, and health.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => listConnectors(config, taskId)
  },
  {
    name: "set_provider",
    summary: "Switch the active LLM provider and/or model. Confirm the target is configured via list_providers first.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider id (e.g. 'codex', 'openai', 'openrouter', 'deepseek', 'local', 'echo'). When omitted, the current provider is kept and only `model`/`baseUrl` are updated."
        },
        model: { type: "string", description: "Model identifier on the target provider (e.g. 'deepseek-v4-pro', 'gpt-5.5'). Defaults to the provider's first catalog model when omitted." },
        baseUrl: { type: "string", description: "Override base URL for OpenAI-compatible providers (openai, openrouter, deepseek, local). Ignored for codex/echo." },
        apiKey: { type: "string", description: "API key — only required when the env var for this provider isn't already set. Persisted to secrets.env and process.env." }
      },
      required: []
    },
    handler: (config, taskId, args) => setProvider(config, taskId, args)
  },
  {
    name: "use_agent",
    summary: "Switch the active agent. Its provider/model override, SOUL.md, toolset filter, and memory namespace take effect next turn.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id or name (e.g. 'agent_abc123' or 'athena')." }
      },
      required: ["agentId"]
    },
    handler: (config, taskId, args) => useAgent(config, taskId, args)
  },
  {
    name: "create_agent",
    summary: "Create a new agent row (NOT activated — follow up with use_agent). Inherits provider/toolsets from the default agent unless overridden.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable name (e.g. 'Athena')." },
        providerName: { type: "string", description: "Optional provider override (e.g. 'deepseek'). Defaults to the default agent's provider." },
        model: { type: "string", description: "Optional model override (e.g. 'deepseek-v4-pro'). Defaults to the default agent's model." },
        toolsets: {
          type: "array",
          description: "Optional list of toolset names this agent is allowed to use. Defaults to the default agent's toolset set.",
          items: { type: "string" }
        }
      },
      required: ["name"]
    },
    handler: (config, taskId, args) => createAgent(config, taskId, args)
  },
  {
    name: "set_approval_mode",
    summary: "Set the runtime approval mode: strict (gate every high-risk action), auto (auto-approve safe actions, gate dangerous shell), or yolo (skip the per-action gate).",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["strict", "auto", "yolo"], description: "strict | auto | yolo." }
      },
      required: ["mode"]
    },
    handler: (config, taskId, args) => setApprovalMode(config, taskId, args)
  },
  {
    name: "list_toolsets",
    summary: "Instance toolsets with id, name, status (enabled/disabled), description, and the tool names each gates.",
    tag: "query",
    schema: { type: "object", properties: {} },
    handler: (config, taskId) => listToolsetsOp(config, taskId)
  },
  {
    name: "enable_toolset",
    summary: "Enable a toolset so its tools become available to agents on this instance. Reversible via disable_toolset.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        toolset: { type: "string", description: "Toolset name or id (e.g. 'browser', 'messaging')." }
      },
      required: ["toolset"]
    },
    handler: (config, taskId, args) => enableToolset(config, taskId, args)
  },
  {
    name: "disable_toolset",
    summary: "Disable a toolset so its tools stop being offered to agents. Self-config tools bypass toolset gating, so this can't lock the agent out of its own config surface. Reversible via enable_toolset.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        toolset: { type: "string", description: "Toolset name or id (e.g. 'browser', 'messaging')." }
      },
      required: ["toolset"]
    },
    handler: (config, taskId, args) => disableToolset(config, taskId, args)
  },
  {
    name: "delete_agent",
    summary: "Hard-delete an agent and its per-agent memory bank. Refuses the default agent and the currently-active agent (switch first via use_agent).",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id or name to delete (e.g. 'agent_abc123' or 'athena')." }
      },
      required: ["agentId"]
    },
    handler: (config, taskId, args) => deleteAgentOp(config, taskId, args)
  },
  {
    name: "remove_provider",
    summary: "Disconnect an env-keyed LLM provider: scrub its API key from process.env + secrets.env. If it was active, falls back to codex (or echo). Codex/local aren't removable this way.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id to remove (e.g. 'openai', 'openrouter', 'deepseek'). Codex and local cannot be removed here." }
      },
      required: ["provider"]
    },
    handler: (config, taskId, args) => removeProvider(config, taskId, args)
  },
  {
    name: "set_auto_approve_commands",
    summary: "REPLACE the auto-approve command allowlist (shell prefixes auto-approved without gating). Include existing entries (visible via get_self.approvalSettings.autoApproveCommands) to keep them.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          description: "The FULL allowlist of command prefixes to auto-approve. This REPLACES the existing list — read get_self.approvalSettings.autoApproveCommands first and include any entries you want to keep.",
          items: { type: "string" }
        }
      },
      required: ["patterns"]
    },
    handler: (config, taskId, args) => setAutoApproveCommands(config, taskId, args)
  },
  {
    name: "set_dangerous_patterns",
    summary: "REPLACE the dangerous-terminal-pattern list (substrings that always force a gate even in auto). Include existing entries (visible via get_self.approvalSettings.dangerousTerminalPatterns) to keep them.",
    tag: "mutate",
    schema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          description: "The FULL list of dangerous command substrings that always require approval. This REPLACES the existing list — read get_self.approvalSettings.dangerousTerminalPatterns first and include any entries you want to keep.",
          items: { type: "string" }
        }
      },
      required: ["patterns"]
    },
    handler: (config, taskId, args) => setDangerousPatterns(config, taskId, args)
  }
];

export function findSelfOperation(name: string): SelfOperation | undefined {
  return SELF_OPERATIONS.find((op) => op.name === name);
}
