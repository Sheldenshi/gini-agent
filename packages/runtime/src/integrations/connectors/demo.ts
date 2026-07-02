import type { ProviderModule } from "./types";

// The "demo" provider exists so a fresh install has a working connector
// to exercise the CRUD + activation flow. It carries no secrets and has
// no remote system to probe — the connector record's status drives health.
export const demoProvider: ProviderModule = {
  id: "demo",
  label: "Demo",
  description: "Built-in placeholder connector. No secrets, no remote API.",
  fields: []
};
