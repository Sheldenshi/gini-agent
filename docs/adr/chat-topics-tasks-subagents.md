# ADR: Chat → Topics → Tasks → Subagents

- **Status:** Proposed (decisions locked 2026-06-25; implementation in progress)
- **Date:** 2026-06-25
- **Supersedes / reverses:** [One Chat Per Agent, Threads, And Job Channels](./agent-chat-threads-and-channels.md) (threads-as-tags and one-canonical-chat are reversed)
- **Updates:** [Bounded Chat Context Window](./chat-context-window.md) (per-session soft thread-priority packing becomes per-topic hard isolation)
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Reorganize the conversation model from **one chat per agent + threads-as-tags** into a
four-level hierarchy:

```
Chat ──(1:N)──> Topics ──(1:N)──> Tasks ──(1:N)──> Subagents
```

- **Chat** is a *special, always-present Topic* and the user's main interface. It does
  **not** own the working context for substantive requests. It is a **router + inbox**:
  it classifies each user message (answer-here / open-new-topic / continue-existing-topic),
  dispatches the work into the chosen **Topic**, and surfaces the Topic's **final** answer
  back in Chat, tagged with the Topic (a forwarded, deep-linkable chip).
- **Topic** is a session whose context is **fresh and isolated to that subject**. It is a
  first-class `ChatSessionRecord` with its own `chat_blocks` ordinal stream, SSE, read
  state, APNs routing, and — the load-bearing win — its **own context window**. Topics
  are started by Chat, by a Job, or by another Topic. A Topic has access to all skills and
  memory. This is what actually fixes "the context window is always filled with irrelevant
  information": each Topic replays only its own transcript.
- **Task** is a unit of delegated work a Topic creates, with explicit task-states. Input:
  prompt, goal, context, tools, skills, memory. Output: success / fail result, **or
  "additional input needed."** A Task owns one-or-more Subagents.
- **Subagent** does the actual unit(s) of work, started by a Task and returning to a Task.
  Input: prompt, context, tools, skills, memory. Return: success / fail result, or
  additional input. The simplest Task is a single Subagent.

