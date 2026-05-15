// Provider-module contract (ADR connector-provider-spec-compliance.md).
//
// A ProviderModule encapsulates everything Gini needs to know about a
// specific external integration — its label, the fields the Add Connector
// dialog renders, which env-var bindings expose to skills, and (optionally)
// a remote health probe. Each module is a peer in `src/integrations/
// connectors/` and registers itself via the registry.

import type { RuntimeConfig } from "../../types";

export interface ProviderField {
  // Stable id used as the form-field name and (for secrets) the secret
  // purpose. Kebab-case by convention.
  name: string;
  // Human-readable label rendered in the Add Connector dialog.
  label: string;
  // Hint text rendered below the field.
  description?: string;
  // Whether the value is sensitive. Secret fields are persisted via the
  // encrypted secrets store (ADR connector-secret-storage.md) and never written to state.json or
  // audit evidence. Non-secret fields live on `connector.metadata.fields`.
  secret: boolean;
  // Whether the user must supply this field. The CRUD layer rejects
  // missing required fields before persisting.
  required?: boolean;
  // Placeholder rendered in the form input.
  placeholder?: string;
}

export interface ProviderSecretSpec {
  // Logical purposes the provider's secrets satisfy (for audit clarity).
  purposes: string[];
  // Map of env var → secret purpose. The runtime uses this to bind a
  // connector's secrets into the env of subprocesses launched by skills
  // that depend on this provider. Example: `{ LINEAR_API_KEY: "token" }`
  // for the Linear provider.
  envBindings: Record<string, string>;
}

export interface ProbeContext {
  config: RuntimeConfig;
  connectorId: string;
  // Resolve a secret value for the connector under probe. Records an audit
  // event regardless of success.
  resolveSecret: (purpose: string) => Promise<string | undefined>;
  // Non-secret per-record metadata (e.g. base URL, account id).
  metadata: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  // Surfaced to the user via `connector.message`.
  message?: string;
}

export interface DetectResult {
  detected: boolean;
  // Optional human-friendly name to suggest in the Add Connector dialog.
  suggestedName?: string;
  // Optional notes describing how detection ran (CLI path, env var…).
  message?: string;
}

export interface ProviderModule {
  // Kebab-case identifier. Must equal the file basename and match the
  // value users supply for `provider` in API and CLI calls.
  id: string;
  // Human-readable label for the dialog and connector cards.
  label: string;
  // One-line product summary rendered in the Add Connector dialog.
  description: string;
  // Form fields the Add Connector dialog renders. Empty for providers that
  // have no inputs (e.g. claude-code, codex use the host environment).
  fields: ProviderField[];
  // Secret spec — purposes and env-var bindings the provider declares.
  // Omitted for providers that don't store secrets.
  secrets?: ProviderSecretSpec;
  // Probe is optional per ADR connector-provider-spec-compliance.md. Providers with no remote system to
  // query (apple-notes via TCC, generic by definition) omit it; the
  // connector record's health falls back to a status-only check.
  probe?(ctx: ProbeContext): Promise<ProbeResult>;
  // Optional detector — surfaces "we noticed `claude` on your PATH" in
  // the Add Connector dialog. Best-effort; called from the gateway only
  // when the user opens the dialog.
  detect?(): Promise<DetectResult>;
  // Per-provider probe-interval override (ms). Defaults to 30 minutes
  // when undefined. The periodic re-probe job uses this to pace the
  // background health pass.
  probeIntervalMs?: number;
}
