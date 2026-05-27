# ADR: approvalMode — three-state approval policy

## Status

Accepted. Supersedes [dangerouslyAutoApprove](dangerously-auto-approve.md).

## Decision

Replace the binary `dangerouslyAutoApprove` flag with a three-state
`RuntimeConfig.approvalMode`:

- `"strict"` — every approval-eligible action creates a pending
  approval row and pauses the task for a human decision. Matches the
  legacy pre-flip default.
- `"auto"` — **new instance default**. Auto-approve `file.write`,
  `file.patch`, `browser.upload_file`, and `messaging.send`
  unconditionally. For
  `terminal.exec` and `code_exec`, auto-approve unless the command
  (or, for `code_exec`, either the wrapper command OR the raw
  source — see `matchDangerousSource`) matches a dangerous-pattern
  entry. Operator override via
  `RuntimeConfig.dangerousTerminalPatterns`; built-ins in
  `DEFAULT_DANGEROUS_TERMINAL_PATTERNS`
  (`src/execution/auto-approve.ts`). The `autoApproveCommands`
  allowlist always short-circuits the blocklist.
- `"yolo"` — full bypass for every approval-gated tool. Same audit
  contract as the legacy `dangerouslyAutoApprove: true`: each call
  still produces an approval row (status="approved") and matching
  audit rows stamped `evidence.autoApproved=true` plus
  `evidence.autoApprovedReason="approval-mode-yolo"`.

Every dispatcher (`tool-dispatch.ts:pendingOrAuto`,
`tool-dispatch.ts:terminalExecDispatch`,
`tool-dispatch.ts:codeExecDispatch`, and the legacy imperative path
in `agent.ts`) routes through one seam:

```ts
resolveApprovalPolicy(config, action, payload)
  → { mode: "auto" | "gate"; reason?: string }
```

Auto decisions feed `evidence.autoApprovedReason` (`"approval-mode-auto"`,
`"approval-mode-yolo"`, or a matched allowlist pattern). Gate
decisions optionally surface a reason on the approval row
(`"dangerous-pattern: <matched>"`) so the operator sees why they're
being asked.

## Context

In practice, the `strict` default forced the operator to babysit the
agent — even safe file writes blocked the loop. The single-flag
escape valve (`dangerouslyAutoApprove`) was too coarse: flipping it
on auto-approved every shell command, including the catastrophic
ones (`rm -rf /`, `sudo *`, pipe-to-shell). The right middle ground
is "auto-approve everything safe by default; gate the genuinely
irreversible / blast-radius-expanding shell shapes; let an operator
still pick strict or yolo if they want either pole."

The two original Plan corrections worth noting:

- `skill.enable`, `connector.enable`, and `memory.activate` are
  audit-label actions, not approval-gated tool calls. They don't
  flow through `pendingOrAuto`, so they don't appear in the
  approval-eligible surface this ADR governs.
- `code_exec` compiles to a shell command and routes through
  `terminal.exec`, so the dangerous-pattern blocklist applies to it
  automatically — a snippet that shells out to `sudo` is gated the
  same way a `terminal_exec` of `sudo *` would be.

The approval-eligible tool surface is `file_write`, `file_patch`,
`terminal_exec`, `code_exec`, `browser_upload_file`, `send_message`,
and `browser_fill_secrets`. `send_message` egresses data and was
folded into the same policy seam after the initial five so the mode
contract applies uniformly. Under `auto` mode `send_message`
auto-approves (the agent can drive normal automations); `strict`
still gates each call.

`browser_fill_secrets` is the one carve-out from the
"route-through-pendingOrAuto" rule, documented in detail in
[browser-fill-secret.md](browser-fill-secret.md). The dispatch
creates the approval directly via `createApproval` (the side effect
— per-slot playwright fill — runs inside `POST /api/approvals/<id>/connect`
from request-scope secrets, not inside `executeApprovedAction`), and
`resolveApprovalPolicy` returns `{ mode: "gate" }` for
`browser.fill_secret` regardless of `approvalMode` — yolo cannot
auto-approve credential entry because the credentials come from the
user, not the agent. The mode-uniformity claim above does not extend
to this action.

## Required Now

