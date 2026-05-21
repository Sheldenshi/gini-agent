// Unit tests for the pure-logic side of src/cli/autostart.ts.
//
// Real `launchctl bootstrap`/`bootout` flows are exercised by the manual
// e2e test the developer runs on the dev machine — those need `gui/<uid>`
// which CI runners (headless) don't have. Pure logic (plist XML, label /
// path derivation, wrapper detection, source-vs-installed flow selection)
// is fully covered here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LABEL_PREFIX,
  generatePlist,
  guiDomain,
  labelFor,
  plistPathFor,
  resolveLaunchSpec,
  serviceTarget
} from "./autostart";

function makeTempHome(tag: string): string {
  const path = `/tmp/gini-autostart-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

describe("labelFor / plistPathFor", () => {
  test("label is namespaced under the gini prefix", () => {
    expect(labelFor("dev")).toBe(`${LABEL_PREFIX}.dev`);
    expect(labelFor("main")).toBe(`${LABEL_PREFIX}.main`);
    expect(labelFor("feature-x")).toBe(`${LABEL_PREFIX}.feature-x`);
  });

  test("plist path lives in ~/Library/LaunchAgents and ends with .plist", () => {
    const path = plistPathFor("dev");
    expect(path).toContain("/Library/LaunchAgents/");
    expect(path.endsWith(`${LABEL_PREFIX}.dev.plist`)).toBe(true);
  });
});

describe("serviceTarget / guiDomain", () => {
  test("service target combines gui/<uid> with the label", () => {
    const target = serviceTarget("dev");
    expect(target.startsWith(guiDomain() + "/")).toBe(true);
    expect(target.endsWith(`/${LABEL_PREFIX}.dev`)).toBe(true);
  });

  test("guiDomain uses the current uid", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(guiDomain()).toBe(`gui/${uid}`);
  });
});

describe("resolveLaunchSpec", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("resolve");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // A neutral cwd that isn't a gini-agent checkout — so resolveLaunchSpec
  // does NOT take the source-flow branch unless we explicitly point it
  // at one. Without this, the test suite running from the repo cwd would
  // always prefer source flow (the cwd-is-source-checkout branch).
  const neutralCwd = "/tmp/gini-autostart-tests-neutral-cwd";

  test("uses ~/.gini/runtime as workingDirectory when a runtime checkout exists and cwd is not a checkout", () => {
    mkdirSync(join(home, ".gini", "runtime", "src"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');
    writeFileSync(join(home, ".gini", "runtime", "src", "server.ts"), "// stub\n");

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      cwdOverride: neutralCwd,
      projectRootOverride: neutralCwd
    });

    // Direct exec of bun against the server entry — no wrapper, no CLI
    // layer. Single-process job so SIGKILL is reliably observed by launchd
    // and KeepAlive.SuccessfulExit:false respawns it.
    expect(spec.programArguments).toEqual([
      "/Users/test/.bun/bin/bun",
      "run",
      "src/server.ts",
      "--instance",
      "main"
    ]);
    expect(spec.workingDirectory).toBe(join(home, ".gini", "runtime"));
    expect(spec.environment.GINI_INSTANCE).toBe("main");
    expect(spec.environment.PATH).toContain("/Users/test/.bun/bin");
    expect(spec.environment.PATH).toContain(join(home, ".local", "bin"));
    expect(spec.environment.HOME).toBe(home);
  });

  test("falls back to repo root when ~/.gini/runtime is not a runtime checkout", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });

    expect(spec.programArguments[0]).toBe("/opt/bun/bin/bun");
    expect(spec.programArguments).toContain("run");
    expect(spec.programArguments).toContain("src/server.ts");
    expect(spec.programArguments).toContain("--instance");
    expect(spec.programArguments).toContain("dev");
    expect(spec.workingDirectory).toBe("/repo/gini");
    expect(spec.environment.GINI_INSTANCE).toBe("dev");
    expect(spec.environment.PATH).toContain("/opt/bun/bin");
  });

  test("falls back to repo root when runtime dir lacks src/server.ts (stale install)", () => {
    // package.json present but no src/server.ts → not a usable checkout.
    mkdirSync(join(home, ".gini", "runtime"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });

    expect(spec.workingDirectory).toBe("/repo/gini");
  });

  test("prefers source flow when cwd is a gini-agent checkout (even if ~/.gini/runtime exists)", () => {
    // Installed runtime is present and usable…
    mkdirSync(join(home, ".gini", "runtime", "src"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');
    writeFileSync(join(home, ".gini", "runtime", "src", "server.ts"), "// stub\n");
    // …but cwd is a source checkout.
    const sourceCwd = join(home, "Dev", "gini-agent");
    mkdirSync(sourceCwd, { recursive: true });
    writeFileSync(join(sourceCwd, "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "feature-x",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/some/other/repo/root",
      cwdOverride: sourceCwd
    });

    // Source flow wins — we use the cwd, not ~/.gini/runtime.
    expect(spec.workingDirectory).toBe(sourceCwd);
  });

  test("propagates testRoot.{stateRoot,logRoot} into plist env when passed (E2E-only)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      testRoot: { stateRoot: "/tmp/scratch-state", logRoot: "/tmp/scratch-logs" }
    });
    expect(spec.environment.GINI_STATE_ROOT).toBe("/tmp/scratch-state");
    expect(spec.environment.GINI_LOG_ROOT).toBe("/tmp/scratch-logs");
  });

  test("does NOT leak shell GINI_STATE_ROOT into plist env when testRoot is unset (production default)", () => {
    const prevState = process.env.GINI_STATE_ROOT;
    const prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = "/tmp/leak-state";
    process.env.GINI_LOG_ROOT = "/tmp/leak-logs";
    try {
      const spec = resolveLaunchSpec({
        instance: "dev",
        homeOverride: home,
        bunPathOverride: "/opt/bun/bin/bun",
        projectRootOverride: "/repo/gini",
        cwdOverride: neutralCwd
      });
      // No testRoot opt-in → no leak. Guards against shell env vars
      // baking into the persistent plist; GINI_STATE_ROOT in the
      // developer's shell must never survive into a LaunchAgent record.
      expect(spec.environment.GINI_STATE_ROOT).toBeUndefined();
      expect(spec.environment.GINI_LOG_ROOT).toBeUndefined();
    } finally {
      if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = prevState;
      if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = prevLog;
    }
  });

  test("merges secrets.env into gateway plist EnvironmentVariables (OPENAI_API_KEY)", () => {
    const secretsBody = [
      "# comment",
      "export OPENAI_API_KEY='sk-test-12345'",
      "BARE_KEY=bare-value",
      "QUOTED=\"with spaces\""
    ].join("\n");
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => secretsBody
    });
    expect(spec.environment.OPENAI_API_KEY).toBe("sk-test-12345");
    expect(spec.environment.BARE_KEY).toBe("bare-value");
    expect(spec.environment.QUOTED).toBe("with spaces");
  });

  test("does not put secrets into env when secrets.env is missing", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => null
    });
    expect(spec.environment.OPENAI_API_KEY).toBeUndefined();
  });

  test("merges login-shell PATH into plist PATH (nvm / asdf / volta visibility)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => "/Users/test/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin",
      mergeShellPath: true
    });
    // bunDir stays at position 0 so the web shim can't be coerced into
    // running a shell-provided bun. nvm bin is inserted right after,
    // ahead of the rest of the base, so it still wins over the system
    // dirs for any node lookup.
    expect(spec.environment.PATH.startsWith(
      "/opt/bun/bin:/Users/test/.nvm/versions/node/v20.0.0/bin:"
    )).toBe(true);
    expect(spec.environment.PATH).toContain(join(home, ".local", "bin"));
  });

  test("falls back to base PATH when the login-shell reader returns null", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => null,
      mergeShellPath: true
    });
    // No nvm dir, no shell-additions. Base launchd PATH still intact.
    expect(spec.environment.PATH).not.toContain(".nvm");
    expect(spec.environment.PATH).toContain("/opt/bun/bin");
  });

  test("does not invoke the login shell when an explicit reader is omitted under test", () => {
    // Sanity: tests that don't opt in to shell-PATH-merge shouldn't pay the
    // spawn cost or pick up developer-shell quirks. We assert by checking
    // the base PATH stays exactly what buildLaunchAgentPath would produce
    // without a reader.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });
    // No nvm path should appear unless we explicitly asked for it.
    expect(spec.environment.PATH).not.toContain(".nvm");
  });

  test("does not invoke the login shell when mergeShellPath is false (status / disable / kick paths)", () => {
    // resolveLaunchSpecPair is called by read-only paths (status,
    // disable, kick) as well as enable. Read-only callers must not
    // spawn the user's interactive shell; the gate keeps them silent.
    // A counting reader proves it was never invoked.
    let calls = 0;
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => {
        calls += 1;
        return "/Users/test/.nvm/bin";
      },
      mergeShellPath: false
    });
    expect(calls).toBe(0);
    expect(spec.environment.PATH).not.toContain(".nvm");
  });

  test("bakes SHELL into the gateway plist so refresh respawns can re-read it", () => {
    // The autostart-refresh flow runs `gini autostart enable --kind
    // gateway` as a launchd-spawned child of the gateway. Without
    // SHELL in the plist's EnvironmentVariables, the child's
    // process.env.SHELL is unset and the regenerated plist drops the
    // nvm/asdf merge from first enable. Pin SHELL so refresh keeps
    // the user's interactive PATH discoverable across respawns.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => "/Users/test/.nvm/bin",
      mergeShellPath: true
    });
    expect(spec.environment.SHELL).toBe("/bin/zsh");
  });

  test("omits SHELL from the plist when neither loginShell nor process.env.SHELL is set", () => {
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const spec = resolveLaunchSpec({
        instance: "dev",
        homeOverride: home,
        bunPathOverride: "/opt/bun/bin/bun",
        projectRootOverride: "/repo/gini",
        cwdOverride: neutralCwd
      });
      expect(spec.environment.SHELL).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SHELL = prev;
    }
  });

  test("omits SHELL from the plist when the configured shell does not exist on disk", () => {
    // A stale or garbage $SHELL must not survive into the LaunchAgent's
    // EnvironmentVariables — children of the gateway would inherit it
    // and break in surprising ways. Gate on file existence.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/no/such/shell/at/this/path",
      // fileExists is the resolveLaunchSpec test seam; treat the bogus
      // path (and only that path) as absent. The real bun + plist
      // files still need to look present so other branches don't error.
      fileExists: (p: string) => p !== "/no/such/shell/at/this/path"
    });
    expect(spec.environment.SHELL).toBeUndefined();
  });

  test("keeps bunDir at the head of PATH when the shell merge adds entries (no bun shadowing)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      // Shell PATH puts a different bun ahead of nvm. The merged PATH
      // must still resolve `bun` to /opt/bun/bin first.
      loginShellReader: () =>
        "/Users/test/.brew/bin:/Users/test/.nvm/versions/node/v20.0.0/bin",
      mergeShellPath: true
    });
    expect(spec.environment.PATH.startsWith("/opt/bun/bin:")).toBe(true);
    // Shell additions land right after bunDir, ahead of the rest of the base.
    expect(spec.environment.PATH).toContain("/opt/bun/bin:/Users/test/.brew/bin:");
  });

  test("web shim execs the absolute bun path so gateway + web share a Bun", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });
    // sh -c <shim> — the shim's last line execs the resolved bun, not
    // bare `bun`. Without this, a shell-provided bun in the plist PATH
    // could drive the web dev server while the gateway runs under a
    // different Bun.
    const shim = pair.web.programArguments[pair.web.programArguments.length - 1] ?? "";
    expect(shim).toContain(`exec "/opt/bun/bin/bun" run dev`);
    expect(shim).not.toMatch(/exec bun run dev$/m);
  });

  test("buildWebShim rejects bunPath with shell-special characters", async () => {
    const { __testing } = await import("./autostart");
    expect(() => __testing.buildWebShim("dev", "/opt/bun;rm -rf /")).toThrow();
    expect(() => __testing.buildWebShim("dev", "/opt/bun bin/bun")).toThrow();
    expect(() => __testing.buildWebShim("dev", "/opt/bun/bin/bun")).not.toThrow();
  });

  // The Next.js BFF only proxies to the gateway over /api/*; it never
  // invokes a provider directly. Provider secrets in the web plist's
  // EnvironmentVariables would widen the secret-exposure surface for zero gain,
  // so they belong in the gateway plist only.
  test("does NOT merge secrets.env into web plist EnvironmentVariables", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const secretsBody = [
      "export OPENAI_API_KEY='sk-test-web-isolation'",
      "BARE_KEY=bare-value"
    ].join("\n");
    const pair = resolveLaunchSpecPair({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => secretsBody
    });
    // Gateway gets the secrets.
    expect(pair.gateway.environment.OPENAI_API_KEY).toBe("sk-test-web-isolation");
    expect(pair.gateway.environment.BARE_KEY).toBe("bare-value");
    // Web must not.
    expect(pair.web.environment.OPENAI_API_KEY).toBeUndefined();
    expect(pair.web.environment.BARE_KEY).toBeUndefined();
  });

});

