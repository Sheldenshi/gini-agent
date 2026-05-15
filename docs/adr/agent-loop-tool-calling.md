# ADR: Agent Loop With Native Tool Calling

## Decision

Chat-mode tasks run through a real agent loop: the runtime calls the LLM
with the OpenAI-style native `tools` array, dispatches each returned tool
call against an in-process catalog, and feeds tool results back to the
model until the model produces a final text answer. Approval-gated tools
pause the loop; the runtime persists a snapshot of the in-flight messages
on the task and resumes the loop after the user approves and the side
effect runs.

The legacy prefix-dispatch path in `runTask` (`write `, `read `, `shell `,
…) stays for the imperative CLI.

## Context

Until now, chat messages went through the same single-shot
`generateTaskSummary` codepath as the CLI. The model produced text only;
tools were "invoked" by sniffing for a prefix on the user's input. That
made the chat surface unable to:

- chain a read with a follow-up answer in the same turn,
- decide *when* to use a tool based on the conversation,
- match Hermes's skill-driven behavior, which assumes the LLM can call
  tools natively from a system-prompt-supplied skill body.

Slice 2 (skill loader) and Slice 3 (apple-notes / apple-reminders) both
require a real tool-calling loop. Slice 4 (subagents) wants to spawn
through the same loop. So the loop comes first.

## Required Now

- `Task.mode` distinguishes `chat` and `imperative`. `submitTask` accepts
  a `{ mode }` option; chat callers (`submitChatMessage`) set it.
- `runTask` dispatches `mode === "chat"` to `runChatTask` in
  `src/execution/chat-task.ts`. Imperative tasks keep the prefix-dispatch
  branch.
- `generateToolCallingResponse` in `src/provider.ts` is the provider-level
  entry: it speaks `/chat/completions` with a `tools` array, supports
  streaming (buffering tool-call argument deltas across SSE events), and
  surfaces `{ text, toolCalls, finishReason, usage, cost, responseId }`.
- The Codex (responses API) and echo providers fall back to text-only
  mode. Echo can be primed with a queue of canned tool-calling responses
  for tests.
- `src/execution/tool-catalog.ts` produces OpenAI-shape specs filtered
  by enabled toolsets. The catalog is hashed; the loop captures the hash
  on pause so a reviewer can see which catalog the resume runs against.
- `src/execution/tool-dispatch.ts` is the per-tool handler: low-risk
  tools (`file_read`, `file_list`, `file_search`, `web_fetch`) execute
  synchronously and return a string; high-risk tools (`file_write`,
  `file_patch`, `terminal_exec`, `code_exec`) create an `Approval` with
  the originating `tool_call_id` on `payload.toolCallId`.
- The loop snapshots the conversation on `Task.toolCallState` when at
  least one approval is pending, transitions the task to
  `waiting_approval`, and returns. `decideApproval` →
  `executeApprovedAction` runs the side effect, then calls
  `resumeChatTask(config, taskId, toolCallId, result)` for chat-task
  approvals. The loop continues from the next iteration.
- The loop cap is 8 iterations (counted across pauses). Hitting it
  marks the task `failed` with a clear error.
- All tool dispatches still write `audit` and `trace` records — same
  shape as the legacy path, with `(chat-task)` suffixes in trace
  messages so the timeline is unambiguous.
- Approvals stay the only path to side effects under default
  configuration: `dispatchToolCall` creates an approval row for
  high-risk tools and `executeApprovedAction` is the only writer.
  Two operator-configured bypasses are sanctioned and documented:
    - The terminal allowlist (`autoApproveCommands`) skips approval-
      row creation entirely for matching commands and stamps the
      matched pattern on the `terminal.exec` audit row's
      `evidence.autoApprovedReason`.
    - `dangerouslyAutoApprove` (ADR dangerously-auto-approve.md) still creates an approval
      row and runs through `executeApprovedAction`, but skips the
      human decision step; both the `approval.approved` audit row and
      the per-action audit row carry
      `evidence.autoApprovedReason="dangerouslyAutoApprove"` so
      reviewers can distinguish auto-approved from human-approved
      actions.

## Deferred

- Skill-driven tool exposure. The catalog is currently a static list;
  Slice 2 will inject skill-aware tools and make the catalog hash
  reflect skill set membership.
- Subagent spawn as a tool. Slice 4 will add `spawn_subagent` to the
  catalog and map it through this same loop.
- Multi-turn `tool` messages in the prior-message snapshot. Today we
  drop tool-result messages from prior turns and only re-include
  `user`/`assistant` text — keeps the context window lean at the cost
  of losing fine-grained tool history across turns.
- Codex tool calling (responses API supports it; we'd need a separate
  parser).

## Consequences For Coding Agents

- New side-effecting tools must follow the dispatch pattern: low-risk
  synchronous execution returns a string; high-risk paths create an
  approval with `payload.toolCallId` and let `executeApprovedAction`
  produce the result.
- The `tool_call_id` is the contract between the LLM and the runtime.
  Don't drop it on the approval payload — the resume path needs it to
  match the snapshot's pending entry.
- `Task.toolCallState` is large (a full message array). It is cleared
  on completion or failure. Any new branch that ends the loop must
  clear it too, otherwise completed tasks retain stale conversation
  snapshots in state.
- Streaming partial text into `task.partialSummary` still works: the
  loop debounces deltas the same way the legacy summary path did.

## Acceptance Checks

- `submitTask(config, "...", { mode: "chat" })` runs through
  `runChatTask`; `submitTask(config, "write x :: y")` runs through the
  prefix-dispatch path and creates a pending approval as before.
- A chat that triggers `file_write` transitions the task to
  `waiting_approval`, populates `toolCallState.pending`, and pauses.
- Approving the approval writes the file, calls `resumeChatTask`, and
  the model's next turn finalizes the assistant message.
- `bun run typecheck` and `bun test` are green.
