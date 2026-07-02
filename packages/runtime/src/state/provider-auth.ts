// Persistent per-provider needs-reauth state (issue #233).
//
// Until this module existed, a provider auth failure surfaced ONLY as a
// transient per-session chat note while every persistent surface (Settings →
// Providers, connector health, setup Verify) kept reporting the provider as
// connected. The record written here is the durable counterpart of that note:
// `failTask` and the chat-task summary-failure path record a failure whenever
// a `ProviderAuthError` kills a task, and the runtime clears it again at the
// seams that prove the credential works (a successful provider call in the
// chat-task loop, a provider-config change / Verify through the setup API).
// Only failures are stored — absence of a record means OK. See ADR
// provider-reauth-guidance.md.

import type { Instance, ProviderAuthFailureRecord, ProviderName, RuntimeState } from "../types";
import { addAudit } from "./audit";
import { now } from "./ids";
import { mutateState, readState } from "./store";

export interface ProviderAuthFailureInput {
  provider: ProviderName;
  // Must already be redacted (redactSecrets) by the caller — failTask and the
  // summary path redact before storing task.error, and this record mirrors it.
  detail: string;
  taskId?: string;
}

// Record (or refresh) the needs-reauth state for a provider. Always updates
// the record's detail/timestamp so the newest failure wins, but emits the
// `provider.auth.needs_reauth` audit row only on the ok→needs_reauth
// transition — repeated failures of an already-flagged provider would
// otherwise spam the audit trail (mirrors connector.health.transition).
// Call from inside a mutateState callback.
export function recordProviderAuthFailure(
  state: RuntimeState,
  input: ProviderAuthFailureInput
): ProviderAuthFailureRecord {
  const transition = !state.providerAuthFailures?.[input.provider];
  const record: ProviderAuthFailureRecord = {
    provider: input.provider,
    detail: input.detail,
    at: now(),
    ...(input.taskId ? { taskId: input.taskId } : {})
  };
  state.providerAuthFailures ??= {};
  state.providerAuthFailures[input.provider] = record;
  if (transition) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "provider.auth.needs_reauth",
        target: input.provider,
        risk: "medium",
        ...(input.taskId ? { taskId: input.taskId } : {}),
        evidence: { provider: input.provider, detail: input.detail }
      },
      input.taskId ? { taskId: input.taskId } : { system: true }
    );
  }
  return record;
}

// Drop the needs-reauth record for a provider. Returns false (and writes
// nothing, audits nothing) when no record exists, so callers inside a
// mutateState callback stay cheap on the healthy path. Call from inside a
// mutateState callback.
//
// `evidenceFrom` is the ISO timestamp at which the successful provider call
// STARTED. When set, a record written at or after that moment survives the
// clear: the success's auth evidence was gathered before the failure was
// observed (a long stream authenticated before the token expired), so it
// proves nothing about the credential's current state. Omit it for explicit
// user re-establishment (setup-API config writes, Verify, removal), which
// clears unconditionally.
export function clearProviderAuthFailure(
  state: RuntimeState,
  provider: ProviderName,
  options: { reason: string; taskId?: string; evidenceFrom?: string }
): boolean {
  const existing = state.providerAuthFailures?.[provider];
  if (!existing) return false;
  // Plain lexicographic compare is correct: both timestamps come from
  // new Date().toISOString() (fixed-width UTC). >= keeps the record on a
  // millisecond tie — a skipped clear self-heals on the next successful
  // call, while a wrong clear restores stale "Connected" against a dead
  // credential. Evaluated here, under the mutateState lock, so a record
  // written between a caller's read and this mutate still wins.
  if (options.evidenceFrom && existing.at >= options.evidenceFrom) return false;
  delete state.providerAuthFailures![provider];
  addAudit(
    state,
    {
      actor: "runtime",
      action: "provider.auth.cleared",
      target: provider,
      risk: "low",
      ...(options.taskId ? { taskId: options.taskId } : {}),
      evidence: { provider, reason: options.reason, failedAt: existing.at }
    },
    options.taskId ? { taskId: options.taskId } : { system: true }
  );
  return true;
}

// Standalone clear seam for high-frequency call sites (every successful
// provider call in the chat-task loop, every setup-API config write). The
// lock-free readState check first means the common healthy path performs NO
// state write at all — mutateState only runs when a record actually exists.
// clearProviderAuthFailure re-checks under the lock, so a racing clear is a
// harmless no-op, and applies the `evidenceFrom` ordering guard so a clear
// racing a newer failure record keeps the record.
export async function clearProviderAuthFailureIfPresent(
  instance: Instance,
  provider: ProviderName,
  options: { reason: string; taskId?: string; evidenceFrom?: string }
): Promise<boolean> {
  if (!readState(instance).providerAuthFailures?.[provider]) return false;
  return mutateState(instance, (state) => clearProviderAuthFailure(state, provider, options));
}
