# ADR: Server-Side Chat Message Queue

## Decision

A chat session serializes its turns through a **per-session FIFO message queue owned by the gateway**. While a session has an in-flight chat task, a newly posted message is enqueued on the session record (`ChatSessionRecord.pendingMessages: PendingChatMessage[]` in `src/types.ts`) instead of starting a concurrent task. When the current turn ends — for any reason — the next queued message auto-dispatches as its own real chat turn (one per turn). The queue is part of durable session state and propagates to every client over the existing `chat_session` SSE event.

## Context

Before this decision, two messages posted to the same session ran their tasks CONCURRENTLY: `submitChatMessage` always created a run + task immediately, with no per-session serialization. The UI papered over this by turning the composer's Send button into a Stop button while a turn was in flight and making a second submit a client-side no-op, but that was a per-client guard, not a runtime invariant — messaging bridges, the CLI, and a second device could all still drive concurrent turns into one session.

The product requirement is a visible message queue: while the agent is mid-turn, the user can keep typing and submitting follow-ups, which stack into a queue (rendered as an expandable "N Queued" pill above the composer) and auto-send one per turn as each turn finishes.

## Why server-side, not client-side

The gateway owns durable state and execution; web, mobile, CLI, and messaging bridges are thin clients of the same `/api/*` contract. Putting the queue on the session record (rather than in each client's local state) means:

- **Implement the policy once.** Web and mobile render the same queue from the same session state instead of each reimplementing enqueue/drain logic.
- **It survives reload and is consistent across devices.** A queued message typed on a phone is visible on the desktop, and a page refresh doesn't lose the queue.
- **It drains even when no client is watching.** Auto-dispatch is driven by task lifecycle on the gateway, so the queue advances whether or not the app is foregrounded.
- **It fixes the latent concurrent-task bug.** Serialization is now a runtime invariant for every surface, not a web-composer affordance.

## Data model

`PendingChatMessage` (`src/types.ts`) is `{ id; content; images?; clientSurface?; createdAt }`. Audio is intentionally absent: a voice message is transcribed to `content` during `prepareChatSubmission`, so only the resulting text plus image refs are queued. `pendingMessages` is optional on `ChatSessionRecord` so existing persisted state stays valid without a migration.

The state helpers operate on `RuntimeState` inside a `mutateState` callback, matching the sibling record helpers (`src/state/records.ts`): `enqueuePendingChatMessage`, `removePendingChatMessage`, `shiftPendingChatMessage`, and `sessionHasInFlightChatTask` (true when `state.tasks` has any task for the session whose status is not terminal — queued/running/waiting_approval all count as in-flight).

## Enqueue policy

`submitChatMessage` (`src/execution/chat.ts`) runs `prepareChatSubmission` first, so audio transcription and content/image validation surface errors at enqueue time exactly as on the run-now path. It then enqueues when **either** the session has an in-flight chat task **or** its `pendingMessages` is already non-empty — the second condition keeps a later submit from jumping ahead of earlier queued messages while the current turn runs. On enqueue it appends inside `mutateState`, publishes the updated session via `publishChatSession`, and returns `{ sessionId, queued: true, pendingId }`. Otherwise it delegates to the shared run-now body.

`runChatSubmission(config, sessionId, prepared)` is the extracted run-now body (create the conversation run, `submitTask`, link the run, persist the user `ChatMessageRecord` + `user_text` `ChatBlock`). Both the immediate path and the auto-dispatch path call it so a queued message becomes an identical real turn when it runs.

## FIFO one-per-turn auto-dispatch

`dispatchNextPendingChatMessage(config, sessionId)` pops the first pending message (FIFO), publishes the shrunk queue, then runs it via `runChatSubmission`. A run failure is logged (`chat.queue.dispatch_failed`) and swallowed so one bad turn doesn't crash the dispatch chain — the remaining queue stays intact for the next terminal transition.

Dispatch is driven from a **single chokepoint** in `submitTask` (`src/agent.ts`): the fire-and-forget `runTask(...)` chain gets a `.finally(...)` that, only for a top-level chat task (`options.mode === "chat" && options.chatSessionId && !options.parentTaskId`), calls `dispatchNextPendingChatMessage`. `.finally` fires on every terminal transition: normal completion, failure (the preceding `.catch(failTask)` runs first), and user cancel (Stop → `cancelTask` makes `runChatTask` return so `runTask` resolves). Each dispatched message becomes the new in-flight task; when IT settles the chain fires again, so the queue drains one message per turn. Subagent and imperative tasks are excluded — they have no session queue.

### Stop drains the queue (current decision)

The queue advances whenever the current turn ends, **including a user Stop**. This is the uniform, simplest-to-reason-about rule ("the next queued message sends when the current turn finishes, however it finishes"); the per-item remove (×) button is the escape hatch for unwanted queued messages. The alternative — Stop clears the entire queue — was considered and not chosen; it is the natural place to revisit if the uniform rule proves surprising.

A negligible, documented residual race exists: between shifting the last pending message and the new task being created, a concurrent submit could run instead of enqueue. The window is sub-millisecond for a single user and degrades to the pre-queue concurrent behavior; no additional atomicity is layered on for it.

## Propagation

Every queue mutation publishes the full session over the existing `chat_session` SSE event (`publishChatSession`, `src/state/chat-session-events.ts`) on the `/api/chat/:id/stream` socket, so the queue pill updates live on every subscribed client. No new event type is introduced.

## HTTP

- `POST /api/chat/:id/messages` returns the run-now shape `{ sessionId, runId, taskId, status }` when the message runs immediately, and `{ sessionId, queued: true, pendingId }` when it is enqueued. Clients discriminate on the `queued` field.
- `DELETE /api/chat/:id/pending/:pendingId` removes a queued (not-yet-dispatched) message, publishing the updated session; returns `{ removed: true }` or 404 when the id isn't queued.

Messaging inbound (`src/integrations/messaging.ts`) tolerates the queued result: a bridge message enqueued behind an in-flight turn lands its `MessagingMessageRecord` with no task linkage (the task is created later at dispatch).

## Acceptance checks

- Idle session: `submitChatMessage` runs immediately (returns `taskId`, no `queued` flag); `pendingMessages` stays empty (`src/execution/chat-queue.test.ts`).
- Busy session (a non-terminal chat task seeded on the session): `submitChatMessage` enqueues (`queued: true` + `pendingId`, `pendingMessages` grows, no second task) (`src/execution/chat-queue.test.ts`, `src/http.test.ts`).
- A submit behind a non-empty queue with no running task still enqueues, preserving FIFO order (`src/execution/chat-queue.test.ts`).
- `dispatchNextPendingChatMessage` pops FIFO and runs the next message (creates a task + user row for the popped content; the queue shrinks); it is a no-op on an empty queue (`src/execution/chat-queue.test.ts`).
- `removePendingChatMessageById` removes the right item and returns false for an unknown id; the DELETE route maps that to 404 (`src/execution/chat-queue.test.ts`, `src/http.test.ts`).
- Two inbound bridge messages to the same session serialize through the queue and both land, in order, once it drains (`src/integrations/messaging.test.ts`).
