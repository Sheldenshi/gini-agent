// Provider-module registry (ADR connector-provider-spec-compliance.md).
//
// Every concrete provider lives in this folder as `<id>.ts` and exports a
// `ProviderModule`. The registry collects them at import time so the
// connector runtime can look them up by id without per-provider switches.

import type { ProviderModule } from "./types";
import { demoProvider } from "./demo";
import { linearProvider } from "./linear";
import { genericProvider } from "./generic";
import { claudeCodeProvider } from "./claude-code";
import { codexProvider } from "./codex";
import { googleOauthDesktopProvider } from "./google-oauth-desktop";
import { braveSearchProvider } from "./brave-search";
import { exaProvider } from "./exa";

const REGISTRY = new Map<string, ProviderModule>();

function register(module: ProviderModule): void {
  if (REGISTRY.has(module.id)) {
    throw new Error(`Duplicate provider id: ${module.id}`);
  }
  REGISTRY.set(module.id, module);
}

register(demoProvider);
register(linearProvider);
register(genericProvider);
register(claudeCodeProvider);
register(codexProvider);
register(googleOauthDesktopProvider);
register(braveSearchProvider);
register(exaProvider);

export function getProvider(id: string): ProviderModule | undefined {
  return REGISTRY.get(id);
}

export function listProviders(): ProviderModule[] {
  return Array.from(REGISTRY.values());
}

export function hasProvider(id: string): boolean {
  return REGISTRY.has(id);
}

// The canonical typed-credential NAME a template-backed provider maps to.
// Single source of truth shared by the state migration (provider-keyed records
// + legacy skill requires → credential names) and the skill loader (legacy
// `requires.connectors` → `requiredCredentials`), so all three of fresh-create
// (createConnector's template), migration, and loader agree:
//   - explicit `credentialName` on the module (oauth2 handles, e.g.
//     google-oauth-desktop → "google-workspace-oauth"), else
//   - the single env-var binding for an api-key provider (e.g. linear →
//     "LINEAR_API_KEY").
// Providers with no secret spec (presence-only) and `generic` have no canonical
// name and return undefined — those skills must declare `requires.credentials`.
export function canonicalCredentialName(providerId: string): string | undefined {
  const module = REGISTRY.get(providerId);
  if (!module) return undefined;
  if (module.credentialName) return module.credentialName;
  const envBindings = module.secrets?.envBindings;
  if (!envBindings) return undefined;
  const envVars = Object.keys(envBindings);
  if (envVars.length === 1) return envVars[0];
  return undefined;
}

// Reverse of `canonicalCredentialName`: the provider id whose canonical typed
// credential is named `credentialName`, or undefined when no registered
// provider owns that name. Used by the inactive-skills / "needs setup" UI to
// route a required credential name back to a provider's setup skill /
// request_connector flow even when no connector record exists yet.
export function providerForCredentialName(credentialName: string): string | undefined {
  for (const module of REGISTRY.values()) {
    if (canonicalCredentialName(module.id) === credentialName) return module.id;
  }
  return undefined;
}
