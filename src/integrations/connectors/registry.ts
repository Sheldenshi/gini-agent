// Provider-module registry (ADR connector-provider-spec-compliance.md).
//
// Every concrete provider lives in this folder as `<id>.ts` and exports a
// `ProviderModule`. The registry collects them at import time so the
// connector runtime can look them up by id without per-provider switches.

import type { ProviderModule } from "./types";
import { demoProvider } from "./demo";
import { linearProvider } from "./linear";
import { telegramProvider } from "./telegram";
import { genericProvider } from "./generic";
import { claudeCodeProvider } from "./claude-code";
import { codexProvider } from "./codex";

const REGISTRY = new Map<string, ProviderModule>();

function register(module: ProviderModule): void {
  if (REGISTRY.has(module.id)) {
    throw new Error(`Duplicate provider id: ${module.id}`);
  }
  REGISTRY.set(module.id, module);
}

register(demoProvider);
register(linearProvider);
register(telegramProvider);
register(genericProvider);
register(claudeCodeProvider);
register(codexProvider);

export function getProvider(id: string): ProviderModule | undefined {
  return REGISTRY.get(id);
}

export function listProviders(): ProviderModule[] {
  return Array.from(REGISTRY.values());
}

export function hasProvider(id: string): boolean {
  return REGISTRY.has(id);
}
