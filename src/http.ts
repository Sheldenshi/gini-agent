import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { decideApproval, submitTask } from "./agent";
import { configPath, pidPath } from "./paths";
import {
  addAudit,
  appendTrace,
  createJob,
  createMemory,
  createSkill,
  mutateState,
  now,
  readState,
  readTrace,
  taskCounts,
  updateConnectorHealth
} from "./state";
import { providerHealth } from "./provider";

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    ["GET", /^\/api\/state$/, () => json(readState(config.lane))],
    ["GET", /^\/api\/tasks$/, () => json(readState(config.lane).tasks)],
    ["POST", /^\/api\/tasks$/, async (request) => json(submitTask(config, String((await body(request)).input ?? "")), 201)],
    ["GET", /^\/api\/tasks\/([^/]+)$/, (_request, params) => {
      const state = readState(config.lane);
      const task = state.tasks.find((item) => item.id === params[0]);
      if (!task) return json({ error: "Task not found" }, 404);
      return json({ task, trace: readTrace(config.lane, task.id) });
    }],
    ["GET", /^\/api\/approvals$/, () => json(readState(config.lane).approvals)],
    ["POST", /^\/api\/approvals\/([^/]+)\/approve$/, async (_request, params) => json(await decideApproval(config, params[0], "approve"))],
    ["POST", /^\/api\/approvals\/([^/]+)\/deny$/, async (_request, params) => json(await decideApproval(config, params[0], "deny"))],
    ["GET", /^\/api\/audit$/, () => json(readState(config.lane).audit)],
    ["GET", /^\/api\/memory$/, () => json(readState(config.lane).memories)],
    ["POST", /^\/api\/memory$/, async (request) => {
      const input = await body(request);
      return json(mutateState(config.lane, (state) => createMemory(state, {
        content: String(input.content ?? ""),
        scope: "project",
        confidence: 1,
        status: String(input.status ?? "active") === "proposed" ? "proposed" : "active",
        sensitivity: "normal",
        provenance: "Created by user"
      })), 201);
    }],
    ["POST", /^\/api\/memory\/([^/]+)\/approve$/, (_request, params) => json(updateMemory(config, params[0], "active"))],
    ["POST", /^\/api\/memory\/([^/]+)\/reject$/, (_request, params) => json(updateMemory(config, params[0], "rejected"))],
    ["GET", /^\/api\/skills$/, () => json(readState(config.lane).skills)],
    ["POST", /^\/api\/skills$/, async (request) => {
      const input = await body(request);
      return json(mutateState(config.lane, (state) => createSkill(state, {
        name: String(input.name ?? "Untitled skill"),
        description: String(input.description ?? ""),
        trigger: String(input.trigger ?? ""),
        steps: Array.isArray(input.steps) ? input.steps.map(String) : [],
        requiredTools: Array.isArray(input.requiredTools) ? input.requiredTools.map(String) : [],
        requiredPermissions: Array.isArray(input.requiredPermissions) ? input.requiredPermissions.map(String) : [],
        status: String(input.status ?? "draft") === "trusted" ? "trusted" : "draft"
      })), 201);
    }],
    ["GET", /^\/api\/jobs$/, () => json(readState(config.lane).jobs)],
    ["POST", /^\/api\/jobs$/, async (request) => {
      const input = await body(request);
      const intervalSeconds = Math.max(1, Number(input.intervalSeconds ?? 60));
      return json(mutateState(config.lane, (state) => createJob(state, {
        name: String(input.name ?? "Untitled job"),
        prompt: String(input.prompt ?? ""),
        intervalSeconds,
        nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString()
      })), 201);
    }],
    ["POST", /^\/api\/jobs\/([^/]+)\/run$/, (_request, params) => json(runJobNow(config, params[0]))],
    ["POST", /^\/api\/jobs\/([^/]+)\/pause$/, (_request, params) => json(updateJobStatus(config, params[0], "paused"))],
    ["POST", /^\/api\/jobs\/([^/]+)\/resume$/, (_request, params) => json(updateJobStatus(config, params[0], "active"))],
    ["GET", /^\/api\/connectors$/, () => json(readState(config.lane).connectors)],
    ["POST", /^\/api\/connectors\/([^/]+)\/health$/, (_request, params) => json(checkConnector(config, params[0]))]
  ];

  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(request, config)) return json({ error: "Unauthorized" }, 401);
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (request.method === method && match) {
          try {
            return await handler(request, Object.fromEntries(match.slice(1).map((value, index) => [String(index), value])));
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        }
      }
      return json({ error: "Not found" }, 404);
    }
    return webApp(config);
  };
}

