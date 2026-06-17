# Job Concern Fan-Out

## Decision

A pre-run job hook can return ROUTED results — a map of **buckets** keyed by
`routeKey` — and the scheduler **fans one job tick out into N constrained-subagent
workers**, one per non-empty bucket, each dispatched into its own chat session
with its own worker config. This inserts a fan-out level between the existing two
levels of a recurring job (the dumb deterministic pre-run hook, and the single
smart model turn): one detection pass feeds many independent concern workers. It
is a **domain-agnostic** extension of the jobs + hooks primitives
([Pre-LLM Job Hooks](job-pre-run-hooks.md)) — the email watcher is the first
consumer (see [Email Watch](email-watch.md)), but `src/jobs` and `src/hooks` carry
zero email knowledge.

The three layers a fan-out job runs through:

1. **Detection (dumb — the pre-run hook).** One deterministic pass. Instead of a
   flat `items[]` it ROUTES each result to a `routeKey` and returns
   `buckets: Record<routeKey, HookContextItem[]>` (only non-empty buckets). A flat
   `items[]` result is the back-compat single-bucket/default case and dispatches
   exactly as before.
2. **Fan-out (the scheduler — the new level).** For each non-empty bucket, spawn
   ONE worker turn into that route's chat session, fed the bucket's items as
   fenced/trusted context plus the route's worker config (prompt, systemPrompt,
   toolsets, skills). Empty buckets spawn nothing.
3. **Concern worker (the intelligence — a subagent).** Each spawned turn is a
   **parentless constrained subagent** ([Subagent Delegation](subagent-delegation.md))
   running in its route's session, under the owning agent, with the route's
   systemPrompt and toolset/skill whitelist. It reads its bucket and acts
   (drafts, flags, asks for input). Continuity across ticks: the channel holds the
   negotiation history, the hook state holds the per-route cursor — so a follow-up
   user message in the channel, and the next tick's worker, both see the prior
   draft.

**Tiered dumb/smart dispatch.** A route worker may be a plain concern worker
(the dumb path: act on this bucket) OR an intelligent router that itself
classifies, groups, and delegates to more workers (the smart path). The smart
path is just a worker that spawns workers — it rides the EXISTING subagent
delegation mechanism, NOT a new primitive. There is no fourth layer to build.

**The discipline that keeps it cheap (zero-idle-turn).** All intelligence is
gated behind the dumb detector. A route worker — even an intelligent router —
only runs when the cheap deterministic detector already produced a non-empty
bucket for its route. An idle tick (every bucket empty) spawns nothing and costs
ZERO model turns. Be arbitrarily smart WITHIN a non-empty tick; never spend a
turn on an idle one. Newness/dedup stays 100% deterministic in the detector; only
ROUTING (and any in-worker grouping) may be intelligent.

## Context

The recurring-job model was two levels: a dumb pre-run hook (a deterministic
detection script, no model) short-circuits or injects context, then ONE smart
model turn runs into ONE chat session. The job IS the single intelligence; there
was no room to handle several independent concerns from one detection pass
without either one job per concern (N polls, N schedules) or one turn juggling
everything in one session.

Fan-out inserts the missing level: one detector → many workers. The detector
stays the single deterministic floor (one poll, deterministic dedup); the
scheduler partitions its output by `routeKey` and dispatches a dedicated,
constrained worker per concern into a dedicated session. This composes the three
primitives Gini already owns — the scheduler, the pre-run hook, and constrained
subagents — rather than adding a new one.

## Required Now

- **Routed hook result (`src/hooks/`).** The `kind: "context"` `HookResult` carries
  either a flat `items?: HookContextItem[]` OR `buckets?: Record<string, HookContextItem[]>`
  (exactly one). The runner renders each bucket through the SAME untrusted-content
  fence as a flat result (JSON-encode + sentinel-strip-to-fixpoint + per-item
  nonce-suffixed close delimiter + char-cap), producing `buckets: Record<string, string[]>`
  on the `HookOutcome`; `items`-only is byte-identical to before. The hooks layer
  stays domain-free — it never imports `src/jobs`, `src/state`, or any domain
  handler. (See [Pre-LLM Job Hooks](job-pre-run-hooks.md).)
