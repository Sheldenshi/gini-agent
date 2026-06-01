// Pins the removePublicUrlFile log-emission contract: when unlinkSync
// throws a non-ENOENT errno AND the diagnostic appendLog call ALSO
// throws (e.g. log-dir EACCES, ENOSPC), the helper must swallow both
// failures. Several callers — the constructor, the cloudflared exit
// listener, the SIGTERM drain — invoke removePublicUrlFile without an
// outer try/catch, so any uncaught throw escalates to a runtime crash.
// The helper's contract is strictly best-effort; log-dir errors must
// not crash the helper.
//
// The test wires up real filesystem state instead of mocking node:fs
// or `../../state`: a bun module mock for either of those would leak
// across test files in the same run. Instead we plant the publicUrl
// path as a non-empty DIRECTORY (so unlinkSync throws EISDIR, which
// is the non-ENOENT branch we need to exercise) and plant the logs
// path as a FILE (so appendLog's recursive mkdirSync throws ENOTDIR,
// which is the appendLog failure mode this fix swallows).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";

const INSTANCE = "manager-publicurl-remove-log-test";

describe("removePublicUrlFile swallows appendLog failures", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-publicurl-remove-log-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: {
          enabled: false,
          secret: "T".repeat(32),
          appleNotes: { enabled: false }
        }
      }),
      "utf8"
    );
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    removeMemoryDb(INSTANCE);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a thrown appendLog inside the non-ENOENT branch does not propagate out of the helper", async () => {
    const instanceDir = join(tmp, "instances", INSTANCE);

    // Plant the publicUrl path as a NON-EMPTY DIRECTORY so unlinkSync
    // throws EISDIR (or EPERM on macOS) instead of ENOENT. We need
    // ANY non-ENOENT errno to drive the helper into its diagnostic
    // appendLog branch — the specific code is reported through the
    // log payload but does not gate the branch.
    const publicUrlPath = join(instanceDir, "tunnel.publicUrl");
    mkdirSync(publicUrlPath, { recursive: true });
    writeFileSync(join(publicUrlPath, "blocker"), "x", "utf8");

    // Plant the logs path as a REGULAR FILE so appendLog's
    // `ensureDir(logDir(instance))` calls `mkdirSync(<logs>, {
    // recursive: true })` and throws ENOTDIR (mkdirSync recursive
    // refuses to create a dir at an existing-non-dir path). This is
    // exactly the operator-facing failure mode the fix has to swallow.
    writeFileSync(join(instanceDir, "logs"), "x", "utf8");

    // Re-import the manager fresh so the constructor runs under the
    // planted state. The constructor invokes removePublicUrlFile()
    // directly with no outer try/catch — if the helper lets either
    // unlinkSync or appendLog escape, the `tunnelManager()` call
    // itself throws and this expect-not-to-throw assertion fails.
    const { __resetTunnelManagerForTests, tunnelManager } = await import("./manager");
    __resetTunnelManagerForTests();
    expect(() => {
      tunnelManager({
        instance: INSTANCE,
        port: 7337,
        token: "test-token",
        provider: { name: "echo", model: "gini-echo-v0" },
        workspaceRoot: "/tmp",
        stateRoot: instanceDir,
        logRoot: join(tmp, "logs", INSTANCE)
      });
    }).not.toThrow();

    __resetTunnelManagerForTests();
  });
});
