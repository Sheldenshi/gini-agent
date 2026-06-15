# Pre-LLM Job Hooks

## Decision

A **pre-run hook** is a deterministic, in-process step that runs BEFORE a model
turn. It is a **top-level, domain-agnostic primitive** (`src/hooks/`), a sibling
of the scheduler rather than a sub-feature of it: the jobs scheduler is one
*consumer* (a job may carry a `preRunHook` — the "combined" case), and the hook
runner is equally usable independently of jobs (resolve + run a registered
handler directly, the "used independently" case). The hook is identified by a
`handlerId` that resolves to a **trusted in-tree handler** from a registry, and
it is fed declarative `config` DATA. It signals back through a **typed
discriminated result** that mirrors Claude Code's exit-code/JSON contract for a
pre-LLM (`UserPromptSubmit`) hook:

| Claude Code mechanism | Gini in-process analog (jobs consumer) |
| --- | --- |
| `UserPromptSubmit` event (pre-LLM) | `preRunHook` on `JobRecord` (the jobs consumer's binding) |
| exit 2 + stderr → block | `{ kind: "shortCircuit" }` → finalize the run, **0 model turns** |
| exit 0 + `additionalContext` → inject | `{ kind: "context", items }` → fenced context into the drafting turn |
| non-zero non-blocking error | `{ kind: "error" }` → finalize the run failed, no draft |
| per-event tight timeout (30s for `UserPromptSubmit`) | per-hook `timeoutMs`, default 30s |
| registration by event → matcher → handler | `HookConfig = { handlerId, config, timeoutMs }`, handler from a trusted registry |

The security pivot is that **Gini supplies declarative data, never executable
code**: the model/user picks a `handlerId` (a key into a reviewed, in-tree
registry) and supplies `config` data. A handler that isn't in the registry is
rejected at config-create time and treated as an error at run time. There is no
user-authored shell/command hook in v1.

v1 registers one handler: **`skill-script`**, a domain-agnostic handler that runs
any named, in-tree skill script HEADLESS (no agent turn, no approval) and maps
its JSON stdout onto the typed hook result. It is the bridge between two core
primitives — the hooks registry and the skill-script runner — so it lives in
`src/capabilities/skill-script-hook.ts` (beside `skill-scripts.ts`; both core,
neither a domain) and self-registers via `builtins.ts`. The email-watch feature
uses it routed at the bundled `gmail-watch/detect` script (see
[Email Watch](email-watch.md)).

**Module shape.** The primitive lives in `src/hooks/` and imports only `src/types`
(for `RuntimeConfig`) and itself — zero `src/jobs`, `src/state`,
`src/integrations`, or `src/capabilities` imports, so it stays domain-free:
- `types.ts` — the generic contract (`HookConfig`, `HookContext`, `HookResult`, `HookHandler`).
- `registry.ts` — the trusted-handler registry (the whole security boundary). Domains POPULATE it via `registerHook(id, handler)` rather than the registry importing handlers; `resolveHook` / `isKnownHook` are the resolution points. Null-prototype maps + own-property checks reject prototype keys.
- `runner.ts` — `runHook(config, hookConfig, payload?)`: resolve + per-hook timeout race + result-validate + context-render, returning a typed `HookOutcome`. It makes NO consumer policy decision — an error outcome carries a neutral `transient` flag (timeout/throw = transient; config/malformed = not) and the consumer decides what transience means for its own durability.
- `index.ts` — the public barrel consumers import (does NOT import builtins, so importing the primitive never drags a domain handler in).
- `builtins.ts` — the composition root: it imports each trusted handler module (which self-registers on load) and is imported once at application boot (server + CLI) and in tests that drive the scheduler.

The `skill-script` handler lives in `src/capabilities/` (core, beside the
skill-script runner it bridges) and self-registers into the registry; the
primitive never imports it.

Two consumers exist today:
- **Jobs (combined).** A `JobRecord.preRunHook` runs at the scheduler seam; the jobs adapter maps `HookOutcome` onto its schedule-fatality policy (below), and the scheduler owns the hook's state (`JobRecord.hookState`, below). The email-watch feature is the first such consumer: an agent's watchers share ONE scheduled job with a `skill-script` pre-run hook driving a per-watch detection list (see [Email Watch](email-watch.md)).
- **Independent.** Any caller can `runHook(config, { handlerId, config }, payload?)` directly — no `JobRecord`, no scheduler — and act on the returned `HookOutcome` itself.

## Context

Gini already owns a durable scheduler (`runDueJobs`, a 1s self-rescheduling loop)
that claims due jobs into `JobRunRecord`s and dispatches a model turn per run.
Several maintenance behaviors (the email watcher being the motivating one) need
to run a cheap, deterministic check BEFORE the model is involved, and frequently
want **no model turn at all** (nothing changed) or want to **inject the matched
data** as context for the turn. Previously the email watcher did this with a
bespoke `gmailPollLoop` in `server.ts` that woke a turn per match and relied on
post-hoc `[SILENT]` suppression to stay quiet.

Claude Code's hooks design (events, JSON-over-stdin input, exit-code semantics,
JSON-on-stdout for richer control, per-hook timeout, matcher/registration,
snapshot-for-safety) is the closest prior art. We map its **block** and
**additionalContext** mechanisms onto a single pre-LLM job hook, in-process and
typed rather than shell-and-exit-code, so the contract is enforced by the type
system instead of by convention.

