import { describe, expect, test } from "bun:test";
import { createEmptyState, expirePairingRequests } from "./store";
import { hashSecret } from "./security";
import {
  approvePairingRequest,
  cancelPairingRequest,
  claimPairingRequest,
  createPairingRequest,
  deviceNameFromUserAgent,
  findActiveDeviceByToken,
  findActiveSessionByToken,
  getPairingRequest,
  isSamePairedDevice,
  listPendingPairingRequests,
  MAX_PENDING_PAIRING_REQUESTS,
  pairedDeviceIdentityKey,
  PairingCapExceededError,
  pollPairingRequest,
  redactPairingRequest,
  rejectPairingRequest,
  revokeDevice,
  touchSessionLastSeen
} from "./records";
import type { PairedDevice } from "../types";

const SECRET = "bind-secret-abc";
const BIND = hashSecret(SECRET);
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function makeRequest(state = createEmptyState("sandbox"), overrides: { userAgent?: string; relayHost?: string; ttlSeconds?: number } = {}) {
  return createPairingRequest(state, {
    userAgent: overrides.userAgent ?? SAFARI_IPHONE,
    relayHost: overrides.relayHost ?? "sub.gini-relay.lilaclabs.ai",
    bindSecret: SECRET,
    ttlSeconds: overrides.ttlSeconds
  });
}

describe("deviceNameFromUserAgent", () => {
  test.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120", "Edge · Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36 OPR/106", "Opera · Mac"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile Safari/537.36 Brave/1.0", "Brave · Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", "Firefox · Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Chrome · Mac"],
    [SAFARI_IPHONE, "Safari · iPhone"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Safari/604.1", "Safari · iPad"],
    ["Firefox/121.0", "Firefox"],
    ["curl/8.4 (Windows)", "Windows"],
    ["SomeRandomBot/1.0", "Unknown device"],
    ["", "Unknown device"]
  ])("maps %p -> %p", (ua, expected) => {
    expect(deviceNameFromUserAgent(ua)).toBe(expected);
  });

  test("tolerates a null-ish user agent", () => {
    expect(deviceNameFromUserAgent(undefined as unknown as string)).toBe("Unknown device");
  });
});

describe("createPairingRequest", () => {
  test("creates a pending request with a comparison code and emits a pairing tick", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(request.status).toBe("pending");
    expect(request.code).toMatch(/^\d{3}-\d{3}$/);
    expect(request.bindHash).toBe(BIND);
    expect(request.deviceName).toBe("Safari · iPhone");
    expect(request.relayHost).toBe("sub.gini-relay.lilaclabs.ai");
    expect(state.pairingRequests[0]?.id).toBe(request.id);
    expect(state.audit.some((event) => event.action === "pairing.requested")).toBe(true);
    // The first appended event is the "pairing" tick; the audit mirror is a
    // "runtime" event beneath it.
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("request");
    // The plaintext code must not leak into the broadcast event payload.
    expect(JSON.stringify(state.events[0]?.data ?? {})).not.toContain(request.code);
  });

  test("clamps the ttl to the 60-3600s window", () => {
    const low = makeRequest(createEmptyState("sandbox"), { ttlSeconds: 5 });
    const lowTtl = (new Date(low.expiresAt).getTime() - new Date(low.createdAt).getTime()) / 1000;
    expect(lowTtl).toBeGreaterThanOrEqual(59);
    expect(lowTtl).toBeLessThanOrEqual(62);

    const high = makeRequest(createEmptyState("sandbox"), { ttlSeconds: 999_999 });
    const highTtl = (new Date(high.expiresAt).getTime() - new Date(high.createdAt).getTime()) / 1000;
    expect(highTtl).toBeGreaterThanOrEqual(3599);
    expect(highTtl).toBeLessThanOrEqual(3602);
  });
});

describe("getPairingRequest / listPendingPairingRequests", () => {
  test("getPairingRequest returns the row or undefined", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(getPairingRequest(state, request.id)?.id).toBe(request.id);
    expect(getPairingRequest(state, "preq_missing")).toBeUndefined();
  });

  test("listPendingPairingRequests excludes resolved and expired rows", () => {
    const state = createEmptyState("sandbox");
    const a = makeRequest(state);
    const b = makeRequest(state);
    approvePairingRequest(state, b.id);
    // Force a to be expired by backdating its expiry.
    const stored = state.pairingRequests.find((r) => r.id === a.id)!;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    const pending = listPendingPairingRequests(state);
    expect(pending.map((r) => r.id)).not.toContain(a.id);
    expect(pending.map((r) => r.id)).not.toContain(b.id);
    expect(stored.status).toBe("expired");
  });
});

