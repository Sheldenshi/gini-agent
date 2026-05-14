// Tests for the exported `enable()` function with launchctl dependency
// injection. The integration-level behavior (real launchctl shellouts)
// is covered by autostart.test.ts under GINI_AUTOSTART_E2E=1; this file
// targets the bookkeeping branches that real launchctl can't reach —
// notably HIGH-B (rollback bootout itself fails) and the corresponding
// EnableResult.rollbackState contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { enable } from "./autostart";
import type { LaunchctlResult } from "../autostart";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeScratch(label: string): { stateRoot: string; logRoot: string; home: string } {
  const root = `/tmp/gini-autostart-enable-tests/${label}-${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { stateRoot: join(root, "state"), logRoot: join(root, "logs"), home };
}

function ok(stdout = ""): LaunchctlResult {
  return { ok: true, stdout, stderr: "", status: 0 };
}

function fail(stderr: string): LaunchctlResult {
  return { ok: false, stdout: "", stderr, status: 1 };
}

const isDarwin = process.platform === "darwin";

(isDarwin ? describe : describe.skip)("autostart enable (DI) — rollback failure surfacing", () => {
  let scratch: { stateRoot: string; logRoot: string; home: string };
  let envHome: string | undefined;
  const instance = `enable-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("rollback");
    envHome = process.env.HOME;
    // Point HOME at the scratch dir so the plist file writes land there
    // instead of the developer's real ~/Library/LaunchAgents. The
    // writePlist call is unmocked — only the launchctl shellouts are.
    process.env.HOME = scratch.home;
  });

  afterEach(() => {
    if (envHome === undefined) delete process.env.HOME;
    else process.env.HOME = envHome;
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Remove any plists we wrote into the scratch LaunchAgents.
    rmSync(join(scratch.home, "Library"), { recursive: true, force: true });
  });

  test("happy path: both kinds bootstrap → rollbackState 'clean', no rollbackFailures", async () => {
    const kickstartCalls: Array<{ inst: string; kind?: "gateway" | "web" }> = [];
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: (inst: string, kind?: "gateway" | "web") => {
        kickstartCalls.push({ inst, kind });
        return ok();
      }
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.rollbackState).toBe("clean");
    expect(result.rollbackFailures).toBeUndefined();
    expect(result.results.length).toBe(2);
    for (const r of result.results) {
      expect(r.enabled).toBe(true);
      expect(r.kickstartError).toBeUndefined();
    }
    // Round-5 fix: kickstart must fire once per successful bootstrap so
    // services actually launch on macOS 26 (where RunAtLoad is
    // best-effort). Order matches the kinds slice: gateway, then web.
    expect(kickstartCalls.length).toBe(2);
    expect(kickstartCalls[0]!.kind).toBe("gateway");
    expect(kickstartCalls[1]!.kind).toBe("web");
  });

  test("Round-5: kickstart failure is surfaced per-kind but does NOT fail the enable", async () => {
    // The bootstrap succeeded (services are registered), but kickstart
    // returned non-zero. We keep enabled:true so install.sh proceeds
    // and surface the soft failure so the user can recover with
    // `gini autostart kick` manually.
    let kickstartCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: () => {
        kickstartCalls += 1;
        // First call (gateway) succeeds, second (web) fails — exercises
        // both branches.
        if (kickstartCalls === 1) return ok();
        return fail("Could not kickstart service: 3: No such process");
      }
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    // Whole-enable still ok — bootstrap succeeded for both.
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.rollbackState).toBe("clean");
    expect(result.results.length).toBe(2);
    const gateway = result.results.find((r) => r.kind === "gateway")!;
    const web = result.results.find((r) => r.kind === "web")!;
    expect(gateway.enabled).toBe(true);
    expect(gateway.kickstartError).toBeUndefined();
    expect(web.enabled).toBe(true);
    expect(web.kickstartError).toBe("launchctl kickstart failed");
    expect(web.kickstartStderr).toContain("No such process");
  });

  test("HIGH-B: web fails AND rollback bootout fails → rollbackState 'rollback_failed' + stderr surfaced", async () => {
    // Bookkeeping: track per-call so the test can distinguish web's
    // bootstrap call (fails) from the rollback bootout call (also fails).
    let bootstrapCalls = 0;
    let bootoutCalls = 0;
    const bootoutStderrSeen: string[] = [];
    const deps = {
      isLoaded: () => false,
      bootout: (_inst: string, _kind?: "gateway" | "web") => {
        bootoutCalls += 1;
        // Rollback bootout fails — this is the scenario HIGH-B flagged.
        return fail("Bootout failed: 5: Input/output error");
      },
      bootstrap: (_inst: string, _path: string) => {
        bootstrapCalls += 1;
        // Gateway succeeds; web fails. The retry-on-IO-error path won't
        // help here because the stderr doesn't contain "Input/output
        // error" (we're simulating a permanent failure).
        if (bootstrapCalls === 1) return ok();
        return fail("Bootstrap failed: permanent fault");
      },
      kickstart: () => ok()
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    // Top-level: enable failed.
    expect(result.ok).toBe(false);
    expect(result.enabled).toBe(false);
    // The honest state: gateway was bootstrapped, web failed, rollback of
    // gateway also failed → "rollback_failed".
    expect(result.rollbackState).toBe("rollback_failed");
    expect(result.rollbackFailures).toBeDefined();
    expect(result.rollbackFailures!.length).toBe(1);
    expect(result.rollbackFailures![0]!.kind).toBe("gateway");
    expect(result.rollbackFailures![0]!.error).toBe("rollback bootout failed");
    expect(result.rollbackFailures![0]!.stderr).toContain("Input/output error");
    // Per-kind detail still surfaces the underlying web failure.
    const webResult = result.results.find((r) => r.kind === "web");
    expect(webResult).toBeDefined();
    expect(webResult!.enabled).toBe(false);
    expect(webResult!.stderr).toContain("permanent fault");
    // Confirm the rollback was actually attempted (one bootout call for
    // the gateway after web failed).
    expect(bootoutCalls).toBeGreaterThanOrEqual(1);
    // Mark variables as used.
    expect(bootoutStderrSeen).toBeDefined();
  });

  test("web fails but rollback bootout SUCCEEDS → rollbackState 'rolled_back', no rollbackFailures", async () => {
    let bootstrapCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(), // rollback succeeds
      bootstrap: () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return ok(); // gateway
        return fail("Bootstrap failed: web missing"); // web
      },
      kickstart: () => ok()
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(false);
    expect(result.rollbackState).toBe("rolled_back");
    expect(result.rollbackFailures).toBeUndefined();
  });

  test("rollback that hits 'Could not find service' is treated as success (idempotent)", async () => {
    let bootstrapCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => fail("Could not find service ai.lilaclabs.gini.x.gateway"),
      bootstrap: () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return ok();
        return fail("Bootstrap failed: web missing");
      },
      kickstart: () => ok()
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(false);
    // "Could not find service" doesn't count as a real rollback failure —
    // the service was never loaded in the first place.
    expect(result.rollbackState).toBe("rolled_back");
  });
});
