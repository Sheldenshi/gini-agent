# ADR: Runtime Identity Files (INSTRUCTIONS.md, SOUL.md, USER.md)

- **Status:** Accepted
- **Date:** 2026-05-21
- **See also:** [Runtime Identity Injection](./runtime-identity-injection.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [Identity-File Long-Horizon Design](./identity-file-long-horizon-design.md)

## Memory surfaces

Gini has three memory surfaces, no fourth:

| Surface | Mechanism | Scope | Injection cadence | Edit path |
|---|---|---|---|---|
| User identity | `USER.md` | instance (cross-agent) | always inject | `edit_user_profile` (auto-approved when injection scan passes) |
| Agent persona | `SOUL.md` | per-agent | always inject | `edit_soul` (auto-approved when injection scan passes) |
| Everything else | Hindsight units | per-agent bank | recall on demand | auto-retain at task end; `recall_memory` on demand |

The partition is intentional: always-inject and recall-on-demand serve different needs. `USER.md` and `SOUL.md` are user-curated, bounded, and ride the prompt every turn so the model never has to "remember" who it is talking to or how it is supposed to sound. Hindsight is unbounded and indexed (semantic + BM25 + temporal + graph recall) so episodic facts surface when the conversation makes them relevant without bloating the prompt.

Where a given fact lands:

- "User's name is Shelden", "User prefers TypeScript", "User is based in Berlin" → `USER.md` via `edit_user_profile`. Bridges agents.
- "Reply concisely", "Act as a hard-edged critic", "End every reply with [edge:on]" → `SOUL.md` via `edit_soul`. Per-agent voice.
- "User asked about Redis on 2026-04-12", "User shipped feature X last week", "User mentioned their dog Hektor" → Hindsight, populated automatically by auto-retain after every chat task. The agent does not call a tool to write these; the runtime extracts them.

There is no separate "pinned memory" surface. Anything worth remembering that does not fit USER.md (cross-agent identity) or SOUL.md (per-agent voice) flows through auto-retain and is surfaced by recall when relevant.

## Decision

Gini exposes three markdown files at the runtime root that the agent loop loads into the system prompt on every turn:

| File | Path | Scope | Edit policy |
|---|---|---|---|
| `INSTRUCTIONS.md` | `~/.gini/instances/<inst>/INSTRUCTIONS.md` | instance | user-only; never edited by the agent |
| `SOUL.md` | `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` | per-agent | agent edits via `edit_soul`; clean bodies auto-approve, the injection scanner routes hostile bodies through proposed → approved |
| `USER.md` | `~/.gini/instances/<inst>/USER.md` | instance | agent edits via `edit_user_profile`; clean bodies auto-approve, the injection scanner routes hostile bodies through proposed → approved |

The three files are a curated layer over the Hindsight memory pipeline. USER.md (instance), SOUL.md (per-agent), and Hindsight (per-agent bank) are the three memory surfaces (see the Memory surfaces section above).

Byte-stable system-prefix assembly order in `buildAgentSystemContext`:

1. `INSTRUCTIONS.md` content (falls back to the bundled `src/runtime/defaults/INSTRUCTIONS.md` when the per-instance file is absent)
2. `SOUL.md` content (per active agent, when present)
3. `USER.md` content (when present)

`INSTRUCTIONS.md` is generic — its preamble is "You are a personal agent running on the gini-agent framework." It names no agent: the framework reference is the platform the agent runs on, not its identity. The agent's name lives in its per-agent `SOUL.md`, seeded as `Your name is <name>.` at creation and backfilled for existing agents at boot, so a non-default agent self-identifies by its own name through the normal SOUL block rather than through any identity sentence in `INSTRUCTIONS.md`. The default agent is named "Gini", so its SOUL is seeded `Your name is Gini.` (Earlier the preamble was a bare "You are Gini, a personal agent." — a literal name — which a non-default agent folded into its self-description as "your Gini personal agent"; `migrateInstructionsIdentityLine` rewrites that stale first line on existing instances. See Required Now.)

The runtime identity block and long-term recalled memory are no longer part of the system prefix — they vary per turn, so they ride in the ephemeral `role:"user"` tail rendered by `renderEphemeralContext` (identity then memory), placed after the full prior transcript and immediately before the real user message. This keeps message 0 byte-stable for prompt caching. See ADR stable-system-prefix.md.

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

- `src/runtime/defaults/INSTRUCTIONS.md` is the single source of truth for the default operating rules. Its bytes are spliced verbatim into the system prompt when no per-instance `INSTRUCTIONS.md` exists, and the scaffolder copies the same bytes into freshly-installed instances. The preamble is generic ("You are a personal agent running on the gini-agent framework.") — it carries no agent name; the framework is the platform, not an identity. `migrateInstructionsIdentityLine(instance)` runs at boot and rewrites a stale legacy first line (the old "You are Gini, a personal agent." or the interim name-free variants) to this current preamble, preserving the rest of a user-edited file. There is no in-code constant; the prior `DEFAULT_GINI_INSTRUCTIONS` string has been replaced.
- `src/system-prompt.ts` exports `getDefaultGiniInstructions()` (memoized per-process, reads and trims the bundled file), `DEFAULT_INSTRUCTIONS_PATH` (the resolved path other modules import), and `sanitizeAgentName(name)` (collapses whitespace runs to a single space and trims; returns `undefined` when empty). A missing bundle file is unrecoverable — both the runtime fallback and the scaffolder throw with `"default INSTRUCTIONS.md missing from bundle"` rather than silently falling back to an empty string. `buildAgentSystemContext` takes an options object with `instructionsOverride`, `soul`, and `userProfile`; the call assembles them into the byte-stable prefix in the order above. (Per-turn identity + recalled memory render through `renderEphemeralContext` into the role:"user" tail — see ADR stable-system-prefix.md.)
- `src/runtime/identity-files.ts` owns file I/O and the injection scan:
  - `loadInstructions(instance)`, `loadSoul(instance, agentId)`, `loadUserProfile(instance)` return either the scanned content, a `[BLOCKED: ...]` notice, or `null` when the file is absent.
  - `seedAgentSoulFile(instance, agentId, name)` seeds the per-agent `SOUL.md` with `Your name is <name>.` when the file is absent or empty/whitespace-only; it never clobbers a populated SOUL and no-ops when the name sanitizes to empty. Called by `createAgent` at creation and by `install()` for every existing agent on each gateway boot (the existing-agent name backfill).
  - `writeSoul(instance, agentId, content, status)` and `writeUserProfile(instance, content, status)` write `<file>` for approved content and `<file>.proposed` for proposed content. The gateway only reads the approved file into the prompt; proposals require approval via the API.
  - `scanForInjection(content, filename)` ports Hermes' `_CONTEXT_THREAT_PATTERNS` and `_CONTEXT_INVISIBLE_CHARS`.
- `src/execution/chat-task.ts` (modern agent loop) and `src/provider.ts::generateTaskSummary` (legacy single-shot path) load the three files via `identity-files.ts` and pass them through `buildAgentSystemContext`.
- `src/execution/tool-catalog.ts` adds `edit_soul` and `edit_user_profile` tools (toolset `identity`, always exposed). Both auto-approve clean bodies — writes land directly at `SOUL.md` / `USER.md` and are effective on the next system prompt — with the injection scan still gating threat patterns (hostile bodies route through `SOUL.md.proposed` / `USER.md.proposed` and stay out of the prompt until the user approves).
- `src/execution/tool-dispatch.ts` routes `edit_soul` / `edit_user_profile` to handlers that call into `identity-files.ts`. The handlers are sync (no approval gate at dispatch time) and rely on the proposed-vs-approved file split to keep unreviewed content out of the prompt.
- Both `edit_soul` and `edit_user_profile` accept an `action` field with three values:
  - `set` — replace the whole file body with `content` (default).
  - `append` — layer a new section under the existing approved body, separated by a blank line. Takes `content`. Earlier design notes used `add`; the shipped surface is `append` because it describes the operation precisely (the new section is appended; it does not insert at an arbitrary position).
  - `remove` — drop the first paragraph (block delimited by blank lines) of the existing approved body that contains the `needle` substring. Takes `needle`. Returns a clean failure to the model when the file is absent or the needle is unmatched, leaving the proposed file untouched.

## Boundary

- **Per-agent filesystem convention.** `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` is the first per-agent filesystem artifact in Gini. The directory is created lazily on first write; readers tolerate a missing directory and treat it as "no SOUL set". This convention is reserved for per-agent state that is too large or too human-edited to belong in `state.json`.
- **Approved-file vs proposed-file split.** The runtime only ever reads the approved file (`SOUL.md`, `USER.md`) into the system prompt. `edit_soul` and `edit_user_profile` both auto-approve a clean body — it lands directly at `SOUL.md` / `USER.md` and is effective on the next turn — so the agent can maintain its own persona and the user's profile without a separate approval round (the file is visible in the prompt, history snapshots make every write reversible, and SOUL is per-agent). The injection scanner is the gate that matters: a body tripping a threat pattern routes through `SOUL.md.proposed` / `USER.md.proposed` and never reaches the model until the user approves it via `POST /api/identity-files/{soul,user}/approve`.
- **Injection-scan policy is fail-soft.** A file that trips a threat pattern is replaced inline with a `[BLOCKED: <filename> contained potential prompt injection (<reasons>). Content not loaded.]` notice and a warning is appended to the runtime trace. The gateway must keep running — a hostile USER.md must not lock the user out of their own instance.
- **INSTRUCTIONS.md is user-only.** The agent has no tool to edit it. The bundled `src/runtime/defaults/INSTRUCTIONS.md` remains shipped with the runtime so a fresh instance has a working preamble without filesystem setup.
- **Scaffold asymmetry.** At instance creation `install()` seeds `INSTRUCTIONS.md` with the bytes of the bundled `src/runtime/defaults/INSTRUCTIONS.md` so the user opens the file to a working baseline they can edit against — an empty file gives them nothing to anchor on. `USER.md` stays zero-byte because no default exists (a user profile is inherently caller-supplied). Per-agent `SOUL.md` is seeded with `Your name is <name>.` (from `AgentRecord.name`) so a new agent self-identifies by its own name; the rest of the persona is caller-supplied. The seed never clobbers a populated SOUL, so a user/agent-authored body is preserved. Drift cost: a user who never edits the seeded `INSTRUCTIONS.md` is frozen at install-time defaults even as the bundled file evolves on later Gini upgrades. The escape hatch is deletion — removing the file restores the bundled fallback path at the next chat turn.
- **Subagents are unaffected.** Subagents continue to receive `subagent.systemPrompt` as an override and do not see the three files. The override path is intentional — a subagent's persona is its parent's responsibility.

## Read and Write Semantics

- **Read (chat-task and provider paths):** `loadInstructions(instance)` is called once per turn; `loadSoul(instance, agentId)` is called only for the active agent (resolved via `resolveEffectiveContext`); `loadUserProfile(instance)` is instance-scoped. All three return the scanned content (or a BLOCKED notice). The chat-task path defers to the existing chat-session machinery for everything else.
- **Write (proposed):** the tool handler writes `<file>.proposed` atomically (write-and-rename). The audit row records `identity.soul.proposed` or `identity.user_profile.proposed` with the actor `agent`, the target file path, and a content excerpt.
- **Write (approved):** the approval API renames `<file>.proposed` over `<file>` atomically and writes an `identity.<file>.approved` audit row with actor `user`. The proposal file is consumed by the rename and is no longer present after approval.
- **Concurrent writes:** within a single instance, write contention is rare (one user editing through the UI). The write-and-rename pattern is the same one `state.ts` uses for the canonical state file.

## Consequences

- **Behavior change:** the agent's operating rules become user-editable. A fresh instance behaves identically to the bundled defaults because `INSTRUCTIONS.md` is absent and the bundled file is the fallback. The bundled file is the single source of truth — the scaffolder copies its bytes verbatim and the runtime reads from it on every fresh install.
- **Per-agent persona is on-disk.** Switching agents picks up that agent's `SOUL.md`. User identity is preserved because `USER.md` is instance-scoped.
- **Audit and trust surface grows.** Three new audit actions cover the propose / approve lifecycle. The injection scan provides a documented trust boundary on user-controlled files that ride the system prompt.
- **State growth is bounded.** Three files per instance plus one `SOUL.md` per agent. None are stored in `state.json`. Per-write history snapshots accumulate under `<file>.history/` directories with a 50-entry retention cap; see ADR [identity-file-long-horizon-design.md](./identity-file-long-horizon-design.md).
- **Long-horizon hygiene is deliberate.** USER.md and SOUL.md ride into the system prompt under a budget header (`N / 1500 chars, X%`) so the model can self-manage consolidation. Every approved write snapshots the previous body so the user can roll back via `gini identity rollback`. See ADR [identity-file-long-horizon-design.md](./identity-file-long-horizon-design.md) for the full design.

## Alternatives Considered

- **One `IDENTITY.md` carrying all three concerns.** Rejected. Operating rules (the model's behavior contract), persona (the agent's voice), and user identity (who the user is) have different scopes and different edit policies. Collapsing them would either force per-agent operating rules (defeating the instance-level baseline) or instance-level persona (breaking the multi-agent product story).
- **Persist file content inside `state.json`.** Rejected. Markdown is human-edited; round-tripping through JSON serialization adds friction for what should be `vim ~/.gini/instances/<inst>/USER.md`.
- **Gate every `SOUL.md` write behind explicit approval.** Rejected. `SOUL.md` and `USER.md` use the same policy: clean bodies auto-approve (effective immediately), and the injection scanner routes hostile bodies through `.proposed`. The persona surface changes every turn, but a clean persona edit is the user shaping their own agent — making them approve their own non-hostile change is friction, not safety. The scanner-gated `.proposed` split is what keeps a tainted body out of the prompt.
- **Apply the injection scan only to `SOUL.md`.** Rejected. All three files reach the system prompt; all three need the same scan. A user pasting a hostile USER.md from a stranger is the realistic threat — same shape as the Hermes context-file model.

## Acceptance Checks

- A fresh instance with no per-instance identity files present produces a system prompt that contains the trimmed bytes of the bundled `src/runtime/defaults/INSTRUCTIONS.md` and no SOUL/USER blocks.
- Writing `~/.gini/instances/<inst>/INSTRUCTIONS.md` with custom content causes the next chat turn to use that content in place of the bundled defaults.
- A `gini install` against a fresh instance copies the bytes of `src/runtime/defaults/INSTRUCTIONS.md` into `~/.gini/instances/<inst>/INSTRUCTIONS.md` byte-for-byte (the scaffold and runtime fallback never drift).
- If `src/runtime/defaults/INSTRUCTIONS.md` is removed from the bundle, both `getDefaultGiniInstructions()` and `scaffoldInstanceIdentityFiles()` throw with a clear "default INSTRUCTIONS.md missing from bundle" message rather than silently falling back to an empty preamble.
- Creating an agent seeds `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` with `Your name is <name>.`; the default agent is named "Gini" so its SOUL is seeded `Your name is Gini.`. On each gateway boot `install()` backfills the same line for any existing agent whose SOUL is absent or empty, never clobbering a populated SOUL.
- Writing `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` causes the next chat turn (under that active agent) to include the SOUL block after the instructions and before the identity block.
- Writing `~/.gini/instances/<inst>/USER.md` causes the next chat turn to include the USER block ahead of any Hindsight-recalled context.
- A file containing `ignore previous instructions` is replaced in the prompt by `[BLOCKED: <filename> contained potential prompt injection (prompt_injection). Content not loaded.]` and a warning is emitted to the runtime trace.
- `edit_soul` writes a clean body directly to SOUL.md and emits `identity.soul.approved` with `autoApproved: true`; a body the injection scanner flags lands at SOUL.md.proposed instead and emits `identity.soul.proposed` (operator promotes via `POST /api/identity-files/soul/approve`).
- `edit_user_profile` writes a clean body directly to USER.md and emits `identity.user_profile.approved` with `autoApproved: true`; a body the injection scanner flags lands at USER.md.proposed instead and emits `identity.user_profile.proposed` (operator promotes via `POST /api/identity-files/user/approve`).
- `bun run typecheck`, `bun test`, and `bun run gini smoke` are green.

## Critical Files

- `src/runtime/defaults/INSTRUCTIONS.md` — the canonical default operating rules. Single source of truth: the runtime fallback reads it (trimmed, memoized) and the scaffolder copies it bytes-as-is into freshly-installed instances.
- `src/system-prompt.ts` — `getDefaultGiniInstructions()` + `DEFAULT_INSTRUCTIONS_PATH` + `sanitizeAgentName()`; `buildAgentSystemContext` accepts `instructionsOverride`, `soul`, `userProfile`.
- `src/runtime/identity-files.ts` — load/write/scan helpers; `scaffoldInstanceIdentityFiles` reads the bundled defaults file once per call; `seedAgentSoulFile` seeds the per-agent name into `SOUL.md`.
- `src/capabilities/agents.ts` (`createAgent`), `src/runtime/index.ts` (`install()`) — seed/backfill the per-agent SOUL name.
- `src/execution/chat-task.ts`, `src/provider.ts` — call sites that load and forward the three files.
- `src/execution/tool-catalog.ts`, `src/execution/tool-dispatch.ts` — `edit_soul` and `edit_user_profile`.
- `~/.gini/instances/<inst>/INSTRUCTIONS.md`, `~/.gini/instances/<inst>/USER.md`, `~/.gini/instances/<inst>/agents/<agentId>/SOUL.md` — the on-disk artifacts.