describe("approvePairingRequest", () => {
  test("transitions pending -> approved and emits a resolved tick", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const approved = approvePairingRequest(state, request.id);
    expect(approved.status).toBe("approved");
    expect(approved.resolvedAt).toBeDefined();
    expect(state.audit.some((event) => event.action === "pairing.approved")).toBe(true);
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("resolved");
  });

  test("throws on a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(() => approvePairingRequest(state, "preq_missing")).toThrow("not found");
  });

  test("throws when the request is no longer pending", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    expect(() => approvePairingRequest(state, request.id)).toThrow("already approved");
  });
});

describe("rejectPairingRequest", () => {
  test("transitions pending -> rejected", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const rejected = rejectPairingRequest(state, request.id);
    expect(rejected.status).toBe("rejected");
    expect(state.audit.some((event) => event.action === "pairing.rejected")).toBe(true);
  });

  test("throws on a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(() => rejectPairingRequest(state, "preq_missing")).toThrow("not found");
  });

  test("throws when the request is no longer pending", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    rejectPairingRequest(state, request.id);
    expect(() => rejectPairingRequest(state, request.id)).toThrow("already rejected");
  });
});

describe("cancelPairingRequest", () => {
  test("cancels a pending request when the binding secret matches", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("cancelled");
  });

  test("cancels an approved-but-unclaimed request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("cancelled");
  });

  test("is a no-op (still ok) for an already-resolved request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    rejectPairingRequest(state, request.id);
    const result = cancelPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.status).toBe("rejected");
  });

  test("rejects a missing request", () => {
    const state = createEmptyState("sandbox");
    const result = cancelPairingRequest(state, "preq_missing", SECRET);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("rejects a binding-secret mismatch", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const result = cancelPairingRequest(state, request.id, "wrong-secret");
    expect(result).toEqual({ ok: false, reason: "bind_mismatch" });
    expect(state.pairingRequests[0]?.status).toBe("pending");
  });
});

describe("claimPairingRequest", () => {
  test("mints a session device and returns the raw token once", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected claim to succeed");
    expect(result.token).toMatch(/^gini_device_[0-9a-f]{32}$/);
    expect(result.device.tokenHash).toBe(hashSecret(result.token));
    expect(result.device.status).toBe("active");
    expect(result.device.origin).toBe(request.relayHost);
    expect(result.device.userAgent).toBe(SAFARI_IPHONE);
    expect(result.device.expiresAt).toBeDefined();
    expect(state.devices[0]?.id).toBe(result.device.id);
    const stored = state.pairingRequests.find((r) => r.id === request.id)!;
    expect(stored.status).toBe("claimed");
    expect(stored.deviceId).toBe(result.device.id);
    expect(state.audit.some((event) => event.action === "device.paired")).toBe(true);
  });

  test("rejects a missing request", () => {
    const state = createEmptyState("sandbox");
    expect(claimPairingRequest(state, "preq_missing", SECRET)).toEqual({ ok: false, reason: "not_found" });
  });

  test("rejects a binding-secret mismatch", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    expect(claimPairingRequest(state, request.id, "wrong")).toEqual({ ok: false, reason: "bind_mismatch" });
  });

  test("rejects a not-yet-approved request", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(claimPairingRequest(state, request.id, SECRET)).toEqual({ ok: false, reason: "not_approved" });
  });
});

