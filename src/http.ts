import { writeFileSync } from "node:fs";
import type { ApprovalMode, ChatBlock, RuntimeConfig } from "./types";
import { cancelTask, decideApproval, resolveApproval, retryTask, submitTask } from "./agent";
import { pidPath } from "./paths";
import {
  addAudit,
  addSseSubscription,
  appendTrace,
  getDevice,
  listChatBlocks,
  listChatBlocksAfter,
  markRead,
  mutateState,
  readState,
  readTrace,
  removeDeviceForCredential,
  subscribeChatBlocks,
  unreadCountForDevice,
  upsertDevice
} from "./state";
import { browserNavigate, safetyCheck } from "./tools/browser";
import { runFillSecretConnect } from "./execution/browser-fill-secrets";
import { mobileBootstrap, publicState } from "./runtime/views";
import { checkConnector, createConnector, deleteConnector, updateConnector } from "./integrations/connectors";
import { listProviders } from "./integrations/connectors/registry";
import { runConnectorDetection } from "./jobs/connector-detection";
import { createScheduledJob, listJobRuns, removeJob, replayJobRun, runJobNow, updateJob, updateJobStatus } from "./jobs";
import { migrateLegacyMemories, recall, reflect, retain } from "./memory";
import { embeddingStatus, reembedAllBanks, reembedBank } from "./memory/embedding";
import { rerankerStatus } from "./memory/reranker";
import { listBanks, listMemoryUnits, getBank, updateBank, ensureDefaultBank, ensureAgentBank, DEFAULT_BANK_ID, type Network } from "./state";
import { proposeImprovement, reviewImprovement } from "./governance/improvements";
import { authorizedBearer, claimPairing, createPairing, resolveCredentialFromBearer, revokePairedDevice } from "./governance/pairing";
import { proposePromotion, reviewPromotion } from "./governance/promotions";
import { status, updateAutoApproveSettings } from "./runtime";
import { searchSessions } from "./execution/search";
import { listToolsets, setToolsetStatus } from "./capabilities/toolsets";
import { cancelSubagent, listSubagents, spawnSubagent } from "./capabilities/subagents";
import { addMcpServer, checkMcpServer, invokeMcpTool, removeMcpServer } from "./integrations/mcp";
import { addMessagingBridge, allowChat, checkMessagingBridge, denyChat, disableMessagingBridge, listAllowedChats, listMessagingMessages, receiveMessagingInput, rejectPendingChat, removeMessagingBridge, sendMessagingOutput } from "./integrations/messaging";
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
import { projectRoot, webPortPath } from "./paths";
import { existsSync, readFileSync } from "node:fs";
import { tunnelManager, bootstrapUrl, renderQrSvg, renderQrAnsi } from "./runtime/tunnel";
import type { RedactedTunnelSnapshot, TunnelSnapshot } from "./runtime/tunnel/types";

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

function redactedSnapshot(snapshot: TunnelSnapshot): RedactedTunnelSnapshot {
  return {
    enabled: snapshot.enabled,
    secret: null,
    publicUrl: null,
    // The revision is a SHA-256 prefix of the secret — non-reversible and
    // safe to expose. The browser uses it as a cache-buster for the QR
    // image. A tunneled browser doesn't actually need it (the launcher is
    // hidden in tunneled contexts) but exposing it keeps the shape uniform.
    secretRevision: snapshot.secretRevision,
    // Transport indicator is non-secret — the client uses it to pick
    // between SSE and the long-poll fallback for runtime events + chat
    // streaming. Exposing it on the redacted shape lets the tunneled
    // browser see the same value the privileged endpoint exposes.
    tunnelTransport: snapshot.tunnelTransport,
    lastError: snapshot.lastError,
    appleNotes: {
      enabled: snapshot.appleNotes.enabled,
      notesAvailable: snapshot.appleNotes.notesAvailable,
      lastError: snapshot.appleNotes.lastError
    }
  };
}

