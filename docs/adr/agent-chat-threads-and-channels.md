# ADR: One Chat Per Agent, Threads, And Job Channels

- **Status:** Accepted
- **Date:** 2026-06-03
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Bounded Chat Context Window](./chat-context-window.md), [Mobile Push Notifications](./mobile-push-notifications.md)

## Decision

The Chats information architecture is reorganized around the agent, not
the session list:

- **One chat per agent.** Each agent has a single canonical chat. The
  session list is gone from the UI; selecting an agent opens its one
  chat directly.
- **Threads are tagged spans of that one session.** A thread is a span
  of `chat_blocks` inside the agent's single session, tagged with a
  `thread_id` and rooted at the main-chat block it branched from
  (`parent_block_id`). An agent-routed thread roots at the turn's own
  `user_text` block, so the thread chip renders directly under the message
  the user sent and the thread reads human → agent. A turn with no human
  message (an autonomous job/channel fire) does **not** thread — the agent
  never seeds a thread off its own message; it answers in the channel's
  main timeline, and threading resumes when the user replies in that
  channel (that turn has its own `user_text` block). A user-started "Reply
  in thread" roots at the `assistant_text` block the user branched from.
  There is **no new session per thread** —
  threads ride the same ordinal stream, SSE, and APNs the ChatBlock
  protocol already provides (see ADR chat-block-protocol.md).
- **The agent decides routing.** The agent calls a `start_thread`
  control tool to branch the current turn into a thread; a leading
  `<route>thread</route>` text directive is a silent fallback. Both root
  the thread at the current turn's `user_text` block so the reply stays
  discoverable beside the prompt that triggered it. A user reply posted
  into a thread always stays threaded — user context wins over any
  routing signal. Because the turn opened in the main chat (its
  `user_text` and a `Thinking` phase already landed there before the
  branch), the switch closes that originating main-chat turn with a
  terminal phase — the turn's work and its own terminal phase continue in
  the thread, so the main chat's in-flight indicator never strands on
  `Thinking`.
- **Channels are job sessions surfaced as chats.** A recurring job's
  dedicated session is surfaced in the rail as a chattable channel
  (`kind:"channel"`, `origin:"job"`). It is a view over the existing
  job session, not a new record type.

This is additive to the persistence layer: `memory.db` schema bumps
8 → 9 with two nullable columns on `chat_blocks` (`thread_id`,
`parent_block_id`) plus one index, and `ChatMessageRecord` carries
optional `threadId` / `parentBlockId` for provider replay. The ChatBlock
protocol — block shapes, the SSE stream, `Last-Event-ID` resume, the
`UNIQUE (session_id, ordinal)` invariant — is unchanged.

## Context

The prior IA gave each agent an unbounded list of chat sessions. A user
who returned to an agent had to remember which session held which line
of work, and a long-running back-and-forth (a research task, a
debugging investigation) buried the rest of the conversation in a flat
transcript. The product direction is the inverse: one durable chat per
agent that stays scannable, with side conversations branched out as
threads — the Slack model — and recurring jobs surfaced as channels you
can also chat into.

The naive implementation — one session per thread — would have forced
every thread to re-derive the ChatBlock machinery: its own ordinal
stream, its own SSE subscription, its own APNs routing, its own
block-grouping. It would also have split a single agent conversation
across many `ChatSessionRecord`s, which is exactly the fragmentation the
"one chat per agent" goal is trying to remove. Treating a thread as a
*tag on existing blocks within the one session* keeps the entire chat in
one ordinal stream and lets every existing client behavior carry over
untouched.

## Data Model

### Session kind

`ChatSessionRecord` gains `kind?: "agent" | "channel"` (in
`src/types.ts`), distinct from `source?.kind` (the messaging-bridge
kind):

- `"agent"` — the single canonical chat for an agent.
- `"channel"` — a recurring-job-derived session (always also carries
  `origin: "job"`).
- `undefined` — a legacy/non-canonical session. The new UI treats
  undefined as **hidden** (not deleted) — legacy multi-session history
  is preserved on disk but not surfaced.

