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
  ["browser.upload_file", "high"]
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
  ["browser.upload_file", "high"]
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
