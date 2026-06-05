// Pre-LLM job-hook primitive (ADR job-pre-run-hooks.md).
//
// A pre-run hook runs deterministically AFTER a job run is claimed but BEFORE
// any model turn, and signals back through a typed discriminated result — the
// in-process analog of Claude Code's exit-code/JSON contract for a pre-LLM
// (UserPromptSubmit) hook:
//   - shortCircuit  ~ exit 2 + stderr -> block: finalize the run, 0 model turns
//   - context       ~ additionalContext: inject fenced data into the drafting turn
//   - error         ~ non-blocking error: finalize the run failed, no draft
//
// Handlers are TRUSTED in-tree built-ins resolved from a registry by id (see
// registry.ts). The model/user supplies a handlerId (a key into the registry)
// plus declarative `config` DATA, never executable code.

import type { JobRecord, JobRunRecord, RuntimeConfig } from "../../types";

// What every pre-run handler receives. Deterministic + read-only-by-contract.
// A handler may persist its OWN cursor/dedup state (the gmail-delta handler
// writes the EmailWatcherRecord cursor + email_seen) but it runs OUTSIDE the
// spawned task's approval/audit/trace envelope, so it must only do read-only /
// idempotent side effects (cursor + dedup), never the kind that requires the
// approval gate. See CLAUDE.md boundaries + ADR job-pre-run-hooks.md.
export interface PreRunHookContext {
  config: RuntimeConfig; // per-instance runtime config (instance-isolated)
  job: JobRecord; // the claimed job
  run: JobRunRecord; // the in-"running" JobRunRecord
  hookConfig: Record<string, unknown>; // JobPreRunHookConfig.config (declarative)
}

// A single piece of injectable context. `untrusted: true` means the scheduler
// renders it inside a fence labeled as data, not instructions (Claude Code's
// "phrase additionalContext as factual data" rule). A handler that owns its own
// fence (gmail-delta returns already-fenced JSON+nonce strings) sets
// untrusted:false so the scheduler doesn't double-fence.
export interface PreRunHookContextItem {
  text: string;
  untrusted: boolean;
}

// Discriminated result — the typed analog of Claude Code's exit-code/JSON. One
// mode per invocation: the union makes it impossible to both short-circuit and
// inject, enforcing what Claude Code enforces by convention.
export type JobPreRunHookResult =
  // exit-2 analog: cancel before the model. The run is finalized with no turn.
  // `summary` becomes the run summary; an empty / "[SILENT]" summary suppresses
  // chat + bridge delivery, exactly like a completed-with-nothing turn.
  | { kind: "shortCircuit"; summary?: string }
  // additionalContext analog: run the drafting turn with these items injected.
  | { kind: "context"; items: PreRunHookContextItem[] }
  // non-blocking-error analog: finalize the run as failed; no draft.
  | { kind: "error"; message: string };

export type PreRunHookHandler = (ctx: PreRunHookContext) => Promise<JobPreRunHookResult>;