`getOrCreateAgentChat(instance, agentId)` (`src/execution/chat.ts`) is
the one resolver for an agent's canonical chat. It runs inside a single
`mutateState` and:

1. validates the agent exists (`throw "Agent not found"` → 404 — an
   arbitrary `agentId` must not mint a session);
2. among sessions already tagged `kind:"agent"`, returns the
   most-recently-updated one that has history (non-empty
   `messageIds`/`taskIds`) and **demotes any other `kind:"agent"`
   duplicates** back to `undefined`, enforcing exactly one canonical
   chat per agent so a stray empty duplicate cannot hijack the real
   chat. It falls back to the most-recent `kind:"agent"` session (and
   demotes nothing) only when none has history — a legitimately empty,
   brand-new chat;
3. otherwise lazily promotes the most-recent non-job, non-bridge legacy
   session to `kind:"agent"` (this is the "fold one legacy session into
   the canonical chat, hide the rest" path — reversible, nothing
   deleted);
4. otherwise creates a fresh `kind:"agent"` session.

### Thread tagging

`ChatBlockBase` gains `threadId?` and `parentBlockId?` (additive, all
block kinds). A main-chat block leaves both unset; a thread block
carries `threadId` and the thread's root carries `parentBlockId`
pointing at the main-chat block it branched from — the human `user_text`
for an agent-started thread, the `assistant_text` for a user-started one.

Schema `MEMORY_SCHEMA_VERSION` 8 → 9 (`src/state/memory-db.ts`):

- `ADD COLUMN thread_id TEXT` and `parent_block_id TEXT` (nullable, so
  every pre-9 row is a main-chat block with `NULL thread_id`);
- `CREATE INDEX idx_chat_blocks_thread ON chat_blocks(session_id, thread_id, ordinal)`.

The `UNIQUE (session_id, ordinal)` constraint is untouched — thread
blocks still draw from the one per-session ordinal sequence, so the
single durable stream and its `Last-Event-ID` resume work for threaded
blocks with no special-casing. The CHECK-table-recreate migration path
copies `thread_id` / `parent_block_id` forward, so an upgrade from any
prior schema lands the new columns whether it took the `ADD COLUMN` or
the recreate branch.

`insertChatBlock` accepts `threadId?` / `parentBlockId?` on every kind;
`upsertAssistantTextBlock` / `updateToolCallBlock` carry the columns
forward (`SELECT *`), so streaming deltas and tool-status flips preserve
thread membership with no extra arguments.

`ChatMessageRecord` also carries optional `threadId?` / `parentBlockId?`
on user, assistant, approval-reason, and tool-transcript rows created
after this change. These fields do not drive UI rendering; they let the
chat-task prompt packer prefer the active thread plus main chat before
unrelated thread side conversations (see ADR chat-context-window.md).
Legacy rows omit them and are treated as main-chat context.

### Thread read helpers

In `src/state/chat-blocks.ts`, surfaced through the `src/state` barrel:

- `listThreadBlocks(instance, sessionId, threadId)` — ordinal-ascending
  blocks of one thread.
- `listMainChatBlocks(instance, sessionId)` — blocks with no
  `thread_id`.
