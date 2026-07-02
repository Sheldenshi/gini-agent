// Hook primitive public surface (ADR job-pre-run-hooks.md).
//
// This barrel re-exports the domain-agnostic primitive that consumers (the jobs
// scheduler, or any independent caller) import. It deliberately does NOT import
// builtins.ts — importing the primitive must never drag a domain handler (email)
// into the load path. The composition root (server/cli/test setup) imports
// builtins.ts separately to register the trusted built-ins.

export type { HookConfig, HookContext, HookContextItem, HookResult, HookHandler } from "./types";
export {
  registerHook,
  resolveHook,
  isKnownHook,
  __registerHookForTest,
  __resetHooksForTest
} from "./registry";
export { runHook, type HookOutcome } from "./runner";
