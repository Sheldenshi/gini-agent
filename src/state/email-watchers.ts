// Email watcher state helpers (ADR email-watch.md).
//
// An EmailWatcherRecord is a durable per-(account, sender-query) watcher.
// The gmail poll worker reads each enabled watcher and wakes an agent turn
// on each new matching message. These helpers follow the createXRecord
// convention in records.ts: the builder mutates a RuntimeState in place and
// emits an audit row; the config-level wrappers go through mutateState so
// all state I/O serializes through the per-instance lock.

import type { EmailWatcherRecord, RuntimeConfig, RuntimeState } from "../types";
import { id, now } from "./ids";
import { addAudit } from "./audit";
import { mutateState, readState } from "./store";

export function createEmailWatcher(
  state: RuntimeState,
  watcher: Omit<EmailWatcherRecord, "id" | "instance" | "status" | "createdAt" | "updatedAt"> &
    Partial<Pick<EmailWatcherRecord, "status">>
): EmailWatcherRecord {
  const at = now();
  const item: EmailWatcherRecord = {
    id: id("emailwatch"),
    instance: state.instance,
    status: "ok",
    createdAt: at,
    updatedAt: at,
    ...watcher
  };
  state.emailWatchers.unshift(item);
  addAudit(
    state,
    {
      actor: "user",
      action: "email.watcher.created",
      target: item.id,
      risk: "low",
      evidence: { provider: item.provider, query: item.query, accountEmail: item.accountEmail }
    },
    item.agentId ? { agentId: item.agentId } : { system: true }
  );
  return item;
}

export function listEmailWatchers(config: RuntimeConfig): EmailWatcherRecord[] {
  return readState(config.instance).emailWatchers;
}

export function getEmailWatcher(config: RuntimeConfig, watcherId: string): EmailWatcherRecord | undefined {
  return readState(config.instance).emailWatchers.find((item) => item.id === watcherId);
}

// Apply a field patch to a watcher inside the per-instance lock. Used by the
// poll worker to advance the cursor / flip status crash-safely, and by the
// tool/API to enable/disable. Returns the updated record (or undefined when
// the watcher vanished mid-flight).
export async function updateEmailWatcher(
  config: RuntimeConfig,
  watcherId: string,
  patch: Partial<Pick<EmailWatcherRecord, "query" | "labelIds" | "lastSeenInternalDate" | "enabled" | "status" | "lastError" | "lastPolledAt" | "accountEmail" | "credentialName">>
): Promise<EmailWatcherRecord | undefined> {
  return mutateState(config.instance, (state) => {
    const item = state.emailWatchers.find((candidate) => candidate.id === watcherId);
    if (!item) return undefined;
    Object.assign(item, patch);
    item.updatedAt = now();
    return item;
  });
}

export async function removeEmailWatcher(config: RuntimeConfig, watcherId: string): Promise<EmailWatcherRecord> {
  return mutateState(config.instance, (state) => {
    const index = state.emailWatchers.findIndex((candidate) => candidate.id === watcherId);
    if (index < 0) throw new Error(`Email watcher not found: ${watcherId}`);
    const [item] = state.emailWatchers.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "email.watcher.removed",
        target: item!.id,
        risk: "low",
        evidence: { provider: item!.provider, query: item!.query }
      },
      item!.agentId ? { agentId: item!.agentId } : { system: true }
    );
    return item!;
  });
}
