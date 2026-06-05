// Trusted pre-run hook handler registry (ADR job-pre-run-hooks.md).
//
// This map is the WHOLE security boundary for the pre-run hook primitive: only
// code that ships in it can run as a pre-run hook. The model/user supplies a
// handlerId (a key into this map) + declarative config, never the handler body.
// A handlerId that isn't in the map is rejected at job-create time
// (isKnownPreRunHook) and treated as an error at run time (resolvePreRunHook).

import type { PreRunHookHandler } from "./types";
import { gmailDeltaHandler } from "./gmail-delta";

const REGISTRY: Record<string, PreRunHookHandler> = {
  "gmail-delta": gmailDeltaHandler
};

// Test-only handler overrides. Kept in a separate map so the production REGISTRY
// is never mutated; a registered override shadows (and resolves before) the
// built-in of the same id. Cleared via __resetPreRunHooksForTest. Only the hook
// primitive tests touch these — production code paths never register here.
const TEST_OVERRIDES: Record<string, PreRunHookHandler> = {};

export function resolvePreRunHook(handlerId: string): PreRunHookHandler | undefined {
  return TEST_OVERRIDES[handlerId] ?? REGISTRY[handlerId];
}

export function isKnownPreRunHook(handlerId: string): boolean {
  return handlerId in TEST_OVERRIDES || handlerId in REGISTRY;
}

export function __registerPreRunHookForTest(handlerId: string, handler: PreRunHookHandler): void {
  TEST_OVERRIDES[handlerId] = handler;
}

export function __resetPreRunHooksForTest(): void {
  for (const key of Object.keys(TEST_OVERRIDES)) delete TEST_OVERRIDES[key];
}