export function status(config: RuntimeConfig) {
  const state = readState(config.lane);
  const missedJobs = state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() + job.intervalSeconds * 1000 < Date.now()).length;
  return {
    ok: true,
    lane: config.lane,
    port: config.port,
    stateRoot: config.stateRoot,
    pid: process.pid,
    taskCounts: taskCounts(state.tasks),
    pendingApprovals: state.approvals.filter((approval) => approval.status === "pending").length,
    activeJobs: state.jobs.filter((job) => job.status === "active").length,
    missedJobs,
    connectors: state.connectors.length,
    provider: providerHealth(config)
  };
}

export function install(config: RuntimeConfig): void {
  writeFileSync(configPath(config.lane), `${JSON.stringify(config, null, 2)}\n`);
  readState(config.lane);
}

export function resetLane(config: RuntimeConfig): void {
  rmSync(config.stateRoot, { recursive: true, force: true });
  install(config);
}

export function runDueJobs(config: RuntimeConfig): void {
  const due = mutateState(config.lane, (state) => {
    const dateNow = Date.now();
    return state.jobs.filter((job) => job.status === "active" && new Date(job.nextRunAt).getTime() <= dateNow);
  });
  for (const job of due) runJobNow(config, job.id);
}

function runJobNow(config: RuntimeConfig, jobId: string) {
  const job = mutateState(config.lane, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === jobId);
    if (!item) throw new Error(`Job not found: ${jobId}`);
    item.lastRunAt = now();
    item.runCount += 1;
    item.nextRunAt = new Date(Date.now() + item.intervalSeconds * 1000).toISOString();
    item.updatedAt = now();
    return item;
  });
  const task = submitTask(config, job.prompt, job.id);
  mutateState(config.lane, (state) => {
    const item = state.jobs.find((candidate) => candidate.id === job.id);
    if (!item) return;
    item.taskIds.unshift(task.id);
    item.lastSuccessAt = now();
    item.lastError = undefined;
    item.status = "active";
  });
  appendTrace(config.lane, task.id, { type: "job", message: "Job spawned task", data: { jobId } });
  return { jobId, taskId: task.id };
}

function updateJobStatus(config: RuntimeConfig, jobId: string, statusValue: "active" | "paused") {
  return mutateState(config.lane, (state) => {
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

function updateMemory(config: RuntimeConfig, memoryId: string, statusValue: "active" | "rejected") {
  return mutateState(config.lane, (state) => {
    const memory = state.memories.find((candidate) => candidate.id === memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    memory.status = statusValue;
    memory.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `memory.${statusValue === "active" ? "approved" : "rejected"}`,
      target: memoryId,
      risk: "medium",
      taskId: memory.sourceTaskId
    });
    return memory;
  });
}

function checkConnector(config: RuntimeConfig, connectorId: string) {
  return mutateState(config.lane, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    updateConnectorHealth(connector);
    addAudit(state, {
      actor: "runtime",
      action: "connector.health",
      target: connectorId,
      risk: "low",
      evidence: { health: connector.health }
    });
    return connector;
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  return (await request.json()) as Record<string, unknown>;
}

function authorized(request: Request, config: RuntimeConfig): boolean {
  const header = request.headers.get("authorization") ?? "";
  const queryToken = new URL(request.url).searchParams.get("token");
  return header === `Bearer ${config.token}` || queryToken === config.token;
}

function json(value: unknown, statusCode = 200): Response {
  return Response.json(value, { status: statusCode });
}

function webApp(config: RuntimeConfig): Response {
  const html = readFileSync(join(import.meta.dir, "web.html"), "utf8")
    .replaceAll("__GINI_TOKEN__", config.token)
    .replaceAll("__GINI_LANE__", config.lane)
    .replaceAll("__GINI_PORT__", String(config.port));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function writePid(config: RuntimeConfig): void {
  writeFileSync(pidPath(config.lane), String(process.pid));
}
