import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTunnelState } from "./runtime";

// runtimeTunnelState reads the tunnel slot out of config.json on demand.
// The previous implementation required the runtime to inject
// GINI_TUNNEL_SECRET into the spawned web process at start time, which
// dropped the secret in two failure modes:
//
//   1. First-boot race: the gateway minted the secret AFTER `gini start`
//      had already spawned the web with an empty env.
//   2. Autostart: the launchd web plist did not propagate runtime env
//      variables at all, so the supervised web never saw the secret.
//
// Reading from config.json on each request (with the helper's mtime
// cache for cheap repeated reads) keeps the proxy in lockstep with the
// gateway's source of truth.

const ROOT = join(tmpdir(), "gini-runtime-tunnel-state-test");

function withConfig(tunnel: unknown): void {
  const instanceDir = join(ROOT, "instances", "tunnel-state-test");
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    join(instanceDir, "config.json"),
    JSON.stringify({ instance: "tunnel-state-test", tunnel }, null, 2)
  );
}

function previousEnv(): { instance?: string; root?: string } {
  return {
    instance: process.env.GINI_INSTANCE,
    root: process.env.GINI_STATE_ROOT
  };
}

let snapshot: ReturnType<typeof previousEnv>;

describe("runtimeTunnelState", () => {
  beforeEach(() => {
    snapshot = previousEnv();
    rmSync(ROOT, { recursive: true, force: true });
    process.env.GINI_INSTANCE = "tunnel-state-test";
    process.env.GINI_STATE_ROOT = ROOT;
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    // Restore env so a later test that depends on the original values
    // doesn't see this suite's overrides. Without restoration the
    // process-wide env mutation would leak across tests run in the
    // same Bun process.
    if (snapshot.instance === undefined) delete process.env.GINI_INSTANCE;
    else process.env.GINI_INSTANCE = snapshot.instance;
    if (snapshot.root === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = snapshot.root;
  });

  test("returns disabled + empty when config.json is missing", () => {
    const state = runtimeTunnelState();
    expect(state).toEqual({ enabled: false, secret: "" });
  });

  test("returns disabled when the tunnel slot is absent", () => {
    withConfig(undefined);
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });

  test("returns enabled+secret for a fully-configured tunnel", () => {
    withConfig({ enabled: true, secret: "abcdefghij0123456789" });
    expect(runtimeTunnelState()).toEqual({
      enabled: true,
      secret: "abcdefghij0123456789"
    });
  });

  test("treats enabled !== true as disabled", () => {
    withConfig({ enabled: "yes", secret: "abcdefghij0123456789" });
    const state = runtimeTunnelState();
    expect(state.enabled).toBe(false);
    expect(state.secret).toBe("abcdefghij0123456789");
  });

  test("ignores non-string secrets", () => {
    withConfig({ enabled: true, secret: 12345 });
    expect(runtimeTunnelState()).toEqual({ enabled: true, secret: "" });
  });

  test("returns disabled when config.json is invalid JSON", () => {
    const instanceDir = join(ROOT, "instances", "tunnel-state-test");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "config.json"), "{ not valid");
    expect(runtimeTunnelState()).toEqual({ enabled: false, secret: "" });
  });
});
