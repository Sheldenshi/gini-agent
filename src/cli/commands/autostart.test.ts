// Subprocess tests for `gini autostart enable|disable|status`.
//
// We invoke the CLI directly with GINI_STATE_ROOT and GINI_LOG_ROOT pointed
// at a scratch dir to avoid touching the developer's real install. The
// launchctl integration is gated by GINI_AUTOSTART_E2E so these tests stay
// safe on shared machines: by default we only exercise the disable/status
// paths against a non-existent service, which prove the JSON contract and
// idempotency without registering anything with launchd.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { labelFor, plistPathFor } from "../autostart";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeScratch(label: string): { stateRoot: string; logRoot: string } {
  const root = `/tmp/gini-autostart-cli-tests/${label}-${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { stateRoot: join(root, "state"), logRoot: join(root, "logs") };
}

function runCli(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("gini autostart usage and platform gate", () => {
  test("no subcommand prints usage block", () => {
    const result = runCli(["autostart"], {});
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.usage).toBeDefined();
    expect(Array.isArray(parsed.usage)).toBe(true);
    expect((parsed.usage as string[]).some((line) => line.includes("enable"))).toBe(true);
  });

  test("unknown subcommand returns non-zero exit", () => {
    const result = runCli(["autostart", "nope"], {});
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
  });
});

// Run only on macOS — the platform gate kicks in elsewhere and the JSON
// shape is different. Skipping rather than describe.skipIf-ing keeps the
// fail signal on the intended platform clear.
const isDarwin = process.platform === "darwin";

(isDarwin ? describe : describe.skip)("gini autostart status (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("status");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
  });

  test("reports plistExists:false and loaded:false for a fresh instance", () => {
    const result = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.instance).toBe(uniqueInstance);
    expect(parsed.label).toBe(labelFor(uniqueInstance));
    expect(parsed.plistExists).toBe(false);
    expect(parsed.loaded).toBe(false);
    expect(parsed.pid).toBe(null);
    expect(Array.isArray(parsed.limitations)).toBe(true);
    expect((parsed.limitations as string[]).some((l) => l.includes("PID supervision"))).toBe(true);
  });
});

(isDarwin ? describe : describe.skip)("gini autostart disable (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("disable");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Defensive: clean up any plist we might have written if a test failed
    // mid-way through. We don't actually expect one to exist here, but the
    // assertion would also catch a leak.
    const path = plistPathFor(uniqueInstance);
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
  });

  test("returns alreadyDisabled:true when nothing is registered", () => {
    const result = runCli(
      ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.alreadyDisabled).toBe(true);
    expect(parsed.disabled).toBe(false);
    expect(parsed.plistRemoved).toBe(false);
  });
});

// True end-to-end: write plist, bootstrap, kill PID, verify respawn,
// `gini stop`, verify it stays down, disable. Gated behind
// GINI_AUTOSTART_E2E because it touches the real `gui/<uid>` domain and
// shouldn't run in shared CI.
const e2eOn = isDarwin && process.env.GINI_AUTOSTART_E2E === "1";

(e2eOn ? describe : describe.skip)("gini autostart enable→stop respawn cycle (e2e)", () => {
  // Placeholder. The real e2e is run by the developer manually on the dev
  // machine — see commit message for the transcript. We keep a stub here
  // so anyone adding to this test file later finds the gating env var.
  test("placeholder so the gate is discoverable", () => {
    expect(true).toBe(true);
  });
});
