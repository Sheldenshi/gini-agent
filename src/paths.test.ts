import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRuntimePort, defaultWebPort, isEnvProviderName, loadConfig, migrateLegacyInstancePaths } from "./paths";

describe("default port helpers", () => {
  test("production default instance is pinned to memorable 7777/7778 ports", () => {
    // Production end-users (installed via curl|bash, GINI_INSTANCE=default)
    // must always land on the same URL. Hashed defaults would force them to
    // run `gini status` to discover a port — bad UX. Web is 7777 (the URL
    // users hit), runtime is the adjacent 7778.
    expect(defaultWebPort("default")).toBe(7777);
    expect(defaultRuntimePort("default")).toBe(7778);
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

describe("GINI_PROVIDER env recognition", () => {
  function withProviderEnv<T>(
    overrides: { provider?: string; model?: string },
    fn: (root: string) => T
  ): T {
    const root = mkdtempSync(join(tmpdir(), "gini-paths-env-"));
    const prev = {
      state: process.env.GINI_STATE_ROOT,
      log: process.env.GINI_LOG_ROOT,
      provider: process.env.GINI_PROVIDER,
      model: process.env.GINI_MODEL,
      port: process.env.GINI_PORT
    };
    process.env.GINI_STATE_ROOT = root;
    delete process.env.GINI_LOG_ROOT;
    delete process.env.GINI_PORT;
    if (overrides.provider === undefined) delete process.env.GINI_PROVIDER;
    else process.env.GINI_PROVIDER = overrides.provider;
    if (overrides.model === undefined) delete process.env.GINI_MODEL;
    else process.env.GINI_MODEL = overrides.model;
    try {
      return fn(root);
    } finally {
      if (prev.state === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = prev.state;
      if (prev.log === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = prev.log;
      if (prev.provider === undefined) delete process.env.GINI_PROVIDER;
      else process.env.GINI_PROVIDER = prev.provider;
      if (prev.model === undefined) delete process.env.GINI_MODEL;
      else process.env.GINI_MODEL = prev.model;
      if (prev.port === undefined) delete process.env.GINI_PORT;
      else process.env.GINI_PORT = prev.port;
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("isEnvProviderName accepts the three documented values and rejects others", () => {
    expect(isEnvProviderName("openai")).toBe(true);
    expect(isEnvProviderName("codex")).toBe(true);
    expect(isEnvProviderName("echo")).toBe(true);
    expect(isEnvProviderName("anthropic")).toBe(false);
    expect(isEnvProviderName("")).toBe(false);
    expect(isEnvProviderName(undefined)).toBe(false);
  });

  test("GINI_PROVIDER=echo lands on echo/gini-echo-v0 (smoke contract)", () => {
    // Without this, ephemeral smoke (src/cli/args.ts pins GINI_PROVIDER=echo)
    // would fall through to the codex default and call the real backend.
    withProviderEnv({ provider: "echo" }, () => {
      const config = loadConfig("smoke-echo-default");
      expect(config.provider.name).toBe("echo");
      expect(config.provider.model).toBe("gini-echo-v0");
      expect(config.provider.apiKeyEnv).toBeUndefined();
    });
  });
});

describe("legacy on-disk layout migration", () => {
  function withTempStateRoot<T>(fn: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), "gini-paths-"));
    const previousState = process.env.GINI_STATE_ROOT;
    const previousLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    // Other test files (state.test.ts) set GINI_LOG_ROOT and don't always
    // unset it; that leak makes the nested-logs migration here a no-op
    // because the migration step skips when GINI_LOG_ROOT is set.
    delete process.env.GINI_LOG_ROOT;
    try {
      return fn(root);
    } finally {
      if (previousState === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = previousState;
      if (previousLog === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = previousLog;
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

  test("moves ~/.gini/logs/<name>/ into instances/<name>/logs/", () => {
    withTempStateRoot((root) => {
      // Pre-existing instance dir + an old top-level logs/<name> dir with a
      // log file inside. Migration should move the contents under instances/.
      const instanceDir = join(root, "instances", "dev");
      mkdirSync(instanceDir, { recursive: true });
      const oldLogs = join(root, "logs", "dev");
      mkdirSync(oldLogs, { recursive: true });
      writeFileSync(join(oldLogs, "runtime.log"), "line one\n");

      migrateLegacyInstancePaths();

      const newLogs = join(instanceDir, "logs");
      expect(existsSync(newLogs)).toBe(true);
      expect(readFileSync(join(newLogs, "runtime.log"), "utf8")).toBe("line one\n");
      expect(existsSync(oldLogs)).toBe(false);
      // Empty top-level logs/ shell is removed.
      expect(existsSync(join(root, "logs"))).toBe(false);
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
