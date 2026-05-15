import { submitTask } from "../agent";
import type { JobRecord, JobRunRecord, RuntimeConfig, RuntimeState } from "../types";
import { addAudit, appendEvent, appendLog, appendTrace, createJob, createJobRun, createRun, isTerminalTaskStatus, mutateState, now, readState } from "../state";
import { spawn } from "bun";
import { Cron } from "croner";

export { finalizeJobRunFromTask } from "./finalize";

// Prepended to every scheduled-job prompt so the LLM produces output the
// runtime can deliver. Without this, a scheduled task run inside a chat
// session inherits the prior conversation context and the LLM tends to
// respond conversationally ("Scheduled: feed-cat will fire in 45 seconds.")
// instead of actually delivering the reminder ("Feed the cat now.").
//
// The hint also defines a `[SILENT]` sentinel the LLM can emit when there
// is genuinely nothing to report — see syncChatTaskResult for the
// suppression path.
const CRON_EXECUTION_HINT = [
  "[IMPORTANT: You are running as a scheduled job, not as part of a live conversation.",
  "DELIVERY: Your final response IS the deliverable. The runtime ships it back to the originating chat (or other configured target) automatically — do NOT try to schedule another job, do NOT acknowledge the schedule, do NOT say 'I will remind you'. Just produce the reminder/report/output the user wanted.",
  "SILENT: If there is genuinely nothing new to report (e.g. a watcher job with no change), respond with exactly \"[SILENT]\" and nothing else to suppress delivery. Never combine [SILENT] with content.]",
  ""
].join("\n");

function withCronHint(jobPrompt: string, context: string[]): string {
  const contextBlock = context.length > 0 ? `Context:\n${context.join("\n")}\n\n` : "";
  return `${CRON_EXECUTION_HINT}\n${contextBlock}${jobPrompt}`;
}

function assertPositiveInt(label: string, value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid input: ${label} must be a positive integer (got ${String(value)})`);
  }
  return num;
}

function assertNonNegativeInt(label: string, value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid input: ${label} must be a non-negative integer (got ${String(value)})`);
  }
  return num;
}

