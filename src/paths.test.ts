import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRuntimePort, defaultWebPort, loadConfig, migrateLegacyInstancePaths } from "./paths";

describe("default port helpers", () => {
  test("dev instance stays pinned to 7337/3000 (no muscle-memory regression)", () => {
    expect(defaultRuntimePort("dev")).toBe(7337);
    expect(defaultWebPort("dev")).toBe(3000);
  });

  test("same instance name always picks the same default port (deterministic hash)", () => {
    expect(defaultRuntimePort("feature-x")).toBe(defaultRuntimePort("feature-x"));
    expect(defaultWebPort("feature-x")).toBe(defaultWebPort("feature-x"));
  });

  test("different instances pick different defaults across a representative sample", () => {
    // 50 random-ish instances; runtime ports should land in [7337, 7437) and web
    // ports in [3000, 3100). We expect a healthy spread (>=20 distinct values
    // in a 100-port window from 50 samples). If FNV ever degenerates this
    // catches it.
    const instances = Array.from({ length: 50 }, (_, index) => `instance-${index}`);
    const runtimePorts = new Set(instances.map((instance) => defaultRuntimePort(instance)));
    const webPorts = new Set(instances.map((instance) => defaultWebPort(instance)));
    expect(runtimePorts.size).toBeGreaterThanOrEqual(20);
    expect(webPorts.size).toBeGreaterThanOrEqual(20);
    for (const instance of instances) {
      const rp = defaultRuntimePort(instance);
      const wp = defaultWebPort(instance);
      expect(rp).toBeGreaterThanOrEqual(7337);
      expect(rp).toBeLessThan(7337 + 100);
      expect(wp).toBeGreaterThanOrEqual(3000);
      expect(wp).toBeLessThan(3000 + 100);
    }
  });

  test("runtime and web ports are independent (different hash namespaces)", () => {
    // Same offset for runtime and web would mean they collide as a pair —
    // not technically wrong, but two namespaces means instance A and instance B
    // can't ever both share the same runtime AND the same web.
    const instances = ["alpha", "beta", "gamma", "delta", "epsilon"];
    let differOnAtLeastOne = 0;
    for (const instance of instances) {
      const rp = defaultRuntimePort(instance) - 7337;
      const wp = defaultWebPort(instance) - 3000;
      if (rp !== wp) differOnAtLeastOne += 1;
    }
    expect(differOnAtLeastOne).toBeGreaterThan(0);
  });
});

describe("legacy on-disk layout migration", () => {
  function withTempStateRoot<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "gini-paths-"));
    const previous = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = root;
    try {
      return fn(root);
    } finally {
      if (previous === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("moves ~/.gini/lanes/<name>/ to ~/.gini/instances/<name>/", () => {
    withTempStateRoot((root) => {
      const oldDir = join(root, "lanes", "dev");
      mkdirSync(oldDir, { recursive: true });
      // Persist a config.json with a workspaceRoot pointing inside the old
      // lanes/ tree so the loader has something to rewrite.
      const oldWorkspace = join(oldDir, "workspace");
      mkdirSync(oldWorkspace, { recursive: true });
      writeFileSync(
        join(oldDir, "config.json"),
        JSON.stringify({
          instance: "dev",
          port: 7337,
          token: "test",
          provider: { name: "echo", model: "gini-echo-v0" },
          workspaceRoot: oldWorkspace,
          stateRoot: oldDir,
          logRoot: join(root, "logs", "dev")
        }, null, 2)
      );

      migrateLegacyInstancePaths();

      const newDir = join(root, "instances", "dev");
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(join(newDir, "config.json"))).toBe(true);
      expect(existsSync(oldDir)).toBe(false);

      const config = loadConfig("dev");
      expect(config.stateRoot).toBe(newDir);
      expect(config.workspaceRoot.startsWith(newDir)).toBe(true);
      const onDisk = JSON.parse(readFileSync(join(newDir, "config.json"), "utf8"));
      expect(onDisk.workspaceRoot.startsWith(newDir)).toBe(true);
    });
  });

  test("moves ~/.gini/<name>/ (very old layout) to ~/.gini/instances/<name>/", () => {
    withTempStateRoot((root) => {
      const oldDir = join(root, "ancient");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(
        join(oldDir, "config.json"),
        JSON.stringify({ instance: "ancient", port: 7400, token: "x", provider: { name: "echo", model: "x" }, workspaceRoot: oldDir, stateRoot: oldDir, logRoot: oldDir }, null, 2)
      );

      migrateLegacyInstancePaths();

      const newDir = join(root, "instances", "ancient");
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(join(newDir, "config.json"))).toBe(true);
      expect(existsSync(oldDir)).toBe(false);
    });
  });

  test("is idempotent — second call with no legacy data is a no-op", () => {
    withTempStateRoot((root) => {
      const newDir = join(root, "instances", "dev");
      mkdirSync(newDir, { recursive: true });
      writeFileSync(
        join(newDir, "config.json"),
        JSON.stringify({ instance: "dev", port: 7337, token: "x", provider: { name: "echo", model: "x" }, workspaceRoot: join(newDir, "workspace"), stateRoot: newDir, logRoot: join(root, "logs", "dev") }, null, 2)
      );

      migrateLegacyInstancePaths();
      migrateLegacyInstancePaths();

      expect(existsSync(newDir)).toBe(true);
    });
  });

  test("does not clobber an existing instances/<name>/ when both legacy and new exist", () => {
    withTempStateRoot((root) => {
      const oldDir = join(root, "lanes", "dev");
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, "config.json"), "{}");
      const newDir = join(root, "instances", "dev");
      mkdirSync(newDir, { recursive: true });
      writeFileSync(join(newDir, "marker"), "keep me");

      migrateLegacyInstancePaths();

      // The new directory is preserved; the old shell stays in place so the
      // user can resolve manually.
      expect(readFileSync(join(newDir, "marker"), "utf8")).toBe("keep me");
      expect(existsSync(oldDir)).toBe(true);
    });
  });
});
