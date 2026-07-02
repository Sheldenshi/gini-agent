// AsyncStorage-backed singleton for the stable per-install client id. Wraps the
// pure createClientIdStore (./client-id-store) with the real AsyncStorage, the
// same way push.ts wraps createDeviceTokenStore. Kept tiny and RN-only so the
// pure store stays unit-testable without react-native.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClientIdStore } from "./client-id-store";
import type { Storage } from "./device-token-store";

const asyncStorageAdapter: Storage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key)
};

// Module-singleton store, constructed eagerly so getCachedClientId can read
// through it from the first synchronous call once primed.
const clientIdStore = createClientIdStore(asyncStorageAdapter);

// Synchronous read for header injection (the native pairing client). Null until
// primeClientId has run; the pairing client falls back to omitting the header.
export function getCachedClientId(): string | null {
  return clientIdStore.read();
}

// Rehydrate-or-mint the per-install id on cold start, alongside the other
// AsyncStorage primes in the root layout, so the X-Gini-Client-ID header is
// available before the first pairing request.
export async function primeClientId(): Promise<void> {
  await clientIdStore.prime();
}
