// Covers the `gini tunnel install-cloudflared` subcommand — the local,
// gateway-independent provisioning path scripts/install.sh calls. The other
// tunnel subcommands proxy the running runtime's HTTP API and are exercised by
// integration/smoke rather than unit tests; this file pins the install-binary
// glue (success prints + exit 0, failure sets exit 1). The underlying
// ensureCloudflaredBin() resolution is unit-tested in
// runtime/tunnel/cloudflared-install.test.ts.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
// Snapshot the REAL cloudflared-install export VALUES at module-eval
// time, before any mock rebinds the live namespace. A snapshot taken
// inside the test body via `await import(...)` is too late once a
// sibling test file (this whole suite shares one Bun process) has
// registered its own mock.module for this path. Restoring this snapshot
// in afterEach undoes our overrides so they can't leak into
// runtime/tunnel/cloudflared-install.test.ts (mock.restore() does not
// unregister mock.module factories).
import * as cloudflaredInstall from "../../runtime/tunnel/cloudflared-install";
const realCfInstall = { ...cloudflaredInstall };

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join(process.env.GINI_STATE_ROOT ?? "/tmp", "instances", "tunnel-cli-test");
  const config: RuntimeConfig = {
    instance: "tunnel-cli-test",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(stateRoot, "workspace"),
    stateRoot,
    logRoot: join(stateRoot, "logs")
  };
  return {
    config,
    cliArgs,
    command: cliArgs[0] ?? "",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: cliArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}

class FakeUnavailable extends Error {
  hint = { platform: "macos" as const, command: "curl ... | tar -xz", url: "https://github.com/cloudflare/cloudflared/releases" };
  constructor(message: string) {
    super(message);
    this.name = "CloudflaredUnavailableError";
  }
}

describe("gini tunnel install-cloudflared", () => {
  let prevExit: number | string | null | undefined;
  let scratch: string;
  let prevState: string | undefined;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = 0;
    prevState = process.env.GINI_STATE_ROOT;
    scratch = `/tmp/gini-tunnel-cli/${process.pid}-${Math.random().toString(36).slice(2)}`;
    process.env.GINI_STATE_ROOT = join(scratch, ".gini");
    mkdirSync(process.env.GINI_STATE_ROOT, { recursive: true });
  });

  afterEach(() => {
    process.exitCode = prevExit;
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    rmSync(scratch, { recursive: true, force: true });
    mock.restore();
    // mock.restore() leaves mock.module factories registered, so re-register
    // the pristine cloudflared-install snapshot to undo our overrides before
    // the next test file in this process runs.
    mock.module("../../runtime/tunnel/cloudflared-install", () => ({ ...realCfInstall }));
  });

  test("prints the resolved binary and leaves exit code 0 on success", async () => {
    // ...realCfInstall keeps the full public surface real; we only
    // override the three exports this subcommand drives. The afterEach
    // restore re-registers the pristine snapshot so these overrides can't
    // leak into runtime/tunnel/cloudflared-install.test.ts.
    mock.module("../../runtime/tunnel/cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => "/usr/local/bin/cloudflared",
      manualInstallHint: () => ({ platform: "macos", command: "m", url: "https://github.com/cloudflare/cloudflared/releases" }),
      CloudflaredUnavailableError: FakeUnavailable
    }));
    const { tunnel } = await import("./tunnel");
    await tunnel(makeCtx(["tunnel", "install-cloudflared"]));
    expect(process.exitCode).toBe(0);
  });

  test("sets exit code 1 when provisioning fails", async () => {
    // ...realCfInstall keeps the full public surface real;
    // ensureCloudflaredBin throws the offline failure so the CLI's catch
    // sets exit 1. The afterEach restore re-registers the pristine
    // snapshot so these overrides can't leak into
    // runtime/tunnel/cloudflared-install.test.ts.
    mock.module("../../runtime/tunnel/cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => {
        throw new FakeUnavailable("cloudflared could not be installed automatically (offline).");
      },
      manualInstallHint: () => ({ platform: "macos", command: "m", url: "https://github.com/cloudflare/cloudflared/releases" }),
      CloudflaredUnavailableError: FakeUnavailable
    }));
    const { tunnel } = await import("./tunnel");
    await tunnel(makeCtx(["tunnel", "install-cloudflared"]));
    expect(process.exitCode).toBe(1);
  });
});