describe("resolveLaunchSpecPair", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("pair");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("web spec is a sh -c shim that gates on /api/status before exec'ing bun run dev", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.programArguments[0]).toBe("/bin/sh");
    expect(pair.web.programArguments[1]).toBe("-c");
    const shim = pair.web.programArguments[2]!;
    expect(shim).toContain("/api/status");
    // Shim execs the resolved absolute bunPath (not bare `bun`) so a
    // shell-provided bun on the launchd PATH can't run a different
    // binary than the gateway.
    expect(shim).toContain(`exec "/opt/bun/bin/bun" run dev`);
    // Polls the gateway port file under the state root.
    expect(shim).toContain("instances/main/runtime.port");
  });

  test("gateway and web share the same workingDirectory", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral"
    });
    expect(pair.gateway.workingDirectory).toBe(pair.web.workingDirectory);
  });

  test("rejects suspicious instance names that could break out of the shell shim", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    expect(() => resolveLaunchSpecPair({
      instance: "bad`name",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral"
    })).toThrow(/refusing to embed instance name/);
  });

  // MEDIUM-C: per-instance Next.js dist dir. Two autostarted instances
  // from the same checkout (e.g. `dev` and `main`) both `bun run dev`
  // from web/, which writes build artifacts to `.next/` by default.
  // Without GINI_DIST_DIR=.next-<instance> in the plist env, they race
  // each other's compile caches. `gini start` already sets this in
  // src/cli/process.ts; the autostart plist MUST mirror it.
  test("web env includes GINI_DIST_DIR=.next-<instance> to avoid Next.js dist-dir races", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.environment.GINI_DIST_DIR).toBe(".next-main");
  });

  test("web env GINI_DIST_DIR sanitizes unsafe characters in the instance name", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    // Names like `feat.x` get punctuation other than [A-Za-z0-9_-]
    // replaced with `_` because Next.js rejects non-relative paths.
    // Match what process.ts does so behavior is consistent between
    // `gini start` and autostart.
    const pair = resolveLaunchSpecPair({
      instance: "feat.x",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.environment.GINI_DIST_DIR).toBe(".next-feat_x");
  });
});

