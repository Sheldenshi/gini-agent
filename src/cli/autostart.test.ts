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

  test("prefers the installed wrapper when both wrapper and runtime/package.json exist", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".local", "bin", "gini"),
      "#!/usr/bin/env bash\n# gini-agent-installer-managed\nexec bun run gini \"$@\"\n"
    );
    mkdirSync(join(home, ".gini", "runtime"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun"
    });

    expect(spec.programArguments[0]).toBe(join(home, ".local", "bin", "gini"));
    expect(spec.programArguments).toContain("--instance");
    expect(spec.programArguments).toContain("main");
    expect(spec.programArguments).toContain("run");
    // --no-web: web is launched by the user/CLI, not by the agent. Auto-
    // starting Next.js inside launchd would conflict with the dev-loop
    // workflow (a user running `gini start --web` interactively).
    expect(spec.programArguments).toContain("--no-web");
    expect(spec.workingDirectory).toBe(join(home, ".gini", "runtime"));
    expect(spec.environment.GINI_INSTANCE).toBe("main");
    expect(spec.environment.PATH).toContain("/Users/test/.bun/bin");
    expect(spec.environment.PATH).toContain(join(home, ".local", "bin"));
    expect(spec.environment.HOME).toBe(home);
  });

  test("falls back to bun run when no installer-managed wrapper is present", () => {
    // No wrapper at all → source-flow.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini"
    });

    expect(spec.programArguments[0]).toBe("/opt/bun/bin/bun");
    expect(spec.programArguments).toContain("run");
    expect(spec.programArguments).toContain("gini");
    expect(spec.programArguments).toContain("--instance");
    expect(spec.programArguments).toContain("dev");
    expect(spec.programArguments).toContain("--no-web");
    expect(spec.workingDirectory).toBe("/repo/gini");
    expect(spec.environment.GINI_INSTANCE).toBe("dev");
    expect(spec.environment.PATH).toContain("/opt/bun/bin");
  });

  test("rejects wrappers that aren't installer-managed (no marker comment)", () => {
    // A user might have their own ~/.local/bin/gini for a different agent;
    // we must not exec it from launchd.
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "gini"), "#!/usr/bin/env bash\nexec foo\n");
    mkdirSync(join(home, ".gini", "runtime"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      projectRootOverride: "/repo/gini"
    });

    // Source-flow because the wrapper isn't recognized as ours.
    expect(spec.programArguments[0]).toBe("/Users/test/.bun/bin/bun");
    expect(spec.workingDirectory).toBe("/repo/gini");
  });

  test("rejects wrapper when runtime dir is missing (stale wrapper)", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".local", "bin", "gini"),
      "#!/usr/bin/env bash\n# gini-agent-installer-managed\nexec bun run gini \"$@\"\n"
    );
    // Note: no ~/.gini/runtime/package.json — wrapper would fail at exec.

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      projectRootOverride: "/repo/gini"
    });

    expect(spec.programArguments[0]).toBe("/Users/test/.bun/bin/bun");
    expect(spec.workingDirectory).toBe("/repo/gini");
  });
});

describe("generatePlist", () => {
  const baseSpec = {
    programArguments: ["/Users/test/.local/bin/gini", "run", "--instance", "main", "--no-web"],
    workingDirectory: "/Users/test/.gini/runtime",
    environment: { PATH: "/usr/bin", GINI_INSTANCE: "main", HOME: "/Users/test", LANG: "en_US.UTF-8" }
  };

  test("writes a well-formed plist header and Label", () => {
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

  test("KeepAlive is a dict with SuccessfulExit=false and NetworkState=true", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    // The exact dict shape is load-bearing: changing it to a <true/>
    // bool would make `gini stop` immediately respawn, which defeats the
    // whole "user intent honored" contract.
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<key>SuccessfulExit<\/key>\s*<false\/>[\s\S]*?<key>NetworkState<\/key>\s*<true\/>[\s\S]*?<\/dict>/);
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
