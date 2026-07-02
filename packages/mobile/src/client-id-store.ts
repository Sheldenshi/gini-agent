// Stable per-install client id, persisted across launches and re-pairs. Sent to
// the gateway as the X-Gini-Client-ID header on native pairing so device
// identity keys on a per-install id instead of the fuzzy User-Agent label — two
// distinct phones on one relay subdomain then no longer evict each other on
// re-pair. The browser equivalent is the gini_client cookie (server-minted); a
// native client is cookieless, so it owns and persists its own id here.
//
// Reuses the `Storage` shape from ./device-token-store. Unlike the device-token
// cache (which only ever stores a value handed to it), this store GENERATES the
// id on first prime and writes it through, so read() returns a stable value for
// the process even on a fresh install.

import type { Storage } from "./device-token-store";

const DEFAULT_KEY = "gini.client-id.v1";

// crypto.randomUUID is unavailable under Hermes, so follow the codebase's
// stable-id idiom (see mobile/app/chat/[sessionId].tsx): time + randomness, base36.
// Generated ONCE and persisted, so the lack of cryptographic strength is fine —
// it's an opaque dedup id, not a secret.
function defaultGenerateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

export interface ClientIdStore {
  // Synchronous in-memory read for header injection. Null until prime() has run.
  read(): string | null;
  // One-shot rehydrate-or-mint: rehydrates a persisted id, or generates and
  // persists a new one when storage is empty. Idempotent once the slot is set.
  prime(): Promise<void>;
  // Drops both the in-memory slot and the persisted row. The next prime() mints
  // a fresh id. (Used on a full reset; ordinary sign-out leaves it intact so the
  // same browser/install re-pairs to the same identity.)
  clear(): Promise<void>;
}

export function createClientIdStore(
  storage: Storage,
  generateId: () => string = defaultGenerateId,
  key: string = DEFAULT_KEY
): ClientIdStore {
  let cached: string | null = null;

  async function prime(): Promise<void> {
    if (cached) return;
    let stored: string | null = null;
    try {
      stored = await storage.getItem(key);
    } catch {
      // Storage unavailable on read — fall through to minting an in-memory id so
      // the process still has a stable value rather than a fresh one per call.
    }
    if (stored && typeof stored === "string" && stored.length > 0) {
      cached = stored;
      return;
    }
    const minted = generateId();
    cached = minted;
    try {
      await storage.setItem(key, minted);
    } catch {
      // Best-effort persistence: the in-memory slot still covers this process.
    }
  }

  async function clear(): Promise<void> {
    cached = null;
    try {
      await storage.removeItem(key);
    } catch {
      // ditto — clearing failures don't block a reset.
    }
  }

  return {
    read: () => cached,
    prime,
    clear
  };
}
