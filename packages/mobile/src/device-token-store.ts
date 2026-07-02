// APNs device-token cache, split out of `./push.ts` as a pure module
// so its rehydration + clear semantics can be exercised under
// `bun:test` without loading react-native or AsyncStorage.
//
// The production wrapper in `./push.ts` constructs a single store
// instance, injecting the real AsyncStorage as the `Storage`
// dependency. Tests pass a Map-backed fake.
//
// Shape mirrors the subset of AsyncStorage we actually use so the
// production call site stays a trivial passthrough.

export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DeviceTokenStore {
  // Synchronous in-memory read for header injection. Returns null
  // until either `prime()` has rehydrated a previously-persisted
  // token or `cache()` has been called this process.
  read(): string | null;
  // Writes the token to in-memory + storage. Passing null is
  // equivalent to `clear()`.
  cache(token: string | null): Promise<void>;
  // One-shot rehydration from storage into the in-memory slot. Safe
  // to call multiple times — once the slot is populated, subsequent
  // calls are no-ops.
  prime(): Promise<void>;
  // Drops both the in-memory slot and the persisted row.
  clear(): Promise<void>;
}

const DEFAULT_KEY = "gini.push.device-token";

export function createDeviceTokenStore(
  storage: Storage,
  key: string = DEFAULT_KEY
): DeviceTokenStore {
  let cached: string | null = null;

  async function cache(token: string | null): Promise<void> {
    if (token === null || token.length === 0) {
      await clear();
      return;
    }
    cached = token;
    try {
      await storage.setItem(key, token);
    } catch {
      // Best-effort: if storage is unavailable the in-memory cache
      // still covers the same-process lifetime.
    }
  }

  async function prime(): Promise<void> {
    if (cached) return;
    try {
      const stored = await storage.getItem(key);
      if (stored && typeof stored === "string" && stored.length > 0) {
        cached = stored;
      }
    } catch {
      // Storage unavailable — leave the slot null; the next cache()
      // call will repopulate.
    }
  }

  async function clear(): Promise<void> {
    cached = null;
    try {
      await storage.removeItem(key);
    } catch {
      // ditto — clearing failures don't block sign-out.
    }
  }

  return {
    read: () => cached,
    cache,
    prime,
    clear
  };
}