- `summarizeThreads(instance, sessionId)` — one `ThreadSummary` per
  distinct thread in a session, newest reply first (with a `thread_id`
  tiebreak so same-millisecond replies can't reorder between polls).
- `summarizeThreadsForInstance(instance, agentSessionIds)` — the
  cross-agent inbox, same ordering plus a `session_id` tiebreak. It
  takes an **explicit list of agent session ids**
  because sessions live in the JSON `RuntimeState`, not SQLite — only
  `chat_blocks` is SQLite, so the helper can't discover which sessions
  are `kind:"agent"` on its own.

`ThreadSummary` (`src/types.ts`) carries `threadId`, `sessionId`,
optional `agentId` / `parentBlockId` / `rootPreview` / `rootAuthor`,
`replyCount`, `lastReplyAt`, optional `lastReplyPreview` /
`lastReplyAuthor`, and optional `activity`. `rootAuthor` (`user` /
`agent`, from the parent
block's kind) lets the panel and inbox attribute the root preview
correctly — "You" for an agent-started thread rooted at the user's
message, the agent otherwise.
`lastReplyAt` is the newest **message** block's `createdAt`
(`user_text` / `assistant_text`), not the newest block of any kind: a run
appends auxiliary blocks (trailing `phase` "Completed", `tool_call` /
`tool_result`, `system_note`) after the reply text, and the client unread
compare keys on `lastReplyAt`, so counting those would re-flag a thread the
user already opened. This matches `replyCount` / `lastReplyPreview` /
`lastReplyAuthor`, which are also message-derived.

`activity` is present only while a run in the thread is in flight,
computed per summary by a newest-first scan of the thread's `phase` /
`tool_call` / `authorization_requested` / `setup_requested` blocks.
Overlapping tasks can interleave blocks in one thread (replies are not
serialized), so each task is decided by its own newest decisive block
and the thread aggregates — any task parked on a gate ⇒
`"waiting_approval"` (the actionable state wins, matching the UI's
ordering), else any running task ⇒ `"running"`. Per task: a gate block
at the top means the run is parked on it (gate blocks carry no
resolution state, but resolving one always appends newer blocks);
otherwise the first phase block decides (`"running"` while its label is
non-terminal — terminal being Completed/Cancelled/Failed, mirroring the
web chat surface) and a tool call still running ahead of any phase
block also reads `"running"`. Unparseable rows are skipped so a
malformed block can't pin a thread active.

Two emission points keep the scan truthful through gate-resolution
windows: approving an authorization emits a best-effort
`Working: <action>` phase block before the side effect executes
(`src/agent.ts` `resolveAuthorization`), and completing a setup request
emits the same block for actions whose side effects run after the
complete-claim (connector probe, playwright secret fill, messaging
connect/remove/pairing) — decided per action by the exhaustive
`SETUP_COMPLETE_EMITS_WORKING_PHASE` map keyed by `SetupRequestAction`
inside `resolveSetupRequest` (`src/agent.ts`) — without these, a long
side effect would leave the resolved gate as the newest block and the
thread would keep reading `waiting_approval` after the user already
acted. `skill.grant_connector` deliberately does not
emit: its multi-credential flow mints the next grant card without a new
gate block, and the old gate staying newest is what keeps the thread
truthfully waiting on the next credential. `activity` drives the
running / needs-approval pills on thread cards, the chat tab-bar dot,
and the inline thread chip dot.

### Channels

A recurring job that creates a dedicated delivery session tags it
`kind:"channel"` + `origin:"job"` at the create site
(`createChatSession(..., "job", "channel")` in `src/jobs/index.ts`),
and `normalizeState` backfills the kind on existing job sessions. A
channel is therefore a **view over the job's existing session** — there
is no `ChannelRecord`. The user can chat into a channel exactly as into
an agent chat; the difference is purely the `kind`/`origin` tags that
drive the rail grouping and the unread-until-opened behavior job
sessions already had.

Session-level unread is computed client-side
(`web/src/lib/use-chat-read-state.ts`) and keys on **delivered replies
only** — the activity timestamp is the newest `updatedAt` among the
session's runs that carry an `assistantMessageId` (set when a final
answer is persisted as a durable chat message, with `run.updatedAt`
stamped to that message's `createdAt`), floored at `session.createdAt`.
It deliberately ignores `session.updatedAt` and runs without a delivered
reply, which advance on dispatch, run creation, and subagent attach: a
job run emits tool calls and finishes subagent runs throughout its
execution, and counting those would re-flag a channel the user already
opened while the job is still working. This mirrors the thread rule
above, where `lastReplyAt` keys on message blocks rather than the
trailing auxiliary blocks a run appends.

The delivery binding is user-chosen at creation. The `create_job` tool
takes `deliverTo: "channel" | "chat"` — `"channel"` (the default) mints
the dedicated channel session above; `"chat"` binds
`JobRecord.chatSessionId` to the originating conversation instead, so
each fire posts into the chat that created the job (the session stays a
normal agent chat — no kind/title mutation). `"chat"` is only valid for
chat-bound invocations; an imperative/CLI task gets a tool error. The
default is `"channel"`; one-shot reminders default to `"chat"`. A
chat-bound job gets no Recurring jobs rail row — the rail lists only
channel-bound jobs; each fire delivers into the bound conversation,
and the job is managed from that conversation's Jobs tab. Its fires
also run with that conversation's prior-turn context (token-budgeted,
like any chat turn), whereas a channel-bound job's fires see only
prior fires.

A chat-bound fire shares the conversation's one ordinal stream, so it
must not disrupt the user's own turn. Two rules keep it from interleaving
with a live turn. **Deferral:** `runDueJobs` skips claiming a chat-bound
job while its bound session has a live (user-initiated, no-`jobId`)
task in flight, leaving `nextRunAt` untouched so the fire retries on the
next ~1s tick once that turn reaches a terminal status (it mirrors the
same-job overlap skip directly above it). The defer spans the entire open
turn, including parked `waiting_approval`/`waiting_input` states, because a
resumed turn appends higher-ordinal blocks that would bracket the fire's
blocks and reorder the `taskId`-grouped transcript — so the check must not
narrow to `running`. Manual `run_job`/Run-now is exempt; it is an explicit
user action. **Attribution:** a chat-bound fire's blocks render in a
distinct light-bordered group subtitled "from &lt;job name&gt;", resolved
client-side from each block's `runId` → its `kind:"job"` run → the job's
name (web and mobile, the shared dual renderers). Together these keep a
watcher/reminder fire legible as the job's output rather than a mis-ordered
conversation turn.

The binding stays modifiable after creation: `update_job` accepts the
same `deliverTo` enum (`rebindJobDelivery` in `src/jobs/index.ts`,
audited as `job.delivery.rebound`). Switching to `"channel"` always
mints a **new** dedicated channel and leaves the previously bound
conversation untouched — it's the user's chat. Switching to `"chat"`
binds future fires to the conversation the `update_job` call came from
(tool error when the invocation isn't chat-bound) and, when the job's
current session is a dedicated channel, stamps the channel's
`archivedAt` (audited as `chat.session.archived`). An archived session
keeps its full history and stays directly addressable by id/URL; it is
only excluded from session/channel lists (web sidebar rail, mobile
channels). Rebinding when already bound the requested way is a no-op.
Watcher jobs (a `preRunHook` or fan-out `routes`) reject `deliverTo` —
their sessions carry routing state a rebind would orphan. The raw
`PATCH /api/jobs` path stays permissive and has no `deliverTo`
semantics.

**Deleting a job archives its dedicated channel.** A channel is a view
over the job's session, so removing the job leaves the channel with
nothing to surface. `removeJob` (`src/jobs/index.ts`) therefore stamps
the channel's `archivedAt` (audited as `chat.session.archived`,
`reason: "job.removed"`) the same way the `deliverTo:"chat"` rebind
does — history preserved, still addressable by id/URL, excluded from
the rails. The guards mirror the rebind path: only a **live**
(`!archivedAt`) channel, never an email-watch channel
(`feature === "email-watch"` — that subsystem owns its channels'
lifecycle), and never one another surviving job still delivers into via
`chatSessionId` or a fan-out route (raw `POST`/`PATCH /api/jobs` can
bind several jobs to one channel, so archiving while a sibling still
fires would hide a live delivery surface). A one-time `normalizeState`
sweep (`archiveOrphanJobChannels`, `src/state/store.ts`) applies the
same rule to channels orphaned by deletions that pre-dated this cleanup,
so a state file carrying a leftover `kind:"channel"` session with no
owning job is healed on load. This complements Decision D: deleting the
**agent** detaches its job channels (jobs survive, paused), while
deleting the **job** archives its channel.

Beyond the channel itself, a finished job run's reply can reach
messaging bridges two ways (`src/jobs/finalize.ts`): the session's
origin mirror (`outboundMirror`/`source`, set when the job was created
from a Telegram/Discord conversation) mirrors the reply back to that
bridge, and `JobRecord.deliveryTargets` names additional bridges to
deliver to — the surface for "send my morning briefing to telegram"
when the job was created from web/CLI. The `create_job`/`update_job`
tools accept `deliveryTargets` entries that must resolve to exactly
one dispatchable (Telegram/Discord) bridge — by id, case-insensitive
name, or kind; unknown and ambiguous entries are rejected — and
persist the resolved bridge id (`[]` clears). Delivery runs on every
terminal finalize: a job with no chat session (created via `POST
/api/jobs` or from a non-chat task) or whose session vanished delivers
the task summary instead of the synced chat reply, and both paths
honor the exact-`[SILENT]` suppression contract. A bridge the origin
mirror already delivered to is skipped. Fire-time resolution failures
and send failures are logged (`job.delivery.target.error`) and audited
(`job.delivery.failed`) without failing the run.

## Agent-Decided Routing

Routing is resolved per turn, before the user sees any text, by three
mechanisms in priority order:

1. **`start_thread` control tool (primary).** Defined in
   `src/execution/tool-catalog.ts`, it is a core tool — always-on,
   never deferred (allowlisted alongside `load_tools` in the deferral
   gate), and never approval-gated. It is handled **inline** in the
   chat-task loop (`src/execution/chat-task.ts`), not through the
   dispatch switch, so it produces no `phase` / `tool_call` /
   `tool_result` chat block — it is a control action, not visible work.
   On the first model call of a fresh turn it calls `switchTurnToThread()`
   and returns a small JSON result telling the model whether it is now
   threaded; a tool result is always pushed so the provider sees the
   call resolved.

2. **`<route>thread</route>` directive (silent fallback).**
   `parseLeadingRouteDirective` (`src/execution/route-directive.ts`)
   inspects the accreted *leading* text of a turn as deltas stream in,
   distinguishing a complete directive, a strict prefix that could still
   become one (buffer and wait), and everything else. A recognized
   directive is parsed and stripped before any text reaches the user or
   the task summary; `<route>thread</route>` triggers the same
   `switchTurnToThread()`. If `start_thread` already routed the turn,
   the text parser does not re-route.

3. **User reply in a thread (user context wins).** When a user posts
   into a thread via `submitThreadReply`, the whole response stays
   threaded regardless of any routing signal — `emitCtx` is seeded with
   the thread's `threadId` / `parentBlockId`, and `switchTurnToThread()`
   no-ops because the turn is already threaded.

`switchTurnToThread()` mints a `thread_id`, resolves the parent as the
current turn's main-chat `user_text` block
(`getMainChatUserTextBlockForTask`) so the thread roots at the message
the user just sent. It then stamps the emit-context so every subsequent
emit on the turn — sibling tool calls in the same batch and all continued
text/tools in later iterations — threads automatically. Rooting at the
user message keeps the thread chip beside the prompt that spawned it and
makes the thread read human → agent; rooting at a prior assistant block
would scatter every agent-routed thread onto one ever-older message and
make the agent appear to reply to itself. A turn with **no** human
message — an autonomous job/channel fire — does not thread: the switch is
a no-op and the turn stays in the channel's main timeline. The agent
never seeds a thread off its own message; threading requires a human
message to root at, so a thread always reads as a reply to the user.

The `start_thread`-as-primary choice was forced by behavior, not
preference (see Resolved Decisions, B). The verified runtime model did
not reliably emit a leading `<route>` token for research/brainstorm
prompts — research went tool-first, so the leading-text directive could
never fire — but it called tools (`web_search`, `request_connector`)
readily. A control tool the model invokes as its first action is the
mechanism it actually reaches for; the directive remains as a
zero-cost fallback for models that do emit it. The
"expect multi-turn → thread" guidance lives in the system prompt
(`src/runtime/defaults/INSTRUCTIONS.md`), instructing the tool as
primary; there is no programmatic retroactive heuristic, because
already-streamed blocks cannot be cleanly re-threaded after the fact.

## Client Contract

New routes (`src/http.ts`):

- `GET /api/agents/:agentId/chat` — resolve (or lazily create) the
  agent's one canonical chat via `getOrCreateAgentChat`.
- `GET /api/chat/:id/threads` — `ThreadSummary[]` for the session
  (`summarizeThreads`), newest reply first.
- `GET /api/chat/:id/threads/:threadId/blocks` — the thread's blocks
  in ordinal order (`listThreadBlocks`).
- `POST /api/chat/:id/threads/:threadId/messages` — post a user reply
  into a thread (`submitThreadReply`), **create-or-append**: if the
  thread has no blocks yet it is *created* on this first reply, rooted at
  the `parentBlockId` supplied in the body (the main-chat message the
  user branched from, validated to be an un-threaded block in this
  session); if the thread already exists, the parent is inherited from
  its first block (a missing one is an error, not a silent drop). This
  is how a user starts a thread off any agent message (Slack-style
  "Reply in thread"), complementing the agent-initiated `start_thread`.
  Body also accepts `alsoToMain?` to best-effort mirror the message into
  the main chat (consistent with the existing dual-publish pattern). The
  handler validates the **session** exists first (so a bad `sessionId`
  fails as "Chat session not found" rather than a misleading
  "Thread not found").
- `GET /api/threads` — the cross-agent inbox: every thread across all
  `kind:"agent"` sessions, enriched with the owning agent's display
  name, newest reply first. The `?filter=all|unread` query is accepted
  but **not** applied server-side.

All thread endpoints 404 on an unknown session id, so a stale link
fails cleanly rather than returning an empty list.

Both list endpoints order newest reply first with a deterministic
`threadId` tiebreak (the inbox also tiebreaks on `sessionId`). The web
thread lists — the per-agent Threads tab and the `/threads` inbox —
re-order client-side through one shared `sortThreads` helper
(`web/src/components/chat/ThreadsTab.tsx`): threads with a run in
flight first, `waiting_approval` outranking `running` (the actionable
state wins), then newest reply within each group. The same ranking
feeds `aggregateActivity`, which drives the chat tab-bar activity dot,
so the dot can never disagree with list ordering.

**Thread unread is computed client-side.** The server has no per-thread
read cursor. The existing `POST` / `DELETE /api/chat/:id/read`
endpoints track a per-device, **session-level** read cursor (and feed
`GET /api/badge`); they are unchanged and remain whole-chat granularity.
The web client tracks thread read-state in `localStorage` and hides read
threads for `filter=unread`; the inbox always receives the full list.

## Resolved Decisions

- **A. Legacy sessions on collapse.** Fold the most-recent non-job,
  non-bridge legacy session into the canonical agent chat (lazy promote
  to `kind:"agent"`); leave the rest with `kind` undefined so they are
  hidden, not deleted. Reversible.
- **B. Thread decision mechanism.** `start_thread` control tool as the
  primary mechanism, `<route>thread</route>` leading directive as a
  silent fallback. (This supersedes the original "structured directive,
  not a tool" plan — the model did not reliably emit the directive; see
  Agent-Decided Routing.)
- **C. Channels.** A view over the job's existing session
  (`kind:"channel"` + `origin:"job"`), no `ChannelRecord`.
- **D. Delete-agent cascade.** Deleting an agent deletes its chat and
  threads and detaches its job channels (the jobs themselves survive,
  paused), while `JobRunRecord` audit history is retained.
- **E. User reply in a thread.** User context wins — the response stays
  in the thread regardless of any routing directive. A user can also
  *start* a thread off any agent message: the first reply (carrying its
  `parentBlockId`) creates the thread, create-or-append (see Client
  Contract), complementing the agent-initiated `start_thread`.
- **F. Thread read-state.** Per-thread unread is computed **client-side**
  (web `localStorage`); the server's per-device read cursor stays
  session-level, and opening the main chat does not clear thread badges.

## Consequences

Pro:

- Threads inherit the entire ChatBlock protocol for free: one ordinal
  stream per session, one SSE subscription, `Last-Event-ID` resume,
  block grouping, and APNs routing all work unchanged because a thread
  is just a tag on blocks in the session that already had them.
- The "which session held that conversation?" problem is gone — one
  chat per agent, side work branched into named threads, recurring jobs
  surfaced as channels in the same rail.
- The persistence change is purely additive (two nullable columns + one
  index). Every pre-9 row reads back as a main-chat block, so the
  migration needs no data backfill for thread membership.
- The routing decision is the agent's, made up front, with a tool the
  model reliably calls and a directive fallback — no client heuristic
  and no post-hoc re-threading.

Con:

- Per-thread read-state is client-side only today, so thread unread
  badges do not sync across devices the way the session-level badge
  does. Server-side per-thread read cursors are the deferred follow-up
  (see below).
- `summarizeThreadsForInstance` must be handed the agent session-id list
  by the caller because sessions live in JSON `RuntimeState` while
  blocks live in SQLite — the two stores can't be joined in one query.
- `start_thread` is one more always-on tool in every turn's catalog,
  and the routing decision now depends on the model invoking it (with
  the directive as the only fallback). A model that does neither stays
  in the main chat — the safe default, but it means auto-threading
  quality is model-dependent.

## Deferred Follow-Up

- **Server-side per-thread read-state.** Today thread unread is computed
  client-side from `localStorage`; the server cursor is session-level
  and per-device. A per-thread, per-device read cursor (mirroring the
  existing session-level `markRead`/`markUnread`) would let thread
  badges sync across devices and feed the APNs badge total. Decision F
  is satisfied behaviorally on web today; the cross-device version is
  out of scope for this change.

## Acceptance Checks

- `bun test src/execution/agent-chat-resolver.test.ts` covers
  `getOrCreateAgentChat`: the agent-exists guard, returning an existing
  `kind:"agent"` session, preferring the non-empty chat over an empty
  `kind:"agent"` duplicate (and demoting the duplicate), lazy promotion
  of a legacy session, and fresh creation.
- `bun test src/execution/route-directive.test.ts` covers the
  leading-directive parser's `none` / `incomplete` / `directive`
  states.
- `bun test src/execution/chat-task-route.test.ts` covers the
  per-turn routing: `start_thread` branching the turn inline (no
  visible block), the `<route>` fallback, the already-threaded and
  no-parent no-ops, and user-reply-stays-threaded.
- `bun test src/state/chat-blocks.test.ts` covers thread tagging on
  insert, `listThreadBlocks` / `listMainChatBlocks`, and the
  `summarizeThreads` / `summarizeThreadsForInstance` aggregates.
- `bun test src/jobs.test.ts` covers job-output bridge delivery: the
  origin-mirror `[SILENT]` contract, and the `deliveryTargets` path
  (resolution by name/id/kind, dedupe against the origin mirror,
  fire-time resolution failure logged without failing the run, and
  `create_job`/`update_job` validation against configured bridges). It
  also covers chat-bound deferral (a due chat-bound job is skipped — no
  run, `nextRunAt` unchanged — while its session has a live non-`jobId`
  turn in flight, firing on the next tick once that turn is terminal) and
  `removeJob`'s channel archive: a deleted job's dedicated channel is
  archived (history intact), a chat-bound conversation is left untouched,
  and a channel a sibling job still delivers into is spared until the last
  job is removed.
- `bun test src/state/store.test.ts` covers `archiveOrphanJobChannels`:
  a job channel orphaned by a pre-cleanup deletion is archived (with the
  legacy `origin:"job"`→`kind:"channel"` backfill running first), a
  channel a surviving job references via `chatSessionId` or a fan-out
  route is spared, email-watch / already-archived / plain sessions are
  never touched, and the sweep is idempotent across repeat normalizes.
- `bun test src/http.test.ts` smoke-tests the new routes — the
  agent-chat resolver, the three per-session thread routes (including
  create-or-append from a new thread id + `parentBlockId`, the
  session-first 404, and the `parentBlockId` requirement), and the
  `/api/threads` inbox.
- The live-gateway end-to-end verification confirms the model calls
  `start_thread` on a brainstorm prompt and the resulting reply (and its
  follow-ups) thread, the web Thread panel and `/threads` inbox render
  the thread, and the `UNIQUE (session_id, ordinal)` invariant holds
  with threaded blocks interleaved in the stream.
