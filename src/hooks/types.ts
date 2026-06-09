// Pre-LLM hook primitive (ADR job-pre-run-hooks.md).
//
// A hook runs deterministically BEFORE a model turn and signals back through a
// typed discriminated result — the in-process analog of Claude Code's
// exit-code/JSON contract for a pre-LLM (UserPromptSubmit) hook:
//   - shortCircuit  ~ exit 2 + stderr -> block: finalize, 0 model turns
//   - context       ~ additionalContext: inject fenced data into the turn
//   - error         ~ non-blocking error: finalize failed, no turn
//
// This module is DOMAIN-AGNOSTIC: it knows nothing about jobs, email, or state.
// Consumers (the jobs scheduler, or any independent caller) drive it via the
// runner; domains register trusted handlers into the registry. Handlers are
// TRUSTED in-tree built-ins resolved by id (see registry.ts) — the model/user
// supplies a handlerId (a registry key) plus declarative `config` DATA, never
// executable code.

import type { RuntimeConfig } from "../types";

// Declarative hook configuration. A consumer persists this (e.g. on a
// JobRecord) and hands it to the runner; the runner resolves the trusted
// handler by `handlerId` and feeds it the `config` DATA.
export interface HookConfig {
  // Registry id of a trusted in-tree handler. v1: "skill-script" (runs a named
  // skill script headless). Rejected by a consumer at config-create time
  // (isKnownHook) and treated as an error at run time (the runner) when not in
  // the registry.
  handlerId: string;
  // Declarative, handler-specific configuration validated by the handler.
  // For skill-script: { skill, script, ...declarative data }.
  config: Record<string, unknown>;
  // Per-hook wall-clock budget. Defaults to the runner's PRE_RUN_HOOK_DEFAULT_
  // TIMEOUT_MS (30s) — the pre-LLM path is on the critical path to the model, so
  // it gets Claude Code's tight UserPromptSubmit budget, not a job's 600s budget.
  timeoutMs?: number;
}

// What every hook handler receives. Deterministic + read-only-by-contract. A
// handler runs OUTSIDE the spawned task's approval/audit/trace envelope, so it
// must only do read-only / idempotent side effects, never the kind that requires
// the approval gate. State that the handler computes should ride back on the
// HookResult (the consumer persists it) rather than being written by the handler
// — the skill-script handler runs a PURE script (state in, state out) and writes
// nothing itself. See CLAUDE.md boundaries + ADR job-pre-run-hooks.md.
//
// CANCELLATION SAFETY: the runner enforces the per-hook timeout with
// Promise.race, which does NOT cancel the losing promise — a handler that
// exceeds its timeout keeps running to completion. Handlers MUST therefore be
// cancellation-safe and idempotent: only replay-safe side effects, so an
// orphaned post-timeout handler can't corrupt state or double-deliver.
export interface HookContext {
  config: RuntimeConfig; // per-instance runtime config (instance-isolated)
  hookConfig: Record<string, unknown>; // HookConfig.config (declarative) merged with any caller payload
}

// A single piece of injectable context. `untrusted: true` means the runner
// renders it inside the hardened untrusted fence (JSON-encoded so quotes /
// newlines / marker-like bytes are escaped onto one physical line, a per-item
// nonce on the close delimiter so it can't be forged from inside the data, a
// fixpoint sentinel strip + CR/LF collapse, and a char cap that keeps the close
// marker intact) — Claude Code's "phrase additionalContext as factual data, not
// instructions" rule, with the prompt-injection boundary owned by the trusted
// runner. A handler that vouches for its own framing (a notice with no untrusted
// bytes) sets untrusted:false and is passed through verbatim (still char-capped).
export interface HookContextItem {
  text: string;
  untrusted: boolean;
}

// Discriminated result — the typed analog of Claude Code's exit-code/JSON. One
// mode per invocation: the union makes it impossible to both short-circuit and
// inject, enforcing what Claude Code enforces by convention.
export type HookResult =
  // exit-2 analog: cancel before the model. The consumer finalizes with no turn.
  // `summary` becomes the run summary; an empty / "[SILENT]" summary suppresses
  // chat + bridge delivery, exactly like a completed-with-nothing turn.
  //
  // `state` is the handler's OPAQUE next state (a pure function returns its new
  // state alongside its result). A consumer that owns the handler's state (the
  // jobs scheduler persists it onto JobRecord.hookState) writes it. A
  // shortCircuit delivers nothing, so the consumer persists `state` IMMEDIATELY.
  | { kind: "shortCircuit"; summary?: string; state?: Record<string, unknown> }
  // additionalContext analog: run the turn with these items injected.
  //
  // `onDispatched` is an OPTIONAL post-delivery commit thunk: the consumer
  // awaits it ONLY after the turn has successfully dispatched — never if dispatch
  // throws. A handler whose items represent about-to-be-DELIVERED work puts that
  // commit here so a dispatch failure leaves the work un-committed.
  //
  // `state` is the handler's OPAQUE next state (see shortCircuit). Because a
  // context result represents about-to-be-DELIVERED work, the consumer persists
  // `state` ONLY after the turn dispatches (the same at-least-once boundary as
  // `onDispatched`): a dispatch failure leaves the OLD state so the next fire
  // re-detects and re-delivers. A pure handler (the skill-script handler) carries
  // ALL of its commit semantics in `state` + this timing and needs no
  // `onDispatched` thunk; the thunk remains for handlers with side effects.
  | {
      kind: "context";
      items: HookContextItem[];
      onDispatched?: () => void | Promise<void>;
      state?: Record<string, unknown>;
    }
  // non-blocking-error analog: the consumer finalizes failed; no turn. No state
  // is committed (the next fire re-reads the last persisted state).
  | { kind: "error"; message: string };

export type HookHandler = (ctx: HookContext) => Promise<HookResult>;
