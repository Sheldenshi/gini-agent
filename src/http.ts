import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { decideApproval, submitTask } from "./agent";
import { pidPath } from "./paths";
import {
  createSkill,
  mutateState,
  readState,
  readTrace,
} from "./state";
import { mobileBootstrap, publicState } from "./api/views";
import { checkConnector } from "./domain/connectors";
import { createScheduledJob, runJobNow, updateJobStatus } from "./domain/jobs";
import { createMemoryFromInput, updateMemory } from "./domain/memory";
import { proposeImprovement, reviewImprovement } from "./domain/improvements";
import { authorizedBearer, claimPairing, createPairing, revokePairedDevice } from "./domain/pairing";
import { proposePromotion, reviewPromotion } from "./domain/promotions";
import { status } from "./domain/runtime";
import { searchSessions } from "./domain/search";
import { listToolsets, setToolsetStatus } from "./domain/toolsets";
import { listSubagents, spawnSubagent } from "./domain/subagents";
import { addMcpServer, checkMcpServer, removeMcpServer } from "./domain/mcp";
import { addMessagingBridge, checkMessagingBridge, disableMessagingBridge } from "./domain/messaging";
import { inspectImportSource } from "./domain/importers";
import { providerCatalog } from "./provider";
import { createProfile, listProfiles, useProfile } from "./domain/profiles";
import { hermesParityChecks } from "./domain/parity";
import { acknowledgeNotification, checkRelay, configureRelay, listRelays, queueNotification, sendQueuedNotifications } from "./domain/relay";

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    ["GET", /^\/api\/state$/, () => json(publicState(config))],
    ["GET", /^\/api\/mobile\/bootstrap$/, () => json(mobileBootstrap(config))],
    ["GET", /^\/api\/tasks$/, () => json(readState(config.lane).tasks)],
    ["POST", /^\/api\/tasks$/, async (request) => json(submitTask(config, String((await body(request)).input ?? "")), 201)],
    ["GET", /^\/api\/search$/, (_request) => json(searchSessions(config, new URL(_request.url).searchParams.get("q") ?? "", Number(new URL(_request.url).searchParams.get("limit") ?? 20)))],
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
      return json(createMemoryFromInput(config, await body(request)), 201);
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
      return json(createScheduledJob(config, await body(request)), 201);
    }],
    ["POST", /^\/api\/jobs\/([^/]+)\/run$/, (_request, params) => json(runJobNow(config, params[0]))],
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
    ["POST", /^\/api\/mcp\/([^/]+)\/health$/, (_request, params) => json(checkMcpServer(config, params[0]))],
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
