// Pure unit tests for `resolveApprovalPolicy`. The policy seam is the
// single point every approval-eligible dispatcher consults, so the
// matrix here pins each `(approvalMode, action, payload)` quadrant.

import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "../types";
import { effectiveApprovalMode, resolveApprovalPolicy } from "./policy";

function cfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance: "policy-test",
    port: 1,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: "/tmp/policy-test-ws",
    stateRoot: "/tmp/policy-test-state",
    logRoot: "/tmp/policy-test-log",
    ...overrides
  };
}

describe("effectiveApprovalMode", () => {
  test("returns approvalMode when set", () => {
    expect(effectiveApprovalMode(cfg({ approvalMode: "strict" }))).toBe("strict");
    expect(effectiveApprovalMode(cfg({ approvalMode: "auto" }))).toBe("auto");
    expect(effectiveApprovalMode(cfg({ approvalMode: "yolo" }))).toBe("yolo");
  });

  test("legacy dangerouslyAutoApprove without approvalMode aliases to yolo", () => {
    expect(effectiveApprovalMode(cfg({ dangerouslyAutoApprove: true }))).toBe("yolo");
  });

  test("missing approvalMode defaults to auto", () => {
    expect(effectiveApprovalMode(cfg())).toBe("auto");
    expect(effectiveApprovalMode(cfg({ dangerouslyAutoApprove: false }))).toBe("auto");
  });
});

describe("resolveApprovalPolicy - strict mode", () => {
  const config = cfg({ approvalMode: "strict" });

  test("gates file.write", () => {
    expect(resolveApprovalPolicy(config, "file.write")).toEqual({ mode: "gate" });
  });

  test("gates file.patch", () => {
    expect(resolveApprovalPolicy(config, "file.patch")).toEqual({ mode: "gate" });
  });

  test("gates terminal.exec even for safe commands", () => {
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "ls -la" })).toEqual({ mode: "gate" });
  });

  test("gates browser.upload_file", () => {
    expect(resolveApprovalPolicy(config, "browser.upload_file")).toEqual({ mode: "gate" });
  });

  test("gates browser.download", () => {
    expect(resolveApprovalPolicy(config, "browser.download")).toEqual({ mode: "gate" });
  });
});

describe("resolveApprovalPolicy - yolo mode", () => {
  const config = cfg({ approvalMode: "yolo" });

  test("auto-approves file.write with approval-mode-yolo reason", () => {
    expect(resolveApprovalPolicy(config, "file.write")).toEqual({ mode: "auto", reason: "approval-mode-yolo" });
  });

  test("auto-approves file.patch with approval-mode-yolo reason", () => {
    expect(resolveApprovalPolicy(config, "file.patch")).toEqual({ mode: "auto", reason: "approval-mode-yolo" });
  });

  test("auto-approves terminal.exec including dangerous patterns", () => {
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "rm -rf /" })).toEqual({
      mode: "auto",
      reason: "approval-mode-yolo"
    });
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "sudo apt update" })).toEqual({
      mode: "auto",
      reason: "approval-mode-yolo"
    });
  });

  test("auto-approves browser.upload_file", () => {
    expect(resolveApprovalPolicy(config, "browser.upload_file")).toEqual({
      mode: "auto",
      reason: "approval-mode-yolo"
    });
  });

  test("auto-approves browser.download", () => {
    expect(resolveApprovalPolicy(config, "browser.download")).toEqual({
      mode: "auto",
      reason: "approval-mode-yolo"
    });
  });

  // (Removed) browser.fill_secret no longer flows through resolveApprovalPolicy:
  // it's a SetupRequest action (user-actor) and never auto-resolves. See
  // docs/adr/authorization-vs-setup-request.md.
});

