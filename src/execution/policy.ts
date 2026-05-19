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
  matchDangerousSource,
  matchDangerousTerminal,
  userDangerousPatterns
} from "./auto-approve";

// Actions the policy seam knows about. Mostly 1:1 onto the
// approval-eligible tool surface in `tool-dispatch.ts`:
//   - file.write          → file_write
//   - file.patch          → file_patch
//   - terminal.exec       → terminal_exec
//   - code.exec           → code_exec (compiled into a wrapper shell
//                            command; matcher runs against BOTH the
//                            wrapper and the raw source)
//   - browser.upload_file → browser_upload_file
// The approval row's persisted action stays `terminal.exec` for
// code_exec (it really runs as one) — only the POLICY decision
// branches separately so the matcher sees the raw `Bun.spawn(["sudo",
// ...])` source the wrapper would otherwise hide.
export type PolicyAction =
  | "file.write"
  | "file.patch"
  | "terminal.exec"
  | "code.exec"
  | "browser.upload_file";

export interface TerminalExecPayload {
  command: string;
}

// Used by `code.exec` policy decisions. `source` is the raw snippet
// the model emitted; `command` is the shell-wrapper that wraps it.
// Both are tested against the dangerous-pattern set since the wrapper
// (e.g. `bun -e "..."` or a python heredoc) hides argv-style payloads
// like `Bun.spawn(["sudo", "apt"])` from a substring-on-command check.
export interface CodeExecPayload {
  command: string;
  source: string;
  language?: string;
}

export type PolicyPayload = TerminalExecPayload | CodeExecPayload | Record<string, unknown> | undefined;

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

    const dangerous = matchDangerousTerminal(effectiveDangerousPatterns(config), command);
    if (dangerous) {
      return { mode: "gate", reason: `dangerous-pattern: ${dangerous}` };
    }

    return { mode: "auto", reason: "approval-mode-auto" };
  }

  if (action === "code.exec") {
    const code = payload as CodeExecPayload | undefined;
    const wrapper = typeof code?.command === "string" ? code.command : "";
    const source = typeof code?.source === "string" ? code.source : "";

    // Allowlist applies to the wrapper command only — that's the
    // shape the operator listed when they wrote the allowlist
    // pattern. Source-level allowlisting would require a separate
    // (language-aware) matcher.
    const allowMatch = matchAutoApprove(config.autoApproveCommands, wrapper);
    if (allowMatch) {
      return { mode: "auto", reason: allowMatch };
    }

    // Match against BOTH the wrapper command AND the raw source.
    //
    // - Wrapper scan uses the regular `matchDangerousTerminal` set
    //   (built-ins + user patterns) — the wrapper is a real shell
    //   command line, so substring-style matching is correct here.
    //   `os.system("sudo apt update")` is caught at this stage
    //   because the heredoc-wrapped source flows through the
    //   wrapper.
    // - Source scan uses `matchDangerousSource`, which extracts
    //   argv-like segments structurally (first element of array
    //   literals, first arg to known exec functions) before applying
    //   the built-in matcher set. This closes the argv-style
    //   `Bun.spawn(["sudo", "apt"])` hole without false-positiving
    //   comments (`# using sudo`) or incidental string literals
    //   (`print("using sudo for X")`). User-supplied
    //   `dangerousTerminalPatterns` are intentionally not applied at
    //   source level — see auto-approve.ts for the rationale.
    const patterns = effectiveDangerousPatterns(config);
    const dangerous =
      matchDangerousTerminal(patterns, wrapper) ?? matchDangerousSource(source);
    if (dangerous) {
      return { mode: "gate", reason: `dangerous-pattern: ${dangerous}` };
    }

    return { mode: "auto", reason: "approval-mode-auto" };
  }

  // Unknown action — default to gate so a new tool added without
  // updating this function doesn't silently auto-approve.
  return { mode: "gate" };
}

// Built-ins always apply; operator-supplied patterns extend rather
// than replace them. Pulled into a helper because both terminal.exec
// and code.exec consult the same set.
function effectiveDangerousPatterns(config: RuntimeConfig) {
  return [
    ...DEFAULT_DANGEROUS_TERMINAL_PATTERNS,
    ...userDangerousPatterns(config.dangerousTerminalPatterns)
  ];
}
