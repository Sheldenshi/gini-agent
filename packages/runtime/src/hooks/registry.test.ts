// Decoupling + boundary + registration-reachability tests for the hook
// primitive (ADR job-pre-run-hooks.md).
//
// These tests deliberately import NO src/jobs symbol — they prove the primitive
// is usable independently of jobs, that its core files import no domain module,
// and that the composition root wires the built-in handler.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, __registerHookForTest, __resetHooksForTest, isKnownHook, resolveHook } from ".";
import type { RuntimeConfig } from "../types";

function buildConfig(): RuntimeConfig {
  return {
    instance: "hook-primitive-test",
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp/gini-hook-primitive",
    stateRoot: "/tmp/gini-hook-primitive",
    logRoot: "/tmp/gini-hook-primitive-logs"
  };
}

describe("hook primitive — independent use (no jobs)", () => {
  afterEach(() => __resetHooksForTest());

  test("runHook drives a stub handler to each outcome with no job/scheduler", async () => {
    const config = buildConfig();
    __registerHookForTest("indep-shortcircuit", async () => ({ kind: "shortCircuit", summary: "[SILENT]" }));
    __registerHookForTest("indep-context", async (ctx) => ({
      kind: "context",
      items: [{ text: `sku=${String(ctx.hookConfig.sku)}`, untrusted: false }]
    }));
    __registerHookForTest("indep-error", async () => ({ kind: "error", message: "broken config" }));

    const sc = await runHook(config, { handlerId: "indep-shortcircuit", config: {} });
    expect(sc.kind).toBe("shortCircuit");

    // The optional payload merges into the handler's hookConfig — the "used
    // independently" path passes ad-hoc data alongside the declarative config.
    const ctx = await runHook(config, { handlerId: "indep-context", config: { sku: "ABC" } });
    expect(ctx.kind).toBe("context");
    if (ctx.kind === "context") expect(ctx.context[0]).toContain("sku=ABC");

    const err = await runHook(config, { handlerId: "indep-error", config: {} });
    expect(err.kind).toBe("error");
    if (err.kind === "error") expect(err.transient).toBe(false);
  });

  test("an unknown handlerId is a non-transient error outcome", async () => {
    const out = await runHook(buildConfig(), { handlerId: "no-such-handler", config: {} });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.transient).toBe(false);
  });

  test("a handler throw is a transient error outcome", async () => {
    __registerHookForTest("indep-throw", async () => { throw new Error("boom"); });
    const out = await runHook(buildConfig(), { handlerId: "indep-throw", config: {} });
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.transient).toBe(true);
  });

  test("a timeout is a transient error outcome", async () => {
    __registerHookForTest("indep-timeout", () => new Promise(() => {}));
    const out = await runHook(buildConfig(), { handlerId: "indep-timeout", config: {}, timeoutMs: 10 });
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.transient).toBe(true);
      expect(out.message).toContain("timed out");
    }
  });
});

describe("hook primitive — registry prototype safety", () => {
  test("rejects Object.prototype keys at membership and resolution", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(isKnownHook(key)).toBe(false);
      expect(resolveHook(key)).toBeUndefined();
    }
  });
});

describe("hook primitive — module boundary", () => {
  test("the generic core imports no jobs/state/integrations/capabilities module", () => {
    // Pins the module boundary so a future edit can't recouple the primitive to a
    // domain or to the (core but non-primitive) capabilities layer. The
    // composition root (builtins.ts) is excluded — it is the ONE file allowed to
    // import a handler module.
    const here = import.meta.dir;
    const forbidden = /from\s+["']\.\.\/(jobs|state|integrations|capabilities)/;
    for (const file of ["types.ts", "registry.ts", "runner.ts", "index.ts"]) {
      const src = readFileSync(join(here, file), "utf8");
      expect(forbidden.test(src)).toBe(false);
    }
  });
});

describe("hook primitive — registration reachability", () => {
  test("importing builtins registers the skill-script built-in", async () => {
    await import("./builtins");
    expect(isKnownHook("skill-script")).toBe(true);
    expect(resolveHook("skill-script")).toBeDefined();
  });
});