- **`JobRecord.routes` + `JobRoute` (`src/types.ts`).**
  `JobRoute = { chatSessionId: string; systemPrompt?; toolsets?; skills?; prompt? }`
  and `JobRecord.routes?: Record<string, JobRoute>` map a `routeKey` to where/how
  that bucket's worker dispatches. Domain-agnostic and optional: a job with no
  `routes` and a hook returning a flat `items[]` behaves EXACTLY as today (one
  turn into `job.chatSessionId`). An unmapped routeKey falls back to
  `job.chatSessionId` (audited `job.route.missing`).
- **Fan-out dispatch in the scheduler (`src/jobs/`).** When a pre-run hook returns
  non-empty `buckets`, `runDueJobs` and `runJobNow` take the fan-out path instead
  of the single `dispatchPromptRun`:
  - `dispatchFanOut` iterates the non-empty buckets. For each, it resolves the
    `JobRoute`, assembles the per-route prompt (`route.prompt ?? job.prompt`, with
    `[...job.context, ...bucketContext]` as the context block at the single
    `withCronHint` assembly point), and spawns ONE constrained worker via
    `spawnSubagent` into `route.chatSessionId` with the route's
    systemPrompt/toolsets/skills and **no `parentTaskId`**. Each route dispatch is
    in its own try/catch, so one bucket's dispatch failure does not derail its
    siblings. It returns the `dispatchedRouteKeys` and the `attemptedRouteKeys`
    (every non-empty bucket it tried).
  - A deleted/missing route session is audited (`job.route.session_missing`) and
    SKIPPED — its siblings still dispatch.
- **Per-bucket at-least-once commit (`persistFanOutState`).** The commit boundary
  is drawn per-bucket. Starting from the OLD `hookState`, the scheduler ADOPTS
  every fresh top-level slice the handler returned (so a bucket that advanced its
  cursor but produced no worker turn — e.g. a watch that deterministically
  consumed mail without drafting — still commits its progress), then ROLLS BACK to
  the old slice ONLY the routeKeys that were ATTEMPTED (non-empty bucket) but
  FAILED to dispatch. A failed dispatch re-surfaces only THAT bucket's results on
  the next tick; siblings stay committed. This preserves at-least-once delivery
  per bucket: no loss, and a re-detect/re-dispatch is idempotent.
- **Handler-state contract.** A routed handler returns its next `state` keyed by
  `routeKey` at the TOP level (`state[routeKey] = <that route's slice>`), so
  `persistFanOutState` can partition each route's cursor independently. A handler
  that returns a nested/opaque blob can't be partitioned per bucket.
- **One run record per tick.** A fan-out tick remains ONE `JobRunRecord` (the
  claim/overlap unit). `finalizeFanOutRun` finalizes it `completed` INLINE by
  `run.id` once dispatch is done — it stamps `lastSuccessAt`, honors one-shot
  auto-pause, and emits `job.run.completed` (mirroring `finalizeShortCircuit`). The
  N workers deliver their results through the NORMAL chat path into their own
  sessions; their tasks are NOT routed through `finalizeJobRunFromTask`, whose
  one-run-one-task assumption does not hold for a fan-out tick.
- **Composition with the subagent primitive.** Workers are parentless constrained
  subagents: `spawnSubagent` threads `chatSessionId` into the worker's chat task
  and stamps it onto the session. The constraint (systemPrompt + toolset/skill
  whitelist) applies off the worker task's `subagentId` independently of any
  parent, and the spawn-depth cap is gated on `parentTaskId` so a parentless spawn
  no-ops it. One mechanism serves both a plain concern worker and an intelligent
  router that delegates further. (See [Subagent Delegation](subagent-delegation.md).)
