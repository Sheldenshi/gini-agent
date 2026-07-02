// Unit tests for the App Group credential bridge. Pins:
//   - write/clear route through the injected resolver
//   - a null resolver (non-iOS, missing entitlement) no-ops silently
//   - native errors (write/delete throw, or the resolver throws) are
//     swallowed so the auth/registration flow is safe
//
// The resolver is injected via __setSharedFileResolverForTests rather than
// a global mock.module("react-native"). A process-wide react-native mock
// leaks into sibling test files (they lose StyleSheet etc.), so the
// dependency-injection seam keeps this test fully isolated.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  APP_GROUP_ID,
  SHARED_CREDS_FILENAME,
  writeSharedCredentials,
  clearSharedCredentials,
  defaultResolveSharedFile,
  loadNativeBridge,
  __setSharedFileResolverForTests,
  __resetSharedFileResolverForTests,
  type SharedFile,
  type NativeBridge
} from "./shared-credentials";

interface FileSpy extends SharedFile {
  written: string[];
  deleted: number;
}

function makeFileSpy(opts?: { throwOnWrite?: boolean; throwOnDelete?: boolean }): FileSpy {
  const spy: FileSpy = {
    written: [],
    deleted: 0,
    write(contents: string) {
      if (opts?.throwOnWrite) throw new Error("disk full");
      spy.written.push(contents);
    },
    delete() {
      if (opts?.throwOnDelete) throw new Error("no such file");
      spy.deleted += 1;
    }
  };
  return spy;
}

afterEach(() => {
  __resetSharedFileResolverForTests();
});

describe("writeSharedCredentials", () => {
  test("writes the credentials JSON into the shared-container file", () => {
    const file = makeFileSpy();
    __setSharedFileResolverForTests(() => file);
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "bearer123", deviceToken: "dev456" });
    expect(file.written).toHaveLength(1);
    expect(JSON.parse(file.written[0]!)).toEqual({
      baseUrl: "https://gw.example",
      token: "bearer123",
      deviceToken: "dev456"
    });
  });

  test("writes without a device token when none is supplied", () => {
    const file = makeFileSpy();
    __setSharedFileResolverForTests(() => file);
    writeSharedCredentials({ baseUrl: "https://gw.example", token: "bearer123" });
    expect(JSON.parse(file.written[0]!)).toEqual({
      baseUrl: "https://gw.example",
      token: "bearer123"
    });
  });

  test("no-ops when the resolver returns null (non-iOS / missing entitlement)", () => {
    __setSharedFileResolverForTests(() => null);
    expect(() => writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" })).not.toThrow();
  });

  test("swallows a native write error so the auth flow never breaks", () => {
    const file = makeFileSpy({ throwOnWrite: true });
    __setSharedFileResolverForTests(() => file);
    expect(() => writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" })).not.toThrow();
  });

  test("swallows a resolver failure (native module unavailable)", () => {
    __setSharedFileResolverForTests(() => {
      throw new Error("native module unavailable");
    });
    expect(() => writeSharedCredentials({ baseUrl: "https://gw.example", token: "t" })).not.toThrow();
  });
});

describe("clearSharedCredentials", () => {
  test("deletes the shared-container file", () => {
    const file = makeFileSpy();
    __setSharedFileResolverForTests(() => file);
    clearSharedCredentials();
    expect(file.deleted).toBe(1);
  });

  test("no-ops when the resolver returns null", () => {
    __setSharedFileResolverForTests(() => null);
    expect(() => clearSharedCredentials()).not.toThrow();
  });

  test("swallows a delete error (file already gone)", () => {
    const file = makeFileSpy({ throwOnDelete: true });
    __setSharedFileResolverForTests(() => file);
    expect(() => clearSharedCredentials()).not.toThrow();
  });

  test("swallows a resolver failure", () => {
    __setSharedFileResolverForTests(() => {
      throw new Error("native module unavailable");
    });
    expect(() => clearSharedCredentials()).not.toThrow();
  });
});

describe("defaultResolveSharedFile", () => {
  class FakeFile implements SharedFile {
    constructor(public dir: unknown, public name: string) {}
    write(): void {}
    delete(): void {}
  }

  function bridge(overrides?: Partial<NativeBridge>): NativeBridge {
    return {
      platformOS: "ios",
      File: FakeFile,
      appleSharedContainers: { [APP_GROUP_ID]: { uri: "file:///shared/" } },
      ...overrides
    };
  }

  test("returns a File in the App Group container on iOS with the group present", () => {
    const file = defaultResolveSharedFile(() => bridge()) as FakeFile;
    expect(file).toBeInstanceOf(FakeFile);
    expect(file.name).toBe(SHARED_CREDS_FILENAME);
  });

  test("returns null on non-iOS", () => {
    expect(defaultResolveSharedFile(() => bridge({ platformOS: "android" }))).toBeNull();
  });

  test("returns null when the App Group key is absent (entitlement not signed in)", () => {
    expect(defaultResolveSharedFile(() => bridge({ appleSharedContainers: {} }))).toBeNull();
  });

  test("returns null when the native bridge fails to load", () => {
    expect(
      defaultResolveSharedFile(() => {
        throw new Error("native module unavailable");
      })
    ).toBeNull();
  });
});

describe("loadNativeBridge", () => {
  test("throws in a non-RN env (react-native not resolvable under bun:test)", () => {
    // The production bridge uses literal require("react-native") — which
    // Metro must see statically to bundle it, and which is unavailable
    // under bun:test. The contract that matters is that the throw is
    // CAUGHT by defaultResolveSharedFile (verified above), so the bridge
    // failing to load degrades to a no-op write rather than a crash.
    expect(() => loadNativeBridge()).toThrow();
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
