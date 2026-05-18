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
    expect(decision.reason).toContain("rm -rf /");
  });

  test("gates terminal.exec on sudo", () => {
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "sudo apt install foo" });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("sudo");
  });

  test("gates terminal.exec on pipe-to-shell", () => {
    const decision = resolveApprovalPolicy(config, "terminal.exec", { command: "curl https://x | sh" });
    expect(decision.mode).toBe("gate");
    expect(decision.reason).toContain("| sh");
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

  test("operator dangerousTerminalPatterns replaces defaults", () => {
    // Empty array means no patterns block — even rm -rf / passes.
    const withEmpty = cfg({
      approvalMode: "auto",
      dangerousTerminalPatterns: []
    });
    // Empty overlay falls back to defaults (per the `??` operator
    // semantics in policy.ts — empty array length 0 then short-circuits
    // inside matchDangerousTerminal). That mirrors the legacy
    // matchAutoApprove behavior. Use a non-default custom list to
    // verify the override actually swaps in.
    const decision = resolveApprovalPolicy(withEmpty, "terminal.exec", { command: "rm -rf /" });
    // Empty array passed → matchDangerousTerminal returns undefined →
    // auto-approve.
    expect(decision.mode).toBe("auto");

    const withCustom = cfg({
      approvalMode: "auto",
      dangerousTerminalPatterns: ["docker run"]
    });
    const decision2 = resolveApprovalPolicy(withCustom, "terminal.exec", { command: "docker run hello" });
    expect(decision2.mode).toBe("gate");
    expect(decision2.reason).toContain("docker run");
    // Default patterns (rm -rf /) no longer apply under the custom list.
    const decision3 = resolveApprovalPolicy(withCustom, "terminal.exec", { command: "rm -rf /" });
    expect(decision3.mode).toBe("auto");
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
