# Job Skill Attachments

## Decision

A scheduled job can carry **skill attachments**: `JobRecord.skillNames` is an
optional list (max 8) of enabled-skill names whose **full bodies are inlined
into every fire's dispatched prompt**. Attachment makes skill usage on a
schedule *deterministic*: the run follows the skill's recipe because the
recipe is in the prompt, instead of relying on the model deciding to call
`read_skill` (which it routinely skips, re-learning CLI usage from `--help`
on every fire at 10x the token cost).

The contract:

- **One validation choke point.** `createScheduledJob` and `updateJob`
  (`src/jobs/index.ts`) validate `skillNames` — shape up-front, registry
  resolution inside the `mutateState` lock. Every surface (HTTP
  `POST /api/jobs` + `PATCH /api/jobs/<id>`, the agent's
  `create_job`/`update_job` tools, CLI via the HTTP API) delegates to those
  two functions, so they all validate identically. Resolution uses the same
  semantics as the `read_skill` tool (`src/execution/tool-dispatch.ts`):
  exact name match, enabled bundled preferred over enabled user. An unknown
  or disabled name rejects with a typed `Invalid input: …` naming the bad
  entry so the agent can self-correct. On update the list is
  replace-wholesale; `[]` or `null` clears.
- **Fire-time inlining at the single prompt-assembly point.** Both dispatch
  paths — the single-turn `dispatchPromptRun` and the routed fan-out
  `dispatchFanOut` (see [Job Concern Fan-Out](job-concern-fanout.md)) —
  resolve `job.skillNames` and pass the rendered block into `withCronHint`,
  ahead of the job's context block (trusted recipe before possibly-untrusted
  hook context). Jobs without attachments assemble byte-identical prompts to
  the pre-attachment behavior. The block shape:

  ```text
  Attached skill instructions (operator-registered; follow these recipes instead of rediscovering CLI usage):
  <skill name="google-calendar" version="3">
  ...full SKILL.md body...
  </skill>
  ```

- **Fire-time resilience: skip, never fail.** A skill that has gone
  missing/disabled/inactive (connector no longer healthy) between create and
  fire is **skipped with a per-task trace event naming it** — the fire
  proceeds without that skill's instructions (`read_skill` rejects
  missing/disabled/inactive skills too, so the skip is final for the fire).
  A stale attachment must never kill a schedule.
- **Size cap.** Inlined bodies share a 32,000-character budget per fire. The
  overflowing skill is truncated with an in-prompt note pointing at
  `read_skill` for the full body, plus a trace warning.
- **Trace + task stamping.** Each fire traces what was inlined (names +
  versions + total chars) on the spawned task, and `dispatchPromptRun` pushes
  the resolved skill ids onto the task's `skillIds` so the UI/telemetry shows
  skill usage. Fan-out workers get the trace only (they are spawned through
  `spawnSubagent`, whose contract stays untouched).

## Context

Dogfooding the dominant personal-agent use case — a scheduled morning
briefing over calendar + email — showed every fire re-discovering the `gws`
CLI from `--help` because the relevant bundled skills were advertised
(name + description in the system prompt) but never read: `task.skillIds`
stayed empty on every run, and each fire burned ~150k input tokens across 6
model iterations. The system-prompt-advertise/`read_skill` design is right
for interactive chat (pay for bodies only when needed) but wrong for
schedules: a job is created once by a capable interactive turn, then fired
unattended many times — the create-time turn knows exactly which recipes the
fires need, so it should pin them. Hermes supports the same shape
(skills attachable to cron jobs); this brings Gini to parity as a general
core primitive rather than a briefing-specific feature.

Attachment is declarative data into a trusted path: the agent supplies skill
*names* validated against the operator's registry; the runtime inlines only
registry-resolved bodies at fire time. No new execution surface.

## Consequences

- Scheduled runs that touch integrations become cheap and reliable: the
  recipe arrives with the prompt, so the model stops trial-and-erroring CLIs
  and stops depending on a `read_skill` call it tends to skip.
- The agent-facing `create_job`/`update_job` schemas steer the agent to
  attach the skills covering whatever integrations the job prompt touches;
  `list_jobs` returns current `skillNames` so a replace-only update can
  preserve attachments.
- Skill bodies are inlined fresh each fire (never snapshotted onto the job),
  so skill upgrades propagate to existing jobs automatically — at the cost
  that a deleted/disabled skill silently degrades the job to its prompt
  (visible in the trace, not fatal).
- Not in scope: heuristic auto-attachment, and skill auto-injection for
  ad-hoc (non-job) turns — interactive turns keep the advertise +
  `read_skill` model.

## Acceptance Checks

- `bun test src/jobs/skill-attachments.test.ts` — create/update validation
  (unknown/disabled names rejected by name, 8-name cap, `[]`/`null` clear),
  fenced-block injection on both dispatch paths, skip-with-trace for a
  skill disabled after create, and 32k truncation with trace.
- `bun test src/execution/tool-catalog.test.ts` — `create_job`/`update_job`
  schemas carry the `skillNames` steering text.
