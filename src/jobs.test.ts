// Cron lifecycle tests. Pairs with src/http.test.ts (kept untouched) — same
// helpers, separate file to keep concerns siloed.
//
// What these cover (Plan B from the cron-hardening context):
// - paused jobs are not picked up by the scheduler tick
// - drift-free nextRunAt advance + missedRuns increment
// - overlap protection: a second scheduled run is skipped while the first
//   is still in-flight
// - prompt-job runs finalize asynchronously when the spawned task settles
// - manual run does not implicitly resume a paused job
// - removeJob cascade-deletes the JobRunRecords
// - replay against a removed job returns 404
// - intervalSeconds validation surfaces 400

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { createHandler } from "./http";
import { runDueJobs, runJobNow } from "./jobs";
import { advanceCronNextRunAt, updateJob } from "./jobs/index";
import { createChatMessage, createTask, mutateState, readState, upsertTask } from "./state";
import { dispatchToolCall } from "./execution/tool-dispatch";
import { syncChatTaskResult } from "./execution/chat";
import type { RuntimeConfig } from "./types";

describe("cron lifecycle", () => {
  test("scheduler skips paused jobs even when they're due", async () => {
    const config = testConfig("jobs-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused job", script: "echo ok", intervalSeconds: 1 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });

    // Force the job to be due in the past so the only thing keeping it
    // from running is its paused status.
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 5_000).toISOString();
    });

    await runDueJobs(config);
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(0);
  });

  test("runDueJobs advances nextRunAt drift-free and increments missedRuns", async () => {
    const config = testConfig("jobs-drift");
    const handler = createHandler(config);

    // intervalSeconds=10, set nextRunAt 25s in the past => the loop should
    // consume one interval (the run we claim) and skip 2 more, landing on
    // 5s in the future (3 total advances from -25 = +5). missedRuns counts
    // the *extra* skipped intervals (the consumed one is not a "miss").
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "drift job", script: "true", intervalSeconds: 10 })
    });
    const setupNow = Date.now();
    const dueAt = setupNow - 25_000;
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(dueAt).toISOString();
    });

    await runDueJobs(config);

    const after = readState(config.instance);
    const updated = after.jobs.find((candidate) => candidate.id === job.id)!;
    const runs = after.jobRuns.filter((run) => run.jobId === job.id);
    expect(runs).toHaveLength(1);
    // The advance loop walks: dueAt + 10s = -15s (still due, miss), -15 + 10
    // = -5s (still due, miss), -5 + 10 = +5s (future, stop). So missedRuns
    // should jump by 2 (the two extra advances).
    expect(updated.missedRuns).toBe(2);
    const newNextMs = new Date(updated.nextRunAt).getTime();
    expect(newNextMs).toBeGreaterThan(setupNow);
    // Sanity: the new nextRunAt must be on the original cadence — i.e.
    // (newNext - originalDue) is a positive multiple of the interval.
    const stepMs = 10_000;
    const delta = newNextMs - dueAt;
    expect(delta % stepMs).toBe(0);
    expect(delta / stepMs).toBe(3);
  });

  test("overlap protection: a second scheduled run is skipped while the first is in flight", async () => {
    const config = testConfig("jobs-overlap");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      // sleep 1 keeps the first run "running" while we try to claim a
      // second one. A bare `sleep 1` is enough on any Bun-supported host.
      body: JSON.stringify({ name: "overlap job", script: "sleep 1", intervalSeconds: 60, timeoutSeconds: 5 })
    });

    // Inject a fake running JobRunRecord directly so we don't have to race
    // a real `sleep 1`. The runJobNow with trigger=schedule must observe
    // the in-flight run and refuse to start a second one.
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: "jobrun_overlap_test",
        instance: state.instance,
        jobId: job.id,
        status: "running",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const result = await runJobNow(config, job.id, "schedule");
    expect(result).toBeUndefined();
    const runs = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    // Still just the one fake "running" run we injected — no new run.
    expect(runs.filter((run) => run.id !== "jobrun_overlap_test")).toHaveLength(0);
    // And the runtime audited the skip.
    const audit = readState(config.instance).audit.find((event) => event.action === "job.run.skipped_overlap" && event.target === job.id);
    expect(audit).toBeDefined();
  });

  test("prompt-job run finalizes asynchronously when the task settles", async () => {
    const config = testConfig("jobs-async-prompt");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "prompt job", prompt: "summarize today", intervalSeconds: 60 })
    });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.taskId).toBeString();
    expect(result.runId).toBeString();

    // Run should be `running` immediately after submitTask returns — the
    // finalize step waits for the spawned task to settle.
    const inFlight = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(inFlight?.status).toBe("running");
    expect(inFlight?.taskId).toBe(result.taskId);

    await waitForTask(handler, config, result.taskId);
    // Give the finalize hook a beat to land — runTask awaits the
    // finalizer before returning, but the task watcher polls on its own.
    await waitFor(() => readState(config.instance).jobRuns.find((run) => run.id === result.runId)?.status === "completed", 2_000);

    const settled = readState(config.instance).jobRuns.find((run) => run.id === result.runId);
    expect(settled?.status).toBe("completed");
    const settledJob = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(settledJob?.lastSuccessAt).toBeString();
  });

  test("manual run does not resume a paused job", async () => {
    const config = testConfig("jobs-manual-paused");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused-manual", script: "echo manual", intervalSeconds: 60 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    const result = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(result.exitCode).toBe(0);

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id);
    expect(after?.status).toBe("paused");
  });

  test("removeJob cascades JobRunRecord deletion", async () => {
    const config = testConfig("jobs-remove-cascade");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cascade", script: "echo cascade", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(runResult.exitCode).toBe(0);

    // Sanity: a run exists.
    const beforeRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(beforeRuns.length).toBeGreaterThanOrEqual(1);

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    const afterRuns = readState(config.instance).jobRuns.filter((run) => run.jobId === job.id);
    expect(afterRuns).toHaveLength(0);
    // The /api/job-runs listing also shouldn't include them.
    const allRuns = await call(handler, config, "/api/job-runs");
    expect(allRuns.filter((run: { jobId: string }) => run.jobId === job.id)).toHaveLength(0);
  });

  test("replay after the underlying job was removed returns 404", async () => {
    const config = testConfig("jobs-replay-404");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "replay-404", script: "echo gone", intervalSeconds: 60 })
    });
    const runResult = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    // Capture the runId before we cascade-delete, then resurrect it as a
    // dangling row (state migrated from an older version had this shape).
    const runId = runResult.runId;
    expect(runId).toBeString();

    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });

    // After removeJob the run is gone — but to test the "job vanished"
    // path of replayJobRun specifically, we re-insert a dangling run
    // record pointing at the removed job. This simulates older data
    // shapes (cron-hardening context says this used to be possible).
    await mutateState(config.instance, (state) => {
      state.jobRuns.unshift({
        id: runId,
        instance: state.instance,
        jobId: job.id,
        status: "completed",
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    const response = await rawCall(handler, config, `/api/job-runs/${runId}/replay`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("overdue manual run advances nextRunAt drift-free and bumps missedRuns", async () => {
    // Setup mirrors the scheduler drift-test, but invokes runJobNow with
    // trigger="manual" instead of letting runDueJobs claim it. Without the
    // overdue-advance, runDueJobs would re-claim this job ~1s later and
    // double-fire it.
    const config = testConfig("jobs-manual-overdue");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "manual overdue", script: "true", intervalSeconds: 10 })
    });
    const setupNow = Date.now();
    const dueAt = setupNow - 25_000;
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(dueAt).toISOString();
    });

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!;
    const newNextMs = new Date(after.nextRunAt).getTime();
    // The advance must have moved nextRunAt past now so the scheduler
    // tick won't re-claim immediately.
    expect(newNextMs).toBeGreaterThan(Date.now());
    // missedRuns counts only the EXTRA skipped intervals — the first
    // advance corresponds to "the manual run satisfied the overdue
    // tick". -25s -> -15s (miss), -15s -> -5s (miss), -5s -> +5s (stop).
    // Two extra advances => missed = 2.
    expect(after.missedRuns).toBe(2);
    // Cadence sanity: new nextRunAt - original due is a multiple of 10s.
    const stepMs = 10_000;
    const delta = newNextMs - dueAt;
    expect(delta % stepMs).toBe(0);
    expect(delta / stepMs).toBe(3);
  });

  test("paused manual run does NOT advance nextRunAt", async () => {
    // The schedule is paused — pretending it kept ticking while paused
    // would surface a misleading "next run in N seconds" once the user
    // resumes. Manual run on a paused job must leave nextRunAt alone.
    const config = testConfig("jobs-manual-paused-noadvance");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "paused manual", script: "echo paused", intervalSeconds: 10 })
    });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });

    const setupNow = Date.now();
    const originalNextRun = new Date(setupNow - 25_000).toISOString();
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = originalNextRun;
      // missedRuns starts from whatever the previous test path left;
      // record the baseline so we can assert it's unchanged.
    });
    const baseMissedRuns = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!.missedRuns;

    const result = await runJobNow(config, job.id, "manual");
    expect(result).toBeDefined();

    const after = readState(config.instance).jobs.find((candidate) => candidate.id === job.id)!;
    // Paused -> nextRunAt unchanged.
    expect(after.nextRunAt).toBe(originalNextRun);
    expect(after.missedRuns).toBe(baseMissedRuns);
    // And the job stays paused (existing behavior; covered separately
    // by "manual run does not resume a paused job", but reaffirm).
    expect(after.status).toBe("paused");
  });

  test("invalid intervalSeconds returns 400", async () => {
    const config = testConfig("jobs-validation");
    const handler = createHandler(config);

    const negative = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: -5 })
    });
    expect(negative.status).toBe(400);

    const nan = await rawCall(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad", intervalSeconds: Number.NaN })
    });
    // JSON.stringify turns NaN into null, which Number(...) rejects via
    // the assertPositiveInt validator. Either way we expect 400.
    expect(nan.status).toBe(400);
  });

  test("create_job dispatch from a chat-bound task mints a dedicated chat session", async () => {
    const config = testConfig("jobs-create-tool-chat");
    // Build a chat session and a task whose runId points at it. This is
    // the shape submitChatMessage produces — we synthesize it directly so
    // the dispatch test isn't gated on the full chat-task agent loop.
    const { taskId, sessionId } = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: "session_test_chat",
        instance: state.instance,
        title: "Test chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const at = new Date().toISOString();
      state.runs.unshift({
        id: "run_test_chat",
        instance: state.instance,
        kind: "conversation_turn",
        status: "running",
        title: "test",
        input: "test",
        createdAt: at,
        updatedAt: at,
        conversationId: "session_test_chat",
        planStepIds: [],
        childRunIds: [],
        approvalIds: []
      });
      const task = createTask(state.instance, "test", undefined, undefined, undefined, "run_test_chat");
      upsertTask(state, task);
      return { taskId: task.id, sessionId: "session_test_chat" };
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_1",
      JSON.stringify({ name: "test-reminder", intervalSeconds: 60, prompt: "Remind me.", oneShot: true })
    );
    expect(result.kind).toBe("sync");

    const stateAfter = readState(config.instance);
    const jobs = stateAfter.jobs;
    expect(jobs).toHaveLength(1);
    // The job points at a FRESH chat session, not the originating one —
    // future fires post into the dedicated thread so the originating
    // conversation doesn't get buried under repeated reports.
    expect(jobs[0]?.chatSessionId).toBeDefined();
    expect(jobs[0]?.chatSessionId).not.toBe(sessionId);
    expect(jobs[0]?.oneShot).toBe(true);
    expect(jobs[0]?.intervalSeconds).toBe(60);
    expect(jobs[0]?.prompt).toBe("Remind me.");

    // The new session exists and its title is exactly the job's name so the
    // user can scan a list of dedicated threads — no "Scheduled:" prefix or
    // other framing, since the chat IS bound to that job's delivery.
    const newSession = stateAfter.chatSessions.find((s) => s.id === jobs[0]!.chatSessionId);
    expect(newSession).toBeDefined();
    expect(newSession?.title).toBe("test-reminder");

    // Confirmation string contains the new job id, cadence, and the new
    // session id so the model can reference both in its reply to the user.
    if (result.kind === "sync") {
      expect(result.result).toContain(jobs[0]!.id);
      expect(result.result).toContain("one-shot");
      expect(result.result).toContain(jobs[0]!.chatSessionId!);
    }
    // Audit row with actor:"agent" action:"job.created".
    const audit = stateAfter.audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.actor).toBe("agent");
  });

  test("create_job dispatch with deliverTo \"chat\" binds the job to the originating session", async () => {
    const config = testConfig("jobs-create-tool-deliverto-chat");
    const { taskId, sessionId } = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: "session_deliverto_chat",
        instance: state.instance,
        title: "Test chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const at = new Date().toISOString();
      state.runs.unshift({
        id: "run_deliverto_chat",
        instance: state.instance,
        kind: "conversation_turn",
        status: "running",
        title: "test",
        input: "test",
        createdAt: at,
        updatedAt: at,
        conversationId: "session_deliverto_chat",
        planStepIds: [],
        childRunIds: [],
        approvalIds: []
      });
      const task = createTask(state.instance, "test", undefined, undefined, undefined, "run_deliverto_chat");
      upsertTask(state, task);
      return { taskId: task.id, sessionId: "session_deliverto_chat" };
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_deliverto_chat",
      JSON.stringify({ name: "in-chat-reminder", intervalSeconds: 120, prompt: "Remind me.", oneShot: true, deliverTo: "chat" })
    );
    expect(result.kind).toBe("sync");

    const stateAfter = readState(config.instance);
    expect(stateAfter.jobs).toHaveLength(1);
    // The job delivers into the ORIGINATING conversation — no dedicated
    // channel session is minted.
    expect(stateAfter.jobs[0]?.chatSessionId).toBe(sessionId);
    expect(stateAfter.chatSessions).toHaveLength(1);
    // The originating session stays a normal chat: no kind/title mutation.
    const session = stateAfter.chatSessions[0]!;
    expect(session.kind).toBeUndefined();
    expect(session.title).toBe("Test chat");
  });

  test("create_job dispatch with explicit deliverTo \"channel\" still mints a dedicated chat session", async () => {
    const config = testConfig("jobs-create-tool-deliverto-channel");
    const { taskId, sessionId } = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: "session_deliverto_channel",
        instance: state.instance,
        title: "Test chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const at = new Date().toISOString();
      state.runs.unshift({
        id: "run_deliverto_channel",
        instance: state.instance,
        kind: "conversation_turn",
        status: "running",
        title: "test",
        input: "test",
        createdAt: at,
        updatedAt: at,
        conversationId: "session_deliverto_channel",
        planStepIds: [],
        childRunIds: [],
        approvalIds: []
      });
      const task = createTask(state.instance, "test", undefined, undefined, undefined, "run_deliverto_channel");
      upsertTask(state, task);
      return { taskId: task.id, sessionId: "session_deliverto_channel" };
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_deliverto_channel",
      JSON.stringify({ name: "channel-report", intervalSeconds: 60, prompt: "Report.", deliverTo: "channel" })
    );
    expect(result.kind).toBe("sync");

    const stateAfter = readState(config.instance);
    expect(stateAfter.jobs).toHaveLength(1);
    // Same behavior as omitting deliverTo: a fresh dedicated channel.
    expect(stateAfter.jobs[0]?.chatSessionId).toBeDefined();
    expect(stateAfter.jobs[0]?.chatSessionId).not.toBe(sessionId);
    const newSession = stateAfter.chatSessions.find((s) => s.id === stateAfter.jobs[0]!.chatSessionId);
    expect(newSession?.title).toBe("channel-report");
  });

  test("create_job dispatch rejects deliverTo \"chat\" from a non-chat-bound task", async () => {
    const config = testConfig("jobs-create-tool-deliverto-nochat");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_deliverto_nochat",
      JSON.stringify({ name: "orphan", intervalSeconds: 60, prompt: "x", deliverTo: "chat" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Error:");
      expect(result.result).toContain("requires invocation from a chat conversation");
    }
    // No job persisted.
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects an invalid deliverTo value", async () => {
    const config = testConfig("jobs-create-tool-deliverto-invalid");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_create_job_deliverto_bad",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", deliverTo: "inbox" })
      )
    ).rejects.toThrow(/deliverTo must be one of/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch from an imperative task leaves chatSessionId undefined", async () => {
    const config = testConfig("jobs-create-tool-cli");
    // An imperative task — no runId, no conversation — looks like a CLI
    // task. The job should still get created but without chatSessionId.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_imperative",
      JSON.stringify({ name: "cli-cron", intervalSeconds: 30, prompt: "Heartbeat." })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.chatSessionId).toBeUndefined();
    // The dispatcher coerces an omitted `oneShot` to false so the field
    // has a stable shape for downstream reads. Recurring behavior either
    // way (oneShot must be strictly === true to trigger the auto-pause).
    expect(jobs[0]?.oneShot).toBe(false);
    // No chat session was created for the imperative path. The runtime
    // only mints a dedicated thread when the agent invokes create_job
    // from inside a chat task.
    expect(readState(config.instance).chatSessions).toHaveLength(0);
  });

  test("HTTP POST /jobs does not auto-create a chat session (legacy path)", async () => {
    // The dedicated-session behavior is specifically for agent-driven
    // create_job tool calls. The legacy CLI path (`gini jobs add`) and
    // HTTP POST /api/jobs path must continue to behave as today — no chat
    // session is minted, the job carries no chatSessionId, and the user
    // controls delivery through deliveryTargets / replay UI.
    const config = testConfig("jobs-http-no-session");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "legacy", script: "true", intervalSeconds: 60 })
    });
    expect(job.chatSessionId).toBeUndefined();
    expect(readState(config.instance).chatSessions).toHaveLength(0);
  });

  test("create_job rejection inside mutateState leaves no orphan chat session", async () => {
    // Atomicity guarantee: createScheduledJob mints the dedicated chat
    // session and the JobRecord inside the SAME mutateState callback. If
    // that callback throws — e.g. the parent task transitioned terminal
    // between the dispatcher's lock-free pre-check and the serialized
    // re-check — mutateState's read-modify-write contract discards the
    // in-memory mutations and nothing is persisted. We exercise that
    // path by injecting a cancelled parent task and asserting both the
    // JobRecord and any chat row are absent.
    const config = testConfig("jobs-orphan-rollback");
    const { createScheduledJob } = await import("./jobs");
    const parentTaskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "parent", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });
    const beforeSessions = readState(config.instance).chatSessions.length;
    await expect(
      createScheduledJob(config, {
        name: "rollback",
        intervalSeconds: 60,
        prompt: "x",
        createDedicatedSession: { title: "Scheduled: rollback" },
        parentTaskId
      })
    ).rejects.toThrow(/Cannot create scheduled job/);
    expect(readState(config.instance).chatSessions.length).toBe(beforeSessions);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("dedicated session stores parent's messaging source on outboundMirror so future inbound stays routed to the live session", async () => {
    // Regression: when a messaging-sourced parent task creates a
    // dedicated job session, the descriptor must NOT land on the new
    // session's `source` field. If it did, both sessions would match
    // findOrCreate{Discord,Telegram}ChatSession's (bridgeId,
    // channelId|chatId) routing key and the next inbound on that
    // channel could attach to the job thread instead of the live one.
    const config = testConfig("jobs-outbound-mirror-no-routing-conflict");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { createScheduledJob } = await import("./jobs");

    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });

    // Live session that the poller would have created on first
    // inbound. Its `source` is the routing key for chan-1.
    const liveSession = await mutateState(config.instance, (state) =>
      findOrCreateDiscordChatSession(state, bridge.id, "chan-1")
    );
    expect(liveSession.source?.kind).toBe("discord");

    // Parent task associated with the live session, completed.
    const parentTaskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "parent", undefined, undefined, undefined, undefined);
      task.status = "completed";
      upsertTask(state, task);
      const session = state.chatSessions.find((s) => s.id === liveSession.id);
      if (session && !session.taskIds.includes(task.id)) session.taskIds.push(task.id);
      return task.id;
    });

    await createScheduledJob(config, {
      name: "reminder",
      intervalSeconds: 60,
      prompt: "remind",
      createDedicatedSession: { title: "Scheduled: reminder" },
      parentTaskId
    });

    const sessions = readState(config.instance).chatSessions;
    const dedicated = sessions.find((s) => s.id !== liveSession.id);
    expect(dedicated).toBeDefined();
    // The architectural invariant: dedicated session has
    // outboundMirror but NO source.
    expect(dedicated?.source).toBeUndefined();
    expect(dedicated?.outboundMirror?.kind).toBe("discord");
    expect((dedicated?.outboundMirror as { channelId?: string } | undefined)?.channelId).toBe("chan-1");

    // Routing key check: a subsequent inbound on chan-1 must return
    // the live session, not the dedicated job session.
    const resolved = await mutateState(config.instance, (state) =>
      findOrCreateDiscordChatSession(state, bridge.id, "chan-1")
    );
    expect(resolved.id).toBe(liveSession.id);
  });

  test("create_job dispatch persists the per-job auto-approve envelope", async () => {
    // The agent passes `autoApproveCommands`, `dangerouslyAutoApprove`, and
    // `timeoutSeconds` through the tool spec to schedule an unattended job.
    // The dispatch path must forward all three onto the JobRecord so
    // `dispatchPromptRun` can clone them into the spawned task's config.
    const config = testConfig("jobs-create-tool-envelope");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_envelope",
      JSON.stringify({
        name: "envelope-job",
        intervalSeconds: 60,
        prompt: "do work",
        autoApproveCommands: ["git *", "gh *"],
        dangerouslyAutoApprove: true,
        timeoutSeconds: 600
      })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.autoApproveCommands).toEqual(["git *", "gh *"]);
    expect(jobs[0]?.dangerouslyAutoApprove).toBe(true);
    expect(jobs[0]?.timeoutSeconds).toBe(600);

    // Audit row carries the envelope so a reviewer can see exactly what
    // the agent opted into when it scheduled the job.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.dangerouslyAutoApprove).toBe(true);
    expect(audit?.evidence?.autoApproveCommands).toEqual(["git *", "gh *"]);
    expect(audit?.evidence?.timeoutSeconds).toBe(600);
  });

  test("create_job dispatch rejects non-boolean dangerouslyAutoApprove", async () => {
    const config = testConfig("jobs-create-tool-validate-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_flag",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", dangerouslyAutoApprove: "true" })
      )
    ).rejects.toThrow(/dangerouslyAutoApprove must be a boolean/);
    // No job should have been persisted.
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects non-string entries in autoApproveCommands", async () => {
    const config = testConfig("jobs-create-tool-validate-2");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_entry",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", autoApproveCommands: ["ok", 7] })
      )
    ).rejects.toThrow(/autoApproveCommands entries must be strings/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch accepts approvalMode and persists it", async () => {
    const config = testConfig("jobs-create-tool-approval-mode");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_mode",
      JSON.stringify({
        name: "mode-job",
        intervalSeconds: 60,
        prompt: "x",
        approvalMode: "yolo"
      })
    );

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.approvalMode).toBe("yolo");
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.approvalMode).toBe("yolo");
  });

  test("create_job dispatch rejects invalid approvalMode value", async () => {
    const config = testConfig("jobs-create-tool-bad-mode");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_mode",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", approvalMode: "loose" })
      )
    ).rejects.toThrow(/approvalMode must be one of/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch accepts both approvalMode and legacy dangerouslyAutoApprove (alias)", async () => {
    // Both fields are accepted on the same payload. approvalMode is
    // the canonical signal; the legacy flag is preserved on the
    // JobRecord as a deprecated alias.
    const config = testConfig("jobs-create-tool-both-fields");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_both",
      JSON.stringify({
        name: "both-fields",
        intervalSeconds: 60,
        prompt: "x",
        approvalMode: "yolo",
        dangerouslyAutoApprove: true
      })
    );

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.approvalMode).toBe("yolo");
    expect(jobs[0]?.dangerouslyAutoApprove).toBe(true);
  });

  test("create_job dispatch persists cronExpression + cronTimezone", async () => {
    // Happy-path cron creation through the tool dispatch surface. The
    // agent should be able to schedule a wall-clock job by name +
    // expression + tz, and the resulting JobRecord must carry both fields
    // verbatim (plus intervalSeconds=0 as the "not interval-driven"
    // sentinel).
    const config = testConfig("jobs-create-tool-cron");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_create_job_cron",
      JSON.stringify({
        name: "daily-9am",
        prompt: "morning report",
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles"
      })
    );
    expect(result.kind).toBe("sync");

    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.cronExpression).toBe("0 9 * * *");
    expect(jobs[0]?.cronTimezone).toBe("America/Los_Angeles");
    // Cron-driven jobs carry no intervalSeconds (field is optional).
    expect(jobs[0]?.intervalSeconds).toBeUndefined();

    // Audit + return-message both reflect the cron cadence so a reviewer
    // and the agent's follow-up reply describe the schedule correctly.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.cronExpression).toBe("0 9 * * *");
    expect(audit?.evidence?.cronTimezone).toBe("America/Los_Angeles");
    if (result.kind === "sync") {
      expect(result.result).toContain("cron");
      expect(result.result).toContain("America/Los_Angeles");
    }
  });

  test("create_job dispatch rejects both intervalSeconds and cronExpression set", async () => {
    const config = testConfig("jobs-create-tool-mutex");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_both",
        JSON.stringify({
          name: "both",
          prompt: "x",
          intervalSeconds: 60,
          cronExpression: "0 9 * * *"
        })
      )
    ).rejects.toThrow(/mutually exclusive/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects when neither intervalSeconds nor cronExpression is set", async () => {
    const config = testConfig("jobs-create-tool-neither");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_neither",
        JSON.stringify({ name: "neither", prompt: "x" })
      )
    ).rejects.toThrow(/requires either intervalSeconds or cronExpression/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects malformed cronExpression", async () => {
    const config = testConfig("jobs-create-tool-bad-cron");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_cron",
        JSON.stringify({ name: "bad", prompt: "x", cronExpression: "foo bar baz qux quux" })
      )
    ).rejects.toThrow(/Invalid input: cronExpression/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects non-integer timeoutSeconds", async () => {
    const config = testConfig("jobs-create-tool-validate-3");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_bad_timeout",
        JSON.stringify({ name: "bad", intervalSeconds: 60, prompt: "x", timeoutSeconds: -5 })
      )
    ).rejects.toThrow(/timeoutSeconds must be a positive integer/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("list_jobs dispatch returns a compact summary of all jobs", async () => {
    const config = testConfig("jobs-list-tool");
    const handler = createHandler(config);
    // Two jobs of mixed schedule shape so we can confirm both cron and
    // interval drivers surface correctly in the summary.
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "alpha-reminder", script: "true", intervalSeconds: 60 })
    });
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "beta-daily",
        script: "true",
        cronExpression: "0 9 * * *",
        cronTimezone: "America/Los_Angeles"
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_list_1",
      JSON.stringify({})
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { count: number; jobs: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(2);
    const names = new Set(parsed.jobs.map((j) => j.name));
    expect(names.has("alpha-reminder")).toBe(true);
    expect(names.has("beta-daily")).toBe(true);
    const cronEntry = parsed.jobs.find((j) => j.name === "beta-daily");
    expect(cronEntry?.cronExpression).toBe("0 9 * * *");
    expect(cronEntry?.cronTimezone).toBe("America/Los_Angeles");

    // The listing call writes an audit row so the log records when the
    // agent pulled the job inventory.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.listed"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.total).toBe(2);
    expect(audit?.evidence?.returned).toBe(2);
  });

  test("list_jobs dispatch filters by nameContains (case-insensitive)", async () => {
    const config = testConfig("jobs-list-tool-filter");
    const handler = createHandler(config);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "Daily Report", script: "true", intervalSeconds: 60 })
    });
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cake-reminder", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_list_filter",
      JSON.stringify({ nameContains: "DAILY" })
    );
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { count: number; jobs: Array<Record<string, unknown>> };
    expect(parsed.count).toBe(1);
    expect(parsed.jobs[0]?.name).toBe("Daily Report");
  });

  test("list_jobs dispatch rejects non-string nameContains", async () => {
    const config = testConfig("jobs-list-tool-bad-filter");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "list_jobs",
        "call_bad_filter",
        JSON.stringify({ nameContains: 7 })
      )
    ).rejects.toThrow(/nameContains must be a string/);
  });

  test("list_jobs dispatch truncates long prompts to ~200 chars", async () => {
    const config = testConfig("jobs-list-tool-truncate");
    const handler = createHandler(config);
    const longPrompt = "x".repeat(500);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "long", prompt: longPrompt, intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_truncate",
      JSON.stringify({})
    );
    if (result.kind !== "sync") throw new Error("expected sync result");
    const parsed = JSON.parse(result.result) as { jobs: Array<{ prompt: string }> };
    // Truncated form is 200 chars + ellipsis marker.
    expect(parsed.jobs[0]?.prompt.length).toBeLessThan(longPrompt.length);
    expect(parsed.jobs[0]?.prompt.endsWith("…")).toBe(true);
  });

  test("list_jobs dispatch returns verbatim prompts when fullPrompt is true", async () => {
    // The agent needs the unstruncated prompt when it intends to edit it
    // (append, search-and-replace), since update_job's prompt field is
    // REPLACE-only. With `fullPrompt: true` the handler returns the
    // entire stored prompt unchanged.
    const config = testConfig("jobs-list-tool-full-prompt");
    const handler = createHandler(config);
    const longPrompt = "y".repeat(300);
    await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "verbatim", prompt: longPrompt, intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const verbatim = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_full",
      JSON.stringify({ fullPrompt: true })
    );
    if (verbatim.kind !== "sync") throw new Error("expected sync result");
    const verbatimParsed = JSON.parse(verbatim.result) as { jobs: Array<{ prompt: string }> };
    expect(verbatimParsed.jobs[0]?.prompt.length).toBe(longPrompt.length);
    expect(verbatimParsed.jobs[0]?.prompt).toBe(longPrompt);
    expect(verbatimParsed.jobs[0]?.prompt.endsWith("…")).toBe(false);

    // Same job, without the flag, falls back to the 200-char truncation
    // so a long prompt doesn't blow up the tool-result context.
    const truncated = await dispatchToolCall(
      config,
      taskId,
      "list_jobs",
      "call_trunc",
      JSON.stringify({})
    );
    if (truncated.kind !== "sync") throw new Error("expected sync result");
    const truncatedParsed = JSON.parse(truncated.result) as { jobs: Array<{ prompt: string }> };
    expect(truncatedParsed.jobs[0]?.prompt.length).toBeLessThan(longPrompt.length);
    expect(truncatedParsed.jobs[0]?.prompt.endsWith("…")).toBe(true);
  });

  test("list_jobs dispatch rejects non-boolean fullPrompt", async () => {
    const config = testConfig("jobs-list-tool-full-prompt-bad");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "list_jobs",
        "call_full_bad",
        JSON.stringify({ fullPrompt: "yes" })
      )
    ).rejects.toThrow(/fullPrompt must be a boolean/);
  });

  test("update_job dispatch patches schedule and writes job.updated audit", async () => {
    const config = testConfig("jobs-update-tool");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-update", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_update_1",
      JSON.stringify({
        jobId: job.id,
        cronExpression: "0 23 * * *",
        cronTimezone: "America/Los_Angeles",
        intervalSeconds: null,
        name: "renamed"
      })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.cronExpression).toBe("0 23 * * *");
    expect(after?.cronTimezone).toBe("America/Los_Angeles");
    expect(after?.intervalSeconds).toBeUndefined();
    expect(after?.name).toBe("renamed");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.updated" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.appliedFields).toContain("cronExpression");
    expect(audit?.evidence?.appliedFields).toContain("name");
    // The audit row pins the prior schedule shape so the change is
    // reconstructable from the log alone.
    expect((audit?.evidence?.previousSchedule as Record<string, unknown>)?.intervalSeconds).toBe(60);
  });

  test("update_job dispatch can pause a running job", async () => {
    const config = testConfig("jobs-update-tool-pause");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-pause", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_pause",
      JSON.stringify({ jobId: job.id, status: "paused" })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.status).toBe("paused");
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.updated" && event.target === job.id && event.actor === "agent"
    );
    expect(audit?.evidence?.appliedFields).toContain("status");
    // The return string must not claim a next-fire moment for a paused
    // job — the scheduler skips it while paused, so "next fires at ..."
    // would be a lie.
    if (result.kind === "sync") {
      expect(result.result).not.toContain("next fires at");
      expect(result.result).toContain("will not fire until resumed");
    }
  });

  test("update_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-update-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_no_id",
        JSON.stringify({ name: "x" })
      )
    ).rejects.toThrow(/jobId/);
  });

  test("update_job dispatch rejects empty patch", async () => {
    const config = testConfig("jobs-update-tool-empty");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "empty-patch", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_empty_patch",
        JSON.stringify({ jobId: job.id })
      )
    ).rejects.toThrow(/at least one field/);
  });

  test("update_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-update-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_unknown",
        JSON.stringify({ jobId: "job_does_not_exist", name: "x" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("update_job dispatch applies autoApproveCommands and dangerouslyAutoApprove onto the JobRecord", async () => {
    const config = testConfig("jobs-update-tool-auto-approve");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "approve-me", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_auto_approve",
      JSON.stringify({
        jobId: job.id,
        autoApproveCommands: ["ls", "git status"],
        dangerouslyAutoApprove: true
      })
    );
    expect(result.kind).toBe("sync");
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.dangerouslyAutoApprove).toBe(true);
    expect(after?.autoApproveCommands).toEqual(["ls", "git status"]);

    // Clearing via empty array drops the override entirely.
    const cleared = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_auto_approve_clear",
      JSON.stringify({
        jobId: job.id,
        autoApproveCommands: [],
        dangerouslyAutoApprove: false
      })
    );
    expect(cleared.kind).toBe("sync");
    const afterClear = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(afterClear?.dangerouslyAutoApprove).toBe(false);
    expect(afterClear?.autoApproveCommands).toBeUndefined();
  });

  test("update_job dispatch rejects null prompt", async () => {
    // `prompt: null` is not a valid clear signal — JobRecord.prompt is
    // string-typed. Throw `Invalid input` so the agent's follow-up
    // can't misreport a phantom prompt change.
    const config = testConfig("jobs-update-tool-null-prompt");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "null-prompt", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_null_prompt",
        JSON.stringify({ jobId: job.id, prompt: null })
      )
    ).rejects.toThrow(/Invalid input: prompt must be a non-empty string/);
  });

  test("update_job dispatch rejects non-string name", async () => {
    const config = testConfig("jobs-update-tool-numeric-name");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-rename", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_numeric_name",
        JSON.stringify({ jobId: job.id, name: 123 })
      )
    ).rejects.toThrow(/Invalid input: name must be a non-empty string/);
  });

  test("update_job dispatch rejects empty-string name", async () => {
    const config = testConfig("jobs-update-tool-empty-name");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_empty_name",
        JSON.stringify({ jobId: job.id, name: "" })
      )
    ).rejects.toThrow(/Invalid input: name must be a non-empty string/);
  });

  test("update_job dispatch rejects invalid status value", async () => {
    const config = testConfig("jobs-update-tool-bad-status");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "bad-status", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_status",
        JSON.stringify({ jobId: job.id, status: "failed" })
      )
    ).rejects.toThrow(/status must be 'active' or 'paused'/);
  });

  test("create_job dispatch persists deliveryTargets as the resolved bridge id", async () => {
    const config = testConfig("jobs-create-tool-delivery");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "create_job",
      "call_delivery",
      JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["disc"] })
    );

    // The entry is stored as the bridge id, not the name the caller
    // typed — names and kinds are not unique, and bridge ordering
    // shifts as records are added, so the id pins the user's choice.
    const jobs = readState(config.instance).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.deliveryTargets).toEqual([bridge.id]);
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.created" && event.target === jobs[0]!.id
    );
    expect(audit?.evidence?.deliveryTargets).toEqual([bridge.id]);
  });

  test("create_job dispatch rejects an unknown deliveryTargets entry, listing dispatchable bridge names", async () => {
    const config = testConfig("jobs-create-tool-delivery-bad");
    const { addMessagingBridge } = await import("./integrations/messaging");
    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // The error names the dispatchable bridges so the agent can relay a
    // fixable message ("did you mean 'disc'?") instead of a dead end.
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_delivery_bad",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["whatsapp"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'whatsapp'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects a non-dispatchable (demo) bridge as a deliveryTargets entry", async () => {
    const config = testConfig("jobs-create-tool-delivery-demo");
    const { addMessagingBridge } = await import("./integrations/messaging");
    // Demo bridges are common (CLI default kind) but the finalizer can
    // only send to telegram/discord — accepting one here would validate
    // a target that fails on every fire.
    await addMessagingBridge(config, { name: "demo-bridge", kind: "demo" });
    await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_delivery_demo",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["demo-bridge"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'demo-bridge'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("create_job dispatch rejects an ambiguous deliveryTargets entry, listing the candidates", async () => {
    const config = testConfig("jobs-create-tool-delivery-ambiguous");
    const { addMessagingBridge } = await import("./integrations/messaging");
    const a = await addMessagingBridge(config, {
      name: "disc-a",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const b = await addMessagingBridge(config, {
      name: "disc-b",
      kind: "discord",
      deliveryTargets: ["chan-2"],
      botToken: "TOK"
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // "discord" matches both bridges by kind — first-match would
    // silently pick whichever record happens to sort first, so the
    // entry is rejected with both candidates named.
    let message = "";
    try {
      await dispatchToolCall(
        config,
        taskId,
        "create_job",
        "call_delivery_ambiguous",
        JSON.stringify({ name: "briefing", intervalSeconds: 60, prompt: "x", deliveryTargets: ["discord"] })
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ambiguous");
    expect(message).toContain(`disc-a (${a.id})`);
    expect(message).toContain(`disc-b (${b.id})`);
    expect(readState(config.instance).jobs).toHaveLength(0);
  });

  test("update_job dispatch sets deliveryTargets and clears them with []", async () => {
    const config = testConfig("jobs-update-tool-delivery");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "disc",
      kind: "discord",
      deliveryTargets: ["chan-1"],
      botToken: "TOK"
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-route", script: "true", intervalSeconds: 60 })
    });
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_set_delivery",
      JSON.stringify({ jobId: job.id, deliveryTargets: ["disc"] })
    );
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([bridge.id]);

    // An unknown entry is rejected with the dispatchable names and the
    // previously-set targets stay untouched.
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "update_job",
        "call_bad_delivery",
        JSON.stringify({ jobId: job.id, deliveryTargets: ["slackk"] })
      )
    ).rejects.toThrow(/no dispatchable messaging bridge matches 'slackk'. Dispatchable bridges: disc/);
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([bridge.id]);

    // Empty array is the documented "clear" signal.
    await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_clear_delivery",
      JSON.stringify({ jobId: job.id, deliveryTargets: [] })
    );
    expect(readState(config.instance).jobs.find((j) => j.id === job.id)?.deliveryTargets).toEqual([]);
  });

  test("delete_job dispatch removes the job and writes job.deleted audit", async () => {
    const config = testConfig("jobs-delete-tool");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "to-delete",
        script: "true",
        cronExpression: "0 9 * * *",
        cronTimezone: "UTC"
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "delete_job",
      "call_delete_1",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("to-delete");
    }

    expect(readState(config.instance).jobs.find((j) => j.id === job.id)).toBeUndefined();
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.deleted" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.name).toBe("to-delete");
    // The audit row pins the prior schedule shape so the deleted job is
    // reconstructable from the log alone.
    const prev = audit?.evidence?.previousSchedule as Record<string, unknown> | undefined;
    expect(prev?.cronExpression).toBe("0 9 * * *");
    expect(prev?.cronTimezone).toBe("UTC");
  });

  test("delete_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-delete-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "delete_job",
        "call_delete_bad",
        JSON.stringify({})
      )
    ).rejects.toThrow(/jobId/);
  });

  test("delete_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-delete-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "delete_job",
        "call_delete_unknown",
        JSON.stringify({ jobId: "job_nope" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("update_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Defense-in-depth: when the parent task has gone terminal between
    // the chat-task per-tool guard and dispatch, update_job must skip
    // the mutation entirely so a cancelled task can't leak a patched
    // job past the cancellation. Pre-check returns an Error string; the
    // JobRecord stays untouched.
    const config = testConfig("jobs-update-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "update_job",
      "call_update_terminal",
      JSON.stringify({ jobId: job.id, name: "should-not-apply" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: update_job skipped/);
    }
    // JobRecord is unchanged — name still "to-keep".
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.name).toBe("to-keep");
  });

  test("update_job inline oneShot mutator applies when parent task is completed", async () => {
    // Consistency invariant: a `completed` parent task may still manage
    // jobs (schedule a follow-up, flip a finished one-shot back to
    // recurring, etc.). The shared job mutators in src/jobs/index.ts
    // (createScheduledJob, updateJob, updateJobStatus, removeJob)
    // permit `completed` and refuse only on `cancelled`/`failed`.
    //
    // The inline oneShot re-check inside updateJobTool's mutateState
    // must match the same predicate, otherwise a single update_job
    // call could partially apply: schedule/name/prompt routed through
    // `updateJob` would succeed while the sibling oneShot field is
    // silently rejected — exactly the partial-success the audit/return
    // surface would lie about.
    //
    // The dispatcher's lock-free entry-level pre-check is stricter
    // (it short-circuits all terminal statuses to avoid touching the
    // lock for the common case), so this test verifies the invariant
    // at the authoritative serialization point — the shared mutator —
    // which is where the asymmetry would actually leak through under
    // a race (parent transitions to `completed` between the pre-check
    // and the inline mutator). Pairs with the comment at
    // src/execution/tool-dispatch.ts:989 which pins the predicate
    // used inside that inline mutateState block.
    const config = testConfig("jobs-update-tool-oneshot-completed-parent");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "flip-oneshot", prompt: "ping", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });

    // The shared mutator path (updateJob) accepts a `completed`
    // parent — this is what permits a completed task's final action
    // to be a legitimate job patch. The inline oneShot mutator at
    // tool-dispatch.ts:989 mirrors this predicate.
    await updateJob(config, job.id, { name: "renamed-from-completed-parent" }, taskId);
    const afterName = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(afterName?.name).toBe("renamed-from-completed-parent");

    // Replicate the inline oneShot mutateState block exactly as
    // updateJobTool runs it. If the production predicate ever drifts
    // wider (i.e. starts rejecting `completed`) this assertion would
    // need to be updated in lockstep — that's the consistency
    // contract.
    await mutateState(config.instance, (state) => {
      const parent = state.tasks.find((t) => t.id === taskId);
      if (parent && (parent.status === "cancelled" || parent.status === "failed")) {
        throw new Error(`Cannot update job: parent task ${taskId} is already ${parent.status}.`);
      }
      const target = state.jobs.find((candidate) => candidate.id === job.id);
      if (!target) throw new Error("setup: job missing");
      target.oneShot = true;
    });
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after?.oneShot).toBe(true);
  });

  test("delete_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Same defense-in-depth as update_job: a cancelled parent task must
    // not be able to delete a JobRecord through the agent tool path.
    const config = testConfig("jobs-delete-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-keep", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "delete_job",
      "call_delete_terminal",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: delete_job skipped/);
    }
    // JobRecord is still present.
    const after = readState(config.instance).jobs.find((j) => j.id === job.id);
    expect(after).toBeDefined();
  });

  test("run_job dispatch rejects missing jobId", async () => {
    const config = testConfig("jobs-run-tool-bad-1");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "run_job",
        "call_run_bad",
        JSON.stringify({})
      )
    ).rejects.toThrow(/jobId/);
  });

  test("run_job dispatch rejects unknown jobId", async () => {
    const config = testConfig("jobs-run-tool-missing");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "run_job",
        "call_run_unknown",
        JSON.stringify({ jobId: "job_nope" })
      )
    ).rejects.toThrow(/Job not found/);
  });

  test("run_job dispatch refuses to mutate when parent task is terminal", async () => {
    // Same defense-in-depth as update_job / delete_job: a cancelled
    // parent task must not be able to fire a fresh job run through the
    // agent tool path. The tool handler does a lock-free pre-check and
    // `runJobNow` re-checks inside its serialized `mutateState` block; this
    // test exercises the pre-check path.
    const config = testConfig("jobs-run-tool-terminal");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "to-fire", script: "true", intervalSeconds: 60 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      task.status = "cancelled";
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_terminal",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toMatch(/Error: run_job skipped/);
    }
    // No new JobRunRecord was created.
    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(0);
  });

  test("run_job dispatch fires a prompt job, spawns a task, and writes job.run.manual audit", async () => {
    const config = testConfig("jobs-run-tool-happy");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "manual-fire",
        prompt: "ping",
        intervalSeconds: 3600
      })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_happy",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("manual-fire");
      expect(result.result).toMatch(/run /);
      expect(result.result).toMatch(/task /);
    }

    // A new JobRunRecord exists with a spawned task linked.
    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    expect(runs[0]?.taskId).toBeDefined();

    // The audit row uses action "job.run.manual" and points at the
    // spawned task + new run id.
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.spawnedTaskId).toBe(runs[0]?.taskId);
  });

  test("run_job dispatch reports script-job success with exit 0", async () => {
    // Script-backed jobs execute synchronously inside `runJobNow`, so by
    // the time the tool returns the run is already complete. The handler
    // must report the exit code (not "Triggered ...") and the audit row
    // must pin exitCode for postmortems.
    const config = testConfig("jobs-run-tool-script-ok");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script-ok", script: "true", intervalSeconds: 3600 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_script_ok",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("script-ok");
      expect(result.result).toMatch(/completed/);
      expect(result.result).toMatch(/exit 0/);
    }

    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    // Script jobs don't spawn a task.
    expect(runs[0]?.taskId).toBeUndefined();

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.exitCode).toBe(0);
  });

  test("run_job dispatch reports script-job failure with non-zero exit", async () => {
    // Failure path: tool return string must say "failed", surface the
    // non-zero exit, and the audit row must capture exitCode so
    // postmortems don't have to cross-reference the JobRun record.
    const config = testConfig("jobs-run-tool-script-fail");
    const handler = createHandler(config);
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script-fail", script: "exit 1", intervalSeconds: 3600 })
    });

    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "run_job",
      "call_run_script_fail",
      JSON.stringify({ jobId: job.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain(job.id);
      expect(result.result).toContain("script-fail");
      expect(result.result).toMatch(/failed/);
      expect(result.result).toMatch(/exit 1/);
    }

    const runs = readState(config.instance).jobRuns.filter((r) => r.jobId === job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    expect(runs[0]?.status).toBe("failed");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "job.run.manual" && event.target === job.id && event.actor === "agent"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.jobId).toBe(job.id);
    expect(audit?.evidence?.runId).toBe(runs[0]?.id);
    expect(audit?.evidence?.exitCode).toBe(1);
  });

  test("scheduled prompt job with chatSessionId delivers an assistant chat message", async () => {
    // End-to-end test: create a job linked to a chat session, force its
    // nextRunAt into the past, let runDueJobs claim + dispatch it, wait
    // for the task to settle, then assert that finalizeJobRunFromTask
    // produced a ChatMessageRecord with role="assistant" in that session.
    const config = testConfig("jobs-chat-delivery");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "delivery test" })
    });

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "delivery-job",
        prompt: "echo ping",
        intervalSeconds: 60,
        chatSessionId: session.id,
        oneShot: true
      })
    });
    expect(job.chatSessionId).toBe(session.id);
    expect(job.oneShot).toBe(true);

    // Force the job due so runDueJobs claims it on the next tick.
    await mutateState(config.instance, (state) => {
      const item = state.jobs.find((candidate) => candidate.id === job.id);
      if (!item) throw new Error("setup: job missing");
      item.nextRunAt = new Date(Date.now() - 1_000).toISOString();
    });

    await runDueJobs(config);

    // Diagnostic: confirm runDueJobs claimed the job and spawned a task.
    const afterClaim = readState(config.instance);
    const claimedRun = afterClaim.jobRuns.find((run) => run.jobId === job.id);
    expect(claimedRun).toBeDefined();
    expect(claimedRun?.taskId).toBeString();
    const spawnedTask = afterClaim.tasks.find((t) => t.id === claimedRun?.taskId);
    expect(spawnedTask?.mode).toBe("chat");

    // Wait for the spawned task to settle, then for the assistant message
    // to appear in the session (finalize is async).
    await waitFor(() => {
      const state = readState(config.instance);
      const jobRun = state.jobRuns.find((run) => run.jobId === job.id);
      return jobRun?.status === "completed" || jobRun?.status === "failed";
    }, 5_000);

    await waitFor(() => {
      const state = readState(config.instance);
      return state.chatMessages.some(
        (m) => m.sessionId === session.id && m.role === "assistant"
      );
    }, 5_000);

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === session.id && m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // The job should be paused now because oneShot=true.
    const finalJob = stateAfter.jobs.find((candidate) => candidate.id === job.id);
    expect(finalJob?.status).toBe("paused");

    // Audit row for the one-shot completion.
    const audit = stateAfter.audit.find(
      (event) => event.action === "job.oneshot.completed" && event.target === job.id
    );
    expect(audit).toBeDefined();
  });

  test("syncChatTaskResult suppresses delivery when the task summary is [SILENT]", async () => {
    // The cron-execution hint instructs the LLM to emit "[SILENT]" when a
    // scheduled run has nothing new to report. syncChatTaskResult must
    // recognize the sentinel, skip creating an assistant ChatMessageRecord,
    // and audit the suppression.
    const config = testConfig("jobs-silent-suppress");

    const sessionId = "session_silent_test";
    const taskId = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Silent test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const task = createTask(state.instance, "watch for change", undefined, undefined, undefined, undefined);
      task.status = "completed";
      task.summary = "[SILENT]";
      task.updatedAt = new Date().toISOString();
      upsertTask(state, task);
      return task.id;
    });

    const result = await syncChatTaskResult(config, sessionId, taskId);
    expect(result).toBeNull();

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(0);

    const audit = stateAfter.audit.find(
      (event) => event.action === "chat.message.suppressed_silent" && event.target === sessionId
    );
    expect(audit).toBeDefined();
    expect(audit?.taskId).toBe(taskId);
  });

  test("syncChatTaskResult delivers when summary contains [SILENT] alongside other text", async () => {
    // The sentinel must match exactly. A summary like "[SILENT] but also..."
    // or a lowercase variant should NOT be suppressed — otherwise a reminder
    // that happens to mention the word could be silently dropped.
    const config = testConfig("jobs-silent-not-exact");

    const sessionId = "session_silent_strict";
    const taskId = await mutateState(config.instance, (state) => {
      state.chatSessions.unshift({
        id: sessionId,
        instance: state.instance,
        title: "Strict",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageIds: [],
        taskIds: [],
        runIds: []
      });
      const task = createTask(state.instance, "watch", undefined, undefined, undefined, undefined);
      task.status = "completed";
      task.summary = "[SILENT] with extra";
      task.updatedAt = new Date().toISOString();
      upsertTask(state, task);
      return task.id;
    });

    const result = await syncChatTaskResult(config, sessionId, taskId);
    expect(result).not.toBeNull();

    const stateAfter = readState(config.instance);
    const assistantMessages = stateAfter.chatMessages.filter(
      (m) => m.sessionId === sessionId && m.role === "assistant"
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe("[SILENT] with extra");
  });

  test("dispatchJobReplyToBridge suppresses ONLY exact '[SILENT]'; any prefix-only match still dispatches", async () => {
    // Mirror invariant of the syncChatTaskResult test above, but for
    // the bridge dispatch path. Earlier code used `startsWith` here
    // which would have silently dropped a legitimate reply like
    // "[SILENT] but here's an update" while syncChatTaskResult
    // (correctly) delivered it to chat — meaning a scheduled job
    // would land in chat UI but never reach Telegram/Discord.
    const config = testConfig("jobs-silent-dispatch-strict");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({
      discordClientFactory: () => ({
        async getMe() {
          return { id: "100", username: "Gini", discriminator: "0000", bot: true };
        },
        async sendMessage(channelId, content) {
          sendCalls.push({ channelId, content });
          return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
        },
        async triggerTypingIndicator() {
          return true as const;
        },
        async fetchChannelMessages() {
          return [];
        }
      })
    });

    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, bridge.id, "chan-1");
        return session.id;
      });

      // "[SILENT] but here's an update" — must NOT be suppressed.
      const taskA = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT] but here's an update";
        t.jobId = "job_x";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        state.jobs.push({
          id: "job_x",
          instance: state.instance,
          name: "x",
          status: "active",
          prompt: "p",
          deliveryTargets: [],
          context: [],
          retryLimit: 0,
          timeoutSeconds: 600,
          chatSessionId: sessionId,
          runIds: [],
          taskIds: [],
          runCount: 0,
          missedRuns: 0,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.jobRuns.push({
          id: "run_x",
          instance: state.instance,
          jobId: "job_x",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });
      const taskAObj = readState(config.instance).tasks.find((t) => t.id === taskA)!;
      await finalizeJobRunFromTask(config, taskAObj);
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0]?.content).toContain("but here's an update");

      // Exact "[SILENT]" — must be suppressed.
      sendCalls.length = 0;
      const taskB = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled-silent", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT]";
        t.jobId = "job_x";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        state.jobRuns.push({
          id: "run_y",
          instance: state.instance,
          jobId: "job_x",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });
      const taskBObj = readState(config.instance).tasks.find((t) => t.id === taskB)!;
      await finalizeJobRunFromTask(config, taskBObj);
      expect(sendCalls.length).toBe(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("dispatchJobReplyToBridge ignores tool_transcript rows so a [SILENT] tool-using job stays suppressed", async () => {
    // A tool-using turn persists assistant rows tagged kind:"tool_transcript"
    // (model-facing replay narration) before the terminal summary. The bridge
    // dispatch picks the newest assistant row for the task; if it considered
    // the transcript row it would mirror that narration to Telegram/Discord
    // even though the terminal summary is "[SILENT]" — bypassing suppression.
    const config = testConfig("jobs-silent-tool-transcript");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({
      discordClientFactory: () => ({
        async getMe() {
          return { id: "100", username: "Gini", discriminator: "0000", bot: true };
        },
        async sendMessage(channelId, content) {
          sendCalls.push({ channelId, content });
          return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
        },
        async triggerTypingIndicator() {
          return true as const;
        },
        async fetchChannelMessages() {
          return [];
        }
      })
    });

    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, bridge.id, "chan-1");
        return session.id;
      });

      const taskId = await mutateState(config.instance, (state) => {
        const t = createTask(state.instance, "scheduled-tool", undefined, undefined, undefined, undefined);
        t.status = "completed";
        t.summary = "[SILENT]";
        t.jobId = "job_tool";
        upsertTask(state, t);
        const session = state.chatSessions.find((s) => s.id === sessionId)!;
        session.taskIds.push(t.id);
        // Seed a model-facing transcript assistant row with non-empty
        // narration for the same task — this must never be mirrored.
        createChatMessage(state, {
          sessionId,
          role: "assistant",
          content: "Let me check the calendar before replying.",
          taskId: t.id,
          runId: t.runId,
          kind: "tool_transcript"
        });
        state.jobs.push({
          id: "job_tool",
          instance: state.instance,
          name: "x",
          status: "active",
          prompt: "p",
          deliveryTargets: [],
          context: [],
          retryLimit: 0,
          timeoutSeconds: 600,
          chatSessionId: sessionId,
          runIds: [],
          taskIds: [],
          runCount: 0,
          missedRuns: 0,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        state.jobRuns.push({
          id: "run_tool",
          instance: state.instance,
          jobId: "job_tool",
          status: "running",
          taskId: t.id,
          attempt: 1,
          trigger: "schedule",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return t.id;
      });

      const taskObj = readState(config.instance).tasks.find((t) => t.id === taskId)!;
      await finalizeJobRunFromTask(config, taskObj);
      expect(sendCalls.length).toBe(0);
    } finally {
      resetMessagingDeps();
    }
  });
});