- `RuntimeConfig.approvalMode?: ApprovalMode` field, defaulting to
  `"auto"` for fresh instances via `paths.defaultConfig`.
- `RuntimeConfig.dangerousTerminalPatterns?: string[]` operator
  overlay for the built-in blocklist. **Extension semantics**: the
  built-in `DEFAULT_DANGEROUS_TERMINAL_PATTERNS` always apply;
  operator-supplied patterns are ADDITIONS, not replacements. An
  empty list or a GET → PATCH round-trip that loses the field keeps
  the full default protection set in place.
- `RuntimeConfig.dangerouslyAutoApprove?: boolean` stays present as
  a **deprecated alias** for `approvalMode === "yolo"`. Returned as a
  derived boolean in GET `/api/settings/auto-approve` responses;
  accepted on PATCH and the `create_job` tool spec; aliased on load
  by the migration shim below.
- `src/execution/policy.ts` exports
  `resolveApprovalPolicy(config, action, payload)` — the single
  policy seam. Every dispatcher reads from it.
- `src/execution/auto-approve.ts` exports
  `matchDangerousTerminal(patterns, command)` and
  `DEFAULT_DANGEROUS_TERMINAL_PATTERNS` (rm -rf to absolute paths or
  $HOME, sudo, pipe-to-shell, chmod 777, destructive git operations,
  writes to /etc/, ~/.ssh/, ~/.aws/).
- Load-time migration shim in `runtime/index.ts:install` aliases
  legacy configs with `dangerouslyAutoApprove: true` (no explicit
  `approvalMode`) to `approvalMode: "yolo"`, persists the upgraded
  shape to disk, and emits a one-time `config.migrated` audit row.
  Idempotent — running install twice produces one audit row.
- GET / PATCH `/api/settings/auto-approve` surfaces `approvalMode`
  and `dangerousTerminalPatterns` alongside the deprecated
  `dangerouslyAutoApprove` (derived boolean on GET, accepted alias
  on PATCH).
- Per-job overlay (`JobRecord.approvalMode`, `.dangerouslyAutoApprove`,
  `.dangerousTerminalPatterns`, `.autoApproveCommands`) carries the
  same semantics scoped to that job's spawned tasks only. When both
  `approvalMode` and `dangerouslyAutoApprove` are set on a job,
  `approvalMode` wins. `dispatchPromptRun` clones the
  RuntimeConfig and overlays the envelope so the operator's global
  config is never mutated.
- `create_job` tool spec documents the new vocabulary and accepts
  both `approvalMode` and the deprecated `dangerouslyAutoApprove`
  alias.

## Allowlist precedence

`RuntimeConfig.autoApproveCommands` is consulted **before** the
dangerous-pattern blocklist. An explicit operator allow beats a
heuristic block — so `autoApproveCommands: ["sudo apt update"]`
auto-approves that command even though `sudo ` is on the
dangerous-pattern list. The `terminalExecDispatch` fast path bypasses
approval-row creation entirely on an allowlist match; the policy
seam mirrors the precedence so callers that ask it directly see the
same answer.

## Audit-marker contract

`evidence.autoApproved=true` plus a non-empty
`evidence.autoApprovedReason` are the authoritative "the human gate
was skipped" markers. Reason strings produced by the runtime:

- `"approval-mode-auto"` — `approvalMode: "auto"` auto-approved a
  safe action.
- `"approval-mode-yolo"` — `approvalMode: "yolo"` auto-approved
  everything (legacy `dangerouslyAutoApprove: true` aliases to this
  on load).
- `"<allowlist pattern>"` — `RuntimeConfig.autoApproveCommands`
  matched a terminal command (the matched pattern IS the reason).

Audit consumers that previously matched
`autoApprovedReason === "dangerouslyAutoApprove"` should match on
`"approval-mode-yolo"` (or any non-empty reason if they only care
about "was this auto").

## Acceptance Checks

- A chat-task `file_write` with `approvalMode: "auto"` (or the new
  default) completes synchronously with the file on disk and the
  `file.write` audit row carries `autoApprovedReason: "approval-mode-auto"`.
- `approvalMode: "strict"` makes the same `file_write` pause for
  approval — no file on disk, one pending approval.