function readWebPort(instance: string): number | null {
  const p = webPortPath(instance);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// `isSupervisedWebChild` lives in `./runtime/health-probe` and the
// TunnelManager runs it inside its apply chain (swapCloudflared) as
// the sole probe per enable transition. The PATCH /api/tunnel
// handler no longer runs a pre-probe of its own — that would land
// outside the apply chain and let concurrent enable/disable PATCH
// requests reorder against the queue, silently overwriting the
// later-issued operation.

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    ["GET", /^\/api\/version$/, () => json(currentVersionInfo())],
    // Tunnel surface. /api/tunnel is the privileged shape (secret + publicUrl);
    // /api/tunnel/redacted is the browser-safe shape (secret=null, publicUrl=null).
    // See docs/adr/tunnel-and-mobile-access.md "Trust radius".
    ["GET", /^\/api\/tunnel$/, () => json(tunnelManager(config).current())],
    ["GET", /^\/api\/tunnel\/redacted$/, () => json(redactedSnapshot(tunnelManager(config).current()))],
    ["PATCH", /^\/api\/tunnel$/, async (request) => {
      const payload = await body(request);
      const mgr = tunnelManager(config);
      if (typeof payload.rotateSecret === "boolean" && payload.rotateSecret) {
        const result = await mgr.rotateSecret();
        if (!result.ok) return json({ error: result.error }, 500);
      }
      if (typeof payload.enabled === "boolean") {
        if (payload.enabled) {
          const port = readWebPort(config.instance);
          if (!port) return json({ error: "Web port unknown; start `gini run` first." }, 409);
          // Health probe lives INSIDE the manager's apply chain
          // (swapCloudflared). The previous version probed here before
          // calling enable(), which created an ordering race: two
          // PATCH requests issued in close succession (enable then
          // disable) could land out of order because the enable's
          // pre-probe await happens BEFORE the manager's queue slot,
          // while disable's body parse is fast and disable enters the
          // queue first. The later-issued disable then loses to the
          // earlier-issued enable's probe-then-queue path, silently
          // re-enabling a tunnel the operator just disabled. Calling
          // mgr.enable() synchronously after body parse keeps queue
          // arrival order = request order, so the later disable
          // wins. The not-healthy 409 is preserved by detecting
          // swapCloudflared's "web port ... not healthy" sentinel
          // in the manager's error payload.
          const result = await mgr.enable(port);
          if (!result.ok) {
            const notHealthy = typeof result.error === "string" && result.error.includes("not healthy");
            return json({ error: result.error }, notHealthy ? 409 : 500);
          }
        } else {
          const result = await mgr.disable();
          if (!result.ok) return json({ error: result.error }, 500);
        }
      }
      if (payload.appleNotes && typeof payload.appleNotes === "object" && !Array.isArray(payload.appleNotes)) {
        const desired = (payload.appleNotes as { enabled?: unknown }).enabled;
        if (typeof desired === "boolean") {
          const result = await mgr.setAppleNotesEnabled(desired);
          if (!result.ok) return json({ error: result.error }, 500);
        }
      }
      return json(mgr.current());
    }],
    ["POST", /^\/api\/tunnel\/refresh-notes$/, async () => {
      const result = await tunnelManager(config).refreshNotes();
      if (!result.ok) return json({ error: result.error }, 500);
      return json(result.snapshot);
    }],
    ["GET", /^\/api\/tunnel\/qr\.svg$/, () => {
      const mgr = tunnelManager(config);
      const snap = mgr.current();
      // Rotate window: the new on-disk secret is bonded to the OLD
      // publicUrl until the recycle finishes. Handing out that mix
      // would yield a bootstrap the old tunnel immediately rejects.
      // Tell the caller to retry shortly; the rotate window is
      // bounded by the cloudflared banner timeout.
      if (mgr.isRotating() || !snap.publicUrl) {
        return new Response(JSON.stringify({ error: "tunnel_rotating", retryAfterSec: 2 }), {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "2",
            "cache-control": "no-store"
          }
        });
      }
      if (!snap.secret) {
        return new Response("Tunnel not enabled", { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const svg = renderQrSvg(bootstrapUrl(snap.publicUrl, snap.secret));
      return new Response(svg, {
        status: 200,
        headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" }
      });
    }],
    ["GET", /^\/api\/tunnel\/qr\.txt$/, () => {
      const mgr = tunnelManager(config);
      const snap = mgr.current();
      if (mgr.isRotating() || !snap.publicUrl) {
        return new Response(JSON.stringify({ error: "tunnel_rotating", retryAfterSec: 2 }), {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": "2",
            "cache-control": "no-store"
          }
        });
      }
      if (!snap.secret) {
        return new Response("Tunnel not enabled", { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const ansi = renderQrAnsi(bootstrapUrl(snap.publicUrl, snap.secret));
      return new Response(ansi, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
      });
    }],
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
    // ChatBlock protocol endpoints (ADR chat-block-protocol.md). The
    // /blocks endpoint returns the full ordered list for initial render;
    // /stream is the SSE companion clients subscribe to for live
    // updates. Both validate the session exists so a stale link returns
    // 404 rather than streaming an empty channel forever.
    ["GET", /^\/api\/chat\/([^/]+)\/blocks$/, (_request, params) => {
      const sessionId = params[0];
      const state = readState(config.instance);
      if (!state.chatSessions.some((s) => s.id === sessionId)) {
        return json({ error: `Chat session not found: ${sessionId}` }, 404);
      }
      return json(listChatBlocks(config.instance, sessionId));
    }],
    ["GET", /^\/api\/chat\/([^/]+)\/stream$/, async (request, params) => {
      // Resolve the credential before opening the SSE stream so the
      // optional X-Device-Token header can be validated. The
      // `authorized` gate above already accepted the bearer, so a
      // null here means the bearer is valid for `authorizedBearer`
      // but not for credential resolution — treat as unauthenticated
      // rather than falling through anonymously.
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      // X-Device-Token is optional — mobile clients send it after
      // they've registered their APNs token via POST /push/devices, so
      // the dispatcher can per-device suppress completion silent pushes
      // while they're watching. Web/CLI clients don't send it (they
      // have no APNs token); they simply aren't tracked in the
      // suppression registry, which is correct — no push is ever sent
      // to them anyway.
      const deviceToken = deviceTokenFromRequest(config, request, credential);
      return chatBlockStream(config, request, params[0], deviceToken);
    }],
    // Long-polling fallback for chat-block streaming — used by clients
    // talking to the gateway via a Cloudflare quick tunnel
    // (`*.trycloudflare.com`), which drops SSE at the edge. Same event-
    // emitter source as the SSE endpoint above; semantics documented on
    // the chatBlockPoll helper. We skip the device-token registration
    // here because per-device APNs suppression is keyed off live SSE
    // subscriptions; a polling client doesn't hold the socket the
    // dispatcher uses to detect "watching now", so its completion
    // pushes are not suppressed (correct, since the client is on a
    // tunnel and may not have foreground attention anyway).
    ["GET", /^\/api\/chat\/([^/]+)\/poll$/, (request, params) => {
      return chatBlockPoll(config, request, params[0]);
    }],
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
    ["POST", /^\/api\/approvals\/([^/]+)\/approve$/, async (_request, params) => {
      // browser.fill_secret cannot be resolved through the generic
      // /approve path: the side-effecting fill happens inside /connect's
      // request handler from the per-slot `secrets` body, so /approve
      // would resolve the approval with status=approved while no DOM
      // fill ever ran — the agent would then be told "fields filled"
      // (synthesized in agent.ts:runApprovedAction) over an empty form.
      // Refuse early so the only resolution path for fill_secret is
      // /connect with values.
      const approvalId = params[0];
      const approval = readState(config.instance).approvals.find((a) => a.id === approvalId);
      if (approval?.action === "browser.fill_secret") {
        return json({
          error: "browser.fill_secret approvals must be resolved via /connect with the per-slot values, not /approve."
        }, 400);
      }
      return json(await decideApproval(config, approvalId, "approve"));
    }],
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
      // The /connect endpoint is the shared substrate for any approval
      // whose user-facing card asks the user to type a value (or set
      // of named values). connector.request persists them to an
      // encrypted connector record; browser.fill_secret pipes them
      // through to playwright.fill on the agent's active page and
      // discards them when the request returns.
      if (approval.action !== "connector.request" && approval.action !== "browser.fill_secret") {
        return json({ error: `Approval ${approvalId} does not take a /connect submission (${approval.action})` }, 400);
      }
      if (approval.status !== "pending") {
        return json({ error: `Approval is already ${approval.status}` }, 410);
      }
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : {};

      if (approval.action === "browser.fill_secret") {
        // The fill_secret flow is bounded inside
        // src/execution/browser-fill-secrets.ts. The handler here is
        // a thin routing seam: parse the body's `secrets` field,
        // delegate to the module, return its {status, body} envelope
        // as the HTTP response. All of the runtime concerns — slot
        // validation, structural approved-URL check, atomic approval
        // resolution, per-slot fill with per-slot origin /
        // task-status re-checks, redacted audit row, chat-task
        // resume — live in the bounded module so they can be
        // unit-tested in isolation.
        const result = await runFillSecretConnect(config, approval, secrets);
        return json(result.body, result.status);
      }

      // connector.request path (unchanged).
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
    // Stage 1 of the browser.connect two-stage flow. The chat UI's
    // "Connect" button POSTs here on a `browser.connect` approval. We:
    //   1. Validate the approval is `browser.connect` and pending.
    //   2. Launch the per-instance managed Chrome (visible) via the
    //      same connectBrowser capability the legacy single-stage path
    //      uses. Idempotent — re-clicking Connect is a no-op.
    //   3. If the approval payload carries a `url` (the page the agent
    //      was trying to reach), navigate the visible window there so
    //      the user lands directly on the sign-in form.
    //   4. Mark the approval payload `signInStarted: true` while keeping
    //      it pending. The UI re-renders with "I've signed in" / "Cancel"
    //      buttons. Clicking "I've signed in" hits the regular /approve
    //      endpoint, and executeApprovedAction's browser.connect branch
    //      reads signInStarted to switch the browser to headless instead
    //      of re-launching.
    ["POST", /^\/api\/approvals\/([^/]+)\/open-browser$/, async (_request, params) => {
      const approvalId = params[0];
      const before = readState(config.instance);
      const approval = before.approvals.find((a) => a.id === approvalId);
      if (!approval) return json({ error: "Approval not found" }, 404);
      if (approval.action !== "browser.connect") {
        return json({ error: `Approval ${approvalId} is not a browser.connect (${approval.action})` }, 400);
      }
      if (approval.status !== "pending") {
        return json({ error: `Approval is already ${approval.status}` }, 410);
      }
      const targetUrl = typeof approval.payload.url === "string" ? approval.payload.url : "";
      if (targetUrl) {
        // Block SSRF / loopback / file:// before launching. Same guard
        // browserNavigate would apply on its first call; we surface it
        // earlier so the visible window doesn't open at all when the
        // target is unsafe.
        const blocked = safetyCheck(targetUrl);
        if (blocked) return json({ error: blocked }, 400);
      }
      // Launch visible managed Chrome. skipAudit is false here so the
      // capability writes its own browser.connect audit row; the second
      // stage (executeApprovedAction on /approve) writes a richer row
      // carrying the approval reason.
      const status = await connectBrowser(config, { mode: "managed" });
      if (!status.connected) {
        return json({ ok: false, error: "Browser failed to launch." }, 500);
      }
      // Navigate the visible Chrome to the target page so the user lands
      // on the sign-in form. browserNavigate uses the per-task session
      // which reuses the persistent context's first page (the about:blank
      // tab Chromium opened at launch). Failure to navigate is non-fatal
      // — the window is still up; the user can navigate manually.
      let openedUrl: string | undefined;
      let navigateError: string | undefined;
      if (targetUrl && approval.taskId) {
        try {
          await browserNavigate(approval.taskId, { url: targetUrl });
          openedUrl = targetUrl;
        } catch (error) {
          navigateError = error instanceof Error ? error.message : String(error);
        }
      }
      await mutateState(config.instance, (state) => {
        const item = state.approvals.find((a) => a.id === approvalId);
        if (!item) return;
        item.payload = {
          ...item.payload,
          signInStarted: true,
          openedAt: new Date().toISOString(),
          openedUrl: openedUrl ?? null,
          navigateError: navigateError ?? null
        };
        if (item.taskId) {
          appendTrace(config.instance, item.taskId, {
            type: "approval",
            message: "Browser connect: visible window opened, awaiting sign-in",
            data: { approvalId, openedUrl, navigateError }
          });
        }
      });
      const refreshed = readState(config.instance).approvals.find((a) => a.id === approvalId);
      return json({ ok: true, approval: refreshed, openedUrl: openedUrl ?? null, navigateError: navigateError ?? null });
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
    // Long-polling fallback for runtime events — used by clients hitting
    // gateway via a Cloudflare quick tunnel (`*.trycloudflare.com`), which
    // drops SSE at the edge. Same event source as the SSE endpoint;
    // semantics are documented above the eventsPoll helper.
    ["GET", /^\/api\/events\/poll$/, (request) => eventsPoll(config, request)],
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
      // `allBanks: true` enumerates every bank known to the instance
      // and reembeds each — the canonical workflow after `gini import
      // apply openclaw`, which routes Hindsight units into per-agent
      // banks (`bank_<agentId>`) that the default single-bank reembed
      // path would otherwise miss. The two flags are mutually
      // exclusive at the CLI (src/cli/commands/embedding.ts throws on
      // both); the API must mirror that contract so an HTTP caller
      // doesn't think they targeted a single bank and instead trigger
      // a full-instance reembed.
      if (payload.allBanks === true && typeof payload.bankId === "string") {
        return json(
          {
            error:
              "`allBanks` and `bankId` are mutually exclusive. Pass one or the other; passing both is rejected to match the CLI."
          },
          400
        );
      }
      if (payload.allBanks === true) {
        return json(await reembedAllBanks(config, { dryRun: payload.dryRun === true }));
      }
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
    // path. See ADR runtime-identity-files.md and ADR
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
    // Push-device registry endpoints. The mobile app POSTs its APNs
    // token here on first launch (and on rotation via
    // addPushTokenListener); DELETE prunes a token when the app
    // signs out. Both routes scope the row to the calling credential
    // — a paired device id (from the pairing claim flow) or the
    // literal "owner" for the runtime config token. The CHECK
    // constraint on the devices table pins platform to "ios" for now.
    ["POST", /^\/api\/push\/devices$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const payload = await body(request);
      const token = typeof payload.token === "string" ? payload.token.trim() : "";
      const platform = typeof payload.platform === "string" ? payload.platform.trim() : "";
      const bundleId = typeof payload.bundleId === "string" ? payload.bundleId.trim() : "";
      if (!token) return json({ error: "token is required" }, 400);
      if (platform !== "ios") return json({ error: "platform must be 'ios'" }, 400);
      if (!bundleId) return json({ error: "bundleId is required" }, 400);
      // The BFF forwards the proxy-stamped `x-gini-tunnel-vetted: 1`
      // marker on tunneled requests. We tag the resulting row with its
      // origin so rotateSecret / disable can purge every tunneled
      // registration without disturbing loopback rows.
      const origin = request.headers.get("x-gini-tunnel-vetted") === "1" ? "tunnel" : "loopback";
      const device = upsertDevice(config.instance, {
        token,
        credentialId: credential,
        platform: "ios",
        bundleId,
        origin
      });
      return json({ ok: true, device });
    }],
    ["DELETE", /^\/api\/push\/devices\/([^/]+)$/, async (request, params) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const removed = removeDeviceForCredential(config.instance, params[0], credential);
      // 404 distinguishes "token does not exist OR belongs to a
      // different credential" — we don't surface which because
      // either leaks information about other credentials' devices.
      if (!removed) return json({ error: "Device not found" }, 404);
      return json({ ok: true });
    }],
    // Chat read-state + badge endpoints. The mobile app POSTs to
    // /read every time the user lands on a chat detail so the gateway
    // can compute the cross-session badge count; GET /badge returns
    // the total unread block count for the caller's credential.
    // Credential scoping happens on every read/write so a paired
    // device can never see or mutate another credential's cursor.
    ["POST", /^\/api\/chat\/([^/]+)\/read$/, async (request, params) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      // Read state is keyed per device, not per credential — two
      // iPhones owned by the same human each track their own cursor.
      // The X-Device-Token header is mandatory here; web/CLI clients
      // don't post reads because there's no device-specific badge to
      // sync for them.
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const sessionId = params[0];
      const state = readState(config.instance);
      if (!state.chatSessions.some((s) => s.id === sessionId)) {
        return json({ error: `Chat session not found: ${sessionId}` }, 404);
      }
      const payload = await body(request);
      const lastReadBlockId =
        typeof payload.lastReadBlockId === "string" ? payload.lastReadBlockId.trim() : "";
      if (!lastReadBlockId) {
        return json({ error: "lastReadBlockId is required" }, 400);
      }
      // Validate the block belongs to this session — the cursor would
      // be meaningless otherwise, and accepting cross-session ids would
      // let a client smuggle a foreign block into another device's
      // read state.
      const blockBelongs = listChatBlocks(config.instance, sessionId).some(
        (b) => b.id === lastReadBlockId
      );
      if (!blockBelongs) {
        return json({ error: "Block does not belong to this session" }, 400);
      }
      const result = markRead(config.instance, sessionId, dev.token, lastReadBlockId);
      return json({ ok: true, readState: result });
    }],
    ["GET", /^\/api\/badge$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      // Badge totals are per-device (see /read endpoint comment).
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const unread = unreadCountForDevice(config.instance, dev.token);
      return json({ unread });
    }],
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
    ["POST", /^\/api\/messaging\/([^/]+)\/remove$/, async (_request, params) => json(await removeMessagingBridge(config, params[0]))],
    ["GET", /^\/api\/messaging\/([^/]+)\/chats$/, (_request, params) => json(listAllowedChats(config, params[0]))],
    ["POST", /^\/api\/messaging\/([^/]+)\/allow$/, async (request, params) => {
      const payload = await body(request);
      const chatId = parseChatIdStrict(payload.chatId);
      const expectedCode = typeof payload.expectedCode === "string" && payload.expectedCode.length > 0
        ? payload.expectedCode
        : undefined;
      return json(await allowChat(config, params[0], chatId, { expectedCode }));
    }],
    ["POST", /^\/api\/messaging\/([^/]+)\/deny$/, async (request, params) => {
      const payload = await body(request);
      const chatId = parseChatIdStrict(payload.chatId);
      return json(await denyChat(config, params[0], chatId));
    }],
    ["POST", /^\/api\/messaging\/([^/]+)\/reject-pending$/, async (request, params) => {
      const payload = await body(request);
      const chatId = parseChatIdStrict(payload.chatId);
      return json(await rejectPendingChat(config, params[0], chatId));
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
    // CORS preflight: short-circuit before auth so browsers can probe
    // protected endpoints. Returning a 401 on OPTIONS would prevent the
    // browser from ever sending the real bearer-carrying request.
    if (request.method === "OPTIONS" && request.headers.get("access-control-request-method")) {
      return preflightResponse(request);
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
        try {
          return withCors(request, json(await claimPairing(config, await body(request)), 201));
        } catch (error) {
          return withCors(request, json({ error: error instanceof Error ? error.message : String(error) }, 400));
        }
      }
      if (!await authorized(request, config)) return withCors(request, json({ error: "Unauthorized" }, 401));
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (request.method === method && match) {
          try {
            return withCors(request, await handler(request, Object.fromEntries(match.slice(1).map((value, index) => [String(index), value]))));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return withCors(request, json({ error: message }, statusFromErrorMessage(message)));
          }
        }
      }
      return withCors(request, json({ error: "Not found" }, 404));
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return withCors(request, json({
        name: "gini-runtime",
        instance: config.instance,
        port: config.port,
        message: "Gini runtime API. The Next.js control plane runs on a separate port; see `gini status`.",
        ui_url_hint: process.env.GINI_WEB_URL ?? null
      }));
    }
    return withCors(request, json({ error: "Not found" }, 404));
  };
}

