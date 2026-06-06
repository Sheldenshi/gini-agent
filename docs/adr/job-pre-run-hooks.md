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

**Module shape.** The primitive lives in `src/hooks/` and imports only `src/types`
(for `RuntimeConfig`) and itself — zero `src/jobs`, `src/state`, or
`src/integrations` imports, so it stays domain-free:
- `types.ts` — the generic contract (`HookConfig`, `HookContext`, `HookResult`, `HookHandler`).
- `registry.ts` — the trusted-handler registry (the whole security boundary). Domains POPULATE it via `registerHook(id, handler)` rather than the registry importing handlers; `resolveHook` / `isKnownHook` are the resolution points. Null-prototype maps + own-property checks reject prototype keys.
- `runner.ts` — `runHook(config, hookConfig, payload?)`: resolve + per-hook timeout race + result-validate + context-render, returning a typed `HookOutcome`. It makes NO consumer policy decision — an error outcome carries a neutral `transient` flag (timeout/throw = transient; config/malformed = not) and the consumer decides what transience means for its own durability.
- `index.ts` — the public barrel consumers import (does NOT import builtins, so importing the primitive never drags a domain handler in).
- `builtins.ts` — the composition root: it imports each trusted handler module (which self-registers on load) and is imported once at application boot (server + CLI) and in tests that drive the scheduler.

Email-domain handlers (`gmail-delta`) live in `src/integrations/` beside their
engine and self-register into the registry; the primitive never imports them.

Two consumers exist today:
- **Jobs (combined).** A `JobRecord.preRunHook` runs at the scheduler seam; the jobs adapter maps `HookOutcome` onto its schedule-fatality policy (below). The email-watch feature is the first such consumer: each watcher is a scheduled job with a `gmail-delta` pre-run hook (see [Email Watch](email-watch.md)).
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

