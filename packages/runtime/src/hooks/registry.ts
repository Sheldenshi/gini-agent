// Trusted hook handler registry (ADR job-pre-run-hooks.md).
//
// This map is the WHOLE security boundary for the hook primitive: only code
// that registers into it can run as a hook. The model/user supplies a handlerId
// (a key into this map) + declarative config, never the handler body. A
// handlerId that isn't in the map is rejected at config-create time
// (isKnownHook) and treated as an error at run time (resolveHook).
//
// Domains POPULATE this registry by calling registerHook at load time (the
// composition root imports the handler modules — see builtins.ts), so the
// generic primitive never imports any domain handler.

import type { HookHandler } from "./types";

// Null-prototype maps so inherited Object.prototype keys ("constructor",
// "toString", "__proto__", …) are NOT members and never resolve to a JS
// built-in. With a plain object, `"constructor" in REGISTRY` is true and
// `REGISTRY["constructor"]` is a function — a client-reachable handlerId
// ("constructor") would then pass create-time validation and resolve to a
// built-in at run time, whose result has no `kind` and bricks the run. The
// null prototype + own-property checks below close that hole.
const REGISTRY: Record<string, HookHandler> = Object.create(null);

// Test-only handler overrides. Kept in a separate (also null-prototype) map so
// the production REGISTRY is never mutated; a registered override shadows (and
// resolves before) the built-in of the same id. Cleared via
// __resetHooksForTest. Only the hook primitive tests touch these — production
// code paths never register here.
const TEST_OVERRIDES: Record<string, HookHandler> = Object.create(null);

// Own-property membership: never walks the prototype chain, so prototype keys
// are rejected even if a future refactor swaps the maps back to plain objects.
function hasOwn(map: Record<string, HookHandler>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, id);
}

// Register a trusted built-in handler. Called at load time by a domain's hook
// module (imported via builtins.ts). Rejects a duplicate id or a prototype key
// so a second registration can't silently shadow a built-in.
export function registerHook(id: string, handler: HookHandler): void {
  if (id === "__proto__" || hasOwn(REGISTRY, id)) {
    throw new Error(`Duplicate or invalid hook id: ${id}`);
  }
  REGISTRY[id] = handler;
}

export function resolveHook(handlerId: string): HookHandler | undefined {
  if (hasOwn(TEST_OVERRIDES, handlerId)) return TEST_OVERRIDES[handlerId];
  if (hasOwn(REGISTRY, handlerId)) return REGISTRY[handlerId];
  return undefined;
}

export function isKnownHook(handlerId: string): boolean {
  return hasOwn(TEST_OVERRIDES, handlerId) || hasOwn(REGISTRY, handlerId);
}

export function __registerHookForTest(handlerId: string, handler: HookHandler): void {
  TEST_OVERRIDES[handlerId] = handler;
}

export function __resetHooksForTest(): void {
  for (const key of Object.keys(TEST_OVERRIDES)) delete TEST_OVERRIDES[key];
}