describe("parseSecretsEnv", () => {
  test("parses a mix of export/bare/quoted/comment lines", async () => {
    const { parseSecretsEnv } = await import("./autostart");
    const out = parseSecretsEnv([
      "# header",
      "",
      "export OPENAI_API_KEY='sk-abc'",
      "BARE=bare-value",
      "  WITH_WHITESPACE='quoted with spaces'",
      "QUOTED=\"dq with \\\"escape\\\"\""
    ].join("\n"));
    expect(out.OPENAI_API_KEY).toBe("sk-abc");
    expect(out.BARE).toBe("bare-value");
    expect(out.WITH_WHITESPACE).toBe("quoted with spaces");
    expect(out.QUOTED).toBe('dq with "escape"');
  });

  test("handles single-quote escape sequence (sh ANSI-C quoting)", async () => {
    const { parseSecretsEnv } = await import("./autostart");
    // shellSingleQuote in setup.ts writes `'\''` to escape an embedded single
    // quote inside a single-quoted string. Our parser inverts that.
    const out = parseSecretsEnv(`export TRICKY='val'\\''with'`);
    expect(out.TRICKY).toBe("val'with");
  });
});

describe("generatePlist", () => {
  const baseSpec = {
    programArguments: ["/Users/test/.local/bin/gini", "run", "--instance", "main", "--no-web"],
    workingDirectory: "/Users/test/.gini/runtime",
    environment: { PATH: "/usr/bin", GINI_INSTANCE: "main", HOME: "/Users/test", LANG: "en_US.UTF-8" }
  };

  test("writes a well-formed plist header and Label (legacy single-plist label by default)", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist PUBLIC");
    expect(xml).toContain(`<string>${LABEL_PREFIX}.main</string>`);
  });

  test("kind:gateway and kind:web produce kind-suffixed labels", () => {
    const gateway = generatePlist({
      instance: "main",
      kind: "gateway",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    const web = generatePlist({
      instance: "main",
      kind: "web",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(gateway).toContain(`<string>${LABEL_PREFIX}.main.gateway</string>`);
    expect(web).toContain(`<string>${LABEL_PREFIX}.main.web</string>`);
  });

  test("KeepAlive is a dict with SuccessfulExit=false", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    // The exact dict shape is load-bearing: changing it to a <true/>
    // bool would make `gini stop` immediately respawn, which defeats the
    // whole "user intent honored" contract.
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<key>SuccessfulExit<\/key>\s*<false\/>[\s\S]*?<\/dict>/);
    // NetworkState was deliberately omitted — see the comment in
    // generatePlist for why (pended-spawn semaphore prevents respawn).
    expect(xml).not.toContain("<key>NetworkState</key>");
  });

  test("ThrottleInterval defaults to 10 and is overridable", () => {
    const def = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(def).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    const custom = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
      throttleIntervalSeconds: 30
    });
    expect(custom).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  test("RunAtLoad is true (start at login)", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("ProgramArguments are emitted in order", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    // Each arg as its own <string>, in order, preserving --instance value.
    const argSection = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(argSection).toBeTruthy();
    const args = (argSection?.[1] ?? "").match(/<string>([^<]*)<\/string>/g) ?? [];
    expect(args.map((s) => s.replace(/<\/?string>/g, ""))).toEqual([
      "/Users/test/.local/bin/gini",
      "run",
      "--instance",
      "main",
      "--no-web"
    ]);
  });

  test("EnvironmentVariables include PATH, HOME, GINI_INSTANCE", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    const envSection = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    expect(envSection).toBeTruthy();
    const block = envSection?.[1] ?? "";
    expect(block).toContain("<key>PATH</key>");
    expect(block).toContain("<key>HOME</key>");
    expect(block).toContain("<key>GINI_INSTANCE</key>");
  });

  test("StdoutPath and StderrPath are recorded verbatim", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/var/log/gini/main-out.log",
      stderrPath: "/var/log/gini/main-err.log"
    });
    expect(xml).toContain("<string>/var/log/gini/main-out.log</string>");
    expect(xml).toContain("<string>/var/log/gini/main-err.log</string>");
  });

  test("escapes XML special characters in arguments and paths", () => {
    const spec = {
      programArguments: ["/path/with <bad>&chars\"'.exe", "run"],
      workingDirectory: "/some/dir & such",
      environment: { TRICKY: '<"&>\'' }
    };
    const xml = generatePlist({
      instance: "weird-instance",
      spec,
      stdoutPath: "/tmp/<out>.log",
      stderrPath: "/tmp/&err.log"
    });
    // No raw `<` other than legitimate tags. Easiest check: special chars
    // appear in their escaped form.
    expect(xml).toContain("&lt;bad&gt;");
    expect(xml).toContain("&amp;chars");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&apos;");
    expect(xml).toContain("&amp; such");
    expect(xml).toContain("&lt;out&gt;");
  });
});
