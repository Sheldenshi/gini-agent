import { submitTask } from "../agent";
import type { RuntimeConfig } from "../types";
import { addAudit, appendEvent, appendTrace, createJob, createJobRun, mutateState, now, readState } from "../state";
import { spawn } from "bun";

export async function createScheduledJob(config: RuntimeConfig, input: Record<string, unknown>) {
  const intervalSeconds = Math.max(1, Number(input.intervalSeconds ?? 60));
  return mutateState(config.instance, (state) => createJob(state, {
    name: String(input.name ?? "Untitled job"),
    prompt: String(input.prompt ?? ""),
    script: typeof input.script === "string" && input.script.trim() ? input.script : undefined,
    intervalSeconds,
    nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : [],
    context: Array.isArray(input.context) ? input.context.map(String) : [],
    retryLimit: Math.max(0, Number(input.retryLimit ?? 0)),
    timeoutSeconds: Math.max(1, Number(input.timeoutSeconds ?? 30)),
    costBudget: typeof input.costBudget === "number" ? input.costBudget : undefined
  }));
}

export async function runDueJobs(config: RuntimeConfig): Promise<void> {
  const due = await mutateState(config.instance, (state) => {
    const dateNow = Date.now();
    return state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() <= dateNow);
  });
  for (const job of due) await runJobNow(config, job.id, "schedule");
}

export async function runJobNow(config: RuntimeConfig, jobId: string, trigger: "schedule" | "manual" | "replay" = "manual") {
  const { job, run } = await mutateState(config.instance, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === jobId);
    if (!item) throw new Error(`Job not found: ${jobId}`);
    item.lastRunAt = now();
    item.runCount += 1;
    item.nextRunAt = new Date(Date.now() + item.intervalSeconds * 1000).toISOString();
    item.updatedAt = now();
    const run = createJobRun(state, { jobId, trigger });
    item.runIds.unshift(run.id);
    return { job: item, run };
  });
  if (job.script) return executeScriptJob(config, job.id, run.id, job.script, job.timeoutSeconds);
  const prompt = [job.context.length > 0 ? `Context:\n${job.context.join("\n")}` : "", job.prompt].filter(Boolean).join("\n\n");
  const task = await submitTask(config, prompt, job.id);
  await mutateState(config.instance, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id);
    const runItem = state.jobRuns.find((candidate) => candidate.id === run.id);
    if (!item || !runItem) return;
    item.taskIds.unshift(task.id);
    item.lastSuccessAt = now();
    item.lastError = undefined;
    item.status = "active";
    runItem.taskId = task.id;
    runItem.status = "completed";
    runItem.completedAt = now();
    runItem.updatedAt = runItem.completedAt;
    runItem.summary = "Prompt job spawned task.";
    appendEvent(state, { kind: "job", action: "job.run.completed", target: job.id, jobId: job.id, taskId: task.id, risk: "low", summary: runItem.summary });
  });
  appendTrace(config.instance, task.id, { type: "job", message: "Job spawned task", data: { jobId, runId: run.id, deliveryTargets: job.deliveryTargets } });
  return { jobId, runId: run.id, taskId: task.id };
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
  return mutateState(config.instance, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (typeof input.name === "string") job.name = input.name;
    if (typeof input.prompt === "string") job.prompt = input.prompt;
    if (typeof input.script === "string") job.script = input.script || undefined;
    if (typeof input.intervalSeconds === "number") job.intervalSeconds = Math.max(1, input.intervalSeconds);
    if (Array.isArray(input.deliveryTargets)) job.deliveryTargets = input.deliveryTargets.map(String);
    if (Array.isArray(input.context)) job.context = input.context.map(String);
    if (typeof input.retryLimit === "number") job.retryLimit = Math.max(0, input.retryLimit);
    if (typeof input.timeoutSeconds === "number") job.timeoutSeconds = Math.max(1, input.timeoutSeconds);
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
    addAudit(state, { actor: "user", action: "job.removed", target: job.id, risk: "medium" });
    return job;
  });
}

export function listJobRuns(config: RuntimeConfig, jobId?: string) {
  const runs = readState(config.instance).jobRuns;
  return jobId ? runs.filter((run) => run.jobId === jobId) : runs;
}

export async function replayJobRun(config: RuntimeConfig, runId: string) {
  const run = readState(config.instance).jobRuns.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Job run not found: ${runId}`);
  return runJobNow(config, run.jobId, "replay");
}

async function executeScriptJob(config: RuntimeConfig, jobId: string, runId: string, script: string, timeoutSeconds: number) {
  const proc = spawn(["zsh", "-lc", script], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timeout);
  return mutateState(config.instance, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    const run = state.jobRuns.find((candidate) => candidate.id === runId);
    if (!job || !run) throw new Error(`Job or run disappeared: ${jobId}/${runId}`);
    run.status = exitCode === 0 ? "completed" : "failed";
    run.completedAt = now();
    run.updatedAt = run.completedAt;
    run.summary = stdout.slice(0, 4000);
    run.error = exitCode === 0 ? undefined : stderr.slice(0, 4000) || `Script exited ${exitCode}`;
    if (exitCode === 0) {
      job.lastSuccessAt = run.completedAt;
      job.lastError = undefined;
      job.status = "active";
    } else {
      job.lastFailureAt = run.completedAt;
      job.lastError = run.error;
      job.status = "failed";
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
}