## Required Now

- A generic config (`src/hooks/types.ts`): `HookConfig = { handlerId: string; config: Record<string, unknown>; timeoutMs?: number }`. The jobs consumer persists it as `JobRecord.preRunHook?` — optional, so legacy jobs have no hook and dispatch byte-identically. `createScheduledJob` validates the shape and rejects a `handlerId` that isn't in the registry (via `isKnownHook`, typed `Invalid input: …`), so a bad id never persists. The agent-facing `create_job` tool exposes the same `preRunHook` parameter and passes it through UNVALIDATED to `createScheduledJob` — tool, HTTP, and internal callers share that one validation seam (the skill-side consumer is the phone-call skill's background call watch).
- A trusted handler registry (`src/hooks/registry.ts`). `resolveHook(id)` / `isKnownHook(id)` are the only resolution points; the map is the whole security boundary. Domains call `registerHook(id, handler)` to populate it (so the registry imports no domain handler). v1 registers exactly one handler: `skill-script` (registered from `src/capabilities/skill-script-hook.ts`).
- The `skill-script` handler. Its `config` is `{ skill, script, ...declarative data }`. It locates the named script via `findSkillScript`, invokes it HEADLESS via `invokeSkillScript` with `{ ...declarative, state }` on stdin (the `state` is the consumer's current `hookState`, threaded in as the `runHook` payload), and maps the script's `{ kind, items?, summary?, state }` stdout onto a `HookResult`. A missing routing key / unknown skill|script / malformed output is a CONFIG error (`{ kind: "error" }`); a non-zero exit, unparseable stdout, or script throw is re-thrown so the runner classes it TRANSIENT (a scheduled job stays alive). The script is a PURE function — `state` rides in on stdin and out on the result; the script never persists it.
- A typed result (`src/hooks/types.ts`): `HookResult = shortCircuit | context | error`. The discriminated union makes it impossible to both short-circuit and inject — one mode per invocation, the analog of Claude Code's "JSON only on exit 0". `shortCircuit` and `context` carry an optional opaque `state` (the handler's next state, for a consumer that owns it). A `context` result carries EITHER a flat `items?: HookContextItem[]` OR ROUTED `buckets?: Record<string, HookContextItem[]>` (exactly one): the flat `items` form is the single-bucket back-compat default (byte-identical to before), while `buckets` lets a consumer fan one hook out to many keyed workers (see [Job Concern Fan-Out](job-concern-fanout.md)). Either way the runner renders every item through the SAME untrusted-content fence — the rendering/fence path is unchanged.
- A generic runner (`src/hooks/runner.ts`): `runHook` resolves the handler, enforces the per-hook timeout via `Promise.race`, validates the result kind INSIDE the race guard (a malformed result takes the typed error path, never a throw past the catch), passes the handler's `state` through to the `HookOutcome`, and renders `context` items into injectable strings. It OWNS the untrusted-content fence: an `untrusted:true` item is JSON-encoded onto one physical line (escaping quotes/newlines/marker-like bytes), sentinel-stripped to a fixpoint with CR/LF collapsed, wrapped in a per-item nonce-suffixed close delimiter, and truncated to the `PRE_RUN_HOOK_CONTEXT_CHAR_CAP` (10k) BEFORE the close marker is appended so an oversized payload can't push the marker out and break the data container. A handler emits raw untrusted fields; the trusted runner produces the safe fenced context. It returns a typed `HookOutcome` whose error carries a neutral `transient` flag — the runner makes NO consumer policy decision.
- The jobs consumer's `runPreRunHook` adapter calls `runHook` and maps the outcome onto the schedule-fatality policy: a TRANSIENT error (timeout / handler throw) is non-fatal (the run fails but the scheduled job stays active to self-recover), a non-transient config/malformed error is fatal (the scheduled job is deactivated). The scheduler runs the hook at the same seam in both `runDueJobs` (the scheduled path) and `runJobNow` (manual/replay), between the run claim and `dispatchPromptRun`:
  - **shortCircuit** → `finalizeShortCircuit` finalizes the run INLINE by `run.id` with NO model turn: it sets the run completed, stamps `job.lastSuccessAt` + clears `lastError`, honors one-shot auto-pause (and its audit), and emits the `job.run.completed` event. Binding by `run.id` is exact, so it never mis-binds under concurrent manual/replay runs; the `status === "running"` guard makes a finalize that races a cancel a no-op (no double finalize). It does NOT route a synthetic `Task` through `finalizeJobRunFromTask` — that path's `syncChatTaskResult` would throw "Task not found" for a task that was never in `state.tasks` (the dominant idle email path), stranding the suppression audit and spamming `job.chat.sync.error`. **Delivery** branches on the summary: a silent/empty summary delivers nothing and emits the `chat.message.suppressed_silent` audit explicitly. A genuinely NON-silent summary IS delivered — this is the generic "**a hook can notify without a model turn**" capability: `finalizeShortCircuit` posts the summary directly into the job's chat session as a runtime-authored assistant message (a legacy `ChatMessageRecord` plus the `assistant_text` + terminal `phase` chat blocks, so the same per-session SSE stream and APNs completion push the chat UI listens on fire), without spawning a task or invoking the model. The gmail-watch backlog notice (a non-silent shortCircuit summary) reaches the user this way.
  - **context** → `dispatchPromptRun` runs the drafting turn with the items injected. Items travel through a default-`[]` `hookContext` param joined into the job's existing `Context:` block at the single `withCronHint` assembly point. An `untrusted` item is fenced by the RUNNER as hardened quoted data (Claude Code's "phrase additionalContext as factual data, not instructions") — JSON-encoded onto one line, sentinel-stripped to a fixpoint, nonce-suffixed close delimiter, char-capped before the close marker; a trusted item (`untrusted:false`) is passed through (still char-capped). The prompt-injection boundary is reviewed CORE code, not per-handler. When the result is ROUTED (`buckets`), the jobs consumer instead fans the tick out into one constrained-subagent worker per non-empty bucket (each into its route's session), with the cursor committed per-bucket — see [Job Concern Fan-Out](job-concern-fanout.md).
  - **error** / **timeout** → `finalizeHookError` finalizes the run failed (no draft) and stamps `lastFailureAt`/`lastError` on the job. Whether a scheduled job is DEACTIVATED depends on the error class: a CONFIG error (unknown handlerId, a handler-returned `{ kind: "error" }` — the `skill-script` handler uses this for a missing/unknown skill|script or malformed script output — or a result whose kind isn't in the union) flips `job.status="failed"` for scheduled triggers, because retrying can never succeed; a TRANSIENT error (a `timeoutMs` overrun, default 30s, or an unexpected handler throw — e.g. the `skill-script` handler re-throwing on a non-zero script exit) leaves `job.status="active"` so the job self-recovers on its next tick. Deactivating a watcher on a transient stall would silently kill it, and the orphaned timed-out handler promise could later write a healthy-looking status that masks the death. The result kind is validated INSIDE the timeout race's guard, so a malformed result takes the typed (fatal) error path rather than throwing past the catch and stranding the run "running" forever.
  - **Handler contract**: because `Promise.race` does NOT cancel the loser, a timed-out handler keeps running to completion. Handlers MUST therefore be cancellation-safe and idempotent. The `skill-script` handler is the cleanest case — it runs a PURE script (state in via stdin, new state out on the result) and writes no state itself, so an orphaned post-timeout handler can't corrupt anything or double-deliver.
- **Job-owned hook state** (`JobRecord.hookState`, opaque blob). A pure hook handler is a function of `{ config, hookState } -> { result, newState }`: the scheduler threads the job's current `hookState` in as the `runHook` payload (the runner merges it into the handler's `hookConfig`, so the script reads `hookConfig.state`) and persists the handler's `newState` (carried on the `HookResult`) back onto the job. The commit TIMING preserves at-least-once across the delivery boundary: a **shortCircuit** persists `newState` IMMEDIATELY (nothing was delivered), while a **context** result persists `newState` ONLY after `dispatchPromptRun` has spawned the drafting turn — a dispatch failure leaves the OLD state so the next fire re-detects and re-delivers. An **error** persists nothing. The blob's shape is owned by the handler/script (e.g. the gmail-watch cursor + a small boundary dedup set), opaque to the runtime.
- The hook runs OUTSIDE the spawned task's approval/audit/trace envelope, so by contract a handler does only read-only / idempotent side effects (the `skill-script` handler does none — its script is pure). Anything that needs the approval gate must happen INSIDE the drafting turn (via a tool/skill), never in the hook. This mirrors the email split: the detection script reads only metadata; the turn reads bodies + sends through the approval-gated skill.
- Overlap, cancel, and shutdown are unchanged from the existing scheduler: the hook runs after the claim (so the in-`running` run is already the overlap key), every finalize re-guards `status === "running"`, and the hook runs inside `runDueJobs` which is already awaited by the SIGTERM scheduler drain (the deleted gmail loop's separate drain is no longer needed).

## Email mapping (first consumer)

- ALL of an agent's watchers share ONE backing interval-driven job (60s) and ONE chat session, whose `preRunHook` is `{ handlerId: "skill-script", config: { skill: "gmail-watch", script: "detect", watches: [{ watcherId, query, account? }, ...] } }`. The `skill-script` handler runs the bundled `gmail-watch/detect` script HEADLESS over the `watches` list and maps its stdout: 0 matches across all watches → `shortCircuit` (no turn); 1+ → `context` with each match as a RAW untrusted item (labeled by sender) the runner fences.
- A gws/transport failure for one watch is reported in that watch's per-watch state (status `error`), never a non-zero exit, so the shared JOB stays active and the other watches keep polling — a hook `error` would flip `job.status="failed"`. The handler's `error` kind is reserved for broken config (missing/unknown skill|script, malformed output). Signed-out is reported the same way, marking every watch `needs_auth`.
- The per-watch detection cursors + small boundary dedup sets live on `JobRecord.hookState` keyed by watcher id (`byWatcher[watcherId]`, job-owned, persisted at the at-least-once commit boundary above). The watcher records are the durable CONFIG identities; the shared job holds the detection state.
- Migration backfill (`backfillEmailWatcherJobs`, run at startup) ensures each agent with enabled watchers has its ONE shared job. Idempotent: it adopts an existing shared job (matched by a stable per-agent marker — `preRunHook.config.skill === "gmail-watch"` owned by the same agent), re-stamps every enabled watcher's `jobId`/`chatSessionId`, or provisions one if missing (e.g. legacy per-sender watchers from before the consolidation), and is safe on every boot. A migrated watcher re-seeds on its first fire (the cursor lived on the now-absent or rebuilt job state).

## Forward-looking (design-only, NOT built)

These are recorded so the primitive can grow without a redesign; none are
implemented in v1.

- **More events.** A `postRun` hook (after the model turn, to react to its
  result) and a `preTool` hook (before a specific tool dispatch) would follow the
  same typed-result shape. They'd need their own contexts (postRun sees the
  task's summary; preTool sees the tool call) but reuse the registry + finalize
  machinery.
- **User-authored command hooks.** A future `handlerId: "command"` kind could run
  a user-supplied shell command (the closest analog to Claude Code's shell
  hooks). It would be **consent-gated** (an explicit Authorization before the
  command runs) and sandboxed, since it crosses from "declarative data" back to
  "executable code" — the exact boundary v1 deliberately does not cross.
- **Matchers.** Claude Code matches an event to a handler by a matcher (tool name
  glob, path glob). v1 binds one handler per job directly; a matcher layer would
  let one registration apply to many jobs.

## Trust Boundary

- The handler registry is the security boundary: only reviewed, in-tree code runs
  as a hook. The model/user supplies a registry key + declarative data, never a
  handler body. An unknown `handlerId` is rejected at create time and errors at
  run time.
- A `context` item is untrusted external content. The RUNNER (reviewed core code)
  owns the prompt-injection fence: it JSON-encodes + sentinel-strips + nonce-
  delimits + char-caps every `untrusted:true` item before it reaches the model, so
  a handler/script emits only raw fields and never has to get the fence right (see
  [Email Watch](email-watch.md)). A handler emits `untrusted:false` only for
  content it generated itself (e.g. a notice with no external bytes).
- Hooks run outside the approval/audit/trace envelope and are read-only by
  contract. Side effects that require approval must happen inside the drafting
  turn through a tool/skill, never in the hook.

## Verification

- `bun test src/hooks/hooks.test.ts` exercises the primitive end-to-end through the jobs consumer (`runJobNow`/`runDueJobs`) with stub handlers registered via a test-only registry override: shortCircuit (0 turns, run completed inline, no assistant message under `[SILENT]`, the `chat.message.suppressed_silent` audit present, and NO `job.chat.sync.error` log), a NON-silent shortCircuit summary (delivered as exactly one runtime-authored assistant message with no spawned task, no suppression audit), shortCircuit on a one-shot job (auto-pause + `job.oneshot.completed` audit), context (exactly one turn spawned with the injected item in the assembled prompt; `untrusted:true` wrapped in the runner's hardened `matched-context` fence; the `onDispatched` commit runs after dispatch), the job-owned `hookState` round-trip (a shortCircuit handler's state persists immediately; a context handler's state persists only after the turn dispatches), a CONFIG error (run failed, no turn, scheduled trigger flips `job.status="failed"`), a TRANSIENT timeout (run failed but the scheduled job stays `active`), a malformed result (typed fatal error, not a throw past the catch), unknown-handler + prototype-key rejection at create + run, no-hook regression (byte-identical prompt), the char cap (oversized item truncated, and an oversized untrusted item keeps an intact nonce-suffixed close marker), and the cancel-race finalize re-guard (no double finalize).
- `bun test src/capabilities/skill-script-hook.test.ts` covers the `skill-script` handler against a real fixture script: the stdout → `HookResult` mapping for context + shortCircuit, the state round-trip (in via the payload, out on the result), and the error taxonomy (missing routing key / unknown skill / malformed output → config error; non-zero exit → a throw the runner classes transient).
- `bun test skills/google/gmail-watch/scripts/detect.test.ts` ports the delta-engine regimes onto the stateless `detect` script with an injected gws spawn (state in, state out, no store): seeding baseline + same-second siblings, the oldest-first backlog drain + cap, the truncated-window backlog notice (a non-silent shortCircuit, cursor jumps to newest, no re-loop), the `after:<epochSec>` watermark bound, boundary dedup, the safety floor (automated + self by address equality), raw (un-fenced) match items, and at-least-once (re-running with the old state re-detects).
- `bun test src/hooks/registry.test.ts` pins the primitive's decoupling: `runHook` drives a stub handler to each `HookOutcome` (with the `payload` merge) importing NO `src/jobs` symbol (used-independently), prototype-key rejection, a structural assertion that `src/hooks/{types,registry,runner,index}.ts` import no `src/jobs`/`src/state`/`src/integrations`/`src/capabilities` module (the module boundary), and registration reachability (importing `builtins` makes `isKnownHook("skill-script")` true).
