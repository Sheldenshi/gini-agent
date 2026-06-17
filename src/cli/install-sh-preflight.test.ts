// Branch coverage for the ensure_git_macos preflight in scripts/install.sh.
//
// On a fresh Mac, /usr/bin/git is a stub that pops the "Install Command Line
// Developer Tools" dialog and exits non-zero. Before the preflight, the later
// `git clone` tripped that dialog and the installer aborted while the dialog
// was still open. ensure_git_macos detects the missing tools, triggers the
// install, and tracks the user's choice:
//   - tools present (incl. a working non-Apple git) -> success
//   - helper alive, tools absent                    -> deciding / downloading -> wait
//   - helper seen then gone, tools absent           -> Cancel -> abort
//
// We source install.sh with GINI_INSTALL_SH_NO_MAIN=1 (so main never runs) and
// call ensure_git_macos directly, with `git`, `xcode-select`, `pgrep`, and
// `command` resolution driven by stubs on a temp PATH. State is driven by files
// in the stub dir:
//   - poll counter (bumped by `xcode-select -p`); tools "appear" at READY_AFTER
//   - a separate pgrep call counter; the helper stub reports "alive" for the
//     first STUB_HELPER_UNTIL pgrep calls then "gone" (so the helper is "seen
//     then gone" -> the Cancel scenario), independent of the poll counter.
//
// The child env is built explicitly (not inherited from process.env): a stray
// BASH_ENV or exported override on the developer's machine would otherwise be
// sourced by `bash -c` and could shadow the stubs or override the test's own
// settings, making the suite non-hermetic.

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

// git --version succeeds once the poll counter reaches STUB_READY_AFTER (CLT
// landed). STUB_GIT_ALWAYS_OK forces it to succeed regardless — combined with a
// huge STUB_READY_AFTER (xcode-select -p never succeeds) this presents a working
// non-Apple git (the stub resolves under stubDir, not /usr/bin/git) so the
// preflight's "working non-Apple git" branch can be exercised.
const GIT_STUB = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  if [ -n "\${STUB_GIT_ALWAYS_OK:-}" ]; then
    echo "git version 2.50.1 (stub)"
    exit 0
  fi
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

// The install-helper stub uses its OWN call counter (independent of the
// xcode-select poll counter) so helper lifetime is deterministic regardless of
// how many times clt_tools_present probes. It reports the helper "alive" (exit 0)
// for the first STUB_HELPER_UNTIL pgrep calls, then "gone" (exit 1). With a
// non-zero HELPER_UNTIL the helper is seen then disappears -> the Cancel scenario;
// with HELPER_UNTIL 0 the helper is never alive -> the never-spawned scenario.
const PGREP_STUB = `#!/usr/bin/env bash
c=$(cat "$STUB_DIR/pgrep_calls" 2>/dev/null || echo 0)
c=$((c + 1))
printf '%s' "$c" > "$STUB_DIR/pgrep_calls"
if [ "$c" -le "\${STUB_HELPER_UNTIL:-0}" ]; then
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
  // Explicit, hermetic child env. We do NOT spread process.env: a developer's
  // BASH_ENV (sourced by non-interactive `bash -c`) or exported overrides could
  // otherwise perturb the stubs or the test's own settings. PATH puts stubDir
  // first so git/xcode-select/pgrep resolve to the stubs, then the standard
  // system dirs so bash/cat/awk/uname/sleep/printf still resolve.
  const res = spawnSync("bash", ["-c", `source "${SCRIPT}"; ensure_git_macos`], {
    encoding: "utf8",
    env: {
      PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: stubDir,
      GINI_INSTALL_SH_NO_MAIN: "1",
      STUB_DIR: stubDir,
      GINI_CLT_WAIT_INTERVAL_S: "0",
      GINI_CLT_WAIT_TIMEOUT_S: "60",
      GINI_CLT_HELPER_APPEAR_S: "60",
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

  test("fast path: CLT active (xcode-select -p ok), no install triggered", () => {
    const res = runPreflight({ OS: "darwin", STUB_READY_AFTER: "1" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Git ready");
    expect(res.installCalled).toBe(false);
  });

  test("working non-Apple git with no active developer dir: accepted, no install", () => {
    // xcode-select -p never succeeds (READY_AFTER huge), but a git resolving to
    // the stubDir (not /usr/bin/git) runs fine — the preflight must accept it
    // and NOT force a CLT install (regression guard for Homebrew/Nix/conda git).
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_GIT_ALWAYS_OK: "1"
    });
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

  test("cancel: helper seen then exits before tools land -> aborts with a clear message", () => {
    // Helper alive on the first pgrep call (so saw_helper is set), gone after;
    // tools never land (READY_AFTER 999). That's a mid-flight dismissal.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_HELPER_UNTIL: "1"
    });
    expect(res.status).toBe(1);
    expect(res.installCalled).toBe(true);
    expect(res.stderr).toContain("cancelled");
  });

  test("helper never appears: aborts fast with 'no dialog appeared', not a false cancel", () => {
    // Helper is never alive (HELPER_UNTIL 0) and tools never land. saw_helper
    // stays 0, so the cancel rule must NOT fire; with the appear window reached
    // (APPEAR 0) before the timeout, it reports "No Command Line Tools installer
    // dialog appeared" instead of hanging until the timeout.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_HELPER_UNTIL: "0",
      GINI_CLT_HELPER_APPEAR_S: "0",
      GINI_CLT_WAIT_TIMEOUT_S: "9999"
    });
    expect(res.status).toBe(1);
    expect(res.installCalled).toBe(true);
    expect(res.stderr).toContain("No Command Line Tools installer dialog appeared");
    expect(res.stderr).not.toContain("cancelled");
  });

  test("timeout precedes the appear window when both are due: reports 'still not installed'", () => {
    // Helper never appears, but the timeout is also reached first (both 0; the
    // timeout check is evaluated before the appear branch). The backstop wins.
    const res = runPreflight({
      OS: "darwin",
      STUB_READY_AFTER: "999",
      STUB_HELPER_UNTIL: "0",
      GINI_CLT_HELPER_APPEAR_S: "0",
      GINI_CLT_WAIT_TIMEOUT_S: "0"
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("still not installed");
    expect(res.stderr).not.toContain("cancelled");
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
