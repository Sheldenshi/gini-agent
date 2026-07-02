// Pure display-status logic for paired devices/sessions, split out of DevicesCard
// so it can be unit-tested without importing the component (which would drag UI
// modules into the component coverage gate).
//
// A relay session stored as "active" but past its expiresAt should read as
// "expired": the gateway enforces expiry lazily at token-resolution time and
// never flips the stored status, so a time-expired session would otherwise be
// counted/shown as live until an operator revokes it. Mobile/code-claimed
// devices carry no expiresAt, so this is a no-op for them.

export interface DeviceStatusInput {
  status: string;
  expiresAt?: string;
}

export function isExpired(device: DeviceStatusInput): boolean {
  return Boolean(device.expiresAt) && new Date(device.expiresAt!).getTime() <= Date.now();
}

export function effectiveStatus(device: DeviceStatusInput): string {
  return device.status === "active" && isExpired(device) ? "expired" : device.status;
}

// A revoked device is permanently dead — it can never become active again — so
// the Active sessions list drops it. Revocation stays in durable state (the row
// keeps its revokedAt timestamp) for the audit trail; it's just not shown.
export function isListedSession(device: DeviceStatusInput): boolean {
  return effectiveStatus(device) !== "revoked";
}
