// Unit tests for the cache-warmer config surface. The validation
// contract and disk persistence are the only behaviors that get tested
// here — the probe itself (fireCacheWarmerProbe) just delegates to
// generateTaskSummary, and the gateway loop in src/server.ts is
// integration territory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getCacheWarmer, setCacheWarmer } from "./cache-warmer";
import { configPath, loadConfig } from "../paths";
import type { RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function scratch(): { stateRoot: string; cleanup: () => void } {
  const root = `/tmp/gini-cache-warmer-tests/${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return {
    stateRoot: join(root, ".gini"),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

describe("cache-warmer", () => {
  let prevStateRoot: string | undefined;
  let s: ReturnType<typeof scratch>;
  let config: RuntimeConfig;

  beforeEach(() => {
    prevStateRoot = process.env.GINI_STATE_ROOT;
    s = scratch();
    process.env.GINI_STATE_ROOT = s.stateRoot;
    config = loadConfig(`cw-${tag()}`);
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    s.cleanup();
  });

  test("getCacheWarmer returns 0 when unset", () => {
    expect(getCacheWarmer(config)).toEqual({ minutes: 0 });
  });

  test("setCacheWarmer persists a valid integer", () => {
    const result = setCacheWarmer(config, { minutes: 45 });
    expect(result).toEqual({ ok: true, minutes: 45 });
    expect(config.cacheWarmerMinutes).toBe(45);
    const onDisk = JSON.parse(readFileSync(configPath(config.instance), "utf-8"));
    expect(onDisk.cacheWarmerMinutes).toBe(45);
  });

  test("setCacheWarmer with 0 clears the field instead of writing 0", () => {
    config.cacheWarmerMinutes = 30;
    const result = setCacheWarmer(config, { minutes: 0 });
    expect(result).toEqual({ ok: true, minutes: 0 });
    expect(config.cacheWarmerMinutes).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(configPath(config.instance), "utf-8"));
    expect(onDisk.cacheWarmerMinutes).toBeUndefined();
  });

  test("setCacheWarmer accepts the upper bound", () => {
    expect(setCacheWarmer(config, { minutes: 1440 })).toEqual({ ok: true, minutes: 1440 });
  });

  test("setCacheWarmer rejects non-integer", () => {
    const result = setCacheWarmer(config, { minutes: 12.5 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("integer");
  });

  test("setCacheWarmer rejects negative", () => {
    const result = setCacheWarmer(config, { minutes: -1 });
    expect(result.ok).toBe(false);
  });

  test("setCacheWarmer rejects out-of-range high", () => {
    const result = setCacheWarmer(config, { minutes: 1441 });
    expect(result.ok).toBe(false);
  });

  test("setCacheWarmer rejects non-numeric type", () => {
    const result = setCacheWarmer(config, { minutes: "30" });
    expect(result.ok).toBe(false);
  });

  test("setCacheWarmer rejects non-object payload", () => {
    expect(setCacheWarmer(config, null).ok).toBe(false);
    expect(setCacheWarmer(config, 42).ok).toBe(false);
    expect(setCacheWarmer(config, "minutes=30").ok).toBe(false);
  });
});