describe("findActiveSessionByToken / touchSessionLastSeen", () => {
  function mintSession() {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    if (!result.ok) throw new Error("expected claim to succeed");
    return { state, token: result.token, device: result.device };
  }

  test("resolves an active, unexpired session without bumping lastSeenAt", () => {
    const { state, token, device } = mintSession();
    const before = device.lastSeenAt;
    const found = findActiveSessionByToken(state, token);
    expect(found?.id).toBe(device.id);
    // read-only: lastSeenAt is untouched
    expect(state.devices[0]?.lastSeenAt).toBe(before);
  });

  test("returns undefined for an unknown token", () => {
    const { state } = mintSession();
    expect(findActiveSessionByToken(state, "gini_device_unknown")).toBeUndefined();
  });

  test("returns undefined for a revoked session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.status = "revoked";
    expect(findActiveSessionByToken(state, token)).toBeUndefined();
  });

  test("returns undefined for an expired session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(findActiveSessionByToken(state, token)).toBeUndefined();
  });

  test("touchSessionLastSeen bumps lastSeenAt for an active session", () => {
    const { state, token } = mintSession();
    state.devices[0]!.lastSeenAt = "2020-01-01T00:00:00.000Z";
    expect(touchSessionLastSeen(state, token)).toBe(true);
    expect(state.devices[0]?.lastSeenAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("touchSessionLastSeen returns false for an unknown token", () => {
    const { state } = mintSession();
    expect(touchSessionLastSeen(state, "gini_device_unknown")).toBe(false);
  });
});

describe("redactPairingRequest", () => {
  test("drops the binding hash but keeps the comparison code", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    const redacted = redactPairingRequest(request);
    expect(redacted.code).toBe(request.code);
    expect(redacted.deviceName).toBe(request.deviceName);
    expect("bindHash" in redacted).toBe(false);
    expect("userAgent" in redacted).toBe(false);
  });
});

describe("expirePairingRequests", () => {
  test("expires pending rows past their deadline and leaves others alone", () => {
    const state = createEmptyState("sandbox");
    const fresh = makeRequest(state);
    const stale = makeRequest(state);
    const approved = makeRequest(state);
    approvePairingRequest(state, approved.id);
    state.pairingRequests.find((r) => r.id === stale.id)!.expiresAt = new Date(Date.now() - 1).toISOString();

    expirePairingRequests(state);

    expect(state.pairingRequests.find((r) => r.id === fresh.id)?.status).toBe("pending");
    expect(state.pairingRequests.find((r) => r.id === stale.id)?.status).toBe("expired");
    expect(state.pairingRequests.find((r) => r.id === approved.id)?.status).toBe("approved");
  });

  test("prunes terminal rows down to the newest 50, keeping every pending row", () => {
    const state = createEmptyState("sandbox");
    // 60 terminal rows: create then reject. Stamp each with a strictly
    // increasing resolvedAt so the newest-50 sort is deterministic — the
    // synchronous test would otherwise land several rejects in the same
    // millisecond and the "oldest dropped" assertion couldn't pin a row.
    const terminal: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const request = makeRequest(state);
      rejectPairingRequest(state, request.id);
      state.pairingRequests.find((r) => r.id === request.id)!.resolvedAt = new Date(1_000 + i).toISOString();
      terminal.push(request.id);
    }
    // A couple of live pending rows that must survive the prune regardless of
    // how many terminal rows exist.
    const pendingA = makeRequest(state);
    const pendingB = makeRequest(state);

    expirePairingRequests(state);

    const surviving = new Set(state.pairingRequests.map((r) => r.id));
    // Both pending rows are retained.
    expect(surviving.has(pendingA.id)).toBe(true);
    expect(surviving.has(pendingB.id)).toBe(true);
    // At most 50 terminal rows remain.
    const survivingTerminal = state.pairingRequests.filter((r) => r.status === "rejected");
    expect(survivingTerminal.length).toBe(50);
    // The 10 oldest terminal rows (lowest resolvedAt) were dropped; the
    // newest 50 (indices 10..59) survive.
    for (const id of terminal.slice(0, 10)) expect(surviving.has(id)).toBe(false);
    for (const id of terminal.slice(10)) expect(surviving.has(id)).toBe(true);
    // Total = 50 terminal + 2 pending.
    expect(state.pairingRequests.length).toBe(52);
  });

  test("an approved-then-expired request is retained by its expiry time, not its approval time", () => {
    const state = createEmptyState("sandbox");
    // A request approved long ago (backdate its approval resolvedAt), then later
    // expired. It must be retained by its TRUE expiry moment, not the stale
    // approval timestamp — otherwise it sorts oldest and is wrongly pruned, and a
    // claim sees 404 instead of an expired/not-approved state.
    const approvedThenExpired = makeRequest(state);
    approvePairingRequest(state, approvedThenExpired.id);
    const row = state.pairingRequests.find((r) => r.id === approvedThenExpired.id)!;
    row.resolvedAt = new Date(1_000).toISOString();
    // Fill the terminal retention cap with rejects resolved AFTER that old
    // approval time (but still long before "now").
    const newerTerminal: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const r = makeRequest(state);
      rejectPairingRequest(state, r.id);
      state.pairingRequests.find((x) => x.id === r.id)!.resolvedAt = new Date(2_000 + i).toISOString();
      newerTerminal.push(r.id);
    }
    // Now push the long-ago-approved row past its deadline and sweep.
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    expirePairingRequests(state);

    const surviving = new Set(state.pairingRequests.map((r) => r.id));
    // Stamped with its real expiry time (now), it sorts newest and survives; the
    // oldest reject is evicted instead.
    expect(surviving.has(approvedThenExpired.id)).toBe(true);
    expect(state.pairingRequests.find((r) => r.id === approvedThenExpired.id)?.status).toBe("expired");
    expect(surviving.has(newerTerminal[0]!)).toBe(false);
  });
});