- A generic config (`src/hooks/types.ts`): `HookConfig = { handlerId: string; config: Record<string, unknown>; timeoutMs?: number }`. The jobs consumer persists it as `JobRecord.preRunHook?` — optional, so legacy jobs have no hook and dispatch byte-identically. `createScheduledJob` validates the shape and rejects a `handlerId` that isn't in the registry (via `isKnownHook`, typed `Invalid input: …`), so a bad id never persists.
- A trusted handler registry (`src/hooks/registry.ts`). `resolveHook(id)` / `isKnownHook(id)` are the only resolution points; the map is the whole security boundary. Domains call `registerHook(id, handler)` to populate it (so the registry imports no domain handler). v1 registers exactly one handler: `gmail-delta` (registered from `src/integrations/gmail-delta-hook.ts`).
- A typed result (`src/hooks/types.ts`): `HookResult = shortCircuit | context | error`. The discriminated union makes it impossible to both short-circuit and inject — one mode per invocation, the analog of Claude Code's "JSON only on exit 0".
- A generic runner (`src/hooks/runner.ts`): `runHook` resolves the handler, enforces the per-hook timeout via `Promise.race`, validates the result kind INSIDE the race guard (a malformed result takes the typed error path, never a throw past the catch), and renders `context` items into injectable strings (capped at the `PRE_RUN_HOOK_CONTEXT_CHAR_CAP` 10k preview; the close marker is appended AFTER truncation so an oversized untrusted payload can't break its fence). It returns a typed `HookOutcome` whose error carries a neutral `transient` flag — the runner makes NO consumer policy decision.
- The jobs consumer's `runPreRunHook` adapter calls `runHook` and maps the outcome onto the schedule-fatality policy: a TRANSIENT error (timeout / handler throw) is non-fatal (the run fails but the scheduled job stays active to self-recover), a non-transient config/malformed error is fatal (the scheduled job is deactivated). The scheduler runs the hook at the same seam in both `runDueJobs` (the scheduled path) and `runJobNow` (manual/replay), between the run claim and `dispatchPromptRun`:
  - **shortCircuit** → `finalizeShortCircuit` finalizes the run INLINE by `run.id` with NO model turn: it sets the run completed, stamps `job.lastSuccessAt` + clears `lastError`, honors one-shot auto-pause (and its audit), and emits the `job.run.completed` event. A short-circuited run never spawned a task, so there is nothing to materialize into chat — the silent/empty case emits the `chat.message.suppressed_silent` audit explicitly (delivering nothing), and `syncChatTaskResult` is reached only in the theoretical edge of a genuinely non-silent summary attached to a real spawned task. Binding by `run.id` is exact, so it never mis-binds under concurrent manual/replay runs; the `status === "running"` guard makes a finalize that races a cancel a no-op (no double finalize). It does NOT route a synthetic `Task` through `finalizeJobRunFromTask` — that path's `syncChatTaskResult` would throw "Task not found" for a task that was never in `state.tasks` (the dominant idle email path), stranding the suppression audit and spamming `job.chat.sync.error`.
  - **context** → `dispatchPromptRun` runs the drafting turn with the items injected. Items travel through a default-`[]` `hookContext` param joined into the job's existing `Context:` block at the single `withCronHint` assembly point. An `untrusted` item is fenced as quoted data (Claude Code's "phrase additionalContext as factual data, not instructions"); a handler that owns its own fence returns `untrusted:false` and is passed through verbatim. Each item is capped at `PRE_RUN_HOOK_CONTEXT_CHAR_CAP` (10k) — an oversized item is truncated to a preview.
  - **error** / **timeout** → `finalizeHookError` finalizes the run failed (no draft) and stamps `lastFailureAt`/`lastError` on the job. Whether a scheduled job is DEACTIVATED depends on the error class: a CONFIG error (unknown handlerId, a handler-returned `{ kind: "error" }` — gmail-delta uses this only for a missing/unknown watcher — or a result whose kind isn't in the union) flips `job.status="failed"` for scheduled triggers, because retrying can never succeed; a TRANSIENT error (a `timeoutMs` overrun, default 30s, or an unexpected handler throw) leaves `job.status="active"` so the job self-recovers on its next tick. Deactivating a watcher on a transient stall would silently kill it, and the orphaned timed-out handler promise could later write a healthy-looking status that masks the death. The result kind is validated INSIDE the timeout race's guard, so a malformed result takes the typed (fatal) error path rather than throwing past the catch and stranding the run "running" forever.
  - **Handler contract**: because `Promise.race` does NOT cancel the loser, a timed-out handler keeps running to completion. Handlers MUST therefore be cancellation-safe and idempotent — they may only do read-only / replay-safe side effects (gmail-delta writes only its cursor + dedup state), so an orphaned post-timeout handler can't corrupt anything or double-deliver.
- The hook runs OUTSIDE the spawned task's approval/audit/trace envelope, so by contract a handler does only read-only / idempotent side effects (e.g. a cursor + dedup write). Anything that needs the approval gate must happen INSIDE the drafting turn (via a tool/skill), never in the hook. This mirrors the email worker's split: the hook reads only metadata; the turn reads bodies + sends through the approval-gated skill.
- Overlap, cancel, and shutdown are unchanged from the existing scheduler: the hook runs after the claim (so the in-`running` run is already the overlap key), every finalize re-guards `status === "running"`, and the hook runs inside `runDueJobs` which is already awaited by the SIGTERM scheduler drain (the deleted gmail loop's separate drain is no longer needed).

## Email mapping (first consumer)

- Creating a watcher provisions a backing interval-driven job (60s) whose `preRunHook` is `{ handlerId: "gmail-delta", config: { watcherId } }`, bound to the watcher's dedicated chat session. The `gmail-delta` handler runs the hardened delta engine for that one watcher and returns: 0 collected prompts → `shortCircuit` (no turn); 1+ → `context` with each match as an already-fenced item.
- A gws/transport failure stamps the WATCHER `status: "error"` (scrubbed `lastError`) and returns `shortCircuit` so the backing JOB stays active and retries next tick — a hook `error` would flip `job.status="failed"` and stop scheduling. The hook's `error` kind is reserved for broken config (missing/unknown watcher). Signed-out flips the watcher to `needs_auth` and short-circuits.
- The watcher remains the durable detection identity: `email_seen` dedup and the `lastSeenInternalDate` cursor stay keyed by **watcher id**, not job id, so the dedup/cursor survive job recreation. The job is just the scheduler.
- Migration backfill (`backfillEmailWatcherJobs`, run at startup) provisions a backing job for any enabled watcher lacking a resolvable `jobId` (legacy watchers, or a watcher whose job was removed out-of-band). Idempotent: it finds existing jobs and does nothing, so it's safe on every boot. The cursor is preserved, so a migrated watcher's first fire is a normal steady-state tick, not a re-seed.

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
- **Generic `hookState`.** v1's one handler persists its own watcher-scoped state
  (`EmailWatcherRecord.lastSeenInternalDate` + `email_seen`). A generic
  `JobRecord.hookState` blob would let a future handler persist cursor/dedup
  without its own table; deferred as YAGNI until a second stateful handler exists.

## Trust Boundary

- The handler registry is the security boundary: only reviewed, in-tree code runs
  as a hook. The model/user supplies a registry key + declarative data, never a
  handler body. An unknown `handlerId` is rejected at create time and errors at
  run time.
- A `context` item is untrusted external content unless its handler vouches for
  its own fence. The scheduler fences `untrusted:true` items as quoted data
  before they reach the model; `gmail-delta` returns `untrusted:false` because the
  delta engine already JSON+nonce-fences each match (see [Email Watch](email-watch.md)).
- Hooks run outside the approval/audit/trace envelope and are read-only by
  contract. Side effects that require approval must happen inside the drafting
  turn through a tool/skill, never in the hook.

## Verification

- `bun test src/hooks/hooks.test.ts` exercises the primitive end-to-end through the jobs consumer (`runJobNow`/`runDueJobs`) with stub handlers registered via a test-only registry override: shortCircuit (0 turns, run completed inline, no assistant message under `[SILENT]`, the `chat.message.suppressed_silent` audit present, and NO `job.chat.sync.error` log), shortCircuit on a one-shot job (auto-pause + `job.oneshot.completed` audit), context (exactly one turn spawned with the injected item in the assembled prompt; `untrusted:true` wrapped in a `matched-context` fence; the `onDispatched` commit runs after dispatch), a CONFIG error (run failed, no turn, scheduled trigger flips `job.status="failed"`), a TRANSIENT timeout (run failed but the scheduled job stays `active`), a malformed result (typed fatal error, not a throw past the catch), unknown-handler + prototype-key rejection at create + run, no-hook regression (byte-identical prompt), the char cap (oversized item truncated, and an oversized untrusted item keeps an intact close marker), and the cancel-race finalize re-guard (no double finalize).
- `bun test src/integrations/gmail-delta-hook.test.ts` ports the delta-engine regimes onto the `gmail-delta` hook entrypoint with an injected gws boundary: seeding, dedup (surviving a simulated restart, committing delivery via the `onDispatched` thunk), the oldest-first backlog drain + cap, the truncated-window notice, same-second siblings, the `after:` watermark bound, signed-out → `needs_auth` (job stays active), a gws error → watcher `error` + scrubbed message + short-circuit (job NOT failed) + at-least-once re-trigger, a collected-but-undelivered draft (commit skipped) re-triggering on the next fire (the delivery boundary), and config-broken → `error`.
- `bun test src/hooks/registry.test.ts` pins the primitive's decoupling: `runHook` drives a stub handler to each `HookOutcome` (with the `payload` merge) importing NO `src/jobs` symbol (used-independently), prototype-key rejection, a structural assertion that `src/hooks/{types,registry,runner,index}.ts` import no `src/jobs`/`src/state`/`src/integrations` module (the module boundary), and registration reachability (importing `builtins` makes `isKnownHook("gmail-delta")` true).