// CORS allowlist for browser-origin clients. The mobile app's RN-Web
// target (Expo on :8090 or :8081) and the Next.js BFF dev server
// (:3045) need cross-origin access to the gateway so Playwright/MCP
// can drive the actual UI. Native iOS/Android, CLI, MCP, and the
// Next.js BFF (which calls the gateway server-side) are NOT browser
// origins and never trigger CORS preflight — they aren't affected.
//
// Allowlist-only: when the Origin header doesn't match, no CORS
// headers are added and the browser blocks the response. No wildcard
// is supported because we send Access-Control-Allow-Credentials: true
// (browsers reject `*` + credentials together).
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3045",
  "http://localhost:8081",
  "http://localhost:8090",
  "http://127.0.0.1:3045",
  "http://127.0.0.1:8081",
  "http://127.0.0.1:8090"
];

function allowedOrigins(): string[] {
  const raw = process.env.GINI_CORS_ORIGINS;
  if (raw === undefined) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function corsOriginFor(request: Request): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  return allowedOrigins().includes(origin) ? origin : undefined;
}

// Wrap any Response with the CORS allow-origin headers when the
// caller's Origin matches the allowlist. Returns the response
// untouched for non-browser callers (no Origin header) so curl/CLI
// behavior is preserved. Errors (4xx/5xx) and SSE responses are also
// CORS-stamped so the browser surfaces the real status to JS rather
// than collapsing to a network error.
function withCors(request: Request, response: Response): Response {
  const origin = corsOriginFor(request);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", "Last-Event-ID");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// Preflight short-circuits the normal route matcher: the browser
// asks "may I send a <method> with these headers?" and expects a 204
// without auth (the actual GET/POST still requires the bearer).
function preflightResponse(request: Request): Response {
  const headers = new Headers();
  const origin = corsOriginFor(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Expose-Headers", "Last-Event-ID");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Device-Token, Last-Event-ID, Accept, Cache-Control, X-Requested-With");
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
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
// proposal exists. See ADR runtime-identity-files.md.
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

// Pull the bearer off a request the same way `authorized` does so
// per-route credential lookups stay consistent with the gate above.
function bearerFromRequest(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const queryToken = new URL(request.url).searchParams.get("token");
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
  return bearer ?? undefined;
}

// Resolve and validate the optional X-Device-Token header. Returns the
// token string when present AND it belongs to the caller's credential;
// returns null when absent (web/CLI clients) or when the device row
// doesn't exist; throws nothing.
//
// Validation is mandatory: a malicious caller with a valid bearer
// could otherwise smuggle another credential's APNs token into the
// SSE registry or read-state, causing cross-account read cursors or
// silent-push suppression bypass. The devices table's `credential_id`
// column is the source of truth — the token only counts as "yours" if
// upsertDevice recorded it under your credential.
function deviceTokenFromRequest(
  config: RuntimeConfig,
  request: Request,
  credentialId: string
): string | null {
  const raw = request.headers.get("x-device-token");
  if (!raw) return null;
  const token = raw.trim();
  if (!token) return null;
  const row = getDevice(config.instance, token);
  if (!row) return null;
  if (row.credentialId !== credentialId) return null;
  return token;
}

// Variant that throws (caller catches and 403s). Used by routes where
// the device token is mandatory (read-state writes and the badge
// endpoint — both are mobile-only, no good fallback when the header
// is missing or mismatched). Returns:
//   - { ok: true, token }    when valid
//   - { ok: false, reason }  when missing, malformed, or mismatched
function requireDeviceToken(
  config: RuntimeConfig,
  request: Request,
  credentialId: string
): { ok: true; token: string } | { ok: false; reason: string; status: number } {
  const raw = request.headers.get("x-device-token");
  if (!raw || !raw.trim()) {
    return { ok: false, reason: "X-Device-Token header is required", status: 400 };
  }
  const token = raw.trim();
  const row = getDevice(config.instance, token);
  if (!row || row.credentialId !== credentialId) {
    return { ok: false, reason: "Device token is not registered to this credential", status: 403 };
  }
  return { ok: true, token };
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
  // Verification-code race surfaces from `allowChat` when the operator's UI
  // snapshot lost to the server: the code rotated (a fresher DM minted a new
  // one) or aged past its TTL between page load and click. 409 Conflict
  // signals "your view is stale, refresh and retry" — the UI can then prompt
  // a re-fetch of the pending row rather than show a generic server error.
  if (message.startsWith("Verification code")) return 409;
  if (message.startsWith("Chat allowlist only applies")) return 400;
  if (message.startsWith("chatId must be")) return 400;
  if (/^Target '.+' not permitted by active agent/.test(message)) return 400;
  return 500;
}

// Long-polling fallback constants — used by `/api/events/poll` and
// `/api/chat/:id/poll`, the JSON-over-HTTP mirrors of the SSE endpoints
// below. Cloudflare quick tunnels (`*.trycloudflare.com`) drop
// `text/event-stream` at the edge, so any tunneled client (web or
// mobile) hitting a quick-tunnel host must use these endpoints instead.
// See `src/runtime/tunnel/transport.ts` for the classifier the clients
// consult.
//
// LONG_POLL_TIMEOUT_MS = 25_000: an idle long-poll resolves with an
// empty `events` array after this. 25 s sits comfortably under the
// 30 s timeout most proxies enforce on hung requests so we don't get
// cut off mid-flight, and is long enough that an idle session doesn't
// burn through HTTP overhead on every short poll.
//
// LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS = 25: once at least one event
// has arrived, wait 25 ms before resolving so a burst (e.g. a chat
// task firing multiple chat_block updates in one tick) coalesces into
// a single response instead of N tiny ones. The coalesce delay is
// short enough to feel real-time to the user; longer would smear
// streaming-text deltas perceptibly.
const LONG_POLL_TIMEOUT_MS = 25_000;
const LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS = 25;

// Mirrors `eventStream` semantics: returns events whose id is past
// `since`, with a 25_000 ms idle timeout and a 25 ms post-first-event
// flush window. The event-source is the same ring buffer the SSE
// endpoint reads from (`readState(...).events`), polled at the same
// 1 s cadence — no event emitter to subscribe to for this surface.
// Resolves with the events accumulated since the cursor plus a fresh
// cursor (the last event's id, or `since` unchanged on idle). Returns
// `application/json` so Cloudflare's quick-tunnel proxy treats it as
// an ordinary HTTP response and doesn't strip it.
function eventsPoll(config: RuntimeConfig, request: Request): Promise<Response> {
  const since = new URL(request.url).searchParams.get("since") ?? "";
  // Promise.withResolvers lets us hand the timer + interval the same
  // resolver without wrapping a `new Promise((res) => …)` callback.
  const { promise, resolve } = Promise.withResolvers<Response>();
  let resolved = false;
  let interval: Timer | undefined;
  let timeoutTimer: Timer | undefined;
  let coalesceTimer: Timer | undefined;
  let accumulated: unknown[] = [];

  const finish = (cursor: string): void => {
    if (resolved) return;
    resolved = true;
    if (interval) clearInterval(interval);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (coalesceTimer) clearTimeout(coalesceTimer);
    resolve(Response.json({ events: accumulated, cursor }));
  };

  // Honor client cancellation. AbortSignal fires on browser navigation
  // away / fetch abort; unsubscribing immediately keeps the gateway
  // from accumulating dead timers behind clients that hung up.
  request.signal.addEventListener("abort", () => {
    // Match the empty-result shape so a cancelled poll doesn't claim
    // it received events it never delivered.
    finish(since);
  });

  // The poll resolves when EITHER (a) at least one event has been
  // accumulated AND LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS ms have
  // elapsed since the first event landed, OR (b) LONG_POLL_TIMEOUT_MS
  // ms have elapsed total. Walking the ring buffer at 1 s matches the
  // SSE endpoint's polling cadence; there's no event-emitter to
  // subscribe to for runtime events.
  const check = (): void => {
    if (resolved) return;
    const events = readState(config.instance).events.slice().reverse();
    const cutoff = since ? events.findIndex((e) => e.id === since) : -1;
    // Slice off the events past the cursor. cutoff < 0 means the cursor
    // rolled out of the 1000-entry ring (or no cursor was given), so we
    // return everything currently retained.
    const fresh = cutoff >= 0 ? events.slice(cutoff + 1) : events;
    if (fresh.length === 0) return;
    accumulated = fresh;
    if (!coalesceTimer) {
      const last = fresh[fresh.length - 1];
      const cursor = last && typeof last === "object" && "id" in last && typeof last.id === "string"
        ? last.id
        : since;
      coalesceTimer = setTimeout(() => finish(cursor), LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS);
    }
  };

  check();
  if (!resolved) {
    interval = setInterval(check, 1_000);
    timeoutTimer = setTimeout(() => finish(since), LONG_POLL_TIMEOUT_MS);
  }
  return promise;
}

// Mirrors `chatBlockStream` semantics over long-polling. The
// subscription source is `subscribeChatBlocks` (the same event-emitter
// the SSE path uses), which fires AFTER the SQLite commit so we
// observe durable rows. Cursor is the SSE wire id (`<block_id>:<ts>`)
// the client received last; if the client has never connected we fall
// back to the full block list via `listChatBlocksAfter(null)`.
function chatBlockPoll(config: RuntimeConfig, request: Request, sessionId: string): Promise<Response> {
  const state = readState(config.instance);
  if (!state.chatSessions.some((s) => s.id === sessionId)) {
    return Promise.resolve(json({ error: `Chat session not found: ${sessionId}` }, 404));
  }
  const since = new URL(request.url).searchParams.get("since") ?? "";
  const { promise, resolve } = Promise.withResolvers<Response>();
  let resolved = false;
  let unsubscribe: (() => void) | undefined;
  let timeoutTimer: Timer | undefined;
  let coalesceTimer: Timer | undefined;
  const accumulated: ChatBlock[] = [];

  // The cursor we return is `<block_id>:<ts>` (matching the SSE id
  // line) of the last block in the response so the next poll resumes
  // from the exact same point. listChatBlocksAfter parses the suffix
  // to detect in-place upserts on the cursor row.
  const wireId = (block: ChatBlock): string => {
    const ts =
      block.kind === "assistant_text" || block.kind === "tool_call"
        ? block.updatedAt
        : block.createdAt;
    return `${block.id}:${ts}`;
  };

  const finish = (cursor: string): void => {
    if (resolved) return;
    resolved = true;
    if (unsubscribe) unsubscribe();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (coalesceTimer) clearTimeout(coalesceTimer);
    resolve(Response.json({ events: accumulated, cursor }));
  };

  request.signal.addEventListener("abort", () => {
    finish(since);
  });

  // Initial backfill — same as the SSE path's start() handler. If the
  // cursor is fresh enough to be present in chat_blocks, replay only
  // missing rows; otherwise replay everything (the gateway caps
  // listChatBlocksAfter's fallback behavior).
  const backfill = listChatBlocksAfter(config.instance, sessionId, since || null);
  for (const block of backfill) {
    accumulated.push(block);
  }
  if (accumulated.length > 0) {
    // Read the latest entry INSIDE the timer callback rather than
    // freezing the backfill's last block in this closure. If a newer
    // block lands on the live subscription within the 25 ms coalesce
    // window, it pushes onto `accumulated`; the cursor we return must
    // reflect THAT block, not the backfill's. Otherwise the client's
    // next poll resumes from the backfill cursor and re-receives the
    // newer block on top of the one it just got.
    coalesceTimer = setTimeout(() => {
      const last = accumulated[accumulated.length - 1]!;
      finish(wireId(last));
    }, LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS);
  }

  // Live subscription for blocks that land after the backfill snapshot.
  // The dedup gate stays loose: assistant_text streaming deltas reuse
  // the same block id with growing payloads, so id-dedup would drop
  // intermediate frames. Instead we accept every emitted block; the
  // client upserts by id and the last seen `<id>:<ts>` is what we
  // return as the cursor.
  unsubscribe = subscribeChatBlocks(config.instance, sessionId, (block) => {
    if (resolved) return;
    accumulated.push(block);
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(() => {
        const last = accumulated[accumulated.length - 1]!;
        finish(wireId(last));
      }, LONG_POLL_FLUSH_AFTER_FIRST_EVENT_MS);
    }
  });

  if (!resolved) {
    timeoutTimer = setTimeout(() => finish(since), LONG_POLL_TIMEOUT_MS);
  }
  return promise;
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

// ChatBlock SSE stream. Per ADR chat-block-protocol.md, each frame is
// `id: <block_id>:<ts>\nevent: chat_block\ndata: <json>\n\n` where `ts`
// is the row's `updated_at` snapshot at emit time (or `created_at` for
// insert-only kinds; they're equal at insert). The browser/EventSource
// client auto-attaches the composite string as `Last-Event-ID` on
// reconnect, and `listChatBlocksAfter` in src/state/chat-blocks.ts
// parses the `:<ts>` suffix to detect in-place updates that happened on
// the cursor row itself (e.g. an `assistant_text` streaming:false flip
// or a `tool_call` status flip) since the client last saw it — without
// requiring a per-row version bump or a separate ack channel.
//
// Differs from `eventStream` above: that route polls the global ring
// buffer at 1s. Here we use the in-process EventEmitter wired into
// insertChatBlock / upsertAssistantTextBlock / updateToolCallBlock —
// inserts and upserts both fire AFTER the SQLite commit so subscribers
// observe durable rows.
function chatBlockStream(
  config: RuntimeConfig,
  request: Request,
  sessionId: string,
  deviceToken: string | null
): Response {
  let closed = false;
  let keepalive: Timer | undefined;
  let unsubscribe: (() => void) | undefined;
  let unregisterSubscription: (() => void) | undefined;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const lastEventId =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("lastEventId") ??
    null;

  // Validate the session exists. We do this inside the stream factory
  // (rather than at the route handler) so the 404 carries the SSE
  // content-type semantics for clients that route both error and
  // success branches through the same EventSource handler.
  const state = readState(config.instance);
  if (!state.chatSessions.some((s) => s.id === sessionId)) {
    return new Response(JSON.stringify({ error: `Chat session not found: ${sessionId}` }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      // Record this subscription on the active-watch registry so the
      // APNs dispatcher can skip terminal-phase silent pushes for the
      // device currently watching this session. Registered inside
      // `start` (rather than at the route handler) so it always pairs
      // with `cancel` — if the response is created but never consumed
      // (rare, but possible on certain client disconnects), the
      // registry doesn't pick up a phantom entry.
      //
      // Web/CLI clients (no X-Device-Token) skip registration: there's
      // no APNs device behind them, so per-device suppression doesn't
      // apply. Registering under a credential key would also incorrectly
      // suppress pushes to a foregrounded mobile device sharing the
      // same credential.
      if (deviceToken) {
        unregisterSubscription = addSseSubscription(config.instance, deviceToken, sessionId);
      }
      // Two enqueue paths:
      //   - `enqueueBackfill` dedupes by block id so an initial replay
      //     doesn't double-send a row that we already sent (relevant
      //     on reconnect when Last-Event-ID is honored). The seen set
      //     is consulted ONLY here.
      //   - `enqueueLive` never dedupes. Upsert-capable kinds
      //     (`assistant_text` streaming deltas, `tool_call` status
      //     flips) fire the same block id repeatedly with updated
      //     payloads; clients merge by id, so the wire MUST carry
      //     every frame. Skipping by id here was the previous bug —
      //     terminal `streaming: false` flips never reached the
      //     client.
      const enqueueFrame = (block: ChatBlock): void => {
        // Event id is `<block_id>:<ts>` where `ts` is the row's
        // updated_at when the block kind exposes one (assistant_text,
        // tool_call) and createdAt otherwise — these two fields hold
        // the same ISO string for insert-only kinds, so the wire format
        // is uniform across kinds. The mobile client stores this string
        // verbatim and replays it via Last-Event-ID; the gateway parses
        // the suffix in listChatBlocksAfter to detect in-place updates
        // that happened on the cursor row itself (e.g. an assistant_text
        // streaming:false flip) since the client last saw it.
        const ts =
          block.kind === "assistant_text" || block.kind === "tool_call"
            ? block.updatedAt
            : block.createdAt;
        controller.enqueue(
          encoder.encode(
            `id: ${block.id}:${ts}\nevent: chat_block\ndata: ${JSON.stringify(block)}\n\n`
          )
        );
      };
      const enqueueBackfill = (block: ChatBlock): void => {
        if (closed) return;
        if (seen.has(block.id)) return;
        seen.add(block.id);
        enqueueFrame(block);
      };
      const enqueueLive = (block: ChatBlock): void => {
        if (closed) return;
        // Mark live-delivered blocks so a hypothetical mid-stream
        // backfill (we don't issue one today, but the wiring is
        // defensive) doesn't re-send the same row in addition.
        seen.add(block.id);
        enqueueFrame(block);
      };

      // Initial backfill: send any blocks the client is missing.
      // listChatBlocksAfter honors Last-Event-ID (or falls back to the
      // full list when the cursor is unknown / absent).
      const backfill = listChatBlocksAfter(config.instance, sessionId, lastEventId);
      for (const block of backfill) enqueueBackfill(block);

      // Subscribe to future inserts/upserts. Listeners fire AFTER the
      // SQLite commit so observers see durable rows. Live events
      // skip the dedup gate by design — see comment above.
      unsubscribe = subscribeChatBlocks(config.instance, sessionId, (block) => {
        enqueueLive(block);
      });

      // Idle keepalive (mirrors eventStream above). Proxies often cap
      // idle streams around 30-60s; a comment line resets the idle-byte
      // clock at every hop without surfacing as an event.
      keepalive = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: keepalive\n\n`));
      }, 5_000);
    },
    cancel() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      if (unsubscribe) unsubscribe();
      // Drop the active-watch entry. The cleanup helper is idempotent
      // so a duplicate call from an error path is a no-op.
      if (unregisterSubscription) unregisterSubscription();
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
