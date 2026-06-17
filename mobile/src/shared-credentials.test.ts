// Unit tests for the App Group credential bridge. Pins:
//   - iOS-only: non-iOS platforms no-op (never touch the native module)
//   - write/clear resolve the shared-container File via
//     Paths.appleSharedContainers[APP_GROUP_ID]
//   - a missing App Group key (unsigned entitlements) no-ops silently
//   - native errors are swallowed so the auth/registration flow is safe

import { describe, expect, test, mock, beforeEach } from "bun:test";

// react-native's Platform is the only RN surface this module reads. Stub
// it so the OS branch is controllable from each test via a mutable holder.
const platform = { OS: "ios" as string };
mock.module("react-native", () => ({ Platform: platform }));

// Controllable expo-file-system stub. `containers` is the
// appleSharedContainers record; `fileOps` records write/delete calls and
// can be told to throw. A fresh File instance is handed back per
// construction so we can assert what was written.
interface FileSpy {
  written: string[];
  deleted: number;
  throwOnWrite: boolean;
  throwOnDelete: boolean;
}
let fileSpy: FileSpy;
let containers: Record<string, unknown>;
// When set, the appleSharedContainers getter throws — exercising the
// outer try/catch that guards the whole native-resolution path.
let throwOnContainers = false;

class FakeFile {
  constructor(public dir: unknown, public name: string) {}
  write(s: string): void {
    if (fileSpy.throwOnWrite) throw new Error("disk full");
    fileSpy.written.push(s);
  }
  delete(): void {
    if (fileSpy.throwOnDelete) throw new Error("no such file");
    fileSpy.deleted += 1;
  }
}

mock.module("expo-file-system", () => ({
  File: FakeFile,
  Paths: {
    get appleSharedContainers() {
      if (throwOnContainers) throw new Error("native module unavailable");
      return containers;
    }
  }
}));

import {
  APP_GROUP_ID,
  SHARED_CREDS_FILENAME,
  writeSharedCredentials,
  clearSharedCredentials
} from "./shared-credentials";

beforeEach(() => {
  platform.OS = "ios";
  throwOnContainers = false;
  fileSpy = { written: [], deleted: 0, throwOnWrite: false, throwOnDelete: false };
  // Default: the App Group container resolves to a directory handle.
  containers = { [APP_GROUP_ID]: { uri: "file:///shared/" } };
});

describe("writeSharedCredentials", () => {
  test("writes the credentials JSON into the shared-container file", () => {
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "bearer123", deviceToken: "dev456" });
    expect(fileSpy.written).toHaveLength(1);
    expect(JSON.parse(fileSpy.written[0]!)).toEqual({
      baseUrl: "https://gw.example",
      token: "bearer123",
      deviceToken: "dev456"
    });
  });

  test("writes without a device token when none is supplied", () => {
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "bearer123" });
    expect(JSON.parse(fileSpy.written[0]!)).toEqual({
      baseUrl: "https://gw.example",
      token: "bearer123"
    });
  });

  test("no-ops on non-iOS platforms", () => {
    platform.OS = "android";
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" });
    expect(fileSpy.written).toHaveLength(0);
  });

  test("no-ops when the App Group key is absent (entitlements not signed in)", () => {
    containers = {};
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" });
    expect(fileSpy.written).toHaveLength(0);
  });

  test("swallows a native write error so the auth flow never breaks", () => {
    fileSpy.throwOnWrite = true;
    expect(() => writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" })).not.toThrow();
  });

  test("swallows a native-resolution failure (module getter throws)", () => {
    throwOnContainers = true;
    expect(() => writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" })).not.toThrow();
    expect(fileSpy.written).toHaveLength(0);
  });
});

describe("clearSharedCredentials", () => {
  test("deletes the shared-container file", () => {
    clearSharedCredentials();
    expect(fileSpy.deleted).toBe(1);
  });

  test("no-ops on non-iOS platforms", () => {
    platform.OS = "web";
    clearSharedCredentials();
    expect(fileSpy.deleted).toBe(0);
  });

  test("no-ops when the App Group key is absent", () => {
    containers = {};
    clearSharedCredentials();
    expect(fileSpy.deleted).toBe(0);
  });

  test("swallows a delete error (file already gone)", () => {
    fileSpy.throwOnDelete = true;
    expect(() => clearSharedCredentials()).not.toThrow();
  });
});

describe("constants", () => {
  test("App Group id matches the config plugin default (group.<bundleId>)", () => {
    expect(APP_GROUP_ID).toBe("group.ai.lilaclabs.gini.mobile");
  });

  test("the shared filename is stable (the NSE reads this exact name)", () => {
    expect(SHARED_CREDS_FILENAME).toBe("gini-push-creds.json");
  });
});
