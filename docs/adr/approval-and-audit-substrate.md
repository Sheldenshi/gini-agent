# ADR: Approval And Audit Substrate

## Decision

Gini uses three core approval and audit primitives before meaningful side effects: `Approval`, `AuditEvent`, and `TraceRecord`.

## Context

The product promise is operational confidence. The system can start small, but it must leave receipts. Broad tool/channel reach is useful only after the runtime has permissions, approval boundaries, and auditability. Seamless chat must not hide actions that mutate files, run commands, execute code, or change remembered facts.

## Required Now

- File writes, terminal commands, and code execution pause as pending approvals when required.
- Approval decisions are auditable.
- Approved side effects emit audit evidence.
- Task/run-linked approvals and tool calls append trace records.
- Memory created by the agent starts as proposed and can be reviewed before becoming active.
- Skills use a plain `enabled` / `disabled` lifecycle. Enabled skills can be
  advertised to the agent when their connector requirements are satisfied;
  disabled skills stay invisible to the agent.
- `AuditEvent`, `RuntimeEvent`, and `TraceRecord` each carry an optional
  `redacted` boolean that the writer enforces at the boundary. When true,
  `addAudit` drops the `evidence` field, `appendEvent` drops `data`, and
  `appendTrace` drops `data` before serializing to JSONL. Metadata (action,
  target, actor, risk, taskId, runId, approvalId, agentId, timestamp) still
  persists so reviewers see that the event happened; payload bytes are not
  stored. `addAudit` propagates the flag into the mirrored runtime event so
  the activity feed inherits the same suppression. The first consumer is
  `browser.fill_secret` (see ADR browser-fill-secret.md), whose audit rows
  would otherwise carry user-typed credentials.

## Deferred

- Full policy engine.
- Fine-grained role-based permissions.
- Cryptographic audit chaining.
- Per-tool sandbox processes.
- Rich diff rendering across every client.

## Consequences For Coding Agents

- If a new action can mutate state outside the task/run record, add an audit event.
- If a new action can affect user files or system state, route it through approval first. The operator can opt into the sanctioned bypass via `approvalMode: "yolo"` (ADR [approval-mode.md](approval-mode.md), supersedes dangerously-auto-approve.md) which still produces the full approval + audit trail with an explicit auto-approved marker. Note that the default instance mode is now `"auto"`, which auto-approves safe actions but still gates dangerous shell patterns — new tools should route through `resolveApprovalPolicy` so the mode contract applies uniformly.
- If a new action happens during execution, append trace evidence.
- If a new bundled skill wraps a side-effecting command, keep the underlying command approval-gated unless an explicit auto-approve rule covers it.
- If a new approval-gated action awaits anything cancellable (a spawned proc, an HTTP request, etc.), thread the abort signal from `claimApproval` into the side effect so `cancelTask` can intercept in-flight work. The contract is documented in ADR approval-execution-abort.md.

## Acceptance Checks

- Submitting `write path :: content` creates a pending approval.
- Denying the approval prevents the write.
- Approving the approval writes the file and records audit evidence.
- Submitting `remember ...` creates proposed memory, not hidden active memory.
- Loading skills creates enabled skill records, while a same-name user skill
  remains a separate record and can be enabled or disabled independently.
