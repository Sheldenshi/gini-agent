import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __test,
  completeBrowserConnectSetup,
  connectBrowser,
  disconnectBrowser,
  getBrowserConnection
} from "./browser-connect";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

// Isolated state root so we don't smear test state across the developer's
// real ~/.gini directory. Mirrors the convention used elsewhere in the
// test suite (see src/http.test.ts).
const TEST_ROOT = "/tmp/gini-browser-connect-tests";
process.env["GINI_STATE_ROOT"] = TEST_ROOT;

function testConfig(instance: string): RuntimeConfig {
  rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${TEST_ROOT}/instances/${instance}`,
    logRoot: `${TEST_ROOT}-logs/${instance}`
  };
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// The runtime drives a single spawned per-instance Chrome (issue #420): there
// is no managed-window or cdp-attach transport and no state.browser record.
// connect/disconnect are thin status acknowledgements; sign-in happens via the
// in-chat screencast (exercised through the HTTP route in src/http.test.ts).
describe("browser-connect helpers", () => {
  test("profileDirFor lives under the instance root", () => {
    const config = testConfig("profile-dir");
    const dir = __test.profileDirFor(config);
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("profile-dir")).toBe(true);
  });

  test("ensureProfileDir materializes the per-instance profile dir", () => {
    const config = testConfig("ensure-profile-dir");
    const dir = __test.ensureProfileDir(config);
    expect(existsSync(dir)).toBe(true);
    expect(dir.endsWith("chrome-profile")).toBe(true);
  });
});

describe("browser-connect API surface", () => {
  test("status reports the stable disconnected shape", () => {
    const config = testConfig("status-empty");
    const status = getBrowserConnection(config);
    expect(status.connected).toBe(false);
  });

  test("connect is a no-op acknowledgement (spawn-only transport)", async () => {
    const config = testConfig("connect-noop");
    const status = await connectBrowser(config, {});
    expect(status.connected).toBe(false);
    // No state record is ever written — the spawned Chrome carries no record.
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("connect ignores its input body and never writes a record", async () => {
    const config = testConfig("connect-ignores-input");
    // Even a fully-populated legacy body is ignored: no cdpUrl/managed handling.
    const status = await connectBrowser(config, { mode: "managed", headless: true });
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("connect with no args defaults the input and stays a no-op", async () => {
    const config = testConfig("connect-default-args");
    const status = await connectBrowser(config);
    expect(status.connected).toBe(false);
  });

  test("disconnect drops the in-process handle and reports disconnected", async () => {
    const config = testConfig("disconnect-empty");
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("disconnect tears down the live spawned handle without touching the profile", async () => {
    const config = testConfig("disconnect-live-handle");
    const browserMod = await import("../tools/browser");
    browserMod.setBrowserInstance(config.instance);
    // Materialize a profile dir + sentinel cookie to prove disconnect leaves
    // on-disk sign-ins intact.
    const dir = __test.ensureProfileDir(config);
    const sentinel = join(dir, "Cookies");
    writeFileSync(sentinel, "fake-cookie-data");
    let contextClosed = false;
    browserMod.__test.installFakeSpawnedHandleForTest(9333, {
      close: async () => {
        contextClosed = true;
      }
    });
    try {
      const status = await disconnectBrowser(config);
      expect(status.connected).toBe(false);
      expect(contextClosed).toBe(true);
      // The on-disk profile (and its cookies) survive the disconnect.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.setBrowserInstance("dev");
    }
  });
});

// completeBrowserConnectSetup runs the non-screencast `/complete` fallback.
// Sign-in normally happens in-place via the screencast bridge (handled in the
// HTTP route), so this records that the user finished acting in the agent's
// spawned Chrome and writes the rich browser.connect audit row.
describe("completeBrowserConnectSetup", () => {
  test("returns success and writes a single rich browser.connect audit row", async () => {
    const config = testConfig("complete-setup");
    const { result, ok } = await completeBrowserConnectSetup(config, {
      id: "setup-1",
      target: "fallback target",
      taskId: undefined,
      agentId: undefined,
      payload: { reason: "Sign in to the store" }
    });
    expect(ok).toBe(true);
    const parsed = JSON.parse(result) as { success: boolean; connected: boolean; mode?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.connected).toBe(true);
    expect(parsed.mode).toBe("spawned");

    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    // The rich row carries the user-facing reason and the originating setup id.
    expect(rows[0]!.target).toBe("Sign in to the store");
    expect(rows[0]!.approvalId).toBe("setup-1");
    expect(rows[0]!.evidence).toMatchObject({ success: true, mode: "spawned" });
  });

  test("falls back to setup.target when no reason is supplied, and binds task scope", async () => {
    const config = testConfig("complete-setup-no-reason");
    const { mutateState } = await import("../state");
    const { createTask, upsertTask } = await import("../state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "complete", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const { ok } = await completeBrowserConnectSetup(config, {
      id: "setup-2",
      target: "the literal target",
      taskId,
      agentId: undefined,
      payload: {}
    });
    expect(ok).toBe(true);
    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    expect(rows[0]!.target).toBe("the literal target");
    expect(rows[0]!.taskId).toBe(taskId);
  });

  test("binds agent scope when only an agentId is present", async () => {
    const config = testConfig("complete-setup-agent");
    const { ok } = await completeBrowserConnectSetup(config, {
      id: "setup-3",
      target: "agent target",
      taskId: undefined,
      agentId: "agent-xyz",
      payload: { reason: "Agent sign-in" }
    });
    expect(ok).toBe(true);
    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    expect(rows[0]!.agentId).toBe("agent-xyz");
  });
});