export async function createScheduledJob(config: RuntimeConfig, input: Record<string, unknown>) {
  // Cron-vs-interval mutual exclusion. A job is driven by EITHER a 5-field
  // Unix cron expression (wall-clock + per-job IANA timezone) OR an
  // interval-from-now (`intervalSeconds`). Reject payloads that explicitly
  // set both — the caller is ambiguous and silently picking one would
  // surprise the user. `intervalSeconds === undefined` (the absent case)
  // is the "not set" sentinel even though JSON.stringify(NaN) === "null"
  // — `null` flows into assertPositiveInt below and gets rejected.
  let cronExpression: string | undefined;
  let cronTimezone: string | undefined;
  if (input.cronExpression !== undefined && input.cronExpression !== null) {
    if (typeof input.cronExpression !== "string" || input.cronExpression.trim().length === 0) {
      throw new Error(`Invalid input: cronExpression must be a non-empty string (got ${String(input.cronExpression)})`);
    }
    cronExpression = input.cronExpression.trim();
    if (input.intervalSeconds !== undefined) {
      throw new Error("Invalid input: cronExpression and intervalSeconds are mutually exclusive");
    }
  }
  if (input.cronTimezone !== undefined && input.cronTimezone !== null) {
    if (typeof input.cronTimezone !== "string" || input.cronTimezone.length === 0) {
      throw new Error(`Invalid input: cronTimezone must be a non-empty string (got ${String(input.cronTimezone)})`);
    }
    cronTimezone = input.cronTimezone;
  }
  // If a cron timezone is supplied without a cronExpression, that's a
  // payload mistake — the timezone is meaningless on an interval job.
  if (cronTimezone !== undefined && cronExpression === undefined) {
    throw new Error("Invalid input: cronTimezone may only be set when cronExpression is set");
  }

  // Validate the cron expression + timezone by constructing a Cron
  // instance. Croner throws synchronously on either an unparseable
  // pattern or an unknown IANA TZ — re-throw as `Invalid input: …` so
  // the HTTP layer surfaces a typed 400. Default timezone is "UTC".
  let initialCronNextRunMs: number | undefined;
  if (cronExpression !== undefined) {
    const tz = cronTimezone ?? "UTC";
    let cron: Cron;
    try {
      cron = new Cron(cronExpression, { timezone: tz });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Croner throws `TypeError: CronPattern: invalid …` for syntax
      // failures and `TypeError: CronOptions: Invalid timezone …` for
      // bad IANA identifiers. Split the error surface so callers know
      // which input was bad.
      if (/timezone/i.test(message)) {
        throw new Error(`Invalid input: cronTimezone "${tz}" is not a valid IANA timezone (${message})`);
      }
      throw new Error(`Invalid input: cronExpression is not a valid 5-field Unix cron (${message})`);
    }
    const next = cron.nextRun();
    if (!next) {
      // Cron returned null — e.g. a pattern that can never fire. Treat as
      // input error so the agent rewrites the expression.
      throw new Error(`Invalid input: cronExpression "${cronExpression}" has no future runs`);
    }
    initialCronNextRunMs = next.getTime();
  }

  // Only fall back to defaults when the field is truly absent. An explicit
  // NaN-from-JSON arrives as `null`, and `null ?? 60` would silently
  // promote a bogus payload to a happy path — instead, validate it.
  // When cronExpression is set, intervalSeconds is stored as 0 (sentinel
  // for "not interval-driven") so the field stays a `number` and the
  // existing JobRecord shape isn't disturbed by a giant migration.
  const intervalSeconds = cronExpression !== undefined
    ? 0
    : input.intervalSeconds === undefined
      ? 60
      : assertPositiveInt("intervalSeconds", input.intervalSeconds);
  const timeoutSeconds = input.timeoutSeconds === undefined
    ? 600
    : assertPositiveInt("timeoutSeconds", input.timeoutSeconds);
  const retryLimit = input.retryLimit === undefined
    ? 0
    : assertNonNegativeInt("retryLimit", input.retryLimit);
  // Optional session linkage + one-shot semantics. We validate types
  // up-front so a bogus payload returns a typed `Invalid input: …` (which
  // the HTTP layer turns into 400) instead of silently coercing.
  let chatSessionId: string | undefined;
  if (input.chatSessionId !== undefined && input.chatSessionId !== null) {
    if (typeof input.chatSessionId !== "string" || input.chatSessionId.length === 0) {
      throw new Error(`Invalid input: chatSessionId must be a non-empty string (got ${String(input.chatSessionId)})`);
    }
    chatSessionId = input.chatSessionId;
  }
  let oneShot: boolean | undefined;
  if (input.oneShot !== undefined && input.oneShot !== null) {
    if (typeof input.oneShot !== "boolean") {
      throw new Error(`Invalid input: oneShot must be a boolean (got ${String(input.oneShot)})`);
    }
    oneShot = input.oneShot;
  }
  // Per-job auto-approve envelope. Both fields are optional; reject malformed
  // payloads up-front so a typo doesn't silently fall back to legacy behavior.
  // See ADR dangerously-auto-approve.md ("Per-job scope") for the trust model.
  let dangerouslyAutoApprove: boolean | undefined;
  if (input.dangerouslyAutoApprove !== undefined && input.dangerouslyAutoApprove !== null) {
    if (typeof input.dangerouslyAutoApprove !== "boolean") {
      throw new Error(`Invalid input: dangerouslyAutoApprove must be a boolean (got ${String(input.dangerouslyAutoApprove)})`);
    }
    dangerouslyAutoApprove = input.dangerouslyAutoApprove;
  }
  let autoApproveCommands: string[] | undefined;
  if (input.autoApproveCommands !== undefined && input.autoApproveCommands !== null) {
    if (!Array.isArray(input.autoApproveCommands)) {
      throw new Error(`Invalid input: autoApproveCommands must be an array of strings (got ${typeof input.autoApproveCommands})`);
    }
    const cleaned: string[] = [];
    for (const entry of input.autoApproveCommands) {
      if (typeof entry !== "string") {
        throw new Error(`Invalid input: autoApproveCommands entries must be strings (got ${typeof entry})`);
      }
      if (entry.length === 0) {
        throw new Error(`Invalid input: autoApproveCommands entries must be non-empty strings`);
      }
      cleaned.push(entry);
    }
    autoApproveCommands = cleaned;
  }
  // A parent task that has already transitioned terminal must not
  // create a durable scheduled job. Without this, a `cancelTask`
  // queued between the dispatcher's lock-free pre-check and our
  // `mutateState` below would win the lock, mark the task
  // cancelled, and still leave a fresh recurring job behind. By
  // doing the terminal check INSIDE the `mutateState` callback the
  // per-instance lock serializes "is the task cancelled?" and
  // "create the job" so neither can interleave.
  const parentTaskId =
    typeof input.parentTaskId === "string" ? input.parentTaskId : undefined;
  return mutateState(config.instance, (state) => {
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      // Refuse on `cancelled` (operator cancel) AND `failed`
      // (sibling denial / runtime failure mid-turn). `completed` is
      // permitted because a legitimate parent's final action can
      // be "schedule a recurring follow-up job."
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot create scheduled job: parent task ${parentTaskId} is already ${parent.status}.`);
      }
    }
    // Initial nextRunAt: cron-driven jobs anchor to the next cron-matched
    // wall-clock moment (resolved above via Cron.nextRun()), interval-driven
    // jobs anchor `intervalSeconds` from now.
    const initialNextRunAtMs = cronExpression !== undefined
      ? (initialCronNextRunMs as number)
      : Date.now() + intervalSeconds * 1000;
    return createJob(state, {
      name: String(input.name ?? "Untitled job"),
      prompt: String(input.prompt ?? ""),
      script: typeof input.script === "string" && input.script.trim() ? input.script : undefined,
      intervalSeconds,
      cronExpression,
      cronTimezone: cronExpression !== undefined ? (cronTimezone ?? "UTC") : undefined,
      nextRunAt: new Date(initialNextRunAtMs).toISOString(),
      deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : [],
      context: Array.isArray(input.context) ? input.context.map(String) : [],
      retryLimit,
      timeoutSeconds,
      costBudget: typeof input.costBudget === "number" ? input.costBudget : undefined,
      chatSessionId,
      oneShot,
      dangerouslyAutoApprove,
      autoApproveCommands
    });
  });
}

// Returns the most recent running run for the given jobId, or undefined.
function findRunningRun(state: RuntimeState, jobId: string): JobRunRecord | undefined {
  return state.jobRuns.find((run) => run.jobId === jobId && run.status === "running");
}

// Drift-free advance: starting from the previous nextRunAt, advance forward
// by intervalSeconds until the next scheduled time is in the future. The
// first advance consumes the run we just claimed; each subsequent advance is
// a missed run we're skipping. Returns the new nextRunAt and the number of
// extra missed runs (>= 0).
function advanceNextRunAt(prevNextRunAtMs: number, intervalSeconds: number, nowMs: number): { nextRunAtMs: number; missed: number } {
  const stepMs = intervalSeconds * 1000;
  let next = prevNextRunAtMs + stepMs;
  let missed = 0;
  while (next <= nowMs) {
    next += stepMs;
    missed += 1;
  }
  return { nextRunAtMs: next, missed };
}

// Cron-driven equivalent of advanceNextRunAt. Walks forward through cron-
// matched moments starting at the run we just claimed: the first advance
// consumes that run, each subsequent advance is a missed cron-fire that
// has already drifted into the past (e.g. the runtime was offline). Mirrors
// the interval helper's contract — the cron version delegates the "what's
// the next match?" math to croner so DST transitions, leap years, and
// month-end edge cases are handled natively. Returns the new nextRunAt
// (ms) and the count of EXTRA missed cron fires (>= 0).
function advanceCronNextRunAt(
  cronExpression: string,
  cronTimezone: string,
  prevNextRunAtMs: number,
  nowMs: number
): { nextRunAtMs: number; missed: number } {
  const cron = new Cron(cronExpression, { timezone: cronTimezone });
  // croner's nextRun(prev) returns the FIRST fire strictly after `prev`,
  // so passing the previous nextRunAt yields the natural next match.
  let next = cron.nextRun(new Date(prevNextRunAtMs));
  let missed = 0;
  // Defensive: a pathological pattern that returns null. We treat it as
  // a fallback to "stay where we are" so the scheduler doesn't crash.
  // createScheduledJob's validation already rejected unfire-able patterns
  // at submit time, so reaching this branch implies clock skew or a
  // truly degenerate edge.
  if (!next) {
    return { nextRunAtMs: prevNextRunAtMs, missed: 0 };
  }
  while (next.getTime() <= nowMs) {
    const after = cron.nextRun(next);
    if (!after) break;
    next = after;
    missed += 1;
  }
  return { nextRunAtMs: next.getTime(), missed };
}

export async function runDueJobs(config: RuntimeConfig): Promise<void> {
  // Atomic claim: select due jobs, skip ones that already have a running
  // run (overlap protection), advance nextRunAt drift-free, and create the
  // JobRunRecord — all inside one mutateState write so a slow tick can't
  // race itself.
  const claimed = await mutateState(config.instance, (state) => {
    const dateNow = Date.now();
    const out: Array<{ job: JobRecord; run: JobRunRecord }> = [];
    for (const job of state.jobs) {
      if (job.status !== "active") continue;
      const dueAt = new Date(job.nextRunAt).getTime();
      if (dueAt > dateNow) continue;
      // Overlap protection: never start a scheduled run when another run
      // for the same job is still in-flight. Leave nextRunAt alone — the
      // next tick will retry once the in-flight run completes.
      if (findRunningRun(state, job.id)) continue;

      // Drift-free nextRunAt + missedRuns. The first advance consumes the
      // tick we're claiming now; each additional advance is a missed run.
      // Cron-driven jobs use the cron-aware helper so DST + month-end
      // boundaries are handled natively; interval jobs keep the linear
      // step math.
      const { nextRunAtMs, missed } = job.cronExpression
        ? advanceCronNextRunAt(job.cronExpression, job.cronTimezone ?? "UTC", dueAt, dateNow)
        : advanceNextRunAt(dueAt, job.intervalSeconds, dateNow);
      job.nextRunAt = new Date(nextRunAtMs).toISOString();
      if (missed > 0) job.missedRuns += missed;
      job.lastRunAt = now();
      job.runCount += 1;
      job.updatedAt = now();
      const run = createJobRun(state, { jobId: job.id, trigger: "schedule" });
      job.runIds.unshift(run.id);
      out.push({ job, run });
    }
    return out;
  });

  for (const { job, run } of claimed) {
    // Regression guard: see review note 2026-05-10. A per-job dispatch
    // failure must NOT escape and strand the OTHER already-claimed runs
    // in `running` forever. dispatchPromptRun finalizes its own run as
    // failed before rethrowing, so the catch here is purely about not
    // derailing the rest of the loop. Log the iteration error so an
    // operator can see what happened.
    try {
      if (job.script) {
        // executeScriptJob handles its own try/catch to keep the scheduler
        // tick from crashing on a script-runtime error.
        await executeScriptJob(config, job.id, run.id, job.script, job.timeoutSeconds, "schedule");
        continue;
      }
      await dispatchPromptRun(config, job, run, "schedule");
    } catch (error) {
      appendLog(config.instance, "scheduler.iteration.error", {
        jobId: job.id,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
  }
}

// Build the per-task RuntimeConfig the spawned job-task will see. The
// returned object is always a fresh clone so we never mutate the
// operator's global config object. When the job carries no per-job
// envelope, the clone is byte-identical to the input and the spawned task
// inherits current behavior. When the job opts in, we overlay:
//   - `dangerouslyAutoApprove=true` (full bypass for this job only)
//   - `autoApproveCommands` merged onto the cloned array (operator's
//     allowlist still applies; the job widens it for its own task)
// Audit rows on the spawned task's side effects automatically pick up the
// usual `autoApprovedReason` markers (matched pattern, or
// "dangerouslyAutoApprove") via the existing tool-dispatch path — the
// only thing that changes per-job is which config object the spawned
// task sees.
function buildTaskConfig(config: RuntimeConfig, job: JobRecord): RuntimeConfig {
  const clone: RuntimeConfig = {
    ...config,
    autoApproveCommands: Array.isArray(config.autoApproveCommands)
      ? [...config.autoApproveCommands]
      : undefined
  };
  if (job.dangerouslyAutoApprove === true) {
    clone.dangerouslyAutoApprove = true;
  }
  if (Array.isArray(job.autoApproveCommands) && job.autoApproveCommands.length > 0) {
    const base = clone.autoApproveCommands ?? [];
    clone.autoApproveCommands = [...base, ...job.autoApproveCommands];
  }
  return clone;
}

// Spawns the prompt task for an already-claimed JobRunRecord. Leaves the
// run in `running` — it will be finalized via finalizeJobRunFromTask once
// the spawned task reaches a terminal state. If submitTask itself throws,
// finalize the run as failed defensively so it doesn't hang.
//
// When the job carries a `chatSessionId` (created via the agent's
// `create_job` tool), we additionally:
//   - create a fresh RunRecord linked to that conversation so the chat
//     UI shows the spawned task in the same thread
//   - submit the task with mode:"chat" + that runId so the tool-calling
//     agent loop is used (multi-turn context, structured tool calls)
//   - push task.id onto session.taskIds so getChatSession picks up the
//     in-flight task and synthesizes a placeholder
// Final delivery (assistant message) is wired up in finalizeJobRunFromTask
// via syncChatTaskResult.
async function dispatchPromptRun(
  config: RuntimeConfig,
  job: JobRecord,
  run: JobRunRecord,
  trigger: "schedule" | "manual" | "replay"
): Promise<{ jobId: string; runId: string; taskId: string }> {
  const prompt = withCronHint(job.prompt, job.context);
  // Per-job auto-approve envelope: clone the RuntimeConfig (NEVER mutate the
  // original — it's the per-instance runtime-wide config) and overlay the
  // job's opt-in fields before handing it to submitTask. The spawned task
  // and every approval-gated dispatch inside it see the cloned config; the
  // operator's global RuntimeConfig stays untouched. See ADR
  // dangerously-auto-approve.md ("Per-job scope") for the trust model.
  const taskConfig: RuntimeConfig = buildTaskConfig(config, job);

  // Resolve session linkage up-front. If the job points at a session that
  // no longer exists (deleted by the user), audit the gap and fall through
  // to the legacy imperative path so the job still produces a result.
  let chatRunId: string | undefined;
  if (job.chatSessionId) {
    const sessionRunId = await mutateState(config.instance, (state) => {
      const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
      if (!session) {
        addAudit(state, {
          actor: "runtime",
          action: "job.session.missing",
          target: job.id,
          risk: "low",
          evidence: { jobId: job.id, runId: run.id, chatSessionId: job.chatSessionId }
        });
        return undefined;
      }
      const chatRun = createRun(state, {
        kind: "job",
        title: job.name,
        input: prompt,
        conversationId: job.chatSessionId,
        jobId: job.id
      });
      // createRun pushes the runId onto session.runIds automatically when
      // conversationId is set. session.taskIds is updated post-submitTask
      // (we don't have task.id yet).
      return chatRun.id;
    });
    chatRunId = sessionRunId;
  }

  let task;
  try {
    if (chatRunId) {
      task = await submitTask(taskConfig, prompt, { jobId: job.id, runId: chatRunId, mode: "chat" });
    } else {
      task = await submitTask(taskConfig, prompt, job.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (state) => {
      const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
      const jobItem = state.jobs.find((candidate) => candidate.id === job.id);
      if (!runItem) return;
      if (runItem.status !== "running") return;
      runItem.status = "failed";
      runItem.error = message;
      runItem.completedAt = now();
      runItem.updatedAt = runItem.completedAt;
      if (jobItem) {
        jobItem.lastFailureAt = runItem.completedAt;
        jobItem.lastError = message;
        // Only flip status="failed" for scheduled runs; manual/replay
        // failures should leave the configured status untouched.
        if (trigger === "schedule") jobItem.status = "failed";
      }
      appendEvent(state, {
        kind: "job",
        action: "job.run.failed",
        target: job.id,
        jobId: job.id,
        risk: "low",
        summary: "Prompt job dispatch failed.",
        data: { runId: run.id, error: message }
      });
    });
    throw error;
  }
  await mutateState(config.instance, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id);
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    if (!item || !runItem) return;
    item.taskIds.unshift(task.id);
    runItem.taskId = task.id;
    // Leave runItem.status === "running" so finalizeJobRunFromTask can
    // complete it when the task settles. Do NOT set lastSuccessAt here.
    if (job.chatSessionId) {
      const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
      if (session && !session.taskIds.includes(task.id)) {
        session.taskIds.push(task.id);
        session.updatedAt = now();
      }
    }
  });
  appendTrace(config.instance, task.id, {
    type: "job",
    message: "Job spawned task",
    data: { jobId: job.id, runId: run.id, deliveryTargets: job.deliveryTargets, chatSessionId: job.chatSessionId, chatRunId }
  });
  return { jobId: job.id, runId: run.id, taskId: task.id };
}

export async function runJobNow(config: RuntimeConfig, jobId: string, trigger: "schedule" | "manual" | "replay" = "manual") {
  const claim = await mutateState(config.instance, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === jobId);
    if (!item) throw new Error(`Job not found: ${jobId}`);
    // Overlap protection for scheduled triggers: refuse to start a second
    // run while another is in-flight. Manual/replay are explicit user
    // actions and may run alongside an in-flight run.
    if (trigger === "schedule" && findRunningRun(state, jobId)) {
      addAudit(state, {
        actor: "runtime",
        action: "job.run.skipped_overlap",
        target: jobId,
        risk: "low",
        evidence: { reason: "previous run still running" }
      });
      return undefined;
    }
    item.lastRunAt = now();
    item.runCount += 1;
    // For trigger="schedule", advancing nextRunAt is owned by runDueJobs
    // (drift-free). For manual/replay we usually leave nextRunAt alone —
    // a user clicking Run shouldn't itself reschedule the next tick.
    //
    // BUT: if the manual run is happening AFTER the scheduled tick was
    // already overdue, we must advance nextRunAt or the scheduler will
    // re-fire the same job ~1s later and double-run it. Only do this
    // for active jobs — advancing on a paused job would imply the
    // schedule kept ticking while paused, which it didn't.
    //
    // The first advance corresponds to "this manual run satisfies the
    // overdue tick" and is NOT counted as a missed run; only additional
    // advances (further skipped intervals) bump missedRuns.
    if (trigger !== "schedule" && item.status === "active") {
      const dueAt = new Date(item.nextRunAt).getTime();
      const dateNow = Date.now();
      if (dueAt <= dateNow) {
        const { nextRunAtMs, missed } = item.cronExpression
          ? advanceCronNextRunAt(item.cronExpression, item.cronTimezone ?? "UTC", dueAt, dateNow)
          : advanceNextRunAt(dueAt, item.intervalSeconds, dateNow);
        item.nextRunAt = new Date(nextRunAtMs).toISOString();
        if (missed > 0) item.missedRuns += missed;
      }
    }
    item.updatedAt = now();
    const run = createJobRun(state, { jobId, trigger });
    item.runIds.unshift(run.id);
    return { job: item, run };
  });
  if (!claim) return undefined;
  const { job, run } = claim;
  if (job.script) return executeScriptJob(config, job.id, run.id, job.script, job.timeoutSeconds, trigger);
  return dispatchPromptRun(config, job, run, trigger);
}

export async function updateJobStatus(config: RuntimeConfig, jobId: string, statusValue: "active" | "paused") {
  return mutateState(config.instance, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = statusValue;
    job.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `job.${statusValue}`,
      target: jobId,
      risk: "low"
    });
    return job;
  });
}

export async function updateJob(config: RuntimeConfig, jobId: string, input: Record<string, unknown>) {
  // Validate up-front so 400-class errors come back as `Invalid input: ...`
  // before we open a mutateState write. Only validate fields the caller
  // actually supplied.
  if (input.intervalSeconds !== undefined) assertPositiveInt("intervalSeconds", input.intervalSeconds);
  if (input.timeoutSeconds !== undefined) assertPositiveInt("timeoutSeconds", input.timeoutSeconds);
  if (input.retryLimit !== undefined) assertNonNegativeInt("retryLimit", input.retryLimit);
  return mutateState(config.instance, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (typeof input.name === "string") job.name = input.name;
    if (typeof input.prompt === "string") job.prompt = input.prompt;
    if (typeof input.script === "string") job.script = input.script || undefined;
    if (typeof input.intervalSeconds === "number") job.intervalSeconds = input.intervalSeconds;
    if (Array.isArray(input.deliveryTargets)) job.deliveryTargets = input.deliveryTargets.map(String);
    if (Array.isArray(input.context)) job.context = input.context.map(String);
    if (typeof input.retryLimit === "number") job.retryLimit = input.retryLimit;
    if (typeof input.timeoutSeconds === "number") job.timeoutSeconds = input.timeoutSeconds;
    if (typeof input.costBudget === "number") job.costBudget = Math.max(0, input.costBudget);
    else if (input.costBudget === null) job.costBudget = undefined;
    job.updatedAt = now();
    addAudit(state, { actor: "user", action: "job.updated", target: job.id, risk: "low" });
    return job;
  });
}

export async function removeJob(config: RuntimeConfig, jobId: string) {
  return mutateState(config.instance, (state) => {
    const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
    if (index < 0) throw new Error(`Job not found: ${jobId}`);
    const [job] = state.jobs.splice(index, 1);
    // Cascade-remove orphan JobRunRecords so /api/job-runs and replay
    // can't 500 on a vanished job. We splice in place instead of filter
    // because mutateState wants the same array reference.
    let removedRuns = 0;
    for (let i = state.jobRuns.length - 1; i >= 0; i -= 1) {
      if (state.jobRuns[i]!.jobId === job.id) {
        state.jobRuns.splice(i, 1);
        removedRuns += 1;
      }
    }
    addAudit(state, {
      actor: "user",
      action: "job.removed",
      target: job.id,
      risk: "medium",
      evidence: { removedRuns }
    });
    return job;
  });
}

export function listJobRuns(config: RuntimeConfig, jobId?: string) {
  const runs = readState(config.instance).jobRuns;
  return jobId ? runs.filter((run) => run.jobId === jobId) : runs;
}

export async function replayJobRun(config: RuntimeConfig, runId: string) {
  const state = readState(config.instance);
  const run = state.jobRuns.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Job run not found: ${runId}`);
  // Cascade-removed jobs leave dangling runs only when state was migrated
  // from an older version. Today removeJob deletes runs alongside the job,
  // so this guard mainly serves replay-against-removed-job: surface a
  // typed error so the HTTP layer maps it to 404.
  const job = state.jobs.find((candidate) => candidate.id === run.jobId);
  if (!job) throw new Error(`Job not found: ${run.jobId}`);
  return runJobNow(config, run.jobId, "replay");
}

async function executeScriptJob(
  config: RuntimeConfig,
  jobId: string,
  runId: string,
  script: string,
  timeoutSeconds: number,
  trigger: "schedule" | "manual" | "replay"
) {
  try {
    const proc = spawn(["zsh", "-lc", script], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    return mutateState(config.instance, (state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      const run = state.jobRuns.find((candidate) => candidate.id === runId);
      // Defensive: don't throw if the job/run vanished (e.g. removeJob
      // raced with the script). Just return so the scheduler tick keeps
      // turning.
      if (!run) return { jobId, runId, exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) };
      run.status = exitCode === 0 ? "completed" : "failed";
      run.completedAt = now();
      run.updatedAt = run.completedAt;
      run.summary = stdout.slice(0, 4000);
      run.error = exitCode === 0 ? undefined : stderr.slice(0, 4000) || `Script exited ${exitCode}`;
      if (job) {
        if (exitCode === 0) {
          job.lastSuccessAt = run.completedAt;
          job.lastError = undefined;
          // Only force status="active" for scheduled runs. Manual/replay
          // successes leave the configured status untouched (so a paused
          // job stays paused after a manual run).
          if (trigger === "schedule") job.status = "active";
        } else {
          job.lastFailureAt = run.completedAt;
          job.lastError = run.error;
          // Same rule: only flip to "failed" for scheduled runs.
          if (trigger === "schedule") job.status = "failed";
        }
      }
      appendEvent(state, {
        kind: "job",
        action: exitCode === 0 ? "job.run.completed" : "job.run.failed",
        target: jobId,
        jobId,
        risk: "low",
        summary: exitCode === 0 ? "Script job completed." : "Script job failed.",
        data: { runId, exitCode, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) }
      });
      addAudit(state, {
        actor: "runtime",
        action: "job.script.executed",
        target: jobId,
        risk: "medium",
        evidence: { runId, exitCode, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) }
      });
      return { jobId, runId, exitCode, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateState(config.instance, (state) => {
      const run = state.jobRuns.find((candidate) => candidate.id === runId);
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!run) return;
      if (run.status !== "running") return;
      run.status = "failed";
      run.completedAt = now();
      run.updatedAt = run.completedAt;
      run.error = message;
      if (job) {
        job.lastFailureAt = run.completedAt;
        job.lastError = message;
        if (trigger === "schedule") job.status = "failed";
      }
      appendEvent(state, {
        kind: "job",
        action: "job.run.failed",
        target: jobId,
        jobId,
        risk: "low",
        summary: "Script job crashed.",
        data: { runId, error: message }
      });
    });
    return { jobId, runId, exitCode: -1, stdout: "", stderr: message };
  }
}