This **reverses** the central decision of `agent-chat-threads-and-channels.md` ("**no new
session per thread** — threads ride the same ordinal stream"). The whole reason that ADR
chose tags-on-one-stream was to reuse the ChatBlock protocol; a Topic-as-session gets the
**same** reuse at the granularity the protocol was designed for, *plus* genuine context
isolation, which tags can never give.

## Context — why threads fail

Two flaws, both rooted in one structural fact (one transcript per agent):

1. **Agent-started threading is unpredictable.** Routing is decided *mid-turn* by the model
   calling `start_thread` (or emitting `<route>thread</route>`). The model fires it
   inconsistently, and when it does, the thread roots on whatever message triggered it, so
   related work scatters across messages and threads are hard to track. (Routing is a
   model behavior, not a structural guarantee.)
2. **The context window fills with irrelevant info.** Because every thread is a tag on the
   *one* agent session, every turn replays that one giant transcript. `chat-context-window.md`
   only *softens* this with thread-priority packing (`groupPriority`, `activeThreadId`):
   unrelated threads are *deprioritized*, not *excluded* — they still enter the budget if
   they fit. There is no hard per-subject isolation.

Topics fix both at the source: routing moves **up** (Chat picks a Topic at intake, before
any work streams) and context moves **out** (a real separate session = a real separate
window). The flaky mid-turn `start_thread` decision and the thread-priority packing
heuristic both **disappear** rather than getting patched.

## How the new model maps onto existing primitives

The redesign is mostly a **promotion and re-wiring** of things that already exist, not a
greenfield build:

| New concept | Closest existing thing | Gap to close |
|---|---|---|
| **Topic** | `kind:"channel"` job session (a real session with its own stream) | Generalize beyond jobs; add `kind:"topic"` + `kind:"chat"`; give it a title/summary + findable identity |
| **Chat** | the `kind:"agent"` canonical session (`getOrCreateAgentChat`) | Stop being the context owner; become a router/forwarder; keep "one per agent" |
| **Task** | the parent `Task` that calls `spawn_subagent` | Add explicit task-states + a typed `{prompt,goal,context,tools,skills,memory}` input and a structured `{success|fail|needs_input}` return |
| **Subagent** | `SubagentRecord` + `spawnSubagent` (constrained child task, fresh narrow context) | Already the right shape; add the "needs input" return variant; elevate its fresh-context property to the Topic tier |
| **Forward topic→chat** | job `finalize.ts` mirror + the "from \<job name\>" web/mobile segment badge | Generalize into a reusable Topic→Chat forwarder ("from #topic" + "View topic →") |
| **Per-topic context window** | `priorChatMessages` already filters `m.sessionId === sessionId` | Once Topic = session, isolation is automatic; delete thread-priority packing |
| **Chat reply → existing topic** | — (net new) | The hard problem: subject→topic resolution + cross-session dispatch + forward-back |

## Data model

### Session kind

`ChatSessionRecord.kind` (`src/types.ts`) extends from `"agent" | "channel"` to add
**`"topic"`** — and **Chat is the existing `kind:"agent"` session**, kept as-is (it is
already the single always-present per-agent chat). We deliberately do **not** rename
`"agent"`→`"chat"`: `kind` is consulted in dozens of value checks across the gateway, web,
and mobile (`isOpenableJobChannel`, `unreachableSessionIds`, the sidebar/rails,
`getOrCreateAgentChat`), and a value rename would churn all of them for no behavioral gain.
The `kind:"agent"` session simply *plays the Chat role* in the new IA (surfaced as
"Messages").

- **`"agent"`** — Chat: the single always-present per-agent chat (unchanged; resolved by
  `getOrCreateAgentChat`, which only manages `kind:"agent"` sessions and therefore never
  demotes Topic siblings).
- **`"topic"`** — a subject-scoped session (new). Carries:
  - `topicTitle` — the `#name` shown in the sidebar.
  - `topicSummary?` — a short rolling summary used for routing/retrieval (embedded).
  - `parentChatSessionId?` — the Chat that spawned it (for forward-back).
  - `origin?: "job"` for job-spawned Topics.
- **`"channel"`** — legacy job channel; folds into `"topic"` during the Jobs→Topics phase
  (kept readable until then).

`normalizeState` keeps existing `kind` values (no `"agent"`/`"channel"` rewrite) and only
nulls legacy thread tags (Decision 3).

### Topic record vs. session extension

**Recommended: a Topic IS a `ChatSessionRecord`** (a `kind:"topic"` session), not a new
`TopicRecord` table. Rationale: per-topic context isolation, the block stream, SSE,
`Last-Event-ID` resume, read-state, badge, and APNs all already key on `session_id` — a
Topic-as-session inherits all of it for free. A parallel `TopicRecord` would re-derive that
machinery (the exact mistake the threads ADR avoided, now applied correctly at session
grain). The cross-store caveat (sessions in JSON `RuntimeState`, blocks in SQLite) is
unchanged.

### Task / Subagent

- `Task` gains an explicit task-state lifecycle distinct from raw `TaskStatus` and a typed
  input envelope `{prompt, goal, context, tools, skills, memory}`. The new **`needs_input`**
  non-terminal state lets a Task bubble "additional input needed" up to its Topic (today the
  only non-terminal pause is `waiting_approval`).
- Subagent return becomes structured `{status, result | needsInput}` instead of the current
  `resultSummary`/`resultError` strings.
- The `parentTaskId` chain + `subagentDepth` cap (max 3) and `agentId` inheritance survive;
  inserting the Task tier must preserve the depth-walk shape.

### Forwarding

A **forward** copies/links a Topic's final `assistant_text` into the Chat session as a
forwarded block tagged with `topicId` + `topicTitle`, rendered as a "from #topic ·
N messages · View topic →" chip (generalizing the existing "from \<job name\>" segment).
The reverse — a Chat reply routed into a Topic — mirrors the user message into the Topic,
runs the turn in the Topic's context, and forwards the answer back. `transcriptSessionId`
for `persistFinalAnswerRow` must point at the **Topic** (replay correctness), even though
the user saw the answer in Chat — getting this wrong re-introduces the "re-answers the
previous question" bug across two sessions.

## Routing (the hard, net-new mechanism)

When a user posts in **Chat**, a lightweight **router** decides one of:

1. **answer-in-chat** — trivial/conversational; Chat answers directly, no Topic.
2. **open-new-topic** — a new subject; mint a `kind:"topic"` session, run the work there,
   forward the final answer back to Chat.
3. **continue-existing-topic** — find the right Topic for this subject and dispatch into it
   (the "drafted an email, then later 'book the game tickets' → find the world-cup Topic"
   case), then forward back.

**Mechanism (hybrid):** an embedding/recall pre-filter over Topic
`topicSummary`/`title` surfaces candidate Topics; a small **structured router call**
(`routeChatMessage`, built like the chat-title generator `generateChatTitleFromBlocks`)
makes the final 3-way decision with those candidates in context, returning
`{decision: "chat"|"new_topic"|"existing_topic", topicId?, title?}`. The decision happens
**at intake** (it selects which transcript loads) instead of mid-stream (tagging
already-streamed blocks). A structured classifier is used instead of agent control tools
because the decision must precede context loading and a forced structured output is more
reliable than hoping the agent calls a tool. The new-vs-existing-vs-inline bias lives in
the router's own prompt, not in hard-coded heuristics.

## Jobs → Topics

A Job **creates a Topic** (today it mints a `kind:"channel"` session — the same act,
renamed). "Deliver to chat" stops being a `chatSessionId` *re-pointer* onto the user's
conversation and becomes a **forward flag** (`job.forwardToChat`) on top of the always-
present `job.topicId`: each fire runs in the Job's Topic and *forwards* its final message
into Chat tagged with the Topic. Consequences:

- The chat-bound **deferral-by-skip** (`runDueJobs` skipping a due job while the chat has a
  live turn) is no longer needed for non-forwarded delivery — a job runs in its own Topic,
  never on the live Chat turn's ordinal range. It survives, if at all, only as a narrow
  "don't forward into Chat mid-turn" guard at the forward step.
- The rebind-archive-channel branch is removed (the Topic is never archived just because
  delivery moved to Chat). Channel-archive-on-job-delete stays (the Topic dies with the job).
- `outboundMirror`/`source`, `deliveryTargets`, `[SILENT]`, oneShot, and fan-out routes
  (each route → a sub-Topic) carry over.

## Client contract

- **Sidebar:** a **"Topics"** section (the Pencil design) lists `#name` Topics with unread
  badges, plus the single **"Messages"** (Chat) entry. The cross-agent `/threads` inbox
  becomes a Topics list. Channels fold into Topics.
- **Main Chat:** forwarded Topic results render in a highlighted block with a "#topic ·
  N messages · View topic →" chip. "Reply in thread" becomes **"Continue as a topic."**
- **Topic view:** structurally the existing pinned-`?session=` channel view, retitled with
  the Topic header ("#topic · N messages") and an "Also send to main" affordance.
- **New/changed routes:** `GET /api/agents/:id/chat` (now resolves the Chat root);
  `GET /api/topics` (replaces `/api/threads`); `POST /api/chat/:id/messages` gains routing;
  a forward/route endpoint; the `/api/chat/:id/threads*` routes become topic routes. Every
  wire change (`topicId`/forward marker, any Task/Subagent block kind) must update **both**
  web and mobile renderers (the dual-renderer rule; mobile's `BlockRenderer` `never`-guard
  catches new block kinds but not new fields).
- **Read-state:** session-level store applies per-topic unchanged; the per-thread
  localStorage store is replaced by per-topic keys (re-seed to avoid an all-unread flash).

## Migration

- `kind:"agent"` session → `kind:"chat"` (the renamed root). Untagged main-chat blocks stay.
- `kind:"channel"` job session → `kind:"topic"` (trivial backfill — already separate sessions).
- Jobs whose `deliverTo:"chat"` pointed `chatSessionId` at the user's conversation get a
  **minted Topic** + `forwardToChat=true` (they have no dedicated Topic today).
- **Legacy threads:** *recommended* — freeze in place, readable as-is; new subjects become
  Topics. Converting each `(sessionId, threadId)` span into a standalone Topic session
  requires re-homing blocks into new sessions with re-based ordinals (the `UNIQUE(session_id,
  ordinal)` invariant) — a real data migration, not an additive column change. (Alternative:
  do the conversion; heavier and riskier.)
- In-flight tasks carry `toolCallState`/`bootResumeCount` and resume on restart — migration
  must not strand them.

## Resolved decisions (locked 2026-06-25)

1. **Topic creation is agent-decided per message.** A 3-way router (answer-in-chat /
   open-new-topic / continue-existing-topic) classifies each Chat message; the bias lives in
   the router's prompt (a structured intake classifier), not a hard rule.
2. **Routing is hybrid.** Embedding recall over Topic `topicSummary`/`title` surfaces
   candidate Topics; a small structured router call (`routeChatMessage`) makes the final
   3-way decision, returning `{decision, topicId?, title?}`.
3. **Legacy threads are converted into the linear Chat history** — not displayed as threads,
   and not split into separate Topic sessions. Their `thread_id`/`parent_block_id` tags are
   nulled so the blocks read as one linear Chat history in ordinal order; new subjects become
   Topics. (No block re-homing / ordinal re-basing — the blocks already share the agent
   session's one ordinal stream, so this is a nulling backfill.)
4. **The full hierarchy ships, including the Task tier.** Topics + routing + forwarding +
   context isolation + Jobs→Topics **and** the explicit Task state-machine (`needs_input`
   structured return). Thorough automated tests plus a live-gateway dogfood gate each phase.

## Phasing (proposed)

1. **Topic data model + per-topic context isolation** — `kind:"chat"|"topic"`,
   `getOrCreateChat`, `createTopic`, scope the packer to the topic session, delete
   thread-priority packing; `normalizeState` backfill. (Backend; the core win.)
2. **Chat→Topic routing + forwarding** — the router (open/route + retrieval), the
   topic↔chat forward bus, cross-session queue handling.
3. **Jobs → Topics** — job creates a Topic; `forwardToChat`; retire deferral-by-skip.
4. **Task-tier formalization** — explicit Task states + `needs_input` structured return.
5. **Clients (web + mobile)** — Topics sidebar, topic view, forwarded-topic chip,
   "Continue as a topic"; remove/repurpose thread UI (dual-renderer).
6. **Remove thread machinery + ADR finalization + tests + live dogfood.**

## Consequences

Pro: the two flaws are solved structurally, not patched; per-topic context windows; the
ChatBlock protocol is reused at the right granularity; jobs/channels unify with topics;
thread-priority packing and the flaky mid-turn `start_thread` decision are deleted.

Con: routing is a new model-driven step at intake (a latency/cost tradeoff for trivial
messages, mitigated by the answer-in-chat path); a Chat reply that runs in a Topic is a
two-session turn no current path models (queue, run-scoping, forward-back must be exact);
legacy threads either freeze or require a real data migration; the Task tier adds a record
layer that must preserve the `subagentDepth` chain.

## Acceptance checks

(to be finalized as phases land — will include: per-topic context isolation test; router
3-way decision test; topic↔chat forward round-trip test; job→topic→forward test; migration
backfill test; web + mobile topic-view render; live-gateway dogfood of the world-cup-trip
flow and the cross-topic "book the game tickets" resume.)