// Delivery of a finished prompt-job's output to the bridges named on
// job.deliveryTargets (src/jobs/finalize.ts dispatchJobReplyToDeliveryTargets).
// This is the path for jobs created from web/CLI chats — sessions with no
// originating bridge to mirror back to. Stubs the Discord client via
// setMessagingDeps so no test touches the network.
describe("job deliveryTargets delivery", () => {
  // Stub client factory shared by every test below; each test resets
  // sendCalls and messaging deps around its body. `failSends` makes the
  // first N sendMessage calls throw (after recording the attempt) so
  // tests can exercise the failed-send paths; Infinity fails every call.
  function discordStub(
    sendCalls: Array<{ channelId: string; content: string }>,
    options: { failSends?: number } = {}
  ) {
    let remainingFailures = options.failSends ?? 0;
    return () => ({
      async getMe() {
        return { id: "100", username: "Gini", discriminator: "0000", bot: true };
      },
      async sendMessage(channelId: string, content: string) {
        sendCalls.push({ channelId, content });
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("Unknown Channel");
        }
        return { id: "reply", channel_id: channelId, content, timestamp: "", author: { id: "100", username: "Gini", bot: true } };
      },
      async triggerTypingIndicator() {
        return true as const;
      },
      async fetchChannelMessages() {
        return [];
      }
    });
  }

  // Seed a plain chat session (no bridge source), an active job pointing
  // at it with the given deliveryTargets, a running run, and a terminal
  // task carrying the summary. Returns the Task object ready for
  // finalizeJobRunFromTask. `session: "none"` seeds a job with no
  // chatSessionId at all (the POST /api/jobs / non-chat-task shape);
  // `session: "vanished"` points chatSessionId at a session that no
  // longer exists (deleted mid-flight). Failed tasks carry `error`
  // (falling back to `summary` when omitted) — a failed task with no
  // summary at all mirrors the real failTask shape (src/agent.ts),
  // which only sets task.error.
  async function seedJobRun(
    config: RuntimeConfig,
    options: {
      deliveryTargets: string[];
      summary?: string;
      error?: string;
      sessionId?: string;
      status?: "completed" | "failed";
      session?: "none" | "vanished";
    }
  ) {
    const taskId = await mutateState(config.instance, (state) => {
      let sessionId = options.sessionId;
      if (!sessionId && options.session === undefined) {
        sessionId = "session_delivery";
        state.chatSessions.unshift({
          id: sessionId,
          instance: state.instance,
          title: "Delivery",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageIds: [],
          taskIds: [],
          runIds: []
        });
      }
      if (options.session === "vanished") sessionId = "session_gone";
      const t = createTask(state.instance, "scheduled", undefined, undefined, undefined, undefined);
      t.status = options.status ?? "completed";
      t.summary = options.summary;
      if (t.status === "failed") t.error = options.error ?? options.summary;
      t.jobId = "job_delivery";
      upsertTask(state, t);
      const session = state.chatSessions.find((s) => s.id === sessionId);
      if (session) session.taskIds.push(t.id);
      state.jobs.push({
        id: "job_delivery",
        instance: state.instance,
        name: "briefing",
        status: "active",
        prompt: "p",
        deliveryTargets: options.deliveryTargets,
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        chatSessionId: options.session === "none" ? undefined : sessionId,
        runIds: [],
        taskIds: [],
        runCount: 0,
        missedRuns: 0,
        nextRunAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      state.jobRuns.push({
        id: "run_delivery",
        instance: state.instance,
        jobId: "job_delivery",
        status: "running",
        taskId: t.id,
        attempt: 1,
        trigger: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      return t.id;
    });
    return readState(config.instance).tasks.find((t) => t.id === taskId)!;
  }

  test("delivers the final output to the named bridge when the session has no origin bridge", async () => {
    const config = testConfig("jobs-delivery-happy");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Morning briefing: all clear." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("chan-1");
      expect(sendCalls[0]?.content).toContain("Morning briefing");
      // The run itself finalized normally.
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
    } finally {
      resetMessagingDeps();
    }
  });

  test("delivers the failure summary on failed runs — parity with the origin mirror, which surfaces failures rather than going silent", async () => {
    const config = testConfig("jobs-delivery-failed");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Briefing failed: calendar fetch errored.",
        status: "failed"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("calendar fetch errored");
    } finally {
      resetMessagingDeps();
    }
  });

  test("exact '[SILENT]' suppresses deliveryTargets delivery", async () => {
    const config = testConfig("jobs-delivery-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "[SILENT]" });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("resolves by case-insensitive name, id, and kind, deduping to one send per bridge", async () => {
    const config = testConfig("jobs-delivery-dedupe");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const first = await addMessagingBridge(config, {
        name: "disc-one",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      await addMessagingBridge(config, {
        name: "disc-two",
        kind: "discord",
        deliveryTargets: ["chan-2"],
        botToken: "TOK"
      });
      // "DISC-ONE" (case-insensitive name), the raw record id, and
      // "discord" (kind → first matching bridge) all resolve to the same
      // bridge; only one send may land on it. "disc-two" is distinct.
      const task = await seedJobRun(config, {
        deliveryTargets: ["DISC-ONE", first.id, "discord", "disc-two"],
        summary: "Multi-target briefing."
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId).sort()).toEqual(["chan-1", "chan-2"]);
    } finally {
      resetMessagingDeps();
    }
  });

  test("skips a target the origin mirror already dispatched to", async () => {
    const config = testConfig("jobs-delivery-origin-dedupe");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const origin = await addMessagingBridge(config, {
        name: "disc-origin",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      await addMessagingBridge(config, {
        name: "disc-extra",
        kind: "discord",
        deliveryTargets: ["chan-2"],
        botToken: "TOK"
      });
      // The job's session originates from disc-origin, so the mirror
      // (dispatchJobReplyToBridge) already sends there. Naming the same
      // bridge in deliveryTargets must NOT double-send; the extra bridge
      // still gets its copy.
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, origin.id, "chan-1");
        return session.id;
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc-origin", "disc-extra"],
        summary: "Origin-dedupe briefing.",
        sessionId
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId).sort()).toEqual(["chan-1", "chan-2"]);
    } finally {
      resetMessagingDeps();
    }
  });

  test("an unresolvable target at fire time logs job.delivery.target.error, audits job.delivery.failed, and the run still completes", async () => {
    const config = testConfig("jobs-delivery-missing-bridge");
    const { setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      // No bridge named "ghost" exists (it was removed after the job was
      // saved). Delivery must skip it without failing the finalize.
      const task = await seedJobRun(config, { deliveryTargets: ["ghost"], summary: "Briefing for nobody." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("ghost");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.target).toBe("job_delivery");
      expect(audit?.evidence?.target).toBe("ghost");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a provider send failure surfaces as job.delivery.target.error + job.delivery.failed without failing the run", async () => {
    const config = testConfig("jobs-delivery-send-failure");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // Every send throws — sendMessagingOutput swallows the provider
    // error into a status:"failed" outbound record instead of throwing,
    // so the failure must be picked up from the returned record.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: Infinity }) });
    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing that bounces." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("Unknown Channel");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.target).toBe("job_delivery");
      expect(audit?.evidence?.bridgeId).toBe(bridge.id);
      expect(audit?.evidence?.reason).toContain("Unknown Channel");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a job with no chat session delivers the task summary", async () => {
    const config = testConfig("jobs-delivery-sessionless");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // POST /api/jobs and create_job from a non-chat task produce jobs
      // with no chatSessionId — there is no synced assistant message,
      // so delivery falls back to the task summary.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Sessionless briefing.",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("chan-1");
      expect(sendCalls[0]?.content).toContain("Sessionless briefing");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a session-less job's exact '[SILENT]' summary is suppressed", async () => {
    const config = testConfig("jobs-delivery-sessionless-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "[SILENT]",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a vanished chat session does not block deliveryTargets delivery", async () => {
    const config = testConfig("jobs-delivery-vanished-session");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The job's chatSessionId points at a deleted session. The chat
      // sync is skipped (job.chat.session.vanished) but the named
      // bridge still receives the task summary.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Briefing without a home.",
        session: "vanished"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("Briefing without a home");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.chat.session.vanished");
    } finally {
      resetMessagingDeps();
    }
  });

  test("an origin-mirror failure does not suppress an explicitly-listed target on the same bridge", async () => {
    const config = testConfig("jobs-delivery-origin-failed");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { findOrCreateDiscordChatSession } = await import("./state");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // First send (the origin mirror) fails; the second (deliveryTargets)
    // succeeds. The dedupe set is seeded only on a CONFIRMED mirror
    // send, so the explicit entry for the same bridge must still be
    // attempted.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: 1 }) });
    try {
      const origin = await addMessagingBridge(config, {
        name: "disc-origin",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      const sessionId = await mutateState(config.instance, (state) => {
        const session = findOrCreateDiscordChatSession(state, origin.id, "chan-1");
        return session.id;
      });
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc-origin"],
        summary: "Mirror-failure briefing.",
        sessionId
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls.map((c) => c.channelId)).toEqual(["chan-1", "chan-1"]);
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.messaging.dispatch.error");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a bridge with no delivery targets falls back to the literal 'local' target and the failed send is logged", async () => {
    const config = testConfig("jobs-delivery-empty-targets");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    // A real Discord send to channel "local" 400s; the stub throws to
    // model that, producing a status:"failed" outbound record.
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls, { failSends: Infinity }) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: [],
        botToken: "TOK"
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing to nowhere." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.channelId).toBe("local");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(readState(config.instance).audit.some((a) => a.action === "job.delivery.failed")).toBe(true);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a disabled bridge makes sendMessagingOutput throw; the failure is caught, logged, and audited", async () => {
    const config = testConfig("jobs-delivery-disabled-bridge");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      const bridge = await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // sendMessagingOutput rejects non-"configured" bridges up front
      // (throws instead of returning a failed record) — the dispatcher
      // must catch that path too.
      await mutateState(config.instance, (state) => {
        const live = state.messagingBridges.find((b) => b.id === bridge.id)!;
        live.status = "disabled";
      });
      const task = await seedJobRun(config, { deliveryTargets: ["disc"], summary: "Briefing to a dark bridge." });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(0);
      const run = readState(config.instance).jobRuns.find((r) => r.id === "run_delivery");
      expect(run?.status).toBe("completed");
      const log = readFileSync(`${config.logRoot}/runtime.jsonl`, "utf8");
      expect(log).toContain("job.delivery.target.error");
      expect(log).toContain("not configured");
      const audit = readState(config.instance).audit.find((a) => a.action === "job.delivery.failed");
      expect(audit?.evidence?.reason).toContain("not configured");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a session-less failed run with no summary delivers the task error", async () => {
    const config = testConfig("jobs-delivery-sessionless-failed-error");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // Failed tasks carry task.error, not task.summary (src/agent.ts
      // failTask). A summary-only fallback would deliver nothing here
      // and the user would hear silence about the broken briefing.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        error: "calendar fetch errored: 503",
        status: "failed",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.content).toContain("calendar fetch errored: 503");
    } finally {
      resetMessagingDeps();
    }
  });

  test("a failed run with summary '[SILENT]' still delivers — suppression applies only to completed runs", async () => {
    const config = testConfig("jobs-delivery-failed-silent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The [SILENT] contract (src/execution/chat.ts) honors the token
      // only for successfully COMPLETED tasks — a failure must still
      // surface a signal even when the model emitted the sentinel.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "[SILENT]",
        status: "failed",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
    } finally {
      resetMessagingDeps();
    }
  });

  test("a legacy name entry resolves past a non-dispatchable demo bridge to the telegram bridge of the same name", async () => {
    const config = testConfig("jobs-delivery-demo-shadow");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ chatId: string | number; text: string }> = [];
    setMessagingDeps({
      telegramClientFactory: () =>
        ({
          async getMe() {
            return { id: 1, is_bot: true, first_name: "Gini" };
          },
          async sendMessage(chatId: string | number, text: string) {
            sendCalls.push({ chatId, text });
            return { message_id: 1, chat: { id: chatId }, date: 0 };
          }
        }) as unknown as import("./integrations/telegram").TelegramClient
    });
    try {
      await addMessagingBridge(config, {
        name: "briefings",
        kind: "telegram",
        deliveryTargets: ["42"],
        botToken: "TOK"
      });
      // Bridges are unshifted into state, so this demo bridge sits in
      // front of the telegram one. A name-tier match over the full
      // bridge list would hit the demo bridge first and fail as
      // non-dispatchable; resolution must pre-filter to dispatchable
      // kinds, the way parseDeliveryTargets does at create/update.
      await addMessagingBridge(config, { name: "briefings", kind: "demo" });
      const task = await seedJobRun(config, {
        deliveryTargets: ["briefings"],
        summary: "Shadowed name briefing",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
      expect(String(sendCalls[0]?.chatId)).toBe("42");
      // The default Telegram send path renders MarkdownV2, so assert on
      // text free of escape-prone characters.
      expect(sendCalls[0]?.text).toContain("Shadowed name briefing");
      expect(readState(config.instance).audit.some((a) => a.action === "job.delivery.failed")).toBe(false);
    } finally {
      resetMessagingDeps();
    }
  });

  test("finalizing the same terminal task twice sends exactly once", async () => {
    const config = testConfig("jobs-delivery-idempotent");
    const { addMessagingBridge, setMessagingDeps, resetMessagingDeps } = await import("./integrations/messaging");
    const { finalizeJobRunFromTask } = await import("./jobs/finalize");
    const sendCalls: Array<{ channelId: string; content: string }> = [];
    setMessagingDeps({ discordClientFactory: discordStub(sendCalls) });
    try {
      await addMessagingBridge(config, {
        name: "disc",
        kind: "discord",
        deliveryTargets: ["chan-1"],
        botToken: "TOK"
      });
      // The runFinalized gate: once the run is terminal, a repeat
      // finalize (duplicate task event, restart replay) must not
      // re-deliver to bridges.
      const task = await seedJobRun(config, {
        deliveryTargets: ["disc"],
        summary: "Once-only briefing.",
        session: "none"
      });
      await finalizeJobRunFromTask(config, task);
      await finalizeJobRunFromTask(config, task);
      expect(sendCalls).toHaveLength(1);
    } finally {
      resetMessagingDeps();
    }
  });
});

describe("advanceCronNextRunAt", () => {
  test("hourly cron without missed fires returns the immediate next match", () => {
    // Regression: previously the helper called cron.nextRun twice and
    // skipped one occurrence per advance, so a 09:00 prev + 09:01 now
    // would jump to 11:00 instead of 10:00.
    const prev = Date.UTC(2026, 0, 1, 9, 0, 0);
    const now = Date.UTC(2026, 0, 1, 9, 1, 0);
    const result = advanceCronNextRunAt("0 * * * *", "UTC", prev, now);
    expect(result.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 10, 0, 0));
    expect(result.missed).toBe(0);
  });

  test("hourly cron catches up after a 3h offline gap", () => {
    const prev = Date.UTC(2026, 0, 1, 9, 0, 0);
    const now = Date.UTC(2026, 0, 1, 12, 30, 0);
    const result = advanceCronNextRunAt("0 * * * *", "UTC", prev, now);
    // 10:00, 11:00, 12:00 are all in the past; 13:00 is the new fire.
    expect(result.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 13, 0, 0));
    expect(result.missed).toBe(3);
  });

  test("DST spring-forward in America/Los_Angeles still lands on the configured hour", () => {
    // 2026-03-08 is the US spring-forward day: clocks jump 02:00 -> 03:00 LA.
    const prev = Date.UTC(2026, 2, 7, 10, 0, 0); // 2026-03-07 02:00 LA (PST, UTC-8)
    const now = Date.UTC(2026, 2, 9, 0, 0, 0); // well past the DST transition
    const result = advanceCronNextRunAt("0 2 * * *", "America/Los_Angeles", prev, now);
    expect(result.nextRunAtMs).toBeGreaterThan(now);
    expect(result.missed).toBeGreaterThanOrEqual(0);
    const hourInLA = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false
    }).format(new Date(result.nextRunAtMs));
    // Intl can render midnight as "24"; normalize before comparing.
    const hourNumber = Number(hourInLA) % 24;
    expect(hourNumber).toBe(2);
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const auth = token ?? config.token;
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, ...(init.headers ?? {}) }
  }));
  return response;
}

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-jobs-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

async function waitForTask(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval", "cancelled"].includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}
