# Architecture Decision Records

Each file in this directory captures one architecture decision: the context, the choice, and its consequences. Update an existing ADR when implementation details shift, add a new ADR for a significant decision, and mark superseded ADRs with a link to their replacement.

ADRs are named by slug, not number. The filename (e.g. `agent-memory-isolation.md`) is the citation key — pick it carefully and never rename it once merged. Always cite an ADR by its full filename including `.md` so the reference is unambiguously a file: `see ADR agent-memory-isolation.md` in prose and code comments, and `[Per-Agent Memory Isolation](./agent-memory-isolation.md)` for markdown links.

## Index

- [Local Runtime Architecture](local-runtime-architecture.md)
- [Minimal Trust Substrate](trust-substrate.md)
- [Instances And Control Surface](instances-and-control-surface.md)
- [Agent Loop With Native Tool Calling](agent-loop-tool-calling.md)
- [Subagent Delegation](subagent-delegation.md)
- [Agents Replace Profiles And Drive Runtime Behavior](agents-replace-profiles.md)
- [dangerouslyAutoApprove](dangerously-auto-approve.md)
- [Per-Agent Memory Isolation](agent-memory-isolation.md)
- [Connector Secret Storage](connector-secret-storage.md)
- [Skills As Packages, Connectors As Credentials](skills-and-connectors.md)
- [Approval Execution Abort Protocol](approval-execution-abort.md)
- [Runtime Update Surface And Automatic Restart](runtime-update-surface.md)
- [Connector + Provider Vocabulary, Spec Compliance, And Meta-Skills](connector-provider-spec-compliance.md)
