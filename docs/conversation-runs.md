# Conversation And Runs

Gini separates user interaction from execution tracking.

Chat is how a user naturally asks for work. Runs are how Gini records work that can be observed, retried, audited, and explained.

## Why Both Exist

Not every message is a task. Some messages are questions, clarifications, status checks, or exploratory planning. At the same time, many conversational requests create real work with multiple steps, tool calls, approvals, and outcomes.

Gini handles this by keeping chat as the interaction layer and creating durable execution records when the conversation causes work.

## Records

- **Chat session:** the conversation and its messages.
- **Run:** a durable execution unit created from chat, CLI, jobs, messaging, or another runtime source.
- **Plan step:** a visible step inside a run, with status and evidence.
- **Task:** compatibility and tool-execution record for work that needs task semantics.
- **Trace:** detailed execution evidence for tools, model calls, approvals, and state changes.
- **Audit event:** security and governance record for meaningful actions.

Chat turns can create `conversation_turn` runs with plan steps and linked compatibility tasks. This preserves the seamless chat feel while keeping observability, approvals, retry, jobs, traces, and audit available.

Chat history and model context are deliberately separate. Gini keeps the
complete conversation durable, including chat blocks, tool transcripts,
runs, traces, audit rows, and Hindsight memory. Each chat-task prompt gets a
bounded prior-history replay tail instead of the whole transcript once the
chat grows large; older exact details remain retrievable through
`search_history`, and durable facts remain retrievable through automatic
recall / `recall_memory` (see [Bounded Chat Context Window](./adr/chat-context-window.md)).

## Flow

```text
user message
  -> chat session/message
  -> run record when work is needed
  -> plan steps
  -> approvals/tool calls/traces/audit
  -> final response and durable outcome
```

The chat model does not need to be the same thing as the execution worker. The system can route execution through task agents, tools, jobs, or future subagents while the conversation remains the user's control surface.

## Current Surfaces

- `gini chat new/send/sync/show/list`
- `gini runs list/show`
- `/api/chat`
- `/api/runs`
- `/api/tasks`
- `/api/events/stream`
- `gini trace`
- `gini audit`

## Design Direction

- Keep decomposition visible but not rigid.
- Do not force every conversational exchange into a task.
- Make retries and approvals operate on durable run/task state, not transient chat text.
- Let future mobile, messaging, and MCP clients create the same records through the gateway.
