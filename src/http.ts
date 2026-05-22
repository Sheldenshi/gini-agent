import { writeFileSync } from "node:fs";
import type { ApprovalMode, RuntimeConfig } from "./types";
import { cancelTask, decideApproval, resolveApproval, retryTask, submitTask } from "./agent";
import { pidPath } from "./paths";
import { addAudit, mutateState, readState, readTrace } from "./state";
import { mobileBootstrap, publicState } from "./runtime/views";
import { checkConnector, createConnector, deleteConnector, updateConnector } from "./integrations/connectors";
import { listProviders } from "./integrations/connectors/registry";
import { runConnectorDetection } from "./jobs/connector-detection";
import { createScheduledJob, listJobRuns, removeJob, replayJobRun, runJobNow, updateJob, updateJobStatus } from "./jobs";
import { migrateLegacyMemories, recall, reflect, retain } from "./memory";
import { embeddingStatus, reembedBank } from "./memory/embedding";
import { rerankerStatus } from "./memory/reranker";
import { listBanks, listMemoryUnits, getBank, updateBank, ensureDefaultBank, ensureAgentBank, DEFAULT_BANK_ID, type Network } from "./state";
import { proposeImprovement, reviewImprovement } from "./governance/improvements";
import { authorizedBearer, claimPairing, createPairing, revokePairedDevice } from "./governance/pairing";
import { proposePromotion, reviewPromotion } from "./governance/promotions";
import { status, updateAutoApproveSettings } from "./runtime";
import { searchSessions } from "./execution/search";
import { listToolsets, setToolsetStatus } from "./capabilities/toolsets";
import { cancelSubagent, listSubagents, spawnSubagent } from "./capabilities/subagents";
import { addMcpServer, checkMcpServer, invokeMcpTool, removeMcpServer } from "./integrations/mcp";
import { addMessagingBridge, allowChat, checkMessagingBridge, denyChat, disableMessagingBridge, listAllowedChats, listMessagingMessages, pairMessagingBridge, receiveMessagingInput, sendMessagingOutput } from "./integrations/messaging";
import { inspectImportSource } from "./integrations/importers";
import { providerCatalog } from "./provider";
import { createAgent, deleteAgent, listAgents, useAgent } from "./capabilities/agents";
import {
  approveSoul,
  approveUserProfile,
  instructionsPath,
  listSoulHistory,
  listUserProfileHistory,
  loadInstructions,
  loadSoul,
  loadUserProfile,
  restoreSoulFromHistory,
  restoreUserProfileFromHistory,
  soulHistoryDir,
  soulPath,
  userProfileHistoryDir,
  userProfilePath
} from "./runtime/identity-files";
import { SOUL_SOFT_CAP_CHARS, USER_SOFT_CAP_CHARS, identityBudgetState } from "./system-prompt";
import { resolveEffectiveContext } from "./execution/effective-context";
import { connectBrowser, disconnectBrowser, getBrowserConnection } from "./capabilities/browser-connect";
import { hermesParityChecks } from "./runtime/parity";
import { acknowledgeNotification, checkRelay, configureRelay, listRelays, queueNotification, sendQueuedNotifications } from "./integrations/relay";
import { getSetupStatus, setSetupProvider } from "./runtime/setup-api";
import { createSkillFromInput, getSkill, installSkillFromBody, listSkills, reloadSkills, rollbackSkill, searchSkills, setSkillStatus, testSkill, updateSkill, validateSkills } from "./capabilities/skills";
import { createChat, deleteChat, getChatSession, listChatSessions, renameChat, submitChatMessage, syncChatTaskResult } from "./execution/chat";
import { v1Readiness } from "./runtime/readiness";
import { getRun, listRuns } from "./execution/runs";
import { assertCurrentRuntimeUpdateSupported, currentVersionInfo, refreshVersionInfo, scheduleRuntimeRestart, updateRuntime } from "./runtime/update";
import { projectRoot } from "./paths";

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    ["GET", /^\/api\/version$/, () => json(currentVersionInfo())],
    ["POST", /^\/api\/update\/check$/, () => json(refreshVersionInfo())],
    ["POST", /^\/api\/update$/, () => {
      assertCurrentRuntimeUpdateSupported();
      const result = updateRuntime(projectRoot());
      const restartRequested = result.upToDate ? false : scheduleRuntimeRestart(config.instance);
      return json({ ...result, restart: { requested: restartRequested } });
    }],
    ["GET", /^\/api\/state$/, () => json(publicState(config))],
    // Settings: auto-approve controls.
    //   - `patterns`: shell-glob allowlist for terminal_exec only.
    //     Allowlist match short-circuits the dangerous-pattern blocklist.
    //   - `approvalMode`: "strict" | "auto" | "yolo". See ADR
    //     approval-mode.md for the contract. Fresh instances default
    //     to "auto".
    //   - `dangerousTerminalPatterns`: optional operator overlay for
    //     the built-in dangerous-pattern blocklist; only consulted when
    //     `approvalMode === "auto"`.
    //   - `dangerouslyAutoApprove`: deprecated read alias for
    //     `approvalMode === "yolo"`. Accepted as a write alias too —
    //     setting it true is equivalent to `approvalMode: "yolo"`.
    // PATCH accepts any subset of fields together; omitted keys are
    // left at their current value.
    ["GET", /^\/api\/settings\/auto-approve$/, () => {
      const approvalMode = config.approvalMode ?? (config.dangerouslyAutoApprove ? "yolo" : "auto");
      return json({
        patterns: config.autoApproveCommands ?? [],
        approvalMode,
        dangerousTerminalPatterns: config.dangerousTerminalPatterns ?? [],
        // Derived read-only alias kept for legacy clients.
        dangerouslyAutoApprove: approvalMode === "yolo",
      });
    }],
    ["PATCH", /^\/api\/settings\/auto-approve$/, async (request) => {
      const payload = await body(request);
      // Validate strictly. Previously an out-of-union value was mapped
      // to undefined and the PATCH silently no-op'd that field while
      // returning 200 — the client thought it succeeded. Job-level
      // approvalMode validation already rejects unknown values; mirror
      // that contract at the HTTP boundary too.
      let approvalMode: ApprovalMode | undefined;
      if (payload.approvalMode !== undefined && payload.approvalMode !== null) {
        if (
          payload.approvalMode !== "strict" &&
          payload.approvalMode !== "auto" &&
          payload.approvalMode !== "yolo"
        ) {
          return json(
            {
              error: `approvalMode must be one of "strict" | "auto" | "yolo" (got ${JSON.stringify(payload.approvalMode)})`,
              validValues: ["strict", "auto", "yolo"]
            },
            400
          );
        }
        approvalMode = payload.approvalMode;
      }
      return json(updateAutoApproveSettings(config, {
        patterns: Array.isArray(payload.patterns) ? payload.patterns.map(String) : undefined,
        approvalMode,
        dangerousTerminalPatterns: Array.isArray(payload.dangerousTerminalPatterns)
          ? payload.dangerousTerminalPatterns.map(String)
          : undefined,
        dangerouslyAutoApprove: typeof payload.dangerouslyAutoApprove === "boolean" ? payload.dangerouslyAutoApprove : undefined
      }));
    }],
    ["GET", /^\/api\/mobile\/bootstrap$/, () => json(mobileBootstrap(config))],
    ["GET", /^\/api\/chat$/, (request) => {
      const agentId = agentIdFilter(request);
      const sessions = listChatSessions(config);
      return json(agentId ? sessions.filter((s) => s.agentId === agentId) : sessions);
    }],
    ["POST", /^\/api\/chat$/, async (request) => json(await createChat(config, await body(request)), 201)],
    ["GET", /^\/api\/chat\/([^/]+)$/, (_request, params) => json(getChatSession(config, params[0]))],
    ["DELETE", /^\/api\/chat\/([^/]+)$/, async (_request, params) => { await deleteChat(config, params[0]); return json({ ok: true }); }],
    ["PATCH", /^\/api\/chat\/([^/]+)$/, async (request, params) => json(await renameChat(config, params[0], await body(request)))],
    ["POST", /^\/api\/chat\/([^/]+)\/messages$/, async (request, params) => json(await submitChatMessage(config, params[0], await body(request)), 201)],
    ["POST", /^\/api\/chat\/([^/]+)\/tasks\/([^/]+)\/sync$/, async (_request, params) => json(await syncChatTaskResult(config, params[0], params[1]))],
    ["GET", /^\/api\/runs$/, () => json(listRuns(config))],
    ["GET", /^\/api\/runs\/([^/]+)$/, (_request, params) => json(getRun(config, params[0]))],
    ["GET", /^\/api\/tasks$/, (request) => {
      const agentId = agentIdFilter(request);
      const tasks = readState(config.instance).tasks;
      return json(agentId ? tasks.filter((task) => task.agentId === agentId) : tasks);
    }],
    ["POST", /^\/api\/tasks$/, async (request) => json(await submitTask(config, String((await body(request)).input ?? "")), 201)],
    ["GET", /^\/api\/search$/, (_request) => json(searchSessions(config, new URL(_request.url).searchParams.get("q") ?? "", Number(new URL(_request.url).searchParams.get("limit") ?? 20)))],
    ["GET", /^\/api\/tasks\/([^/]+)$/, (_request, params) => {
      const state = readState(config.instance);
      const task = state.tasks.find((item) => item.id === params[0]);
      if (!task) return json({ error: "Task not found" }, 404);
      return json({ task, trace: readTrace(config.instance, task.id) });
    }],
    ["POST", /^\/api\/tasks\/([^/]+)\/retry$/, async (_request, params) => json(await retryTask(config, params[0]))],
    ["POST", /^\/api\/tasks\/([^/]+)\/cancel$/, async (_request, params) => json(await cancelTask(config, params[0]))],
    ["GET", /^\/api\/approvals$/, (request) => {
      const agentId = agentIdFilter(request);
      const approvals = readState(config.instance).approvals;
      return json(agentId ? approvals.filter((a) => a.agentId === agentId) : approvals);
    }],
    ["POST", /^\/api\/approvals\/([^/]+)\/approve$/, async (_request, params) => json(await decideApproval(config, params[0], "approve"))],
    ["POST", /^\/api\/approvals\/([^/]+)\/deny$/, async (_request, params) => json(await decideApproval(config, params[0], "deny"))],
    // Connect endpoint for `connector.request` approvals. The chat UI's
    // Connect button POSTs here with the user-entered secrets. The
    // endpoint:
    //   1. Validates the approval exists, is pending, and was raised by
    //      the `request_connector` tool (`action === "connector.request"`).
    //   2. Calls createConnector with the secret payload.
    //   3. Probes via checkConnector. On failure, returns 200 + ok:false so
    //      the dialog can keep itself open and let the user retry without
    //      tearing down the approval row.
    //   4. On success, resolves the approval through resolveApproval —
    //      that path fires executeApprovedAction (a no-op for
    //      `connector.request`) and resumes the chat-task loop with the
    //      synthesized "Connected to X. Proceed" tool result.
    ["POST", /^\/api\/approvals\/([^/]+)\/connect$/, async (request, params) => {
      const approvalId = params[0];
      const state = readState(config.instance);
      const approval = state.approvals.find((a) => a.id === approvalId);
      if (!approval) return json({ error: "Approval not found" }, 404);
      if (approval.action !== "connector.request") {
        return json({ error: `Approval ${approvalId} is not a connector.request (${approval.action})` }, 400);
      }
      if (approval.status !== "pending") {
        return json({ error: `Approval is already ${approval.status}` }, 410);
      }
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : {};
      const scopes = Array.isArray(payload.scopes) ? payload.scopes.map(String) : [];
      const providerId = String(approval.payload.provider ?? "");
      const providerLabel = typeof approval.payload.providerLabel === "string"
        ? approval.payload.providerLabel
        : providerId;
      const overrideName = typeof payload.name === "string" && payload.name.trim().length > 0
        ? payload.name.trim()
        : providerLabel;
      const connector = await createConnector(config, {
        name: overrideName,
        provider: providerId,
        scopes,
        secrets
      });
      const probed = await checkConnector(config, connector.id);
      if (probed.health !== "healthy") {
        return json({
          ok: false,
          connector: probed,
          message: probed.message ?? "Connector probe failed; please verify the credentials and retry."
        });
      }
      await resolveApproval(config, approvalId, { actor: "user", resumeChatTask: true });
      return json({ ok: true, connector: probed });
    }],
    ["GET", /^\/api\/audit$/, (request) => {
      const agentId = agentIdFilter(request);
      const audit = readState(config.instance).audit;
      return json(agentId ? audit.filter((entry) => entry.agentId === agentId) : audit);
    }],
    ["GET", /^\/api\/events$/, (request) => {
      const agentId = agentIdFilter(request);
      const events = readState(config.instance).events;
      return json(agentId ? events.filter((event) => event.agentId === agentId) : events);
    }],
    ["GET", /^\/api\/events\/stream$/, (request) => eventStream(config, request)],
    // Hindsight phase 6: one-time migration trigger.
    ["POST", /^\/api\/memory\/migrate$/, async () => {
      const report = await migrateLegacyMemories(config);
      return json(report);
    }],
    // Hindsight phase 4: reflect pipeline.
    ["POST", /^\/api\/memory\/reflect$/, async (request) => {
      const payload = await body(request);
      const effective = resolveEffectiveContext(readState(config.instance), config);
      if (!effective.agentId) return json({ error: "no active agent" }, 400);
      const query = String(payload.query ?? "").trim();
      if (!query) return json({ error: "query is required" }, 400);
      const result = await reflect(config, {
        agentId: effective.agentId,
        query,
        bankId: typeof payload.bankId === "string" ? payload.bankId : undefined,
        tokenBudget: typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined,
        sourceTaskId: typeof payload.sourceTaskId === "string" ? payload.sourceTaskId : undefined
      });
      return json(result);
    }],
    // Hindsight phase 3: recall pipeline.
    ["POST", /^\/api\/memory\/recall$/, async (request) => {
      const payload = await body(request);
      const effective = resolveEffectiveContext(readState(config.instance), config);
      if (!effective.agentId) return json({ error: "no active agent" }, 400);
      const query = String(payload.query ?? "").trim();
      if (!query) return json({ error: "query is required" }, 400);
      const networkRaw = Array.isArray(payload.network) ? payload.network : undefined;
      const networks = networkRaw
        ? networkRaw.filter((value): value is Network => value === "world" || value === "experience" || value === "opinion" || value === "observation")
        : undefined;
      const result = await recall(config, {
        agentId: effective.agentId,
        query,
        bankId: typeof payload.bankId === "string" ? payload.bankId : undefined,
        tokenBudget: typeof payload.tokenBudget === "number" ? payload.tokenBudget : undefined,
        network: networks && networks.length > 0 ? networks : undefined,
        sourceTaskId: typeof payload.sourceTaskId === "string" ? payload.sourceTaskId : undefined
      });
      return json(result);
    }],
    // Hindsight phase 2: retain pipeline. Specific routes come before the
    // catch-all /api/memory/:id pattern below.
    ["POST", /^\/api\/memory\/retain$/, async (request) => {
      const payload = await body(request);
      const effective = resolveEffectiveContext(readState(config.instance), config);
      if (!effective.agentId) return json({ error: "no active agent" }, 400);
      const text = String(payload.text ?? "").trim();
      if (!text) return json({ error: "text is required" }, 400);
      const result = await retain(config, {
        agentId: effective.agentId,
        text,
        bankId: typeof payload.bankId === "string" ? payload.bankId : undefined,
        sourceTaskId: typeof payload.sourceTaskId === "string" ? payload.sourceTaskId : undefined,
        sourceSessionId: typeof payload.sourceSessionId === "string" ? payload.sourceSessionId : undefined,
        mentionedAt: typeof payload.mentionedAt === "string" ? payload.mentionedAt : undefined
      });
      return json(result, 201);
    }],
    ["GET", /^\/api\/memory\/units$/, (request) => {
      const url = new URL(request.url);
      const networkParam = url.searchParams.get("network");
      ensureDefaultBank(config.instance);
      // Phase C — list the active agent's units by default. Caller may
      // still override with ?bank= for the legacy default bank, but the
      // agent_id filter still applies so cross-agent visibility never
      // accidentally leaks through.
      const state = readState(config.instance);
      const effective = resolveEffectiveContext(state, config);
      const agentId = effective.agentId;
      const defaultBank = agentId ? `bank_${agentId}` : DEFAULT_BANK_ID;
      const bankId = url.searchParams.get("bank") ?? defaultBank;
      const networks = networkParam
        ? networkParam.split(",").filter((value): value is Network =>
            value === "world" || value === "experience" || value === "opinion" || value === "observation"
          )
        : undefined;
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const units = listMemoryUnits(config.instance, bankId, {
        agentId,
        network: networks && networks.length > 0 ? networks : undefined,
        limit
      });
      return json(units.map((unit) => ({ ...unit, kind: "hindsight" })));
    }],
    ["GET", /^\/api\/embedding\/status$/, () => json(embeddingStatus(config))],
    ["POST", /^\/api\/embedding\/reembed$/, async (request) => {
      const payload = await body(request);
      const result = await reembedBank(config, {
        bankId: typeof payload.bankId === "string" ? payload.bankId : undefined,
        dryRun: payload.dryRun === true
      });
      return json(result);
    }],
    ["GET", /^\/api\/reranker\/status$/, () => json(rerankerStatus(config))],
    ["GET", /^\/api\/memory\/banks$/, () => {
      ensureDefaultBank(config.instance);
      // Phase C — list banks belonging to the active agent only. The
      // ambient default bank stays hidden so the web Memory page surfaces
      // a single per-agent bank instead of a mixed pool.
      const state = readState(config.instance);
      const effective = resolveEffectiveContext(state, config);
      if (effective.agentId) {
        ensureAgentBank(config.instance, effective.agentId);
      }
      const banks = listBanks(config.instance).filter((bank) =>
        effective.agentId ? bank.agentId === effective.agentId : true
      );
      return json(banks);
    }],
    ["GET", /^\/api\/memory\/banks\/([^/]+)$/, (_request, params) => {
      ensureDefaultBank(config.instance);
      const bank = getBank(config.instance, params[0]);
      if (!bank) return json({ error: "bank not found" }, 404);
      return json(bank);
    }],
    ["PATCH", /^\/api\/memory\/banks\/([^/]+)$/, async (request, params) => {
      ensureDefaultBank(config.instance);
      const payload = await body(request);
      const updated = updateBank(config.instance, params[0], {
        name: typeof payload.name === "string" ? payload.name : undefined,
        agentName: typeof payload.agentName === "string" ? payload.agentName : undefined,
        background: typeof payload.background === "string" ? payload.background : undefined,
        skepticism: typeof payload.skepticism === "number" ? payload.skepticism : undefined,
        literalism: typeof payload.literalism === "number" ? payload.literalism : undefined,
        empathy: typeof payload.empathy === "number" ? payload.empathy : undefined,
        biasStrength: typeof payload.biasStrength === "number" ? payload.biasStrength : undefined
      });
      if (!updated) return json({ error: "bank not found" }, 404);
      return json(updated);
    }],
    // Identity-file approval surface. The chat-task `edit_soul` tool
    // lands its proposal on SOUL.md.proposed and the runtime continues
    // to read the approved SOUL.md until this endpoint renames the
    // proposal over the approved target. `edit_user_profile` is
    // auto-approved post-consolidation for clean bodies; a write that
    // trips the injection scanner falls back to USER.md.proposed and
    // requires this approval endpoint before it lands at the approved
    // path. See ADR memory-surface-consolidation.md and ADR
    // runtime-identity-files.md for the original propose/approve design.
    ["POST", /^\/api\/identity-files\/soul\/approve$/, async () => json(await approveSoulProposal(config))],
    ["POST", /^\/api\/identity-files\/user\/approve$/, async () => json(await approveUserProfileProposal(config))],
    // Read-only inspection: dump INSTRUCTIONS.md, USER.md, and the
    // SOUL.md for the active or named agent with char counts vs the
    // soft cap. Returns full file content (no truncation). The CLI
    // `gini identity show` consumes this endpoint.
    ["GET", /^\/api\/identity-files$/, (request) => json(showIdentityFiles(config, request))],
    // List history snapshots for USER.md or a per-agent SOUL.md.
    // kind ∈ {user, soul}; agentId required for soul. Newest first.
    ["GET", /^\/api\/identity-files\/history$/, (request) => json(showIdentityHistory(config, request))],
    // Restore an identity file from a named history snapshot. Atomic.
    // Emits an audit row + creates a fresh pre-rollback snapshot so
    // the rollback is itself reversible.
    ["POST", /^\/api\/identity-files\/rollback$/, async (request) => json(await rollbackIdentityFile(config, request))],
    ["GET", /^\/api\/skills$/, (request) => {
      const query = new URL(request.url).searchParams.get("q");
      return json(query ? searchSkills(config, query) : listSkills(config));
    }],
    // POST /api/skills accepts two payload shapes per ADR connector-provider-spec-compliance.md:
    //   - { body: "<SKILL.md text>", files?: [...] }: install-from-disk
    //     flow used by the install-skill meta-skill and remote/mobile UIs.
    //     Writes to ~/.gini/instances/<instance>/skills/<category>/<name>/
    //     and reloads.
    //   - legacy CRUD payload (`name`, `description`, `steps`, …): create
    //     an in-memory SkillRecord without a manifest file.
    ["POST", /^\/api\/skills$/, async (request) => {
      const payload = await body(request);
      if (typeof payload?.body === "string" && payload.body.trim().startsWith("---")) {
        const files = Array.isArray(payload.files)
          ? payload.files.filter((f: unknown): f is { name: string; content: string } =>
              !!f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string" && typeof (f as { content?: unknown }).content === "string")
          : undefined;
        return json(await installSkillFromBody(config, {
          body: String(payload.body),
          category: typeof payload.category === "string" ? payload.category : undefined,
          files
        }), 201);
      }
      return json(await createSkillFromInput(config, payload), 201);
    }],
    ["GET", /^\/api\/skills\/validate$/, () => json(validateSkills(config))],
    // Manual filesystem skill reload — re-runs loadSkillsFromDisk so a user
    // can drop a new SKILL.md under <instance>/skills/ without restarting.
    ["POST", /^\/api\/skills\/reload$/, async () => json(await reloadSkills(config))],
    ["GET", /^\/api\/skills\/([^/]+)$/, (_request, params) => json(getSkill(config, params[0]))],
    ["PATCH", /^\/api\/skills\/([^/]+)$/, async (request, params) => json(await updateSkill(config, params[0], await body(request)))],
    ["POST", /^\/api\/skills\/([^/]+)\/test$/, async (_request, params) => json(await testSkill(config, params[0]))],
    ["POST", /^\/api\/skills\/([^/]+)\/enable$/, async (_request, params) => json(await setSkillStatus(config, params[0], "enabled"))],
    ["POST", /^\/api\/skills\/([^/]+)\/disable$/, async (_request, params) => json(await setSkillStatus(config, params[0], "disabled"))],
    ["POST", /^\/api\/skills\/([^/]+)\/rollback$/, async (_request, params) => json(await rollbackSkill(config, params[0]))],
    ["GET", /^\/api\/jobs$/, (request) => {
      const agentId = agentIdFilter(request);
      const jobs = readState(config.instance).jobs;
      return json(agentId ? jobs.filter((job) => job.agentId === agentId) : jobs);
    }],
    ["POST", /^\/api\/jobs$/, async (request) => {
      return json(await createScheduledJob(config, await body(request)), 201);
    }],
    ["PATCH", /^\/api\/jobs\/([^/]+)$/, async (request, params) => json(await updateJob(config, params[0], await body(request)))],
    ["DELETE", /^\/api\/jobs\/([^/]+)$/, async (_request, params) => json(await removeJob(config, params[0]))],
    ["GET", /^\/api\/job-runs$/, (request) => {
      const agentId = agentIdFilter(request);
      const runs = listJobRuns(config);
      return json(agentId ? runs.filter((run) => run.agentId === agentId) : runs);
    }],
    ["GET", /^\/api\/jobs\/([^/]+)\/runs$/, (request, params) => {
      const agentId = agentIdFilter(request);
      const runs = listJobRuns(config, params[0]);
      return json(agentId ? runs.filter((run) => run.agentId === agentId) : runs);
    }],
    ["POST", /^\/api\/jobs\/([^/]+)\/run$/, async (_request, params) => json(await runJobNow(config, params[0]))],
    ["POST", /^\/api\/job-runs\/([^/]+)\/replay$/, async (_request, params) => json(await replayJobRun(config, params[0]))],
    ["POST", /^\/api\/jobs\/([^/]+)\/pause$/, async (_request, params) => json(await updateJobStatus(config, params[0], "paused"))],
    ["POST", /^\/api\/jobs\/([^/]+)\/resume$/, async (_request, params) => json(await updateJobStatus(config, params[0], "active"))],
    ["GET", /^\/api\/connectors$/, () => json(readState(config.instance).connectors)],
    ["GET", /^\/api\/connectors\/providers$/, () => json(listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      fields: p.fields,
      secrets: p.secrets,
      hasProbe: Boolean(p.probe),
      hasDetect: Boolean(p.detect),
      probeIntervalMs: p.probeIntervalMs
    })))],
    ["POST", /^\/api\/connectors$/, async (request) => {
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : undefined;
      const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined;
      return json(await createConnector(config, {
        name: String(payload.name ?? ""),
        provider: String(payload.provider ?? ""),
        scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : undefined,
        secrets,
        metadata
      }), 201);
    }],
    ["PATCH", /^\/api\/connectors\/([^/]+)$/, async (request, params) => {
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : undefined;
      const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined;
      const status = payload.status === "configured" || payload.status === "disabled" || payload.status === "error"
        ? payload.status
        : undefined;
      return json(await updateConnector(config, params[0], {
        name: typeof payload.name === "string" ? payload.name : undefined,
        scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : undefined,
        status,
        secrets,
        metadata
      }));
    }],
    ["DELETE", /^\/api\/connectors\/([^/]+)$/, async (_request, params) => json(await deleteConnector(config, params[0]))],
    ["POST", /^\/api\/connectors\/([^/]+)\/health$/, async (_request, params) => json(await checkConnector(config, params[0]))],
    // On-demand auto-detection — Skills page "Refresh detection" button
    // calls this. Same job that runs at gateway startup; idempotent.
    ["POST", /^\/api\/connectors\/detect$/, async () => json(await runConnectorDetection(config))],
    ["GET", /^\/api\/improvements$/, () => json(readState(config.instance).improvements)],
    ["POST", /^\/api\/improvements$/, async (request) => json(await proposeImprovement(config, await body(request)), 201)],
    ["POST", /^\/api\/improvements\/([^/]+)\/approve$/, async (_request, params) => json(await reviewImprovement(config, params[0], "approve"))],
    ["POST", /^\/api\/improvements\/([^/]+)\/reject$/, async (_request, params) => json(await reviewImprovement(config, params[0], "reject"))],
    ["GET", /^\/api\/devices$/, () => json(publicState(config).devices)],
    ["POST", /^\/api\/devices\/([^/]+)\/revoke$/, async (_request, params) => json(await revokePairedDevice(config, params[0]))],
    ["POST", /^\/api\/pairing$/, async (request) => json(await createPairing(config, await body(request)), 201)],
    ["GET", /^\/api\/promotions$/, () => json(readState(config.instance).promotions)],
    ["POST", /^\/api\/promotions$/, async (request) => json(await proposePromotion(config, await body(request)), 201)],
    ["POST", /^\/api\/promotions\/([^/]+)\/approve$/, async (_request, params) => json(await reviewPromotion(config, params[0], "approve"))],
    ["POST", /^\/api\/promotions\/([^/]+)\/reject$/, async (_request, params) => json(await reviewPromotion(config, params[0], "reject"))],
    ["GET", /^\/api\/browser$/, () => json(getBrowserConnection(config))],
    ["POST", /^\/api\/browser\/connect$/, async (request) => {
      const payload = await body(request);
      return json(await connectBrowser(config, payload), 201);
    }],
    ["POST", /^\/api\/browser\/disconnect$/, async () => json(await disconnectBrowser(config))],
    ["GET", /^\/api\/toolsets$/, () => json(listToolsets(config))],
    ["POST", /^\/api\/toolsets\/([^/]+)\/enable$/, async (_request, params) => json(await setToolsetStatus(config, params[0], "enabled"))],
    ["POST", /^\/api\/toolsets\/([^/]+)\/disable$/, async (_request, params) => json(await setToolsetStatus(config, params[0], "disabled"))],
    ["GET", /^\/api\/subagents$/, async (request) => {
      const agentId = agentIdFilter(request);
      const subagents = await listSubagents(config);
      return json(agentId ? subagents.filter((sub) => sub.agentId === agentId) : subagents);
    }],
    ["POST", /^\/api\/subagents$/, async (request) => json(await spawnSubagent(config, await body(request)), 201)],
    ["POST", /^\/api\/subagents\/([^/]+)\/cancel$/, async (_request, params) => json(await cancelSubagent(config, params[0]))],
    ["GET", /^\/api\/mcp$/, () => json(readState(config.instance).mcpServers)],
    ["POST", /^\/api\/mcp$/, async (request) => json(await addMcpServer(config, await body(request)), 201)],
    ["POST", /^\/api\/mcp\/([^/]+)\/health$/, async (_request, params) => json(await checkMcpServer(config, params[0]))],
    ["POST", /^\/api\/mcp\/([^/]+)\/invoke$/, async (request, params) => {
      const input = await body(request);
      return json(await invokeMcpTool(config, params[0], String(input.toolName ?? ""), input.input && typeof input.input === "object" ? input.input as Record<string, unknown> : {}));
    }],
    ["POST", /^\/api\/mcp\/([^/]+)\/disable$/, async (_request, params) => json(await removeMcpServer(config, params[0]))],
    ["GET", /^\/api\/messaging$/, () => json(readState(config.instance).messagingBridges)],
    ["POST", /^\/api\/messaging$/, async (request) => json(await addMessagingBridge(config, await body(request)), 201)],
    ["GET", /^\/api\/messaging\/messages$/, () => json(listMessagingMessages(config))],
    ["GET", /^\/api\/messaging\/([^/]+)\/messages$/, (_request, params) => json(listMessagingMessages(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/receive$/, async (request, params) => json(await receiveMessagingInput(config, params[0], await body(request)), 201)],
    ["POST", /^\/api\/messaging\/([^/]+)\/send$/, async (request, params) => json(await sendMessagingOutput(config, params[0], await body(request)), 201)],
    ["POST", /^\/api\/messaging\/([^/]+)\/health$/, async (_request, params) => json(await checkMessagingBridge(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/disable$/, async (_request, params) => json(await disableMessagingBridge(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/pair$/, async (_request, params) => json(await pairMessagingBridge(config, params[0]))],
    ["GET", /^\/api\/messaging\/([^/]+)\/chats$/, (_request, params) => json(listAllowedChats(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/allow$/, async (request, params) => {
      const payload = await body(request);
      const chatId = parseChatIdStrict(payload.chatId);
      return json(await allowChat(config, params[0], chatId));
    }],
    ["POST", /^\/api\/messaging\/([^/]+)\/deny$/, async (request, params) => {
      const payload = await body(request);
      const chatId = parseChatIdStrict(payload.chatId);
      return json(await denyChat(config, params[0], chatId));
    }],
    ["GET", /^\/api\/providers\/catalog$/, () => json(providerCatalog())],
    // Browser-driven onboarding endpoints. The webapp's /setup route polls
    // /api/setup/status to decide whether to render the form, and POSTs
    // /api/setup/provider to set credentials. The runtime writes
    // secrets.env (so future processes pick it up) AND updates
    // process.env.OPENAI_API_KEY so the running gateway uses the new key
    // immediately. Plist refresh for the next launchd respawn is signaled
    // back via plistRefreshNeeded — the CLI layer hooks that.
    ["GET", /^\/api\/setup\/status$/, () => json(getSetupStatus(config))],
    ["POST", /^\/api\/setup\/provider$/, async (request) => {
      const payload = await body(request);
      const result = await setSetupProvider(config, payload);
      return json(result, result.ok ? 200 : 400);
    }],
    ["GET", /^\/api\/agents$/, () => json(listAgents(config))],
    ["POST", /^\/api\/agents$/, async (request) => json(await createAgent(config, await body(request)), 201)],
    ["POST", /^\/api\/agents\/([^/]+)\/use$/, async (_request, params) => json(await useAgent(config, params[0]))],
    ["DELETE", /^\/api\/agents\/([^/]+)$/, async (_request, params) => json(await deleteAgent(config, params[0]))],
    ["GET", /^\/api\/parity\/hermes$/, () => json(hermesParityChecks(config))],
    ["GET", /^\/api\/readiness\/v1$/, () => json(v1Readiness(config))],
    ["GET", /^\/api\/relays$/, () => json(listRelays(config))],
    ["POST", /^\/api\/relays$/, async (request) => json(await configureRelay(config, await body(request)), 201)],
    ["POST", /^\/api\/relays\/([^/]+)\/health$/, async (_request, params) => json(await checkRelay(config, params[0]))],
    ["GET", /^\/api\/notifications$/, () => json(readState(config.instance).notifications)],
    ["POST", /^\/api\/notifications$/, async (request) => json(await queueNotification(config, await body(request)), 201)],
    ["POST", /^\/api\/notifications\/send$/, async () => json(await sendQueuedNotifications(config))],
    ["POST", /^\/api\/notifications\/([^/]+)\/ack$/, async (_request, params) => json(await acknowledgeNotification(config, params[0]))],
    ["GET", /^\/api\/imports$/, () => json(readState(config.instance).importReports)],
    ["POST", /^\/api\/imports\/inspect$/, async (request) => {
      const input = await body(request);
      const source = input.source === "openclaw" ? "openclaw" : "hermes";
      return json(await inspectImportSource(config, source, String(input.path ?? "")), 201);
    }]
  ];

  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
        try {
          return json(await claimPairing(config, await body(request)), 201);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      if (!await authorized(request, config)) return json({ error: "Unauthorized" }, 401);
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (request.method === method && match) {
          try {
            return await handler(request, Object.fromEntries(match.slice(1).map((value, index) => [String(index), value])));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return json({ error: message }, statusFromErrorMessage(message));
          }
        }
      }
      return json({ error: "Not found" }, 404);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return json({
        name: "gini-runtime",
        instance: config.instance,
        port: config.port,
        message: "Gini runtime API. The Next.js control plane runs on a separate port; see `gini status`.",
        ui_url_hint: process.env.GINI_WEB_URL ?? null
      });
    }
    return json({ error: "Not found" }, 404);
  };
}

// Strict parse for Telegram chat_id values on the allow/deny endpoints.
// `Number(null)` / `Number("")` / `Number(undefined)` all coerce to 0 (or
// NaN), so without this guard a malformed payload would either enroll
// chat 0 (which is the JSON sentinel allowed-everyone, NOT what the
// caller intended) or throw deep in mutateState — neither is what an
// API caller should get back. Accept only finite safe integers
// (including negatives — Telegram group chat_ids are negative).
function parseChatIdStrict(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && Number.isSafeInteger(parsed)) return parsed;
  }
  // Use the "Invalid input:" prefix so statusFromErrorMessage maps
  // this to a 400 instead of a catch-all 500. Without the prefix, a
  // malformed allow/deny payload would surface as "internal error"
  // even though the caller's input is what's broken.
  throw new Error(`Invalid input: chatId must be a finite integer (got ${JSON.stringify(raw)}).`);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  return (await request.json()) as Record<string, unknown>;
}

// Promote SOUL.md.proposed → SOUL.md for the active agent and write an
// `identity.soul.approved` audit row. Returns `{ ok: true, path }` on
// success or `{ ok: false, reason }` when no proposal exists / no
// active agent. The API surface mirrors the propose tool — the rename
// itself is atomic. See ADR runtime-identity-files.md.
async function approveSoulProposal(config: RuntimeConfig): Promise<{ ok: boolean; reason?: string; path?: string }> {
  const state = readState(config.instance);
  const agentId = state.activeAgentId;
  if (!agentId) return { ok: false, reason: "no active agent" };
  const promoted = approveSoul(config.instance, agentId);
  if (!promoted) return { ok: false, reason: "no proposal to approve" };
  const path = soulPath(config.instance, agentId);
  await mutateState(config.instance, (s) => {
    addAudit(
      s,
      {
        actor: "user",
        action: "identity.soul.approved",
        target: path,
        risk: "low",
        evidence: { agentId, path }
      },
      { agentId }
    );
  });
  return { ok: true, path };
}

// Promote USER.md.proposed → USER.md and write an audit row. Reached
// when `edit_user_profile` produced a body the injection scanner flagged
// — the auto-approve path bypasses this endpoint entirely. Returns
// `{ ok: true, path }` on success or `{ ok: false, reason }` when no
// proposal exists. See ADR memory-surface-consolidation.md.
async function approveUserProfileProposal(config: RuntimeConfig): Promise<{ ok: boolean; reason?: string; path?: string }> {
  const promoted = approveUserProfile(config.instance);
  if (!promoted) return { ok: false, reason: "no proposal to approve" };
  const path = userProfilePath(config.instance);
  await mutateState(config.instance, (s) => {
    addAudit(
      s,
      {
        actor: "user",
        action: "identity.user_profile.approved",
        target: path,
        risk: "low",
        evidence: { path, approvedFromProposal: true }
      },
      { system: true }
    );
  });
  return { ok: true, path };
}

// Identity-file inspection. Returns the bytes of INSTRUCTIONS.md,
// USER.md, and (for the active or named agent) SOUL.md with char-vs-cap
// budget metadata. No truncation — the response carries the full file
// content. The CLI `gini identity show` consumes this endpoint and
// pretty-prints; downstream UIs are free to do the same. SOUL.md
// surfaces under all agents in the instance by default (an empty
// agentId query parameter dumps each agent's SOUL.md alongside the
// shared instance-level USER.md / INSTRUCTIONS.md).
function showIdentityFiles(config: RuntimeConfig, request: Request): unknown {
  const state = readState(config.instance);
  const requestedAgent = new URL(request.url).searchParams.get("agentId") ?? undefined;
  const instructionsContent = loadInstructions(config.instance);
  const userContent = loadUserProfile(config.instance);
  const userBudget = userContent && !userContent.startsWith("[BLOCKED:")
    ? identityBudgetState(userContent, USER_SOFT_CAP_CHARS)
    : null;
  const targetAgents = requestedAgent
    ? state.agents.filter((a) => a.id === requestedAgent || a.name === requestedAgent)
    : state.agents;
  const soulEntries = targetAgents.map((agent) => {
    const content = loadSoul(config.instance, agent.id);
    const budget = content && !content.startsWith("[BLOCKED:")
      ? identityBudgetState(content, SOUL_SOFT_CAP_CHARS)
      : null;
    return {
      agentId: agent.id,
      agentName: agent.name,
      path: soulPath(config.instance, agent.id),
      content,
      budget
    };
  });
  return {
    instance: config.instance,
    instructions: {
      path: instructionsPath(config.instance),
      content: instructionsContent
    },
    userProfile: {
      path: userProfilePath(config.instance),
      content: userContent,
      budget: userBudget,
      cap: USER_SOFT_CAP_CHARS
    },
    souls: soulEntries,
    soulCap: SOUL_SOFT_CAP_CHARS
  };
}

// List history snapshots for USER.md or a per-agent SOUL.md. Query
// params: kind=user|soul, agentId=<id> (required when kind=soul).
// Returns the snapshot entries newest-first; each carries the filename
// (which the rollback endpoint accepts), the absolute path, mtime, and
// size.
function showIdentityHistory(config: RuntimeConfig, request: Request): unknown {
  const url = new URL(request.url);
  const kind = (url.searchParams.get("kind") ?? "").toLowerCase();
  const agentId = url.searchParams.get("agentId") ?? undefined;
  if (kind === "user") {
    return {
      kind: "user",
      dir: userProfileHistoryDir(config.instance),
      entries: listUserProfileHistory(config.instance)
    };
  }
  if (kind === "soul") {
    if (!agentId) return { error: "agentId required when kind=soul" };
    return {
      kind: "soul",
      agentId,
      dir: soulHistoryDir(config.instance, agentId),
      entries: listSoulHistory(config.instance, agentId)
    };
  }
  return { error: "kind must be one of: user, soul" };
}

// Restore an identity file from a named history snapshot. Payload:
// { kind: "user" | "soul", snapshot: "<name>", agentId?: "<id>" }.
// Emits an `identity.<file>.rollback` audit row with the source
// snapshot and the pre-rollback snapshot path (so the rollback is
// itself recoverable). Returns 404 when the snapshot doesn't exist.
async function rollbackIdentityFile(
  config: RuntimeConfig,
  request: Request
): Promise<unknown> {
  const payload = (await body(request)) as { kind?: unknown; snapshot?: unknown; agentId?: unknown };
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const snapshot = typeof payload.snapshot === "string" ? payload.snapshot : "";
  if (!snapshot) return { ok: false, reason: "snapshot required" };
  if (kind === "user") {
    const result = restoreUserProfileFromHistory(config.instance, snapshot);
    if (!result.ok) return { ok: false, reason: result.reason };
    await mutateState(config.instance, (s) => {
      addAudit(
        s,
        {
          actor: "user",
          action: "identity.user_profile.rollback",
          target: userProfilePath(config.instance),
          risk: "low",
          evidence: {
            snapshot,
            fromPath: result.from,
            restoredBytes: result.restoredBytes,
            preRestoreSnapshot: result.preRestoreSnapshot
          }
        },
        { system: true }
      );
    });
    return {
      ok: true,
      kind: "user",
      restoredBytes: result.restoredBytes,
      fromPath: result.from,
      preRestoreSnapshot: result.preRestoreSnapshot,
      activePath: userProfilePath(config.instance)
    };
  }
  if (kind === "soul") {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
    if (!agentId) return { ok: false, reason: "agentId required when kind=soul" };
    const result = restoreSoulFromHistory(config.instance, agentId, snapshot);
    if (!result.ok) return { ok: false, reason: result.reason };
    await mutateState(config.instance, (s) => {
      addAudit(
        s,
        {
          actor: "user",
          action: "identity.soul.rollback",
          target: soulPath(config.instance, agentId),
          risk: "low",
          evidence: {
            agentId,
            snapshot,
            fromPath: result.from,
            restoredBytes: result.restoredBytes,
            preRestoreSnapshot: result.preRestoreSnapshot
          }
        },
        { agentId }
      );
    });
    return {
      ok: true,
      kind: "soul",
      agentId,
      restoredBytes: result.restoredBytes,
      fromPath: result.from,
      preRestoreSnapshot: result.preRestoreSnapshot,
      activePath: soulPath(config.instance, agentId)
    };
  }
  return { ok: false, reason: "kind must be one of: user, soul" };
}

async function authorized(request: Request, config: RuntimeConfig): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const queryToken = new URL(request.url).searchParams.get("token");
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
  return authorizedBearer(config, bearer ?? undefined);
}

function json(value: unknown, statusCode = 200): Response {
  return Response.json(value, { status: statusCode });
}

// Parse the `?agentId=` filter shared by GET endpoints that return per-agent
// record types. Returns undefined for absent or empty values so the caller
// preserves the legacy "no filter" semantics.
function agentIdFilter(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("agentId");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Maps a thrown Error.message to an HTTP status code. Job-layer code throws
// typed errors with stable prefixes ("Job not found:", "Job run not found:",
// "Invalid input: ...") so the gateway can return 404/400 instead of the
// previous catch-all 500. Anything else stays 500.
function statusFromErrorMessage(message: string): number {
  if (message.startsWith("Job not found") || message.startsWith("Job run not found")) return 404;
  if (message.startsWith("Agent not found")) return 404;
  if (message.startsWith("Invalid input")) return 400;
  // Agent delete guards (default agent, active agent) throw user-input
  // errors that should surface as 400.
  if (message.startsWith("Cannot delete")) return 400;
  // Hindsight memory routes (/memory/retain, /memory/recall,
  // /memory/reflect) and identity-file edit tools throw this when no
  // agent is active. Map to 400 so callers see a clean user-input error
  // rather than a 500.
  if (message.includes("no active agent")) return 400;
  // Browser-connect surfaces user-input failures with these prefixes;
  // forward them to 400 so the webapp can surface the original error text
  // rather than a generic "internal error". Connectivity failures
  // (unreachable CDP) and discovery failures (no Chrome on PATH) are also
  // user-correctable, not internal errors.
  if (message.startsWith("Invalid cdpUrl")) return 400;
  if (message.startsWith("Unsupported cdpUrl protocol")) return 400;
  if (message.startsWith("Invalid port")) return 400;
  if (message.startsWith("Could not reach CDP endpoint")) return 400;
  if (message.startsWith("Could not locate")) return 400;
  if (message.startsWith("Web update is only available")) return 400;
  // Messaging-bridge surface throws plain Error strings rather than the
  // "Invalid input:" prefix the rest of the codebase uses. Map the
  // expected user-error shapes to 400 / 404 so the HTTP layer doesn't
  // collapse them to a misleading 500.
  if (message.startsWith("Messaging bridge not found")) return 404;
  if (message.startsWith("Messaging bridge is not configured")) return 400;
  if (message.startsWith("Messaging bridge name is required")) return 400;
  if (/^(Telegram|Discord) bridges require a botToken/.test(message)) return 400;
  if (/^(Telegram|Discord) bot token contains invalid characters/.test(message)) return 400;
  if (message.startsWith("Inbound message text or media is required")) return 400;
  if (message.startsWith("Telegram inbound target must be")) return 400;
  if (message.startsWith("Discord inbound target")) return 400;
  if (message.startsWith("Outbound message requires")) return 400;
  if (message.startsWith("Pairing codes only apply")) return 400;
  if (message.startsWith("Chat allowlist only applies")) return 400;
  if (message.startsWith("chatId must be")) return 400;
  if (/^Target '.+' not permitted by active agent/.test(message)) return 400;
  return 500;
}

function eventStream(config: RuntimeConfig, request: Request): Response {
  let closed = false;
  let interval: Timer | undefined;
  const encoder = new TextEncoder();
  // Last-Event-ID is the SSE-native dedup signal. The browser-side EventSource
  // attaches it automatically on reconnect; honoring it here means a flapping
  // connection doesn't re-deliver the entire historical event log every time.
  // Query-string fallback covers proxies/clients that drop the header.
  const lastEventId =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("lastEventId") ??
    undefined;
  let lastFlushAt = Date.now();
  const stream = new ReadableStream({
    start(controller) {
      const seen = new Set<string>();
      // Pre-seed `seen` with events up to and including the last delivered id
      // so the first send() after reconnection only emits genuinely new events.
      // The events list is append-only by id; we walk it in order (oldest-first,
      // same direction as `send` below) to find the cutoff.
      //
      // CRITICAL: only pre-seed if the cutoff id is actually present in the
      // retained buffer. The buffer is capped at 1000 events; if the client's
      // Last-Event-ID is older than that (long disconnect or bursty event
      // generation), naively seeding everything would silently drop the entire
      // retained window. When the cutoff isn't found, behave as if no
      // Last-Event-ID was supplied — send everything currently retained.
      if (lastEventId) {
        const ordered = readState(config.instance).events.slice().reverse();
        const cutoff = ordered.findIndex((event) => event.id === lastEventId);
        if (cutoff >= 0) {
          for (let index = 0; index <= cutoff; index += 1) {
            seen.add(ordered[index]!.id);
          }
        }
        // cutoff < 0: id rolled out of the ring buffer; leave `seen` empty so
        // the client receives the full retained window (best effort recovery).
      }
      const send = () => {
        if (closed) return;
        let wrote = false;
        const events = readState(config.instance).events.slice().reverse();
        for (const event of events) {
          if (seen.has(event.id)) continue;
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
          seen.add(event.id);
          wrote = true;
        }
        // Keepalive comment when nothing real has flowed for a while.
        // Bun.serve defaults to a 10s idleTimeout and proxies (Next.js dev,
        // CDNs, etc.) often cap idle streams around 30-60s. A comment line
        // (`: ...`) is ignored by the EventSource API but resets the
        // idle-byte clock at every hop, so the connection survives quiet
        // periods. Without this the client reconnects every ~10s and the
        // runtime re-replays the event window each time.
        if (!wrote && Date.now() - lastFlushAt >= 5_000) {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
          wrote = true;
        }
        if (wrote) lastFlushAt = Date.now();
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

export function writePid(config: RuntimeConfig): void {
  writeFileSync(pidPath(config.instance), String(process.pid));
}
