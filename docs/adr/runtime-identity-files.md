# ADR: Runtime Identity Files (INSTRUCTIONS.md, SOUL.md, USER.md)

- **Status:** Accepted
- **Date:** 2026-05-21
- **See also:** [Runtime Identity Injection](./runtime-identity-injection.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md)

## Decision

Gini exposes three markdown files at the runtime root that the agent loop loads into the system prompt on every turn:

| File | Path | Scope | Edit policy |
|---|---|---|---|
| `INSTRUCTIONS.md` | `~/.gini/instances/<inst>/INSTRUCTIONS.md` | instance | user-only; never edited by the agent |
| `SOUL.md` | `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` | per-agent | agent may propose edits via `edit_soul` (proposed → approved) |
| `USER.md` | `~/.gini/instances/<inst>/USER.md` | instance | agent may propose edits via `edit_user_profile` (proposed → approved) |

The three files are a curated layer over the existing memory pipeline; they do not replace `state.memories` (legacy pinned memories) or the Hindsight per-agent bank.

System-prompt assembly order in `buildAgentSystemContext`:

1. `INSTRUCTIONS.md` content (falls back to `DEFAULT_GINI_INSTRUCTIONS` constant when the file is absent)
2. `SOUL.md` content (per active agent, when present)
3. Runtime identity block (unchanged, see ADR runtime-identity-injection.md)
4. Pinned memories (`state.memories`, unchanged)
5. `USER.md` content (when present)
6. Long-term recalled memory (Hindsight, unchanged)

All three files are passed through a prompt-injection scanner before they reach the prompt. Files that match a threat pattern are replaced inline with a `[BLOCKED: ... ]` notice and a warning is recorded in the runtime trace; the gateway does not crash on a malicious file.

## Context

Before this change, the agent's operating rules lived in an in-code `INSTRUCTIONS` constant inside `src/system-prompt.ts`. The user could not adjust them without editing the source tree. There was also no place for a per-agent persona ("how this agent talks, what it cares about, what it refuses to do") or for an instance-level user profile ("who Gini is talking to") that survived agent switching.

Two comparable systems shaped the design:

- **Hermes** (`NousResearch/hermes-agent`) assembles the system prompt at session start in `agent/system_prompt.py::build_system_prompt_parts`, with three tiers (stable / context / volatile). `SOUL.md` lives at the Hermes home root; `MEMORY.md` and `USER.md` live under `memories/`. A hardcoded `DEFAULT_AGENT_IDENTITY` constant is the fallback when `SOUL.md` is missing. Context files pass through `_CONTEXT_THREAT_PATTERNS` + `_CONTEXT_INVISIBLE_CHARS` checks in `agent/prompt_builder.py`.
- **OpenClaw** (`docs.openclaw.ai`) uses the same trio in `~/.openclaw/workspace/`. `SOUL.md` is deliberately separated from operating rules; `MEMORY.md` is the curated layer; `USER.md` is a template.

Gini diverges from a pure file model because the existing memory stack already does the heavy lifting:

- Per-agent Hindsight banks (`bank_${agentId}`) and units carry the isolation key.
- Legacy `MemoryRecord` rows carry an `agentId` and feed the pinned-memory block.
- `recall.ts` / `retain.ts` / `reflect.ts` already handle propose / approve / archive lifecycles.

The three new files are additive to that stack — a slow-moving, human-curated layer that complements the LLM-curated Hindsight memory.

## Required Now

- `src/system-prompt.ts` exports `DEFAULT_GINI_INSTRUCTIONS` (the prior in-code constant). `buildAgentSystemContext` takes new optional parameters `instructionsOverride`, `soul`, and `userProfile`; the call assembles them in the order above.
- `src/runtime/identity-files.ts` owns file I/O and the injection scan:
  - `loadInstructions(instance)`, `loadSoul(instance, agentId)`, `loadUserProfile(instance)` return either the scanned content, a `[BLOCKED: ...]` notice, or `null` when the file is absent.
  - `writeSoul(instance, agentId, content, status)` and `writeUserProfile(instance, content, status)` write `<file>` for approved content and `<file>.proposed` for proposed content. The gateway only reads the approved file into the prompt; proposals require approval via the API.
  - `scanForInjection(content, filename)` ports Hermes' `_CONTEXT_THREAT_PATTERNS` and `_CONTEXT_INVISIBLE_CHARS`.
- `src/execution/chat-task.ts` (modern agent loop) and `src/provider.ts::generateTaskSummary` (legacy single-shot path) load the three files via `identity-files.ts` and pass them through `buildAgentSystemContext`.
- `src/execution/tool-catalog.ts` adds `edit_soul` and `edit_user_profile` tools (toolset `identity`, always exposed alongside `add_memory`). Both tools propose a new file body; the body lands as `<file>.proposed` and is reflected in the audit + trace stream.
- `src/execution/tool-dispatch.ts` routes `edit_soul` / `edit_user_profile` to handlers that call into `identity-files.ts`. The handlers are sync (no approval gate at dispatch time) and rely on the proposed-vs-approved file split to keep unreviewed content out of the prompt.

## Boundary

