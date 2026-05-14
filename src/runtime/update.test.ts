import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { currentVersionInfo, formatInstallFailure } from "./update";

function scratch(tag: string): string {
  const dir = `/tmp/gini-runtime-update-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

function initRepo(path: string, origin: string): void {
  mkdirSync(path, { recursive: true });
  spawnSync("git", ["-C", path, "init", "--quiet"]);
  spawnSync("git", ["-C", path, "remote", "add", "origin", origin]);
}

describe("runtime update metadata", () => {
  test("repo checkout status does not offer web update for a separate installed runtime", () => {
    const home = scratch("repo-checkout-home");
    const checkout = scratch("repo-checkout");
    initRepo(join(home, ".gini", "runtime"), "https://github.com/Lilac-Labs/gini-agent");
    initRepo(checkout, "https://github.com/Lilac-Labs/gini-agent");

    const info = withHome(home, () => currentVersionInfo(checkout));

    expect(info.installedRuntimePresent).toBe(true);
    expect(info.update.supported).toBe(false);
    expect(info.update.reason).toContain("installer-managed runtime");
  });

  test("installer-managed runtime status offers web update", () => {
    const home = scratch("installed-home");
    const runtimeDir = join(home, ".gini", "runtime");
    initRepo(runtimeDir, "https://github.com/Lilac-Labs/gini-agent");

    const info = withHome(home, () => currentVersionInfo(runtimeDir));

    expect(info.installedRuntimePresent).toBe(true);
    expect(info.update.supported).toBe(true);
  });
});

describe("runtime update install failures", () => {
  test("includes captured bun install output in quiet mode", () => {
    const message = formatInstallFailure("bun install", 1, "stdout line", Buffer.from("stderr line"));

    expect(message).toContain("gini update: bun install failed (exit 1).");
    expect(message).toContain("----- bun install output -----");
    expect(message).toContain("stdout line");
    expect(message).toContain("stderr line");
  });

  test("keeps install failure concise without captured output", () => {
    const message = formatInstallFailure("bun install in web/", null);

    expect(message).toBe("gini update: bun install in web/ failed (exit null).");
  });
});
