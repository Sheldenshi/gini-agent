// Unit tests for the push-device registry. Pins:
//   - upsert is idempotent (re-registering the same token rebinds
//     credential/bundle and preserves registered_at)
//   - listDevicesForCredential is scoped — devices for a different
//     credential never leak across
//   - removeDevice deletes by token regardless of credential
//   - removeDeviceForCredential refuses to delete tokens that belong
//     to a different credential

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  getDevice,
  listAllDevices,
  listDevicesForCredential,
  purgeTunnelDevices,
  removeDevice,
  removeDeviceForCredential,
  upsertDevice
} from "./index";

const ROOT = "/tmp/gini-devices-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  closeAllMemoryDbs();
});

describe("devices registry", () => {
  test("upsertDevice inserts a fresh row", () => {
    const instance = "devices-insert";
    const device = upsertDevice(instance, {
      token: "abc123",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });

    expect(device.token).toBe("abc123");
    expect(device.credentialId).toBe("cred_a");
    expect(device.platform).toBe("ios");
    expect(device.bundleId).toBe("ai.lilaclabs.gini.mobile");
    expect(device.registeredAt).toBeString();
    expect(device.lastSeenAt).toBeString();
  });

  test("upsertDevice is idempotent — re-registering keeps registered_at, updates last_seen_at and rebinds", async () => {
    const instance = "devices-upsert";
    const first = upsertDevice(instance, {
      token: "tok",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });

    // Force a clock tick so last_seen_at can advance. Bun.sleep(2) is
    // plenty for the ISO-millisecond string to differ.
    await Bun.sleep(2);

    const second = upsertDevice(instance, {
      token: "tok",
      credentialId: "cred_b",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile.dev"
    });

    expect(second.registeredAt).toBe(first.registeredAt);
    expect(second.lastSeenAt).not.toBe(first.lastSeenAt);
    expect(second.credentialId).toBe("cred_b");
    expect(second.bundleId).toBe("ai.lilaclabs.gini.mobile.dev");

    // Re-read via getDevice to confirm the row was persisted, not just
    // returned in-memory.
    const fetched = getDevice(instance, "tok");
    expect(fetched?.credentialId).toBe("cred_b");
    expect(fetched?.bundleId).toBe("ai.lilaclabs.gini.mobile.dev");
  });

  test("listDevicesForCredential scopes to a single credential", () => {
    const instance = "devices-scope";
    upsertDevice(instance, {
      token: "t1",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });
    upsertDevice(instance, {
      token: "t2",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });
    upsertDevice(instance, {
      token: "t3",
      credentialId: "cred_b",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });

    const aDevices = listDevicesForCredential(instance, "cred_a");
    const bDevices = listDevicesForCredential(instance, "cred_b");

    expect(aDevices.map((d) => d.token).sort()).toEqual(["t1", "t2"]);
    expect(bDevices.map((d) => d.token)).toEqual(["t3"]);
  });

  test("removeDevice deletes by token regardless of credential", () => {
    const instance = "devices-remove";
    upsertDevice(instance, {
      token: "t1",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });

    expect(removeDevice(instance, "t1")).toBe(true);
    expect(removeDevice(instance, "t1")).toBe(false);
    expect(getDevice(instance, "t1")).toBeNull();
  });

  test("removeDeviceForCredential refuses to delete tokens that belong to a different credential", () => {
    const instance = "devices-remove-scoped";
    upsertDevice(instance, {
      token: "t1",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });

    // Wrong credential cannot delete.
    expect(removeDeviceForCredential(instance, "t1", "cred_b")).toBe(false);
    expect(getDevice(instance, "t1")).not.toBeNull();

    // Correct credential can.
    expect(removeDeviceForCredential(instance, "t1", "cred_a")).toBe(true);
    expect(getDevice(instance, "t1")).toBeNull();
  });

  test("upsertDevice defaults origin to loopback when omitted", () => {
    const instance = "devices-origin-default";
    const device = upsertDevice(instance, {
      token: "t-default",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });
    expect(device.origin).toBe("loopback");
    expect(getDevice(instance, "t-default")?.origin).toBe("loopback");
  });

  test("upsertDevice persists origin when explicitly passed as tunnel", () => {
    const instance = "devices-origin-tunnel";
    const device = upsertDevice(instance, {
      token: "t-tunnel",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "tunnel"
    });
    expect(device.origin).toBe("tunnel");
    expect(getDevice(instance, "t-tunnel")?.origin).toBe("tunnel");
  });

  test("upsertDevice retags origin when the same token re-registers from a different origin", () => {
    const instance = "devices-origin-retag";
    upsertDevice(instance, {
      token: "tok",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "loopback"
    });
    upsertDevice(instance, {
      token: "tok",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "tunnel"
    });
    expect(getDevice(instance, "tok")?.origin).toBe("tunnel");
  });

  test("purgeTunnelDevices wipes tunnel rows and leaves loopback rows intact", () => {
    const instance = "devices-purge";
    upsertDevice(instance, {
      token: "loop1",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "loopback"
    });
    upsertDevice(instance, {
      token: "tun1",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "tunnel"
    });
    upsertDevice(instance, {
      token: "tun2",
      credentialId: "cred_b",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile",
      origin: "tunnel"
    });

    const result = purgeTunnelDevices(instance);
    expect(result.deleted).toBe(2);

    const remaining = listAllDevices(instance);
    expect(remaining.map((d) => d.token)).toEqual(["loop1"]);
    expect(remaining[0]?.origin).toBe("loopback");
  });

  test("purgeTunnelDevices on an empty/clean instance returns deleted=0", () => {
    const instance = "devices-purge-empty";
    expect(purgeTunnelDevices(instance).deleted).toBe(0);

    upsertDevice(instance, {
      token: "only-loopback",
      credentialId: "cred_a",
      platform: "ios",
      bundleId: "ai.lilaclabs.gini.mobile"
    });
    expect(purgeTunnelDevices(instance).deleted).toBe(0);
    expect(listAllDevices(instance).map((d) => d.token)).toEqual(["only-loopback"]);
  });
});
