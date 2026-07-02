import type { ProviderModule } from "./types";

// The "generic" provider is the escape hatch (ADR connector-provider-spec-compliance.md) used when a skill
// declares a connector requirement for a system Gini has no native module
// for. The user provides arbitrary `{ name, value, secret }` fields in the
// Add Connector dialog; secrets land in the encrypted store, non-secrets
// live on `metadata.fields`.
//
// There is no remote system to probe — the connector is "configured" if
// at least one field is present, and the runtime treats the connector as
// presence-only via the fallback path in `checkConnector`.
export const genericProvider: ProviderModule = {
  id: "generic",
  label: "Generic",
  description: "Catch-all connector for systems Gini doesn't yet have a native module for. You supply the fields.",
  // Fields are configured per-record at create time, not declared statically
  // on the module. The Add Connector dialog renders a dynamic field editor
  // when `provider === "generic"`.
  fields: []
};