- **The worker's turn persists to its channel's history.** A session-bound fan-out
  worker is spawned via `spawnSubagent` and its run carries no `conversationId`, so
  the legacy chat-finalize paths (`syncChatTaskResult`, `finalizeJobRunFromTask`)
  that normally write a turn's transcript + a durable assistant chatMessage do not
  fire for it. The chat task resolves its transcript session from `task.chatSessionId`
  (the same key the block-emit path uses, so blocks and transcript land in the same
  channel), and the general completion rule covers it: every completed chat task
  persists its final turn-ending text as a durable assistant chatMessage
  (`persistFinalAnswerRow`, gated on no `jobId` and non-empty non-sentinel text,
  guarded against double-writing an existing assistant row), so the worker needs no
  subagent-specific carve-out. Without that row, the channel would replay empty
  history and a follow-up user message would not see the worker's prior draft.
- **`[SILENT]` is suppressed at the chat-BLOCK layer.** A worker (like any
  scheduled-job turn) with nothing to report answers with exactly `[SILENT]` to
  suppress delivery. The legacy message layer already drops that `ChatMessageRecord`;
  because the UI renders chat BLOCKS, the in-flight `assistant_text` block is also
  retracted when the final text reads as silent — the literal token, or a trailing
  standalone `[SILENT]` line after a no-op preamble (a leading/inline sentinel like
  `[SILENT] but here's an update` still delivers; see `src/jobs/silent.ts`) — so the
  channel never shows a literal `[SILENT]` row, and the durable-message persistence
  above skips it identically.

## Trust Boundary

- The hook config carries only DECLARATIVE data: the detection script TAGS each
  item with a `routeKey`; the `routeKey → session/persona/toolset` mapping lives in
  the typed, validated `JobRoute` config, NOT in the script. The detector cannot
  pick where a worker runs or what it can do — that stays runtime-owned config,
  preserving the hooks security model (Gini supplies data, never executable
  routing code).
- A bucket's items are untrusted external content. The RUNNER fences each bucket
  item exactly as it fences a flat-result item before it reaches a worker — the
  detector emits raw fields and never has to get the fence right.
- A worker is a constrained subagent: it runs only with the route's whitelisted
  toolsets/skills, so its side-effecting reach is bounded by config the worker
  cannot widen, and approval/audit/trace apply inside its turn as for any task.

## Forward-looking (design-only, NOT built)

- **Routed results from other hook events.** A future `postRun` or `preTool` hook
  ([Pre-LLM Job Hooks](job-pre-run-hooks.md)) could return routed buckets and reuse
  the same fan-out dispatch + per-bucket commit.
- **Non-email consumers.** Any recurring detector that partitions its findings
  (e.g. a multi-repo CI watcher, a multi-feed digest) can adopt fan-out by
  emitting routed buckets and provisioning a `JobRoute` per partition — no jobs/hooks
  change needed.

## Verification

- `bun test src/jobs/fanout.test.ts` pins the scheduler fan-out: two non-empty
  buckets dispatch two workers into two sessions (each carrying its route prompt +
  bucket context; the job session gets none); one run, finalized completed; both
  sub-states committed. An empty bucket spawns no worker. A deleted route session
  preserves that bucket's cursor while the sibling advances (audited, run still
  completed). A flat `items[]` result with no `routes` takes exactly the legacy
  single dispatch (one job-bound task, single opaque `hookState`). A constrained
  route spawns a PARENTLESS subagent whose `SubagentRecord` carries the route's
  systemPrompt + toolset whitelist. A bucket that advanced its cursor but spawned
  no worker still commits its fresh slice (silent-advance at-least-once).
- `bun test src/hooks/hooks.test.ts` pins the routed render: a `buckets` context
  renders each bucket through the fence with its own nonce-suffixed close marker
  (distinct nonces); a flat `items` result leaves `buckets` absent.
- `bun test src/hooks/boundary.test.ts` pins that `src/hooks` imports no
  `src/jobs`/`src/state`/email/gmail module — the fan-out carrier stays
  domain-free.
