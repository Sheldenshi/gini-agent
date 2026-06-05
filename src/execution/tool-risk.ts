// The single source of truth for tool risk classification.
// Action strings here (e.g. "browser.tabs.new") are the audit-action labels
// emitted by the dispatch path; tool names (e.g. "browser.upload_file") are
// the catalog tool names used in default state seeding.

export type RiskLevel = "low" | "medium" | "high";

// Map from audit action string → risk. Used by dispatch to tag audit rows.
export const ACTION_RISK: ReadonlyMap<string, RiskLevel> = new Map<string, RiskLevel>([
  ["browser.click", "medium"],
  ["browser.type", "medium"],
  ["browser.drag", "medium"],
  ["browser.select_option", "medium"],
  ["browser.tabs.new", "medium"],
  ["browser.tabs.switch", "medium"],
  ["browser.tabs.close", "medium"],
  // browser.connect spawns a persistent Chrome profile and surfaces a
  // desktop window — the trust-establishment moment that warrants an
  // explicit approval row. Other browser actions skip approval because
  // they happen *within* a window the user already approved; this is
  // the action that establishes that window.
  ["browser.connect", "medium"],
  ["browser.upload_file", "high"],
  // Routes user-typed secrets directly into a DOM field on the
  // agent's page. High risk because the approval card is the user's
  // last chance to refuse before a credential leaves their keyboard.
  ["browser.fill_secret", "high"],
  // Mutate self-config ops (set_provider / use_agent / create_agent /
  // rename_agent) route through the approval seam as this action. Medium:
  // a config rewrite, not external egress.
  ["self.config", "medium"]
  // anything not listed defaults to "low" via the helper below
]);

export function riskForAction(action: string): RiskLevel {
  return ACTION_RISK.get(action) ?? "low";
}

// Map from catalog tool NAME → risk. Used by default-state seeding.
// This is intentionally a separate map: action labels include suffixes like
// ".new"/".switch", while tool names are the underlying catalog identifiers.
// Listing both maps explicitly is clearer than deriving one from the other.
export const TOOL_RISK: ReadonlyMap<string, RiskLevel> = new Map<string, RiskLevel>([
  ["browser.upload_file", "high"],
  // Mirror the medium classification ACTION_RISK gives to browser.connect
  // so the persisted tool row in state.json carries the right risk
  // label. Without this entry the substring heuristic in
  // riskForTool below would default this to "low".
  ["browser.connect", "medium"],
  // Mirrors the high classification ACTION_RISK gives to
  // browser.fill_secret. The catalog tool name is the
  // underscore-separated form.
  ["browser_fill_secrets", "high"],
  // The agent-database write tool. Its name trips the "exec" substring
  // heuristic below, but it's a no-approval write to the agent's OWN isolated
  // sandbox DB (ADR agent-database.md) — like a memory write, not an external
  // side effect. Pin it low so the ToolRecord risk and the audit
  // (recordLowRiskAudit) agree. The toolset registers it as "db.execute".
  ["db.execute", "low"]
  // The self-config direct tools (get_self, list_*, set_provider, use_agent,
  // create_agent, rename_agent) are not listed here: none of their names
  // trip the substring heuristic below, so they correctly seed as "low" at
  // the tool-name level. The mutate ops still gate at dispatch via the
  // "self.config" ACTION_RISK entry above.
  // Everything else falls out of the substring heuristic in defaults.ts.
]);

export function riskForTool(name: string): RiskLevel {
  const explicit = TOOL_RISK.get(name);
  if (explicit) return explicit;
  if (name.includes("write") || name.includes("exec") || name.includes("invoke") || name.includes("send")) {
    return "high";
  }
  return "low";
}