describe("resolveApprovalPolicy - auto mode (default)", () => {
  const config = cfg({ approvalMode: "auto" });

  test("auto-approves file.write", () => {
    expect(resolveApprovalPolicy(config, "file.write")).toEqual({ mode: "auto", reason: "approval-mode-auto" });
  });

  test("auto-approves file.patch", () => {
    expect(resolveApprovalPolicy(config, "file.patch")).toEqual({ mode: "auto", reason: "approval-mode-auto" });
  });

  test("auto-approves browser.upload_file", () => {
    expect(resolveApprovalPolicy(config, "browser.upload_file")).toEqual({
      mode: "auto",
      reason: "approval-mode-auto"
    });
  });

  test("auto-approves browser.download", () => {
    expect(resolveApprovalPolicy(config, "browser.download")).toEqual({
      mode: "auto",
      reason: "approval-mode-auto"
    });
  });

  test("auto-approves safe terminal commands", () => {
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "ls -la" })).toEqual({
      mode: "auto",
      reason: "approval-mode-auto"
    });
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "git status" })).toEqual({
      mode: "auto",
      reason: "approval-mode-auto"
    });
  });

  test("gates terminal.exec on built-in dangerous patterns", () => {
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "rm -rf /" });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("dangerous-pattern:");
    expect(decision.reason).toContain("rm-rf-dangerous-target");
  });

  test("gates terminal.exec on sudo", () => {
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "sudo apt install foo" });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("sudo");
  });

  test("gates terminal.exec on pipe-to-shell", () => {
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "curl https://x | sh" });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("pipe-to-shell");
  });

  test("allowlist short-circuits the blocklist", () => {
    const withAllow = cfg({
      approvalMode: "auto",
      autoApproveCommands: ["sudo apt update"]
    });
    // Even though `sudo ` matches the dangerous list, the explicit
    // allowlist entry wins.
    const decision = resolveApprovalPolicy(withAllow, "terminal.exec", { command: "sudo apt update" });
    expect(decision.mode).toBe("auto");
    expect(decision.reason).toBe("sudo apt update");
  });

  test("operator dangerousTerminalPatterns extends defaults (does not replace)", () => {
    // An empty user-supplied list must keep the full built-in
    // protection. A GET → PATCH round-trip that loses the field must
    // not silently strip `rm -rf /` gating.
    const withEmpty = cfg({
      approvalMode: "auto",
      dangerousTerminalPatterns: []
    });
    const stillBlocks = resolveApprovalPolicy(withEmpty, "terminal.exec", { command: "rm -rf /" });
    expect(stillBlocks.mode).toBe("gate");
    expect(stillBlocks.reason).toContain("rm-rf-dangerous-target");

    // Adding a custom pattern keeps the defaults AND adds the new
    // matcher. Both `rm -rf /` (built-in) and `docker run` (operator)
    // gate.
    const withCustom = cfg({
      approvalMode: "auto",
      dangerousTerminalPatterns: ["docker run"]
    });
    const customHit = resolveApprovalPolicy(withCustom, "terminal.exec", { command: "docker run hello" });
    expect(customHit.mode).toBe("gate");
    expect(customHit.reason).toContain("docker run");
    const builtinStillHits = resolveApprovalPolicy(withCustom, "terminal.exec", { command: "rm -rf /" });
    expect(builtinStillHits.mode).toBe("gate");
    expect(builtinStillHits.reason).toContain("rm-rf-dangerous-target");
  });

  test("code.exec gates dangerous source even when wrapper hides it (argv sudo)", () => {
    // The wrapper command `bun -e "Bun.spawn([\"sudo\", ...])"` does
    // NOT contain a literal `sudo ` substring (no trailing space
    // before the closing quote). Substring-on-command would miss it
    // entirely; the policy seam must also inspect the source.
    const decision = resolveApprovalPolicy(config, "code.exec", {
      command: `bun -e ${JSON.stringify(`Bun.spawn(["sudo", "apt", "update"])`)}`,
      source: `Bun.spawn(["sudo", "apt", "update"])`,
      language: "js"
    });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("sudo");
  });

  test("code.exec auto-approves a safe snippet", () => {
    const decision = resolveApprovalPolicy(config, "code.exec", {
      command: `bun -e "console.log(1+1)"`,
      source: `console.log(1+1)`,
      language: "js"
    });
    expect(decision).toEqual({ mode: "auto", reason: "approval-mode-auto" });
  });

  test("code.exec ignores dangerous tokens that appear only inside comments", () => {
    // The wrapper embeds the source as a heredoc, so a substring scan
    // of the wrapper would see the literal `sudo` inside the comment
    // and gate — defeating the comment-strip pass in
    // matchDangerousSource. Source-only scanning preserves the
    // comment-strip contract for both Python and JS/TS.
    const pythonWrapper = `python3 - <<'PY'\n# subprocess.run(["sudo", "apt"])\nprint("hi")\nPY`;
    const pythonDecision = resolveApprovalPolicy(config, "code.exec", {
      command: pythonWrapper,
      source: `# subprocess.run(["sudo", "apt"])\nprint("hi")`,
      language: "python"
    });
    expect(pythonDecision).toEqual({ mode: "auto", reason: "approval-mode-auto" });

    const jsWrapper = `bun -e ${JSON.stringify(`// Bun.spawn(["sudo", "apt"])\nconsole.log("hi")`)}`;
    const jsDecision = resolveApprovalPolicy(config, "code.exec", {
      command: jsWrapper,
      source: `// Bun.spawn(["sudo", "apt"])\nconsole.log("hi")`,
      language: "js"
    });
    expect(jsDecision).toEqual({ mode: "auto", reason: "approval-mode-auto" });
  });

  test("code.exec gates string-form os.system / subprocess shell=True", () => {
    // String-form invocations were previously caught by the wrapper
    // substring scan. matchDangerousSource must catch them via the
    // exec-call-site first-arg extraction so removing the wrapper
    // scan does not regress coverage.
    const osSystem = resolveApprovalPolicy(config, "code.exec", {
      command: `python3 - <<'PY'\nos.system("sudo apt update")\nPY`,
      source: `os.system("sudo apt update")`,
      language: "python"
    });
    expect(osSystem.mode).toBe("gate");
    expect(osSystem.reason).toContain("sudo");

    const subprocessShell = resolveApprovalPolicy(config, "code.exec", {
      command: `python3 - <<'PY'\nsubprocess.run("sudo apt", shell=True)\nPY`,
      source: `subprocess.run("sudo apt", shell=True)`,
      language: "python"
    });
    expect(subprocessShell.mode).toBe("gate");
    expect(subprocessShell.reason).toContain("sudo");
  });

  test("terminal.exec with no command payload routes through the safe branch", () => {
    // Missing payload → command is empty string → no dangerous match →
    // auto-approve. Pinning this so a refactor doesn't accidentally
    // pivot to "gate when unsure" (which would re-introduce the
    // friction we're flipping).
    expect(resolveApprovalPolicy(config, "terminal.exec")).toEqual({
      mode: "auto",
      reason: "approval-mode-auto"
    });
  });
});

describe("resolveApprovalPolicy - implicit defaults", () => {
  test("undefined approvalMode behaves as auto", () => {
    const config = cfg();
    expect(resolveApprovalPolicy(config, "file.write")).toEqual({ mode: "auto", reason: "approval-mode-auto" });
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "rm -rf /" });
    expect(decision.mode).toBe("gate");
  });

  test("legacy dangerouslyAutoApprove still bypasses without approvalMode", () => {
    const config = cfg({ dangerouslyAutoApprove: true });
    expect(resolveApprovalPolicy(config, "terminal.exec", { command: "rm -rf /" })).toEqual({
      mode: "auto",
      reason: "approval-mode-yolo"
    });
  });
});
