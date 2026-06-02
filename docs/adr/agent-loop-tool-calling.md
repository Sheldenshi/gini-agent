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
  on pause so a reader can see which catalog the resume runs against (the
  hash is telemetry, not enforced on resume).
- Catalog tools may be marked `deferred`: their schemas are withheld from
  the live provider `tools` array until the model loads them by name via
  the core `load_tools` meta-tool, which the loop handles inline and
  persists on `Task.loadedTools`. This keeps the live full-schema tool
  count low. See ADR deferred-tools.md for the mechanism, the
  persistence / resume contract, and which clusters are deferred.
- `src/execution/tool-dispatch.ts` is the per-tool handler: low-risk
  tools (`file_read`, `file_list`, `file_search`, `web_fetch`) execute
  synchronously and return a string; high-risk tools (`file_write`,
  `file_patch`, `terminal_exec`, `code_exec`, `browser_upload_file`,
  `send_message`) create an `Approval` with
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
- Approvals are the canonical writer for side effects.
  `dispatchToolCall` creates an approval row for every
  approval-eligible tool and `executeApprovedAction` is the only
  executor. The `approvalMode` policy seam (ADR approval-mode.md)
  decides whether each row pauses for a human or auto-resolves:
    - The terminal allowlist (`autoApproveCommands`) skips approval-
      row creation entirely for matching commands and stamps the
      matched pattern on the `terminal.exec` audit row's
      `evidence.autoApprovedReason`.
    - Under `approvalMode: "auto"`, safe actions
      (file_write, file_patch, code_exec, browser_upload_file,
      send_message) and non-dangerous terminal commands
      still create an approval row, but `resolveApprovalPolicy`
      auto-resolves it through the same `resolveApproval` ->
      `executeApprovedAction` pipeline a human would take. The
      `approval.approved` and per-action audit rows carry
      `evidence.autoApprovedReason="approval-mode-auto"`.
    - Under `approvalMode: "yolo"`, every approval-eligible action
      auto-resolves with `evidence.autoApprovedReason="approval-mode-yolo"`.
    - Dangerous-pattern hits under `"auto"` still gate; the matched
      pattern id surfaces on the approval row's `reason` field so
      operators see WHY they're being asked.

## Durable tool-calling transcript

The model sees its own prior tool calls and results across turns. Each
turn's assistant `tool_calls` message and every paired `role:"tool"`
result are persisted durably as `ChatMessageRecord` rows tagged
`kind:"tool_transcript"` (the store gains a `"tool"` role plus inline
`toolCalls` / `toolCallId` / `seq` fields). `priorChatMessages` replays
the full ordered transcript — user/assistant text interleaved with the
assistant→tool pairs — sorted by `(createdAt, seq)`, so the model can
reference a structured result it produced earlier (a created issue's id)
and so an invoked skill body (`read_skill`) stays in context instead of
being re-read every turn.

- Replay applies a defensive pairing pass: each `role:"tool"` row is
  grouped under the assistant `tool_calls` row that emitted its id;
  orphan tool rows and assistant rows missing any paired result are
  dropped, so a partially-persisted turn can never produce a provider
  400 on the ordering invariant.
- These rows are model-facing replay state, **not** the human-facing
  transcript. The chat UI renders from the ChatBlock stream (ADR
  chat-block-protocol.md), and the JSON view-builders in
  `src/execution/chat.ts` (`getChatSession`, `listChatSessions`) plus
  `syncChatTaskResult`'s terminal-summary short-circuit all exclude
  `kind:"tool_transcript"` rows, so they never leak into or corrupt
  what the user sees.

## Deferred

- Skill-driven tool exposure. Beyond the deferred-tools mechanism above
  (which loads tool schemas on demand by name), tools could be injected
  per-skill so a skill body brings its own tool surface into the catalog.
- Subagent spawn as a tool. Slice 4 will add `spawn_subagent` to the
  catalog and map it through this same loop.
- Codex tool calling (responses API supports it; we'd need a separate
  parser).
- Transcript compaction. The replayed transcript (see "Durable
  tool-calling transcript" below) grows unbounded, the same way prior
  text history already does. A future ADR can introduce
  summarization-based compaction (e.g. re-attach the most-recent skill
  body after a summary boundary) to bound the model-facing window.

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
- A tool result from turn 1 (a returned id, a `read_skill` body) appears
  in turn 2's replayed provider messages as a `role:"tool"` row paired
  with its assistant `tool_calls` row, while the JSON chat views exclude
  every `kind:"tool_transcript"` row.
- `bun run typecheck` and `bun test` are green.
