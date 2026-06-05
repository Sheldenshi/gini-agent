import AsyncStorage from "@react-native-async-storage/async-storage";

// A breadcrumb that survives an iOS suspend/terminate while the user is mid-pair.
// The /pair screen holds no credentials and keeps its whole handshake in memory,
// so a cold relaunch would otherwise land on the auth gate (index.tsx) and bounce
// to /setup, losing the in-progress pairing. We persist just enough to resume:
//   - "input":   the user was on the paste screen but hadn't created a request —
//                resume straight back to the input view.
//   - "request": a live handshake exists — resume and re-poll the SAME request id
//                so an approval that landed while the app was dead is picked up
//                without minting a new (and orphaning the old) request.
const STORAGE_KEY = "gini.pending-pair.v1";

// Local optimization only. The relay clamps a request's TTL to [60,3600]s
// (default 600s) and the native create response omits the expiry, so we stamp our
// own createdAt and refuse to resume a record older than this. Once a resume
// actually happens the server poll status (expired/rejected/…) stays authoritative.
export const PENDING_PAIR_TTL_MS = 600_000;

export type PendingPair =
  | { kind: "input"; createdAt: number }
  | {
      kind: "request";
      relayOrigin: string;
      id: string;
      bindSecret: string;
      code: string;
      createdAt: number;
    };

// Module-scoped mirror of the persisted record so the auth gate can read it
// synchronously before the first render (primed in _layout.tsx, mirroring auth.ts).
// `undefined` = not yet loaded; `null` = loaded, nothing stored.
let cached: PendingPair | null | undefined = undefined;

export function isPendingPairLive(pending: PendingPair, now: number): boolean {
  return now - pending.createdAt < PENDING_PAIR_TTL_MS;
}

// Validate an untrusted parsed value into a PendingPair (or null). Exported for
// direct unit coverage of every record shape without round-tripping storage.
export function parsePendingPair(raw: string | null): PendingPair | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.createdAt !== "number") return null;
  if (v.kind === "input") return { kind: "input", createdAt: v.createdAt };
  if (
    v.kind === "request" &&
    typeof v.relayOrigin === "string" &&
    typeof v.id === "string" &&
    typeof v.bindSecret === "string" &&
    typeof v.code === "string"
  ) {
    return {
      kind: "request",
      relayOrigin: v.relayOrigin,
      id: v.id,
      bindSecret: v.bindSecret,
      code: v.code,
      createdAt: v.createdAt
    };
  }
  return null;
}

// Read + validate the persisted record. Exported so the storage-failure and
// parse branches are testable independently of the prime() cache. A read error
// is treated as "nothing stored" — a missing breadcrumb only costs a resume.
export async function loadPendingPairFromStorage(): Promise<PendingPair | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  return parsePendingPair(raw);
}

export async function savePendingPair(pending: PendingPair): Promise<void> {
  cached = pending;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Best-effort: the in-memory cache still drives a same-session resume.
  }
}

export async function clearPendingPair(): Promise<void> {
  cached = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

export function readCachedPendingPair(): PendingPair | null {
  return cached ?? null;
}

export async function primePendingPair(): Promise<PendingPair | null> {
  if (cached !== undefined) return cached;
  cached = await loadPendingPairFromStorage();
  return cached;
}