- **Per-agent filesystem convention.** `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` is the first per-agent filesystem artifact in Gini. The directory is created lazily on first write; readers tolerate a missing directory and treat it as "no SOUL set". This convention is reserved for per-agent state that is too large or too human-edited to belong in `state.json`.
- **Approved-file vs proposed-file split.** The runtime only ever reads the approved file (`SOUL.md`, `USER.md`) into the system prompt. Agent-proposed edits land as `SOUL.md.proposed` / `USER.md.proposed` and never reach the model until the user approves them via the approval API. This mirrors how `add_memory` lands as `status: "proposed"` and only enters the pinned-memory block after a `POST /api/memory/<id>/approve`.
- **Injection-scan policy is fail-soft.** A file that trips a threat pattern is replaced inline with a `[BLOCKED: <filename> contained potential prompt injection (<reasons>). Content not loaded.]` notice and a warning is appended to the runtime trace. The gateway must keep running — a hostile USER.md must not lock the user out of their own instance.
- **INSTRUCTIONS.md is user-only.** The agent has no tool to edit it. The default constant remains in source so a fresh instance has a working preamble without filesystem setup.
- **Subagents are unaffected.** Subagents continue to receive `subagent.systemPrompt` as an override and do not see the three files. The override path is intentional — a subagent's persona is its parent's responsibility.

## Read and Write Semantics

- **Read (chat-task and provider paths):** `loadInstructions(instance)` is called once per turn; `loadSoul(instance, agentId)` is called only for the active agent (resolved via `resolveEffectiveContext`); `loadUserProfile(instance)` is instance-scoped. All three return the scanned content (or a BLOCKED notice). The chat-task path defers to the existing chat-session machinery for everything else.
- **Write (proposed):** the tool handler writes `<file>.proposed` atomically (write-and-rename). The audit row records `identity.soul.proposed` or `identity.user_profile.proposed` with the actor `agent`, the target file path, and a content excerpt.
- **Write (approved):** the approval API renames `<file>.proposed` over `<file>` atomically and writes an `identity.<file>.approved` audit row with actor `user`. The proposal file is consumed by the rename and is no longer present after approval.
- **Concurrent writes:** within a single instance, write contention is rare (one user editing through the UI). The write-and-rename pattern is the same one `state.ts` uses for the canonical state file.

## Consequences

- **Behavior change:** the agent's operating rules become user-editable. A fresh instance behaves identically to the prior in-code constant because `INSTRUCTIONS.md` is absent and the constant is the fallback.
- **Per-agent persona is on-disk.** Switching agents picks up that agent's `SOUL.md`. User identity is preserved because `USER.md` is instance-scoped.
- **Audit and trust surface grows.** Three new audit actions cover the propose / approve lifecycle. The injection scan provides a documented trust boundary on user-controlled files that ride the system prompt.
- **State growth is bounded.** Three files per instance plus one `SOUL.md` per agent. None are stored in `state.json`.

## Alternatives Considered

- **One `IDENTITY.md` carrying all three concerns.** Rejected. Operating rules (the model's behavior contract), persona (the agent's voice), and user identity (who the user is) have different scopes and different edit policies. Collapsing them would either force per-agent operating rules (defeating the instance-level baseline) or instance-level persona (breaking the multi-agent product story).
- **Persist file content inside `state.json`.** Rejected. Markdown is human-edited; round-tripping through JSON serialization adds friction for what should be `vim ~/.gini/instances/<inst>/USER.md`.
- **Skip the proposed-file split and rely on inline approval.** Rejected. The propose / approve split mirrors the existing `add_memory` flow and lets the user inspect the diff before approval. Inline approval would bypass the audit chain for human-readable content.
- **Apply the injection scan only to `SOUL.md`.** Rejected. All three files reach the system prompt; all three need the same scan. A user pasting a hostile USER.md from a stranger is the realistic threat — same shape as the Hermes context-file model.

## Acceptance Checks

- A fresh instance with no identity files present produces a system prompt that contains `DEFAULT_GINI_INSTRUCTIONS` and no SOUL/USER blocks.
- Writing `~/.gini/instances/<inst>/INSTRUCTIONS.md` with custom content causes the next chat turn to use that content in place of the default constant.
- Writing `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` causes the next chat turn (under that active agent) to include the SOUL block after the instructions and before the identity block.
- Writing `~/.gini/instances/<inst>/USER.md` causes the next chat turn to include the USER block between pinned memories and recalled memory.
- A file containing `ignore previous instructions` is replaced in the prompt by `[BLOCKED: <filename> contained potential prompt injection (prompt_injection). Content not loaded.]` and a warning is emitted to the runtime trace.
- `edit_soul` and `edit_user_profile` write `<file>.proposed` and create an `identity.*.proposed` audit row; the new content does not appear in the next turn's prompt until approval.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.

## Critical Files

- `src/system-prompt.ts` — `DEFAULT_GINI_INSTRUCTIONS`; `buildAgentSystemContext` accepts `instructionsOverride`, `soul`, `userProfile`.
- `src/runtime/identity-files.ts` — load/write/scan helpers.
- `src/execution/chat-task.ts`, `src/provider.ts` — call sites that load and forward the three files.
- `src/execution/tool-catalog.ts`, `src/execution/tool-dispatch.ts` — `edit_soul` and `edit_user_profile`.
- `~/.gini/instances/<inst>/INSTRUCTIONS.md`, `~/.gini/instances/<inst>/USER.md`, `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` — the on-disk artifacts.
