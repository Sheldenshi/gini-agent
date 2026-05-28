import type { RuntimeConfig } from "../types";
import { claimPairingCode, createPairingCode, findActiveDeviceByToken, mutateState, readState, revokeDevice } from "../state";

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
    revokedAt: device.revokedAt
  };
}
