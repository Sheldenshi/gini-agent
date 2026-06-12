// Tests for `gini watchdog`. Every external dependency is injected — no real
// fetch, no real launchctl, no real sleeps. Port files + the report/log dirs
// live under a unique GINI_STATE_ROOT in /tmp. The watchdog always keeps
// process.exitCode === 0 regardless of which services were down.
//
// Coverage:
//   - all healthy -> no kickstart, no report queued, exit 0
//   - web down while runtime healthy -> web kickstart + a pending web report
//   - runtime hung -> gateway kickstart, no web report
//   - missing port files -> treated as down (kickstart fired), no report, exit 0
//   - a deregistered core service -> re-bootstrap (enable) instead of kickstart,
//     only under launchd; a failed/throwing re-enable is swallowed, exit 0
//   - loop mode: ticks are paced by the injectable sleep, revive requires TWO
//     consecutive failed ticks (a one-tick probe miss never hard-kills a
//     healthy-but-busy service), streaks reset on a healthy probe, and
//     `--once` forces a single tick with the threshold back at 1
//
// Single-tick tests run via `--once` so the loop (the launchd default) never
// spins; loop tests bound it with deps.maxTicks. The `--once` single-tick
// tests double as the threshold-1 pin: a down service is revived (and a web
// report queued) on the one and only tick.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchdog, UPDATE_MARKER_STALE_MS, WATCHDOG_TICK_INTERVAL_MS } from "./watchdog";
import type { CliContext } from "../context";
import type { LaunchctlResult, PlistKind } from "../../integrations/launchd";
import { logDir, runtimePortPath, updateInProgressMarkerPath, webPortPath } from "../../paths";
import { listPendingReports } from "../../runtime/crash-report";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

const INSTANCE = "watchdog-test";

function ctxFor(extraArgs: string[] = ["--once"]): CliContext {
  return {
    config: { instance: INSTANCE } as CliContext["config"],
    cliArgs: ["watchdog", ...extraArgs],
    command: "watchdog",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: ["watchdog", "--instance", INSTANCE, ...extraArgs],
    web: { webPort: 0, webPortPinned: false, noWeb: true, runtimePortPinned: false }
  };
}

const okLaunchctl: LaunchctlResult = { ok: true, stdout: "", stderr: "", status: 0 };

