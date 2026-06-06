// Trusted pre-run hook handler registry (ADR job-pre-run-hooks.md).
//
// This map is the WHOLE security boundary for the pre-run hook primitive: only
// code that ships in it can run as a pre-run hook. The model/user supplies a
// handlerId (a key into this map) + declarative config, never the handler body.
// A handlerId that isn't in the map is rejected at job-create time
// (isKnownPreRunHook) and treated as an error at run time (resolvePreRunHook).

import type { PreRunHookHandler } from "./types";
import { gmailDeltaHandler } from "./gmail-delta";

// Null-prototype maps so inherited Object.prototype keys ("constructor",
// "toString", "__proto__", …) are NOT members and never resolve to a JS
// built-in. With a plain object, `"constructor" in REGISTRY` is true and
// `REGISTRY["constructor"]` is a function — a client-reachable handlerId
// ("constructor") would then pass create-time validation and resolve to a
// built-in at run time, whose result has no `kind` and bricks the run. The
// null prototype + own-property checks below close that hole.
const REGISTRY: Record<string, PreRunHookHandler> = Object.assign(Object.create(null), {
  "gmail-delta": gmailDeltaHandler
});

// Test-only handler overrides. Kept in a separate (also null-prototype) map so
// the production REGISTRY is never mutated; a registered override shadows (and
// resolves before) the built-in of the same id. Cleared via
// __resetPreRunHooksForTest. Only the hook primitive tests touch these —
// production code paths never register here.
const TEST_OVERRIDES: Record<string, PreRunHookHandler> = Object.create(null);

// Own-property membership: never walks the prototype chain, so prototype keys
// are rejected even if a future refactor swaps the maps back to plain objects.
function hasOwn(map: Record<string, PreRunHookHandler>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, id);
}

export function resolvePreRunHook(handlerId: string): PreRunHookHandler | undefined {
  if (hasOwn(TEST_OVERRIDES, handlerId)) return TEST_OVERRIDES[handlerId];
  if (hasOwn(REGISTRY, handlerId)) return REGISTRY[handlerId];
  return undefined;
}

export function isKnownPreRunHook(handlerId: string): boolean {
  return hasOwn(TEST_OVERRIDES, handlerId) || hasOwn(REGISTRY, handlerId);
}

export function __registerPreRunHookForTest(handlerId: string, handler: PreRunHookHandler): void {
  TEST_OVERRIDES[handlerId] = handler;
}

export function __resetPreRunHooksForTest(): void {
  for (const key of Object.keys(TEST_OVERRIDES)) delete TEST_OVERRIDES[key];
}
