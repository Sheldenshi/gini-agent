# ADR 0002: Minimal Trust Substrate

## Decision

Gini uses three core trust primitives before meaningful side effects: `Approval`, `AuditEvent`, and `TraceRecord`.

## Context

The product promise is operational trust. The system can start small, but it must leave receipts. Broad tool/channel reach is useful only after the runtime has permissions, approval boundaries, and auditability. Seamless chat must not hide actions that mutate files, run commands, execute code, or change remembered facts.

## Required Now

- File writes, terminal commands, and code execution pause as pending approvals when required.
- Approval decisions are auditable.
- Approved side effects emit audit evidence.
- Task/run-linked approvals and tool calls append trace records.
- Memory created by the agent starts as proposed and can be reviewed before becoming trusted.

## Deferred

- Full policy engine.
- Fine-grained role-based permissions.
- Cryptographic audit chaining.
- Per-tool sandbox processes.
- Rich diff rendering across every client.

## Consequences For Coding Agents

- If a new action can mutate state outside the task/run record, add an audit event.
- If a new action can affect user files or system state, route it through approval first. The operator can opt into the sanctioned bypass (`dangerouslyAutoApprove`, ADR 0006) which still produces the full approval + audit trail with an explicit auto-approved marker — but new tools should be designed assuming the human gate is the default.
- If a new action happens during execution, append trace evidence.

## Acceptance Checks

- Submitting `write path :: content` creates a pending approval.
- Denying the approval prevents the write.
- Approving the approval writes the file and records audit evidence.
- Submitting `remember ...` creates proposed memory, not hidden active memory.
