import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useState } from "react";

// Stored under a stable key so a future migration (pairing-claim flow,
// multiple instances) can read the older record without an app reset.
const STORAGE_KEY = "gini.auth.v1";

export interface AuthCredentials {
  baseUrl: string;
  token: string;
}

interface AuthState {
  status: "loading" | "ready";
  credentials: AuthCredentials | null;
}

// Listener fan-out so every mounted useAuth hook sees the same value
// (AsyncStorage doesn't broadcast change events). Saving on one screen
// must wake the auth gate on another without remounting.
type Listener = (next: AuthCredentials | null) => void;
const listeners = new Set<Listener>();
let cached: AuthCredentials | null | undefined = undefined;
let inflightLoad: Promise<AuthCredentials | null> | null = null;

async function loadFromStorage(): Promise<AuthCredentials | null> {
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<AuthCredentials> | null;
      if (!parsed || typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string") {
        return null;
      }
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    } catch {
      return null;
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

function broadcast(next: AuthCredentials | null) {
  cached = next;
  for (const listener of listeners) listener(next);
}

// Reduce a user-supplied base URL to scheme + host + port. The gateway
// accepts `?token=...` as an auth fallback, so a pasted URL like
// `http://host:7421?token=leaked` would otherwise be concatenated into
// every request and silently authenticate that way. Reject anything
// that doesn't parse so a malformed value can't be saved.
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid base URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https.");
  }
  return parsed.origin;
}

export async function saveCredentials(creds: AuthCredentials): Promise<void> {
  // Funnel all writes through normalizeBaseUrl so query strings, paths,
  // and trailing slashes can't sneak in via either the setup screen or
  // a future re-save path.
  const normalized: AuthCredentials = {
    baseUrl: normalizeBaseUrl(creds.baseUrl),
    token: creds.token.trim()
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  broadcast(normalized);
}

export async function clearCredentials(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
  broadcast(null);
}

export function useAuth(): AuthState & {
  save: (creds: AuthCredentials) => Promise<void>;
  clear: () => Promise<void>;
} {
  const [credentials, setCredentials] = useState<AuthCredentials | null>(
    cached ?? null
  );
  const [status, setStatus] = useState<"loading" | "ready">(
    cached === undefined ? "loading" : "ready"
  );

  useEffect(() => {
    let active = true;
    if (cached === undefined) {
      loadFromStorage().then((value) => {
        if (!active) return;
        cached = value;
        setCredentials(value);
        setStatus("ready");
      });
    } else {
      setCredentials(cached);
      setStatus("ready");
    }
    const listener: Listener = (next) => {
      if (!active) return;
      setCredentials(next);
    };
    listeners.add(listener);
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const save = useCallback((creds: AuthCredentials) => saveCredentials(creds), []);
  const clear = useCallback(() => clearCredentials(), []);

  return useMemo(
    () => ({ status, credentials, save, clear }),
    [status, credentials, save, clear]
  );
}

// Read-only accessor for the fetcher in api.ts. The api() call has to be
// callable from React Query queryFn / mutationFn closures, so it can't
// take the credentials as an argument from every call site — instead it
// pulls them from this module's cache, which mirrors AsyncStorage.
export function readCachedCredentials(): AuthCredentials | null {
  return cached ?? null;
}

// Used by the auth-gate effect in the root layout to pre-warm the cache
// before the first render that depends on it.
export async function primeCredentials(): Promise<AuthCredentials | null> {
  if (cached !== undefined) return cached;
  const value = await loadFromStorage();
  cached = value;
  return value;
}