- `approvalMode: "yolo"` auto-approves a dangerous shell command
  (`rm -rf /` in tests is asserted via the audit reason, not by
  actually deleting anything) with
  `autoApprovedReason: "approval-mode-yolo"`.
- Under `approvalMode: "auto"`, `terminal_exec` of `rm -rf /` (or
  any built-in dangerous pattern) gates for approval.
- `autoApproveCommands: ["sudo apt update"]` short-circuits the
  `sudo ` blocklist entry; the command auto-runs with
  `autoApprovedReason: "sudo apt update"`.
- A legacy config (`dangerouslyAutoApprove: true`, no `approvalMode`)
  loads into effective `"yolo"` AND emits a single `config.migrated`
  audit row with `evidence.field: "approvalMode", from:
  "dangerouslyAutoApprove: true", to: "yolo"`. Restarting the
  runtime does NOT double-emit the audit row.
- A fresh instance (no prior `config.json`) writes
  `approvalMode: "auto"` to disk.
- `create_job` accepts `approvalMode` directly and the legacy
  `dangerouslyAutoApprove` alias. Both persist onto the JobRecord;
  `approvalMode` wins when both are set.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are
  green; `src/execution/approval-mode.test.ts` covers the
  `{strict, auto, yolo}` × `{file_write, file_patch, terminal_exec
  safe + dangerous, code_exec, browser_upload_file, send_message}`
  matrix, plus
  the legacy alias, the symlink-escape rejection, side-effect
  failure propagation, and the human (decideApproval) path.

## Per-Job Scope

Same shape as the operator config, scoped to one job's spawned tasks
via the cloned RuntimeConfig in `jobs.buildTaskConfig`:

- `JobRecord.approvalMode` overlays onto the cloned config.
- `JobRecord.dangerouslyAutoApprove: true` aliases to
  `approvalMode: "yolo"` on the clone when `approvalMode` is unset.
- `JobRecord.autoApproveCommands` is merged onto the cloned
  allowlist (operator's global allowlist still applies; the per-job
  opt-in widens it for that job's task only).
- `JobRecord.dangerousTerminalPatterns` replaces the cloned
  blocklist for that job's spawned task only.

The clone is byte-isolated from the operator's global config — the
spawned task sees the envelope; the operator's settings are never
mutated.

## Consequences For Coding Agents

- New approval-gated tools added in the future MUST route through
  `pendingOrAuto(config, action, payload, request)` (chat-task)
  AND, if exposed via the imperative dispatcher, call
  `resolveApprovalPolicy` against the freshly-created approval and
  forward the same `evidenceExtra` markers through `resolveApproval`.
  Side-stepping the policy seam (creating an approval and resolving
  it inline without going through the seam) would silently bypass
  the mode contract documented here. The one exception is
  `browser.fill_secret` — see [browser-fill-secret.md](browser-fill-secret.md)
  for the rationale (side effect runs in `/connect` from
  request-scope secrets, no `executeApprovedAction` frame, policy
  hard-codes a gate for the action so the mode contract still holds
  end-to-end).
- Adding a new approval-gated `PolicyAction` requires:
  1. Extending the discriminated union in `policy.ts`.
  2. Adding the auto/gate decision branch in `resolveApprovalPolicy`.
  3. Mapping the approval row's `action` string in
     `agent.ts:mapApprovalToPolicyAction` (used by the imperative
     dispatch path).
- Audit consumers should rely on
  `evidence.autoApproved === true` + a non-empty
  `evidence.autoApprovedReason` rather than parsing the reason
  string. The reason string is informational (which rule fired) and
  may grow new values without notice.
- `AutoApproveMarkers` on `resolveApproval` stays typed narrowly on
  purpose; runtime-owned canonical evidence fields (`beforeBytes`,
  `exitCode`, `diff`, etc.) must not be overridable from the
  auto-approve call site.

## Deferred

- UI surface for the three-state toggle on `/settings`. Today the
  mode is set via `PATCH /api/settings/auto-approve` or by editing
  `config.json` directly.
- A future "explain-this-gate" affordance that surfaces the
  policy decision's `reason` field to the approval-card UI so
  operators understand WHY a command was held (`"dangerous-pattern:
  sudo "`) without needing to read the source.
