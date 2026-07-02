import type { AgentRecord, Instance, ToolRecord, ToolsetRecord } from "../types";
import { riskForTool } from "../execution/tool-risk";

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
      description: "On-demand recall against the Hindsight per-agent bank (recall_memory). Auto-retain populates the bank from chat tasks automatically; this toolset gates the agent's ability to query it.",
      status: "enabled",
      toolNames: ["memory.recall"],
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
      status: "enabled",
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
      status: "enabled",
      toolNames: ["message.send"],
      scopes: ["job", "messaging"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_web_search",
      instance,
      name: "web_search",
      description: "Public web search via configured Brave Search or Exa connectors.",
      status: "enabled",
      toolNames: ["web.search"],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_database",
      instance,
      name: "database",
      description: "The agent's own sandboxed SQL database for keeping and exhaustively querying structured records (db_query/db_execute/db_import/db_schema). Distinct from memory recall — SQL returns every matching row, not a ranked sample. Skills layer use-cases (people-CRM, expense log, …) on top.",
      status: "enabled",
      toolNames: [
        "db.query",
        "db.execute",
        "db.import",
        "db.schema"
      ],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    },
    {
      id: "toolset_browser",
      instance,
      name: "browser",
      description: "Browser automation: navigate, snapshot, click, type, and inspect web pages.",
      status: "enabled",
      toolNames: [
        "browser.navigate",
        "browser.snapshot",
        "browser.click",
        "browser.type",
        "browser.press",
        "browser.scroll",
        "browser.back",
        "browser.console",
        "browser.close",
        "browser.vision",
        "browser.hover",
        "browser.drag",
        "browser.select_option",
        "browser.wait_for",
        "browser.tabs",
        "browser.upload_file",
        "browser.connect"
      ],
      scopes: ["task", "job", "skill", "subagent"],
      createdAt: at,
      updatedAt: at
    }
  ];
}

export function defaultTools(instance: Instance, at: string): ToolRecord[] {
  return defaultToolsets(instance, at).flatMap((toolset) => toolset.toolNames.map((name) => {
    const risk = riskForTool(name);
    return {
      id: `tool_${name.replaceAll(".", "_")}`,
      instance,
      name,
      description: `${name} from ${toolset.name} toolset`,
      toolset: toolset.name,
      status: toolset.status === "enabled" ? "available" : "disabled",
      risk,
      requiresApproval: risk === "high",
      createdAt: at,
      updatedAt: at
    } satisfies ToolRecord;
  }));
}

// Baseline toolset whitelist for any newly-created agent. Exported so
// the openclaw migrator (and any future agent-bootstrap path) can
// mirror the canonical list rather than duplicating it inline and
// drifting silently when this list grows.
//
// `messaging` and `mcp` are in the whitelist so that the active agent
// doesn't silently gate them out via the per-agent intersection. The
// kill switch lives where it should: on the toolset's enabled/disabled
// status.
//
// `browser` is included so new agents can drive the headless Chrome
// surface (navigate/snapshot/click/type/upload/etc.) on day one.
// A migration in store.ts widens existing agent_default rows whose
// toolsets predate this addition.
export const DEFAULT_AGENT_TOOLSETS: readonly string[] = [
  "file",
  "terminal",
  "memory",
  "session_search",
  "delegation",
  "messaging",
  "mcp",
  "browser",
  "web_search",
  "database"
];

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
    name: "Gini",
    status: "active",
    providerName: undefined,
    model: undefined,
    toolsets: [...DEFAULT_AGENT_TOOLSETS],
    messagingTargets: [],
    createdAt: at,
    updatedAt: at
  };
}
