// Branch coverage for the ensure_git_macos preflight in scripts/install.sh.
//
// On a fresh Mac, /usr/bin/git is a stub that pops the "Install Command Line
// Developer Tools" dialog and exits non-zero. Before the preflight, the later
// `git clone` tripped that dialog and the installer aborted while the dialog
// was still open. ensure_git_macos detects the missing tools, triggers the
// install, and tracks the user's choice:
//   - tools present              -> success
//   - helper alive, tools absent -> still deciding / downloading -> keep waiting
//   - helper gone,  tools absent -> Cancel -> abort with a clear error
//
// We source install.sh with GINI_INSTALL_SH_NO_MAIN=1 (so main never runs) and
// call ensure_git_macos directly, with `git`, `xcode-select`, and `pgrep`
// shadowed by stubs on a temp PATH. State is driven by files in the stub dir:
//   - poll counter (bumped by `xcode-select -p`); tools "appear" at READY_AFTER
//   - a `helper_until` ceiling that makes the pgrep stub report the install
//     helper alive until the poll counter passes it (simulating Cancel = helper
//     exits before tools land).
// All sleeps use interval 0 and grace 0 so the suite stays deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/install.sh");

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

let stubDir: string;

// `xcode-select -p` bumps a shared poll counter and reports the tools present
// once it reaches STUB_READY_AFTER. `--install` drops a marker so the test can
// assert the GUI installer was triggered.
const XCODE_SELECT_STUB = `#!/usr/bin/env bash
case "$1" in
  -p)
    n=$(cat "$STUB_DIR/poll" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > "$STUB_DIR/poll"
    if [ "$n" -ge "\${STUB_READY_AFTER:-999999}" ]; then
      echo "/Library/Developer/CommandLineTools"
      exit 0
    fi
    echo "xcode-select: error: unable to get active developer directory" >&2
    exit 2
    ;;
  --install)
    touch "$STUB_DIR/install_called"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const GIT_STUB = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  n=$(cat "$STUB_DIR/poll" 2>/dev/null || echo 0)
  if [ "$n" -ge "\${STUB_READY_AFTER:-999999}" ]; then
    echo "git version 2.50.1 (stub)"
    exit 0
  fi
  echo "xcode-select: note: No developer tools were found, requesting install." >&2
  exit 1
fi
exit 0
`;

// The install-helper stub: "alive" (exit 0) while the poll counter is below
// STUB_HELPER_UNTIL, "gone" (exit 1) afterwards. With HELPER_UNTIL < READY_AFTER
// the helper disappears before the tools land — the Cancel scenario.
const PGREP_STUB = `#!/usr/bin/env bash
n=$(cat "$STUB_DIR/poll" 2>/dev/null || echo 0)
if [ "$n" -lt "\${STUB_HELPER_UNTIL:-0}" ]; then
  echo 12345
  exit 0
fi
exit 1
`;

function writeStub(name: string, body: string): void {
  const path = join(stubDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function runPreflight(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
  installCalled: boolean;
} {
  const res = spawnSync("bash", ["-c", `source "${SCRIPT}"; ensure_git_macos`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      GINI_INSTALL_SH_NO_MAIN: "1",
      STUB_DIR: stubDir,
      GINI_CLT_WAIT_INTERVAL_S: "0",
      GINI_CLT_HELPER_GRACE_S: "0",
      GINI_CLT_WAIT_TIMEOUT_S: "60",
      ...env
    }
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    installCalled: existsSync(join(stubDir, "install_called"))
  };
}

beforeEach(() => {
  stubDir = `/tmp/gini-install-preflight/${tag()}`;
  rmSync(stubDir, { recursive: true, force: true });
  mkdirSync(stubDir, { recursive: true });
  writeStub("xcode-select", XCODE_SELECT_STUB);
  writeStub("git", GIT_STUB);
  writeStub("pgrep", PGREP_STUB);
});

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("install.sh ensure_git_macos preflight", () => {
  test("non-darwin is a no-op: returns 0 without probing the tools", () => {
    const res = runPreflight({ OS: "linux", STUB_READY_AFTER: "999" });
    expect(res.status).toBe(0);
    expect(res.installCalled).toBe(false);
    expect(existsSync(join(stubDir, "poll"))).toBe(false);
  });

  test("fast path: tools already present, no install triggered", () => {
    const res = runPreflight({ OS: "darwin", STUB_READY_AFTER: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Git ready");
    expect(res.installCalled).toBe(false);
  });

  test("recovery: triggers install, waits while helper runs, proceeds once tools land", () => {
    // Helper stays alive through poll 9; tools appear at poll 4. The helper is
    // present the whole time the user is "installing", so no cancel fires.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "4",
      STUB_HELPER_UNTIL: "9"
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Git ready");
    expect(res.stdout).toContain("Xcode Command Line Tools");
    expect(res.installCalled).toBe(true);
  });

  test("cancel: helper exits before tools land -> aborts with a clear message", () => {
    // Helper "alive" only through poll 1, tools would need poll 999: the user
    // dismissed the dialog. With grace 0 the cancel rule fires promptly.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_HELPER_UNTIL: "1"
    });
    expect(res.status).toBe(1);
    expect(res.installCalled).toBe(true);
    expect(res.stderr).toContain("cancelled");
  });

  test("timeout: helper stays alive but tools never land -> aborts after timeout", () => {
    // Helper never exits (download wedged); tools never appear. The timeout
    // backstop fires rather than the cancel rule.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_HELPER_UNTIL: "999",
      GINI_CLT_WAIT_TIMEOUT_S: "0"
    });
    expect(res.status).toBe(1);
    expect(res.installCalled).toBe(true);
    expect(res.stderr).toContain("still not installed");
  });
});
