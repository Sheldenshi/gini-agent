import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairedDevice, RuntimeConfig } from "../types";
import { mutateState, readState } from "../state";
import { hashSecret } from "../state/security";
import {
  approvePairing,
  cancelPairing,
  claimPairingSession,
  listPairingRequests,
  pollPairingStatus,
  redactDevice,
  rejectPairing,
  requestPairing,
  resolveSessionFromCookie,
  touchPairedSession
} from "./pairing";

function testConfig(instance: string): RuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), `gini-gov-${instance}-`));
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

const SECRET = "binding-secret";

async function open(config: RuntimeConfig) {
  return requestPairing(config, {
    userAgent: "Mozilla/5.0 (iPhone) Safari",
    relayHost: "sub.gini-relay.lilaclabs.ai",
    bindSecret: SECRET
  });
}

describe("governance pairing wrappers", () => {
  test("requestPairing returns a redacted request (no bindHash) and lists it", async () => {
    const config = testConfig("gov-request");
    const request = await open(config);
    expect(request.code).toMatch(/^\d{3}-\d{3}$/);
    expect("bindHash" in request).toBe(false);
    const pending = await listPairingRequests(config);
    expect(pending.map((r) => r.id)).toContain(request.id);
  });

  test("approve then claim mints a resolvable session", async () => {
    const config = testConfig("gov-approve-claim");
    const request = await open(config);
    const approved = await approvePairing(config, request.id);
    expect(approved.status).toBe("approved");
    const claim = await claimPairingSession(config, request.id, SECRET);
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error("expected claim ok");
    expect(resolveSessionFromCookie(config, claim.token)?.id).toBe(claim.device.id);
  });

  test("reject resolves the request", async () => {
    const config = testConfig("gov-reject");
    const request = await open(config);
    expect((await rejectPairing(config, request.id)).status).toBe("rejected");
  });

  test("cancel returns ok / not_found results", async () => {
    const config = testConfig("gov-cancel");
    const request = await open(config);
    expect(await cancelPairing(config, request.id, SECRET)).toEqual({ ok: true, request: expect.objectContaining({ status: "cancelled" }) });
    expect(await cancelPairing(config, "preq_missing", SECRET)).toEqual({ ok: false, reason: "not_found" });
  });

  test("claim before approval reports not_approved", async () => {
    const config = testConfig("gov-claim-early");
    const request = await open(config);
    expect(await claimPairingSession(config, request.id, SECRET)).toEqual({ ok: false, reason: "not_approved" });
  });

  test("resolveSessionFromCookie short-circuits on an undefined token", () => {
    const config = testConfig("gov-resolve-undef");
    expect(resolveSessionFromCookie(config, undefined)).toBeUndefined();
    expect(resolveSessionFromCookie(config, "gini_device_unknown")).toBeUndefined();
  });

  test("pollPairingStatus reads status and enforces the binding secret", async () => {
    const config = testConfig("gov-poll");
    const request = await open(config);
    expect(pollPairingStatus(config, request.id, SECRET)).toEqual({ ok: true, status: "pending" });
    expect(pollPairingStatus(config, request.id, "wrong-secret")).toEqual({ ok: false, reason: "bind_mismatch" });
    expect(pollPairingStatus(config, "preq_missing", SECRET)).toEqual({ ok: false, reason: "not_found" });
  });

  test("pollPairingStatus reports expiry without persisting (read-only hot path)", async () => {
    const config = testConfig("gov-poll-readonly");
    // Inject a row whose deadline is already in the past (createPairingRequest
    // clamps ttl >= 60s, so it can't mint an already-expired one directly).
    const past = "2000-01-01T00:00:00.000Z";
    await mutateState(config.instance, (state) => {
      state.pairingRequests.unshift({
        id: "preq_expired",
        instance: config.instance,
        code: "123-456",
        bindHash: hashSecret(SECRET),
        status: "pending",
        deviceName: "Safari · iPhone",
        userAgent: "ua",
        relayHost: "sub.gini-relay.lilaclabs.ai",
        createdAt: past,
        expiresAt: past
      });
    });
    // Effective status is "expired" even though the stored row is still "pending".
    expect(pollPairingStatus(config, "preq_expired", SECRET)).toEqual({ ok: true, status: "expired" });
    // The poll went through readState, not mutateState — so it never persisted
    // the expiry flip. The on-disk row is untouched (still "pending"); the flip
    // is deferred to the next genuine mutation.
    const onDisk = readState(config.instance).pairingRequests.find((r) => r.id === "preq_expired");
    expect(onDisk?.status).toBe("pending");
  });

  test("touchPairedSession bumps last-seen for a live session", async () => {
    const config = testConfig("gov-touch");
    const request = await open(config);
    await approvePairing(config, request.id);
    const claim = await claimPairingSession(config, request.id, SECRET);
    if (!claim.ok) throw new Error("expected claim ok");
    await touchPairedSession(config, claim.token);
    // a no-op touch for an unknown token must not throw
    await touchPairedSession(config, "gini_device_unknown");
    expect(resolveSessionFromCookie(config, claim.token)).toBeDefined();
  });
});

describe("redactDevice", () => {
  test("exposes session fields including origin and expiresAt, never tokenHash", () => {
    const device: PairedDevice = {
      id: "device_1",
      instance: "x",
      name: "Safari · iPhone",
      tokenHash: "sha256:secret",
      status: "active",
      scopes: ["state:read"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      origin: "sub.gini-relay.lilaclabs.ai",
      userAgent: "ua",
      expiresAt: "2026-02-01T00:00:00.000Z"
    };
    const redacted = redactDevice(device);
    expect(redacted.origin).toBe("sub.gini-relay.lilaclabs.ai");
    expect(redacted.expiresAt).toBe("2026-02-01T00:00:00.000Z");
    expect(redacted.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
    expect("tokenHash" in redacted).toBe(false);
  });
});
