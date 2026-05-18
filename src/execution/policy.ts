// Central approval-policy seam.
//
// Every approval-eligible tool call (file.write, file.patch,
// terminal.exec, code_exec via terminal.exec, browser.upload_file) goes
// through `resolveApprovalPolicy` before deciding whether to gate or
// auto-approve. Keeping the decision in one module is the load-bearing
// invariant — duplicating the policy across dispatchers / agent paths
// would silently drift "auto" / "yolo" / "strict" semantics over time.
//
// See ADR approval-mode.md for the user-facing contract.
//
// Allowlist precedence: `RuntimeConfig.autoApproveCommands` is always
// consulted first for `terminal.exec`. A match short-circuits the
// dangerous-pattern blocklist — an explicit operator allow beats the
// heuristic block. This mirrors the legacy fast path the dispatcher
// already runs before calling this function, and is documented here so
// future tools that introduce their own allowlists follow the same
// rule.

import type { ApprovalMode, RuntimeConfig } from "../types";
import {
  DEFAULT_DANGEROUS_TERMINAL_PATTERNS,
  matchAutoApprove,
  matchDangerousTerminal
} from "./auto-approve";

// Actions the policy seam knows about. These map 1:1 onto the
// approval-eligible tool surface in `tool-dispatch.ts`:
//   - file.write       → file_write
//   - file.patch       → file_patch
//   - terminal.exec    → terminal_exec AND code_exec (code_exec routes
//                        through terminal.exec internally)
//   - browser.upload   → browser_upload_file
// Use the same action label `createApproval` will eventually persist so
// callers don't translate names twice.
export type PolicyAction =
  | "file.write"
  | "file.patch"
  | "terminal.exec"
  | "browser.upload_file";

export interface TerminalExecPayload {
  command: string;
}

export type PolicyPayload = TerminalExecPayload | Record<string, unknown> | undefined;

export type ApprovalPolicyDecision =
  | { mode: "auto"; reason: string }
  | { mode: "gate"; reason?: string };

// Effective mode for a config — defaults to "auto" when not set so a
// freshly-loaded config without the field (e.g. partial test fixtures)
// behaves like a new instance. Legacy `dangerouslyAutoApprove: true`
// without `approvalMode` is already aliased to "yolo" by the load-time
// migration in `runtime/index.ts`; this fallback only matters for
// in-memory configs constructed without going through `loadConfig`.
export function effectiveApprovalMode(config: RuntimeConfig): ApprovalMode {
  if (config.approvalMode) return config.approvalMode;
  if (config.dangerouslyAutoApprove === true) return "yolo";
  return "auto";
}

// Returns whether the action should auto-approve or gate. The `reason`
// string flows into audit evidence as `autoApprovedReason` on the
// auto-approve path, and onto the approval row's reason field on the
// gate path so the operator sees WHY they're being asked.
export function resolveApprovalPolicy(
  config: RuntimeConfig,
  action: PolicyAction,
  payload?: PolicyPayload
): ApprovalPolicyDecision {
  const mode = effectiveApprovalMode(config);

  if (mode === "yolo") {
    return { mode: "auto", reason: "approval-mode-yolo" };
  }

  if (mode === "strict") {
    return { mode: "gate" };
  }

  // mode === "auto"
  if (action === "file.write" || action === "file.patch" || action === "browser.upload_file") {
    return { mode: "auto", reason: "approval-mode-auto" };
  }

  if (action === "terminal.exec") {
    const command = typeof (payload as TerminalExecPayload | undefined)?.command === "string"
      ? (payload as TerminalExecPayload).command
      : "";

    // Allowlist short-circuits the blocklist. An explicit operator
    // pattern match wins even if the command would otherwise be
    // flagged dangerous. The tool dispatcher's existing allowlist
    // fast path bypasses approval rows entirely; this branch keeps
    // the semantics consistent for callers that ask the policy seam
    // directly.
    const allowMatch = matchAutoApprove(config.autoApproveCommands, command);
    if (allowMatch) {
      return { mode: "auto", reason: allowMatch };
    }

    const patterns = config.dangerousTerminalPatterns ?? DEFAULT_DANGEROUS_TERMINAL_PATTERNS;
    const dangerous = matchDangerousTerminal(patterns, command);
    if (dangerous) {
      return { mode: "gate", reason: `dangerous-pattern: ${dangerous}` };
    }

    return { mode: "auto", reason: "approval-mode-auto" };
  }

  // Unknown action — default to gate so a new tool added without
  // updating this function doesn't silently auto-approve.
  return { mode: "gate" };
}
