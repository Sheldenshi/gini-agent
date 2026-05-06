# ADR 0002: Minimal Trust Substrate

## Decision

v0 uses three minimal trust primitives before meaningful side effects: `Approval`, `AuditEvent`, and `TraceRecord`.

## Context

The product promise is operational trust. The system can be small, but it must leave receipts. OpenClaw-style broad tool/channel reach is useful only after the runtime has permissions and sandbox boundaries. Hermes-style seamlessness must not hide actions that mutate files, run commands, or change remembered facts.

## Required Now

- File writes and terminal commands pause as pending approvals.
- Approval decisions are auditable.
- Approved side effects emit audit evidence.
- Task-linked approvals and tool calls append trace records.
- Memory created by the agent starts as proposed and needs approval before becoming active.

## Deferred

- Full policy engine.
- Fine-grained role-based permissions.
- Cryptographic audit chaining.
- Per-tool sandbox processes.
- Rich diff rendering.

## Consequences For Coding Agents

- If a new action can mutate state outside the task record, add an audit event.
- If a new action can affect user files or system state, route it through approval first.
- If a new action happens during a task, append trace evidence.

## Acceptance Checks

- Submitting `write path :: content` creates a pending approval.
- Denying the approval prevents the write.
- Approving the approval writes the file and records audit evidence.
- Submitting `remember ...` creates a proposed memory, not an active one.
