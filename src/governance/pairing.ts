import type { PairedDevice, RuntimeConfig } from "../types";
import {
  approvePairingRequest,
  cancelPairingRequest,
  claimPairingCode,
  claimPairingRequest,
  createPairingCode,
  createPairingRequest,
  findActiveDeviceByToken,
  findActiveSessionByToken,
  listPendingPairingRequests,
  pollPairingRequest,
  mutateState,
  readState,
  redactPairingRequest,
  rejectPairingRequest,
  revokeDevice,
  touchSessionLastSeen
} from "../state";

export async function createPairing(config: RuntimeConfig, input: Record<string, unknown>) {
  const ttlSeconds = Math.min(3600, Math.max(60, Number(input.ttlSeconds ?? 600)));
  const created = await mutateState(config.instance, (state) => createPairingCode(state, ttlSeconds));
  return {
    id: created.pairing.id,
    instance: created.pairing.instance,
    code: created.code,
    expiresAt: created.pairing.expiresAt
  };
}

export async function claimPairing(config: RuntimeConfig, input: Record<string, unknown>) {
  const code = String(input.code ?? "");
  const deviceName = String(input.deviceName ?? "Mobile device");
  if (!code) throw new Error("Pairing code is required.");
  const claimed = await mutateState(config.instance, (state) => claimPairingCode(state, code, deviceName));
  return {
    device: redactDevice(claimed.device),
    token: claimed.token
  };
}

export async function revokePairedDevice(config: RuntimeConfig, deviceId: string) {
  return redactDevice(await mutateState(config.instance, (state) => revokeDevice(state, deviceId)));
}

export async function authorizedBearer(config: RuntimeConfig, bearer: string | undefined): Promise<boolean> {
  return Boolean(await resolveCredentialFromBearer(config, bearer));
}

// Resolves an incoming bearer to a stable credential identifier so
// per-credential state (push devices today, read state and unread
// counters in Step 3) can be scoped without giving every caller a
// view of every other paired device's state.
//
// Returns:
//   - "owner"  — when the bearer matches the runtime's config token
//                (CLI, BFF, web). Single shared identity since the
//                config token is a singleton.
//   - "<deviceId>" — when the bearer matches an active PairedDevice
//                row in state.devices. Each paired mobile install
//                has its own credential id.
//   - null    — bearer is absent or doesn't match anything active
//                (mapped to 401 at the HTTP boundary).
export async function resolveCredentialFromBearer(
  config: RuntimeConfig,
  bearer: string | undefined
): Promise<string | null> {
  if (!bearer) return null;
  if (bearer === config.token) return "owner";
  const device = await mutateState(config.instance, (state) => findActiveDeviceByToken(state, bearer));
  return device ? device.id : null;
}

export function redactDevice(device: ReturnType<typeof readState>["devices"][number]) {
  return {
    id: device.id,
    instance: device.instance,
    name: device.name,
    status: device.status,
    scopes: device.scopes,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    origin: device.origin,
    expiresAt: device.expiresAt
  };
}

// ---------------------------------------------------------------------------
// Relay device-pairing request flow (operator-approved). These wrap the state
// mutators with mutateState + redaction so the HTTP layer stays thin. See ADR
// device-pairing-auth.md.

// A relay device opens a pairing request. `bindHash` is hashSecret of the
// per-request binding secret the route stores as the gini_pair cookie.
export async function requestPairing(
  config: RuntimeConfig,
  input: { userAgent: string; relayHost: string; bindSecret: string; ttlSeconds?: number }
) {
  const request = await mutateState(config.instance, (state) => createPairingRequest(state, input));
  return redactPairingRequest(request);
}

// Admin-facing list of pending requests (the route admits loopback OR a valid
// gini_session — the mirror model; see ADR device-pairing-auth.md). Uses
// mutateState so the lazy expiry sweep persists.
export async function listPairingRequests(config: RuntimeConfig) {
  const pending = await mutateState(config.instance, (state) => listPendingPairingRequests(state));
  return pending.map(redactPairingRequest);
}

// Bind-checked status poll for the requesting device. Requires the gini_pair
// binding secret so a known request id + an unrelated cookie can't read status.
export async function pollPairingStatus(config: RuntimeConfig, id: string, bindSecret: string) {
  return mutateState(config.instance, (state) => pollPairingRequest(state, id, bindSecret));
}

export async function approvePairing(config: RuntimeConfig, id: string) {
  return redactPairingRequest(await mutateState(config.instance, (state) => approvePairingRequest(state, id)));
}

export async function rejectPairing(config: RuntimeConfig, id: string) {
  return redactPairingRequest(await mutateState(config.instance, (state) => rejectPairingRequest(state, id)));
}

// Device cancels its own request; bindSecret must match the gini_pair cookie.
export async function cancelPairing(config: RuntimeConfig, id: string, bindSecret: string) {
  return mutateState(config.instance, (state) => cancelPairingRequest(state, id, bindSecret));
}

// Device claims its approved request, minting the session device and returning
// the raw token exactly once (the route sets it as the gini_session cookie).
export async function claimPairingSession(config: RuntimeConfig, id: string, bindSecret: string) {
  return mutateState(config.instance, (state) => claimPairingRequest(state, id, bindSecret));
}

// Read-only session validation for the gateway's hot relay cookie gate. Sync —
// readState is a lock-free atomic read and the gate runs on every proxied
// request, so this never writes (no lastSeenAt bump). Returns the active,
// unexpired session device or undefined.
export function resolveSessionFromCookie(config: RuntimeConfig, token: string | undefined): PairedDevice | undefined {
  if (!token) return undefined;
  return findActiveSessionByToken(readState(config.instance), token);
}

// Bump lastSeenAt for a session. Called by the gate on document navigations
// (infrequent) so the Active Sessions list shows a useful "last seen" without a
// write on every asset request.
export async function touchPairedSession(config: RuntimeConfig, token: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    touchSessionLastSeen(state, token);
  });
}
