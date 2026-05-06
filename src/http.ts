import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { cancelTask, decideApproval, retryTask, submitTask } from "./agent";
import { pidPath } from "./paths";
import { readState, readTrace } from "./state";
import { mobileBootstrap, publicState } from "./api/views";
import { checkConnector } from "./domain/connectors";
import { createScheduledJob, listJobRuns, removeJob, replayJobRun, runJobNow, updateJob, updateJobStatus } from "./domain/jobs";
import { createMemoryFromInput, updateMemory } from "./domain/memory";
import { proposeImprovement, reviewImprovement } from "./domain/improvements";
import { authorizedBearer, claimPairing, createPairing, revokePairedDevice } from "./domain/pairing";
import { proposePromotion, reviewPromotion } from "./domain/promotions";
import { status } from "./domain/runtime";
import { searchSessions } from "./domain/search";
import { listToolsets, setToolsetStatus } from "./domain/toolsets";
import { listSubagents, spawnSubagent } from "./domain/subagents";
import { addMcpServer, checkMcpServer, invokeMcpTool, removeMcpServer } from "./domain/mcp";
import { addMessagingBridge, checkMessagingBridge, disableMessagingBridge } from "./domain/messaging";
import { inspectImportSource } from "./domain/importers";
import { providerCatalog } from "./provider";
import { createProfile, listProfiles, useProfile } from "./domain/profiles";
import { hermesParityChecks } from "./domain/parity";
import { acknowledgeNotification, checkRelay, configureRelay, listRelays, queueNotification, sendQueuedNotifications } from "./domain/relay";
import { createSkillFromInput, getSkill, listSkills, rollbackSkill, searchSkills, setSkillStatus, testSkill, updateSkill, validateSkills } from "./domain/skills";
import { createChat, getChatSession, listChatSessions, submitChatMessage, syncChatTaskResult } from "./domain/chat";

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    ["GET", /^\/api\/state$/, () => json(publicState(config))],
    ["GET", /^\/api\/mobile\/bootstrap$/, () => json(mobileBootstrap(config))],
    ["GET", /^\/api\/chat$/, () => json(listChatSessions(config))],
    ["POST", /^\/api\/chat$/, async (request) => json(createChat(config, await body(request)), 201)],
    ["GET", /^\/api\/chat\/([^/]+)$/, (_request, params) => json(getChatSession(config, params[0]))],
    ["POST", /^\/api\/chat\/([^/]+)\/messages$/, async (request, params) => json(submitChatMessage(config, params[0], await body(request)), 201)],
    ["POST", /^\/api\/chat\/([^/]+)\/tasks\/([^/]+)\/sync$/, (_request, params) => json(syncChatTaskResult(config, params[0], params[1]))],
    ["GET", /^\/api\/tasks$/, () => json(readState(config.lane).tasks)],
    ["POST", /^\/api\/tasks$/, async (request) => json(submitTask(config, String((await body(request)).input ?? "")), 201)],
    ["GET", /^\/api\/search$/, (_request) => json(searchSessions(config, new URL(_request.url).searchParams.get("q") ?? "", Number(new URL(_request.url).searchParams.get("limit") ?? 20)))],
    ["GET", /^\/api\/tasks\/([^/]+)$/, (_request, params) => {
      const state = readState(config.lane);
      const task = state.tasks.find((item) => item.id === params[0]);
      if (!task) return json({ error: "Task not found" }, 404);
      return json({ task, trace: readTrace(config.lane, task.id) });
    }],
    ["POST", /^\/api\/tasks\/([^/]+)\/retry$/, (_request, params) => json(retryTask(config, params[0]))],
    ["POST", /^\/api\/tasks\/([^/]+)\/cancel$/, (_request, params) => json(cancelTask(config, params[0]))],
    ["GET", /^\/api\/approvals$/, () => json(readState(config.lane).approvals)],
    ["POST", /^\/api\/approvals\/([^/]+)\/approve$/, async (_request, params) => json(await decideApproval(config, params[0], "approve"))],
    ["POST", /^\/api\/approvals\/([^/]+)\/deny$/, async (_request, params) => json(await decideApproval(config, params[0], "deny"))],
    ["GET", /^\/api\/audit$/, () => json(readState(config.lane).audit)],
    ["GET", /^\/api\/events$/, () => json(readState(config.lane).events)],
    ["GET", /^\/api\/events\/stream$/, () => eventStream(config)],
    ["GET", /^\/api\/memory$/, () => json(readState(config.lane).memories)],
    ["POST", /^\/api\/memory$/, async (request) => {
      return json(createMemoryFromInput(config, await body(request)), 201);
    }],
    ["POST", /^\/api\/memory\/([^/]+)\/approve$/, (_request, params) => json(updateMemory(config, params[0], "active"))],
    ["POST", /^\/api\/memory\/([^/]+)\/reject$/, (_request, params) => json(updateMemory(config, params[0], "rejected"))],
    ["GET", /^\/api\/skills$/, (request) => {
      const query = new URL(request.url).searchParams.get("q");
      return json(query ? searchSkills(config, query) : listSkills(config));
    }],
    ["POST", /^\/api\/skills$/, async (request) => json(createSkillFromInput(config, await body(request)), 201)],
    ["GET", /^\/api\/skills\/validate$/, () => json(validateSkills(config))],
    ["GET", /^\/api\/skills\/([^/]+)$/, (_request, params) => json(getSkill(config, params[0]))],
    ["PATCH", /^\/api\/skills\/([^/]+)$/, async (request, params) => json(updateSkill(config, params[0], await body(request)))],
    ["POST", /^\/api\/skills\/([^/]+)\/test$/, (_request, params) => json(testSkill(config, params[0]))],
    ["POST", /^\/api\/skills\/([^/]+)\/trust$/, (_request, params) => json(setSkillStatus(config, params[0], "trusted"))],
    ["POST", /^\/api\/skills\/([^/]+)\/disable$/, (_request, params) => json(setSkillStatus(config, params[0], "disabled"))],
    ["POST", /^\/api\/skills\/([^/]+)\/rollback$/, (_request, params) => json(rollbackSkill(config, params[0]))],
    ["GET", /^\/api\/jobs$/, () => json(readState(config.lane).jobs)],
    ["POST", /^\/api\/jobs$/, async (request) => {
      return json(createScheduledJob(config, await body(request)), 201);
    }],
    ["PATCH", /^\/api\/jobs\/([^/]+)$/, async (request, params) => json(updateJob(config, params[0], await body(request)))],
    ["DELETE", /^\/api\/jobs\/([^/]+)$/, (_request, params) => json(removeJob(config, params[0]))],
    ["GET", /^\/api\/job-runs$/, () => json(listJobRuns(config))],
    ["GET", /^\/api\/jobs\/([^/]+)\/runs$/, (_request, params) => json(listJobRuns(config, params[0]))],
    ["POST", /^\/api\/jobs\/([^/]+)\/run$/, async (_request, params) => json(await runJobNow(config, params[0]))],
    ["POST", /^\/api\/job-runs\/([^/]+)\/replay$/, async (_request, params) => json(await replayJobRun(config, params[0]))],
    ["POST", /^\/api\/jobs\/([^/]+)\/pause$/, (_request, params) => json(updateJobStatus(config, params[0], "paused"))],
    ["POST", /^\/api\/jobs\/([^/]+)\/resume$/, (_request, params) => json(updateJobStatus(config, params[0], "active"))],
    ["GET", /^\/api\/connectors$/, () => json(readState(config.lane).connectors)],
    ["POST", /^\/api\/connectors\/([^/]+)\/health$/, (_request, params) => json(checkConnector(config, params[0]))],
    ["GET", /^\/api\/improvements$/, () => json(readState(config.lane).improvements)],
    ["POST", /^\/api\/improvements$/, async (request) => json(proposeImprovement(config, await body(request)), 201)],
    ["POST", /^\/api\/improvements\/([^/]+)\/approve$/, (_request, params) => json(reviewImprovement(config, params[0], "approve"))],
    ["POST", /^\/api\/improvements\/([^/]+)\/reject$/, (_request, params) => json(reviewImprovement(config, params[0], "reject"))],
    ["GET", /^\/api\/devices$/, () => json(publicState(config).devices)],
    ["POST", /^\/api\/devices\/([^/]+)\/revoke$/, (_request, params) => json(revokePairedDevice(config, params[0]))],
    ["POST", /^\/api\/pairing$/, async (request) => json(createPairing(config, await body(request)), 201)],
    ["GET", /^\/api\/promotions$/, () => json(readState(config.lane).promotions)],
    ["POST", /^\/api\/promotions$/, async (request) => json(proposePromotion(config, await body(request)), 201)],
    ["POST", /^\/api\/promotions\/([^/]+)\/approve$/, (_request, params) => json(reviewPromotion(config, params[0], "approve"))],
    ["POST", /^\/api\/promotions\/([^/]+)\/reject$/, (_request, params) => json(reviewPromotion(config, params[0], "reject"))],
    ["GET", /^\/api\/toolsets$/, () => json(listToolsets(config))],
    ["POST", /^\/api\/toolsets\/([^/]+)\/enable$/, (_request, params) => json(setToolsetStatus(config, params[0], "enabled"))],
    ["POST", /^\/api\/toolsets\/([^/]+)\/disable$/, (_request, params) => json(setToolsetStatus(config, params[0], "disabled"))],
    ["GET", /^\/api\/subagents$/, () => json(listSubagents(config))],
    ["POST", /^\/api\/subagents$/, async (request) => json(spawnSubagent(config, await body(request)), 201)],
    ["GET", /^\/api\/mcp$/, () => json(readState(config.lane).mcpServers)],
    ["POST", /^\/api\/mcp$/, async (request) => json(addMcpServer(config, await body(request)), 201)],
    ["POST", /^\/api\/mcp\/([^/]+)\/health$/, async (_request, params) => json(await checkMcpServer(config, params[0]))],
    ["POST", /^\/api\/mcp\/([^/]+)\/invoke$/, async (request, params) => {
      const input = await body(request);
      return json(await invokeMcpTool(config, params[0], String(input.toolName ?? ""), input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {}));
    }],
    ["POST", /^\/api\/mcp\/([^/]+)\/disable$/, (_request, params) => json(removeMcpServer(config, params[0]))],
    ["GET", /^\/api\/messaging$/, () => json(readState(config.lane).messagingBridges)],
    ["POST", /^\/api\/messaging$/, async (request) => json(addMessagingBridge(config, await body(request)), 201)],
    ["POST", /^\/api\/messaging\/([^/]+)\/health$/, (_request, params) => json(checkMessagingBridge(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/disable$/, (_request, params) => json(disableMessagingBridge(config, params[0]))],
    ["GET", /^\/api\/providers\/catalog$/, () => json(providerCatalog())],
    ["GET", /^\/api\/profiles$/, () => json(listProfiles(config))],
    ["POST", /^\/api\/profiles$/, async (request) => json(createProfile(config, await body(request)), 201)],
    ["POST", /^\/api\/profiles\/([^/]+)\/use$/, (_request, params) => json(useProfile(config, params[0]))],
    ["GET", /^\/api\/parity\/hermes$/, () => json(hermesParityChecks(config))],
    ["GET", /^\/api\/relays$/, () => json(listRelays(config))],
    ["POST", /^\/api\/relays$/, async (request) => json(configureRelay(config, await body(request)), 201)],
    ["POST", /^\/api\/relays\/([^/]+)\/health$/, (_request, params) => json(checkRelay(config, params[0]))],
    ["GET", /^\/api\/notifications$/, () => json(readState(config.lane).notifications)],
    ["POST", /^\/api\/notifications$/, async (request) => json(queueNotification(config, await body(request)), 201)],
    ["POST", /^\/api\/notifications\/send$/, () => json(sendQueuedNotifications(config))],
    ["POST", /^\/api\/notifications\/([^/]+)\/ack$/, (_request, params) => json(acknowledgeNotification(config, params[0]))],
    ["GET", /^\/api\/imports$/, () => json(readState(config.lane).importReports)],
    ["POST", /^\/api\/imports\/inspect$/, async (request) => {
      const input = await body(request);
      const source = input.source === "openclaw" ? "openclaw" : "hermes";
      return json(inspectImportSource(config, source, String(input.path ?? "")), 201);
    }]
  ];

  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
        try {
          return json(claimPairing(config, await body(request)), 201);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
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

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  return (await request.json()) as Record<string, unknown>;
}

function authorized(request: Request, config: RuntimeConfig): boolean {
  const header = request.headers.get("authorization") ?? "";
  const queryToken = new URL(request.url).searchParams.get("token");
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
  return authorizedBearer(config, bearer ?? undefined);
}

function json(value: unknown, statusCode = 200): Response {
  return Response.json(value, { status: statusCode });
}

function eventStream(config: RuntimeConfig): Response {
  let closed = false;
  let interval: Timer | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const seen = new Set<string>();
      const send = () => {
        if (closed) return;
        const events = readState(config.lane).events.slice().reverse();
        for (const event of events) {
          if (seen.has(event.id)) continue;
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
          seen.add(event.id);
        }
      };
      send();
      interval = setInterval(send, 1000);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
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