describe("createPairingRequest pending cap", () => {
  test("allows creating up to the cap, then throws PairingCapExceededError", () => {
    const state = createEmptyState("sandbox");
    for (let i = 0; i < MAX_PENDING_PAIRING_REQUESTS; i += 1) {
      const request = makeRequest(state);
      expect(request.status).toBe("pending");
    }
    expect(state.pairingRequests.filter((r) => r.status === "pending").length).toBe(MAX_PENDING_PAIRING_REQUESTS);
    expect(() => makeRequest(state)).toThrow(PairingCapExceededError);
  });

  test("frees a slot once a pending request resolves", () => {
    const state = createEmptyState("sandbox");
    const requests = Array.from({ length: MAX_PENDING_PAIRING_REQUESTS }, () => makeRequest(state));
    // At the cap — the next create throws.
    expect(() => makeRequest(state)).toThrow(PairingCapExceededError);
    // Resolve one pending request; a slot opens up and create succeeds again.
    rejectPairingRequest(state, requests[0]!.id);
    expect(makeRequest(state).status).toBe("pending");
  });
});

describe("pollPairingRequest", () => {
  test("returns the status for the matching binding secret", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(pollPairingRequest(state, request.id, SECRET)).toEqual({ ok: true, status: "pending" });
    approvePairingRequest(state, request.id);
    expect(pollPairingRequest(state, request.id, SECRET)).toEqual({ ok: true, status: "approved" });
  });

  test("rejects a binding-secret mismatch", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    expect(pollPairingRequest(state, request.id, "wrong-secret")).toEqual({ ok: false, reason: "bind_mismatch" });
  });

  test("rejects an unknown request id", () => {
    const state = createEmptyState("sandbox");
    expect(pollPairingRequest(state, "preq_missing", SECRET)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("claimPairingRequest events", () => {
  test("emits a pairing tick on the broadcast stream after a successful claim", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    expect(result.ok).toBe(true);
    // The most recent appended event is the claim's pairing tick.
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("resolved");
    expect(state.events[0]?.target).toBe(request.id);
  });
});

describe("revokeDevice events", () => {
  test("emits a pairing tick so every admin client refreshes Active Sessions", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    expect(claimPairingRequest(state, request.id, SECRET).ok).toBe(true);
    const device = state.devices[0]!;
    revokeDevice(state, device.id);
    // The most recent appended event is the revoke's pairing tick — the same
    // kind:"pairing" the web SSE bridge maps to the ["devices"] query, so other
    // admin tabs drop the revoked session from Active Sessions without a refetch.
    expect(state.events[0]?.kind).toBe("pairing");
    expect(state.events[0]?.action).toBe("resolved");
    expect(state.events[0]?.target).toBe(device.id);
  });
});

describe("findActiveDeviceByToken", () => {
  // A relay session IS a PairedDevice; its token is a full credential (the mirror
  // model — see ADR device-pairing-auth.md), so it resolves on the bearer path,
  // honoring the session's finite expiry.
  function mintSession() {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    const result = claimPairingRequest(state, request.id, SECRET);
    if (!result.ok) throw new Error("expected claim to succeed");
    return { state, token: result.token, device: result.device };
  }

  test("resolves an active, unexpired device on the bearer path", () => {
    const { state, token, device } = mintSession();
    expect(findActiveDeviceByToken(state, token)?.id).toBe(device.id);
  });

  test("returns undefined for a device whose expiry is in the past", () => {
    const { state, token } = mintSession();
    state.devices[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(findActiveDeviceByToken(state, token)).toBeUndefined();
  });

  test("still resolves a device whose expiry is in the future", () => {
    const { state, token, device } = mintSession();
    state.devices[0]!.expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(findActiveDeviceByToken(state, token)?.id).toBe(device.id);
  });
});

describe("approved request lifecycle (not terminal)", () => {
  test("an approved request past its expiry is no longer claimable", () => {
    const state = createEmptyState("sandbox");
    const request = makeRequest(state);
    approvePairingRequest(state, request.id);
    // Backdate the approval past its deadline.
    state.pairingRequests.find((r) => r.id === request.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const result = claimPairingRequest(state, request.id, SECRET);
    expect(result).toEqual({ ok: false, reason: "not_approved" });
    // expirePairingRequests (run at the top of claim) flipped it to "expired".
    expect(state.pairingRequests.find((r) => r.id === request.id)?.status).toBe("expired");
  });

  test("a live approved request is never pruned, even behind many terminal rows", () => {
    const state = createEmptyState("sandbox");
    const approved = makeRequest(state);
    approvePairingRequest(state, approved.id);
    // Pile up more than the terminal retention cap of rejected rows after it.
    // (Each is rejected immediately so the pending cap is never hit.)
    for (let i = 0; i < 60; i++) {
      rejectPairingRequest(state, makeRequest(state).id);
    }
    expirePairingRequests(state);
    // The approved row is ACTIVE (not terminal) so it survives; terminal capped at 50.
    expect(state.pairingRequests.find((r) => r.id === approved.id)?.status).toBe("approved");
    expect(state.pairingRequests.filter((r) => r.status === "rejected").length).toBe(50);
  });
});

// Mint a fully-claimed session for a given UA + relayHost so a test can control
// the derived name (UA) and origin (relayHost) — the two fields that decide
// whether two sessions are the same device.
function mintClaimed(state: RuntimeStateForTest, userAgent: string, relayHost: string) {
  const request = createPairingRequest(state, { userAgent, relayHost, bindSecret: SECRET });
  approvePairingRequest(state, request.id);
  const result = claimPairingRequest(state, request.id, SECRET);
  if (!result.ok) throw new Error("expected claim to succeed");
  return result.device;
}
type RuntimeStateForTest = ReturnType<typeof createEmptyState>;

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROME_MAC_NEWER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const RELAY_A = "aaa.gini-relay.lilaclabs.ai";
const RELAY_B = "bbb.gini-relay.lilaclabs.ai";

describe("pairedDeviceIdentityKey / isSamePairedDevice", () => {
  function device(overrides: Partial<PairedDevice>): PairedDevice {
    return {
      id: "device_x",
      instance: "sandbox",
      name: "Chrome · Mac",
      tokenHash: "hash",
      status: "active",
      scopes: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      origin: RELAY_A,
      ...overrides
    };
  }

  test("a legacy (no clientId) device keys on origin + name in the name: namespace", () => {
    expect(pairedDeviceIdentityKey(device({}))).toBe(`${RELAY_A}\nname:Chrome · Mac`);
  });

  test("a device with a clientId keys on origin + clientId in the client: namespace", () => {
    expect(pairedDeviceIdentityKey(device({ clientId: "client-123" }))).toBe(`${RELAY_A}\nclient:client-123`);
  });

  test("an originless device (legacy code-claimed bearer) keys to null", () => {
    expect(pairedDeviceIdentityKey(device({ origin: undefined }))).toBeNull();
    // Even with a clientId, no origin means no key (originless bearer stays exempt).
    expect(pairedDeviceIdentityKey(device({ origin: undefined, clientId: "client-123" }))).toBeNull();
  });

  test("legacy rows: same origin + same name match; differing origin OR name do not", () => {
    expect(isSamePairedDevice(device({}), device({ id: "device_y" }))).toBe(true);
    expect(isSamePairedDevice(device({}), device({ origin: RELAY_B }))).toBe(false);
    expect(isSamePairedDevice(device({}), device({ name: "Safari · iPhone" }))).toBe(false);
  });

  test("two originless devices never match (null key is not equal to null key)", () => {
    expect(isSamePairedDevice(device({ origin: undefined }), device({ origin: undefined }))).toBe(false);
  });

  // Two DISTINCT browsers on the same relay subdomain produce the same
  // User-Agent-derived name ("Chrome · Mac") but each holds its own per-browser
  // gini_client id (clientId). They must NOT be treated as the same device, so a
  // re-pair by one never evicts the other on a shared subdomain.
  test("same origin + same name but DIFFERENT clientId are NOT the same device", () => {
    const browserA = device({ id: "device_a", clientId: "client-aaaa" });
    const browserB = device({ id: "device_b", clientId: "client-bbbb" });
    expect(isSamePairedDevice(browserA, browserB)).toBe(false);
    expect(pairedDeviceIdentityKey(browserA)).not.toBe(pairedDeviceIdentityKey(browserB));
  });

  test("same origin + same clientId ARE the same device (own re-pair still supersedes)", () => {
    const before = device({ id: "device_old", clientId: "client-same" });
    const after = device({ id: "device_new", clientId: "client-same" });
    expect(isSamePairedDevice(before, after)).toBe(true);
  });

  test("a clientId-bearing row and a legacy (no clientId) row never match, even same origin+name", () => {
    const legacy = device({ id: "device_legacy", clientId: undefined });
    const modern = device({ id: "device_modern", clientId: "client-xyz" });
    expect(isSamePairedDevice(legacy, modern)).toBe(false);
  });
});

describe("supersede prior session on re-pair", () => {
  test("re-pairing the same device revokes the prior active session", () => {
    const state = createEmptyState("sandbox");
    const first = mintClaimed(state, CHROME_MAC, RELAY_A);
    // A browser auto-update changes the UA version but not the derived label.
    const second = mintClaimed(state, CHROME_MAC_NEWER, RELAY_A);

    const firstRow = state.devices.find((d) => d.id === first.id)!;
    const secondRow = state.devices.find((d) => d.id === second.id)!;
    expect(firstRow.status).toBe("revoked");
    expect(firstRow.revokedAt).toBeString();
    expect(secondRow.status).toBe("active");
    // Exactly one active session remains for this device/origin.
    expect(state.devices.filter((d) => d.status === "active").length).toBe(1);
  });

  test("emits a device.superseded audit naming the new session", () => {
    const state = createEmptyState("sandbox");
    const first = mintClaimed(state, CHROME_MAC, RELAY_A);
    const second = mintClaimed(state, CHROME_MAC_NEWER, RELAY_A);
    const audit = state.audit.find(
      (e) => e.action === "device.superseded" && e.target === first.id
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.supersededBy).toBe(second.id);
  });

  test("does NOT revoke a different device on the same relay (distinct name)", () => {
    const state = createEmptyState("sandbox");
    const mac = mintClaimed(state, CHROME_MAC, RELAY_A);
    const iphone = mintClaimed(state, SAFARI_IPHONE, RELAY_A);
    expect(state.devices.find((d) => d.id === mac.id)!.status).toBe("active");
    expect(state.devices.find((d) => d.id === iphone.id)!.status).toBe("active");
  });

  test("does NOT revoke the same label on a DIFFERENT relay origin", () => {
    const state = createEmptyState("sandbox");
    const onA = mintClaimed(state, CHROME_MAC, RELAY_A);
    const onB = mintClaimed(state, CHROME_MAC, RELAY_B);
    expect(state.devices.find((d) => d.id === onA.id)!.status).toBe("active");
    expect(state.devices.find((d) => d.id === onB.id)!.status).toBe("active");
  });

  test("leaves an already-revoked prior row untouched (no re-revoke)", () => {
    const state = createEmptyState("sandbox");
    const first = mintClaimed(state, CHROME_MAC, RELAY_A);
    const firstRevokedAt = state.devices.find((d) => d.id === first.id)!;
    // Second claim revokes the first.
    mintClaimed(state, CHROME_MAC, RELAY_A);
    const stamp = firstRevokedAt.revokedAt;
    // A third claim must not touch the already-revoked first row again.
    mintClaimed(state, CHROME_MAC, RELAY_A);
    expect(firstRevokedAt.revokedAt).toBe(stamp);
    // Only the latest session is active.
    expect(state.devices.filter((d) => d.status === "active").length).toBe(1);
  });
});