describe("watchdog", () => {
  let stateRoot: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    stateRoot = `/tmp/gini-watchdog-tests-${tag()}`;
    rmSync(stateRoot, { recursive: true, force: true });
    mkdirSync(join(stateRoot, "instances", INSTANCE), { recursive: true });
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = stateRoot;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(stateRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function writePorts(): void {
    writeFileSync(runtimePortPath(INSTANCE), "7778\n");
    writeFileSync(webPortPath(INSTANCE), "7777\n");
  }

  test("all healthy -> no kickstart, no report queued, exit 0", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    expect(kicks.length).toBe(0);
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("web down while runtime healthy (recorded port) -> web kickstart + a pending web report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    // Web revived, gateway untouched.
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    // Exactly one web report queued in pending/.
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.source).toBe("web");
    expect(pending[0]!.report.instance).toBe(INSTANCE);
    expect(pending[0]!.report.fingerprint.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });

  test("runtime hung -> gateway kickstart, no web report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    expect(kicks.map((k) => k.kind)).toEqual(["gateway"]);
    // A hung runtime is captured via the in-process crash handler, not the
    // watchdog — no web report queued here.
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("missing web port -> kickstart only, NO web crash report (boot race, not a crash)", async () => {
    // No writePorts(): the port files are absent. A missing web port means the
    // service never booted (or was stopped) — that's a boot race, not a web
    // crash, so we kickstart but must NOT queue a false-positive report.
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    let probedRuntime = false;
    let probedWeb = false;
    await watchdog(ctxFor(), {
      probeRuntime: async () => {
        probedRuntime = true;
        return true;
      },
      probeWeb: async () => {
        probedWeb = true;
        return true;
      },
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    // With no recorded port, there's nothing to probe — both are down and
    // both get kicked (gateway first, then web).
    expect(probedRuntime).toBe(false);
    expect(probedWeb).toBe(false);
    expect(kicks.map((k) => k.kind)).toEqual(["gateway", "web"]);
    // No web crash report: the missing port is a boot race, not a crash.
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("web down WHILE runtime down -> kickstart web, NO web report (symptom, not web crash)", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      // Runtime is down too — the web BFF failing is just a symptom of the
      // dead gateway, not a web-specific crash worth its own report.
      probeRuntime: async () => false,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    // Both kicked, but no web crash report queued.
    expect(kicks.map((k) => k.kind)).toEqual(["gateway", "web"]);
    expect(listPendingReports().length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("a kickstart that throws still results in exit 0 (tick never propagates the throw)", async () => {
    writePorts();
    // Runtime is down, so the gateway kickstart fires — and throws. The tick
    // must still set exitCode 0 (try/finally) and must not reject.
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: () => {
        throw new Error("launchctl blew up");
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    expect(process.exitCode).toBe(0);
  });

  test("a probe that throws/rejects -> watchdog resolves, exit 0, never propagates", async () => {
    writePorts();
    // probeRuntime rejects. Without the tick's catch, this rejection would
    // propagate out of watchdog and the CLI top-level would exit(1). The tick
    // must instead swallow it, resolve normally, and set exitCode 0.
    await expect(
      watchdog(ctxFor(), {
        probeRuntime: async () => {
          throw new Error("probe blew up");
        },
        probeWeb: async () => true,
        kickstartImpl: () => okLaunchctl,
        isLoadedImpl: () => true,
        supervisorImpl: () => "launchd"
      })
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  test("web down but not under launchd -> still kicks web, and still queues the report", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => false,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      // Registered but dead -> kickstart path (this test asserts the report
      // queuing under supervisor: null, not the deregistered re-enable path).
      isLoadedImpl: () => true,
      // Not launchd: capture is unconditional now; the consent gate lives in
      // crash-recovery. The report carries supervisor: null.
      supervisorImpl: () => null
    });
    expect(kicks.map((k) => k.kind)).toEqual(["web"]);
    const pending = listPendingReports();
    expect(pending.length).toBe(1);
    expect(pending[0]!.report.supervisor).toBeNull();
    expect(process.exitCode).toBe(0);
  });

  test("runtime down + gateway DEREGISTERED -> re-bootstrap (enable), no kickstart, exit 0", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const reenables: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      // launchd has deregistered the gateway: kickstart would no-op, so the
      // watchdog re-bootstraps it via enable instead.
      isLoadedImpl: () => false,
      reenableImpl: async (instance, kind) => {
        reenables.push({ instance, kind });
        return true;
      },
      supervisorImpl: () => "launchd"
    });
    expect(kicks.length).toBe(0);
    expect(reenables).toEqual([{ instance: INSTANCE, kind: "gateway" }]);
    expect(process.exitCode).toBe(0);
  });

  test("re-bootstrap that returns false -> exit 0, retried next tick (no throw)", async () => {
    writePorts();
    const reenables: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => false,
      reenableImpl: async (instance, kind) => {
        reenables.push({ instance, kind });
        return false;
      },
      supervisorImpl: () => "launchd"
    });
    expect(reenables).toEqual([{ instance: INSTANCE, kind: "gateway" }]);
    expect(process.exitCode).toBe(0);
  });

  test("re-bootstrap that throws -> swallowed, exit 0 (tick never propagates)", async () => {
    writePorts();
    await expect(
      watchdog(ctxFor(), {
        probeRuntime: async () => false,
        probeWeb: async () => true,
        kickstartImpl: () => okLaunchctl,
        isLoadedImpl: () => false,
        reenableImpl: async () => {
          throw new Error("enable blew up");
        },
        supervisorImpl: () => "launchd"
      })
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  test("deregistered but NOT under launchd -> no re-enable, no kickstart, exit 0", async () => {
    writePorts();
    const kicks: Array<{ instance: string; kind: PlistKind }> = [];
    const reenables: Array<{ instance: string; kind: PlistKind }> = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (instance, kind) => {
        kicks.push({ instance, kind });
        return okLaunchctl;
      },
      isLoadedImpl: () => false,
      reenableImpl: async (instance, kind) => {
        reenables.push({ instance, kind });
        return true;
      },
      // A manual foreground `gini watchdog` (not under launchd) must not start
      // creating launchd plists — the deregistered service is left alone.
      supervisorImpl: () => null
    });
    expect(kicks.length).toBe(0);
    expect(reenables.length).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("loop: runs maxTicks ticks, sleeping the tick interval BETWEEN ticks (not after the last)", async () => {
    writePorts();
    let probes = 0;
    const sleeps: number[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => {
        probes += 1;
        return true;
      },
      probeWeb: async () => true,
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    expect(probes).toBe(3);
    // Two pauses for three ticks, each at the default cadence.
    expect(sleeps).toEqual([WATCHDOG_TICK_INTERVAL_MS, WATCHDOG_TICK_INTERVAL_MS]);
    expect(process.exitCode).toBe(0);
  });

  test("loop: a gateway dead for two consecutive ticks is kickstarted on the second, and the loop keeps going", async () => {
    writePorts();
    const results = [true, false, false, true];
    let probes = 0;
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => {
        const result = results[probes] ?? true;
        probes += 1;
        return result;
      },
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 4,
      intervalMs: 7,
      sleep: async () => {}
    });
    expect(probes).toBe(4);
    // Exactly one revive: the first dead tick only opened the streak, the
    // second confirmed it and kicked the gateway, and the healthy ticks
    // before and after did nothing.
    expect(kicks).toEqual(["gateway"]);
    expect(process.exitCode).toBe(0);
  });

  test("loop: a single failed tick never revives (two-strike), and a recovery resets the streak", async () => {
    writePorts();
    // Failures never run back-to-back: each one is followed by a healthy
    // probe that resets the streak, so the threshold of 2 is never reached.
    const results = [false, true, false, true];
    let probes = 0;
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => {
        const result = results[probes] ?? true;
        probes += 1;
        return result;
      },
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 4,
      sleep: async () => {}
    });
    expect(probes).toBe(4);
    expect(kicks).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("loop: a sustained gateway outage re-kicks every threshold ticks, not every tick", async () => {
    writePorts();
    // The streak resets after each revive, so the kicked gateway gets a full
    // threshold window to boot: kicks land on ticks 3 and 5, not 3-4-5
    // (without the post-revive reset, streak 3/4/5 would re-kick every tick
    // and keep restarting the very boot the watchdog is waiting for).
    const results = [true, false, false, false, false];
    let probes = 0;
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => {
        const result = results[probes] ?? false;
        probes += 1;
        return result;
      },
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 5,
      sleep: async () => {}
    });
    expect(probes).toBe(5);
    expect(kicks).toEqual(["gateway", "gateway"]);
    expect(process.exitCode).toBe(0);
  });

  test("loop: the web streak resets after a revive too", async () => {
    writePorts();
    // Three consecutive web failures: tick 2 reaches the threshold (report +
    // kick), the reset makes tick 3 streak 1 again — no second kick.
    const webResults = [false, false, false];
    let probes = 0;
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => true,
      probeWeb: async () => {
        const result = webResults[probes] ?? true;
        probes += 1;
        return result;
      },
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 3,
      sleep: async () => {}
    });
    expect(probes).toBe(3);
    expect(kicks).toEqual(["web"]);
    expect(process.exitCode).toBe(0);
  });

  test("loop: web crash report waits for the second consecutive failed tick too", async () => {
    writePorts();
    const webResults = [false, false];
    let probes = 0;
    const kicks: PlistKind[] = [];
    let reportsAtFirstKick = -1;
    await watchdog(ctxFor([]), {
      probeRuntime: async () => true,
      probeWeb: async () => {
        const result = webResults[probes] ?? true;
        probes += 1;
        return result;
      },
      kickstartImpl: (_instance, kind) => {
        if (kicks.length === 0) reportsAtFirstKick = listPendingReports().length;
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 2,
      sleep: async () => {}
    });
    // No report (and no kick) after tick 1; both fire together on tick 2 —
    // the report is written just before the kick.
    expect(kicks).toEqual(["web"]);
    expect(reportsAtFirstKick).toBe(1);
    expect(listPendingReports().length).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  test("loop: a custom intervalMs reaches the sleep", async () => {
    writePorts();
    const sleeps: number[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => true,
      probeWeb: async () => true,
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 2,
      intervalMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    expect(sleeps).toEqual([5]);
  });

  test("default runtime probe: a live local HTTP server counts as alive", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 401 }) });
    try {
      writeFileSync(runtimePortPath(INSTANCE), `${server.port}\n`);
      writeFileSync(webPortPath(INSTANCE), "7777\n");
      const kicks: PlistKind[] = [];
      await watchdog(ctxFor(), {
        // No probeRuntime injected — the real localhost fetch runs.
        probeWeb: async () => true,
        kickstartImpl: (_instance, kind) => {
          kicks.push(kind);
          return okLaunchctl;
        },
        isLoadedImpl: () => true,
        supervisorImpl: () => "launchd"
      });
      expect(kicks.length).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("default runtime probe: a refused connection counts as dead", async () => {
    // Claim an ephemeral port, then free it so the probe is refused.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const freedPort = server.port;
    server.stop(true);
    writeFileSync(runtimePortPath(INSTANCE), `${freedPort}\n`);
    writeFileSync(webPortPath(INSTANCE), "7777\n");
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor(), {
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    expect(kicks).toEqual(["gateway"]);
  });

  test("default sleep paces the loop when none is injected", async () => {
    writePorts();
    let probes = 0;
    await watchdog(ctxFor([]), {
      probeRuntime: async () => {
        probes += 1;
        return true;
      },
      probeWeb: async () => true,
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 2,
      intervalMs: 1
    });
    expect(probes).toBe(2);
  });

  test("an unreadable port file (directory) is treated as down", async () => {
    mkdirSync(runtimePortPath(INSTANCE), { recursive: true });
    writeFileSync(webPortPath(INSTANCE), "7777\n");
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor(), {
      probeRuntime: async () => true,
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd"
    });
    expect(kicks).toEqual(["gateway"]);
  });

  test("web crash report carries the web.log tail and scrubs secrets.env values", async () => {
    writePorts();
    // Point HOME at the scratch root so secretsEnvPath() resolves inside it.
    const prevHome = process.env.HOME;
    process.env.HOME = stateRoot;
    try {
      mkdirSync(join(stateRoot, ".gini"), { recursive: true });
      writeFileSync(join(stateRoot, ".gini", "secrets.env"), "OPENAI_API_KEY=sk-super-secret-value\n");
      const logs = join(stateRoot, "instances", INSTANCE, "logs");
      mkdirSync(join(logs, "web-launchd.err.log"), { recursive: true }); // unreadable (directory) — must not block the report
      writeFileSync(join(logs, "web.log"), "boot ok\ntoken sk-super-secret-value leaked\n");
      await watchdog(ctxFor(), {
        probeRuntime: async () => true,
        probeWeb: async () => false,
        kickstartImpl: () => okLaunchctl,
        isLoadedImpl: () => true,
        supervisorImpl: () => "launchd"
      });
      const pending = listPendingReports();
      expect(pending.length).toBe(1);
      const serialized = JSON.stringify(pending[0]!.report);
      expect(serialized).toContain("boot ok");
      // The secrets.env literal must never survive into the queued report.
      expect(serialized).not.toContain("sk-super-secret-value");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("an unreadable secrets.env (directory) still queues the report", async () => {
    writePorts();
    const prevHome = process.env.HOME;
    process.env.HOME = stateRoot;
    try {
      mkdirSync(join(stateRoot, ".gini", "secrets.env"), { recursive: true });
      await watchdog(ctxFor(), {
        probeRuntime: async () => true,
        probeWeb: async () => false,
        kickstartImpl: () => okLaunchctl,
        isLoadedImpl: () => true,
        supervisorImpl: () => "launchd"
      });
      expect(listPendingReports().length).toBe(1);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("loop: a sustained web outage queues ONE report per episode, not one per tick", async () => {
    writePorts();
    // Seven ticks: down x3 (one episode), recovered, down x3 (new episode).
    const webResults = [false, false, false, true, false, false, false];
    let probes = 0;
    await watchdog(ctxFor([]), {
      probeRuntime: async () => true,
      probeWeb: async () => {
        const result = webResults[probes] ?? true;
        probes += 1;
        return result;
      },
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 7,
      sleep: async () => {}
    });
    expect(probes).toBe(7);
    // Tick 2 (second consecutive failure) reports, tick 3 is the same episode
    // (suppressed), tick 4 clears the episode, tick 6 confirms a fresh outage
    // and reports again, tick 7 is suppressed.
    expect(listPendingReports().length).toBe(2);
    expect(process.exitCode).toBe(0);
  });

  test("a fresh update-in-progress marker suppresses revives AND the web report despite sustained failures", async () => {
    writePorts();
    // updateRuntime writes this for the duration of the install/build window;
    // probe misses there are expected and a kickstart -k would force-kill the
    // mid-update service.
    writeFileSync(updateInProgressMarkerPath(), "2026-06-12T00:00:00.000Z\n");
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => false,
      probeWeb: async () => false,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 3,
      sleep: async () => {}
    });
    // Three failed ticks for both services, zero revive actions and zero
    // queued reports — only suppression entries in the tick log.
    expect(kicks.length).toBe(0);
    expect(listPendingReports().length).toBe(0);
    const tickLog = readFileSync(join(logDir(INSTANCE), "runtime.jsonl"), "utf8");
    expect(tickLog).toContain("suppressed:update:gateway");
    expect(tickLog).toContain("suppressed:update:web");
    expect(process.exitCode).toBe(0);
  });

  test("a STALE marker does not suppress: revives proceed as normal", async () => {
    writePorts();
    writeFileSync(updateInProgressMarkerPath(), "2026-06-12T00:00:00.000Z\n");
    // The injected clock sits past the staleness cutoff relative to the
    // marker's just-written mtime — a crashed update that never removed its
    // marker must not disarm the watchdog forever.
    const clock = () => new Date(Date.now() + UPDATE_MARKER_STALE_MS + 60_000);
    const kicks: PlistKind[] = [];
    await watchdog(ctxFor([]), {
      probeRuntime: async () => false,
      probeWeb: async () => true,
      kickstartImpl: (_instance, kind) => {
        kicks.push(kind);
        return okLaunchctl;
      },
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      clock,
      maxTicks: 2,
      sleep: async () => {}
    });
    expect(kicks).toEqual(["gateway"]);
    expect(process.exitCode).toBe(0);
  });

  test("--help prints usage and returns without probing or looping", async () => {
    // The default mode loops forever, so help MUST short-circuit before the
    // loop — falling through would hang the terminal and kickstart services.
    writePorts();
    let probes = 0;
    const realLog = console.log;
    const logged: string[] = [];
    console.log = ((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    }) as typeof console.log;
    try {
      for (const helpArg of ["--help", "-h", "help"]) {
        await watchdog(ctxFor([helpArg]), {
          probeRuntime: async () => {
            probes += 1;
            return true;
          },
          probeWeb: async () => true,
          kickstartImpl: () => okLaunchctl,
          isLoadedImpl: () => true,
          supervisorImpl: () => "launchd",
          sleep: async () => {
            throw new Error("help must not enter the loop");
          }
        });
      }
    } finally {
      console.log = realLog;
    }
    expect(probes).toBe(0);
    expect(logged.join("\n")).toContain("--once");
  });

  test("--once forces a single tick even when deps.maxTicks asks for more (and never sleeps)", async () => {
    writePorts();
    let probes = 0;
    await watchdog(ctxFor(["--once"]), {
      probeRuntime: async () => {
        probes += 1;
        return true;
      },
      probeWeb: async () => true,
      kickstartImpl: () => okLaunchctl,
      isLoadedImpl: () => true,
      supervisorImpl: () => "launchd",
      maxTicks: 5,
      sleep: async () => {
        throw new Error("--once must not sleep");
      }
    });
    expect(probes).toBe(1);
    expect(process.exitCode).toBe(0);
  });
});
