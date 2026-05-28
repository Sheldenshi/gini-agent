# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately by emailing **security@lilaclabs.ai** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected version or commit, and
- any suggested mitigation if you have one.

You can expect an initial acknowledgement within 5 business days. We'll work with you on a disclosure timeline and credit you in the release notes unless you ask us not to.

## Supported versions

Gini Agent is pre-1.0 and ships from `main`. Security fixes land on `main`; users on the installer-managed runtime should run `gini update` to pick them up.

## Scope

Gini is a personal agent runtime. Reports we're particularly interested in:

- Authentication or authorization bypass on the gateway's `/api/*` surface.
- Leakage of provider credentials (Codex OAuth tokens, OpenAI API keys) into logs, traces, or client responses.
- Approval-gating bypasses in file, terminal, or code tools.
- Path traversal, command injection, or sandbox escape from any tool execution.
- Cross-origin or cross-instance access (browser code reaching another instance's gateway, BFF leaking the bearer token).
- MCP or messaging bridges accepting unauthenticated input that reaches the runtime.

Out of scope:

- Issues that require physical or root access to the host.
- Denial of service against the local gateway from a process already running as the same user.
- Vulnerabilities in third-party providers (OpenAI, OpenRouter, etc.) — report those upstream.
