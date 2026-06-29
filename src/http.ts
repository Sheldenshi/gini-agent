import { writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { ApprovalMode, ChatBlock, RuntimeConfig, SkillRecord } from "./types";
import { cancelTask, decideApproval, findTask, resolveSetupRequest, retryTask, submitTask } from "./agent";
import { pidPath } from "./paths";
import {
  addAudit,
  addSseSubscription,
  addPushlessSubscription,
  clearDeviceWatch,
  clearSessionWatch,
  clearStreamWatch,
  appendTrace,
  assertInsideWorkspace,
  createSetupRequest,
  getDevice,
  latestAssistantTextForSession,
  latestAssistantTextForThread,
  listChatBlocks,
  listChatBlocksAfter,
  listThreadBlocks,
  summarizeThreads,
  summarizeThreadsForInstance,
  markRead,
  markUnread,
  mutateState,
  now,
  PairingCapExceededError,
  readState,
  SESSION_COOKIE_MAX_AGE_MS,
  unreadCountsByDevice,
  readTrace,
  readUpload,
  removeDeviceForCredential,
  storeUpload,
  subscribeChatBlocks,
  subscribeChatSession,
  unreadCountForDevice,
  uploadStat,
  isPlausibleMime,
  upsertDevice
} from "./state";
import { browserNavigate, getScreencastPort, peekCurrentBrowserTargetId, peekCurrentBrowserUrl, safetyCheck } from "./tools/browser";
import {
  getOrStartBridge,
  hasLiveBridgeForOwner,
  stopActiveBridge,
  type ScreencastBridge,
  type ScreencastInput
} from "./execution/browser-screencast";
import { runFillSecretConnect } from "./execution/browser-fill-secrets";
import { runMessagingBridgeConnect } from "./execution/messaging-bridge-connect";
import { runMessagingPairingConnect } from "./execution/messaging-pairing-connect";
import { runMessagingRemoveConnect } from "./execution/messaging-remove-connect";
import { buildNotificationPreview, type PreviewEvent } from "./integrations/apns/preview";
import { dailyUsage, mobileBootstrap, publicState } from "./runtime/views";
import { checkConnector, createConnector, credentialTemplateForProvider, deleteConnector, firstUngrantedCredential, isSkillActive, updateConnector } from "./integrations/connectors";
import { gwsSessionStatus } from "./integrations/connectors/gws-session";
import { listAccountsWithStatus, registerAccount, removeAccount, retagAccount } from "./integrations/connectors/google-accounts";
import { getGoogleAccount, googleAccountsRoot } from "./state/google-accounts";
import { listProviders } from "./integrations/connectors/registry";
import { runConnectorDetection } from "./jobs/connector-detection";
import { createScheduledJob, listJobRuns, removeJob, replayJobRun, runJobNow, updateJob, updateJobStatus } from "./jobs";
import { addEmailWatcher, clearEmailWatcherObjective, getEmailWatcher, listEmailWatchers, removeEmailWatcher, setEmailTriageEnabled, setEmailWatcherEnabled, setEmailWatcherObjective } from "./state/email-watchers";
import { resolveDraftSendConfigDir, sendGmailDraft } from "./integrations/connectors/gmail-draft-send";
import { migrateLegacyMemories, recall, reflect, retain } from "./memory";
import { embeddingStatus, reembedAllBanks, reembedBank } from "./memory/embedding";
import { rerankerStatus } from "./memory/reranker";
import { listBanks, listMemoryUnits, getBank, updateBank, ensureDefaultBank, ensureAgentBank, DEFAULT_BANK_ID, type Network } from "./state";
import { proposeImprovement, reviewImprovement } from "./governance/improvements";
import { runDailyReview } from "./learning/daily-review";
import { computeSkillScores } from "./learning/score";
import {
  approvePairing,
  authorizedBearer,
  cancelPairing,
  claimPairing,
  claimPairingSession,
  createPairing,
  listPairingRequests,
  pollPairingStatus,
  rejectPairing,
  requestPairing,
  resolveCredentialFromBearer,
  resolveSessionFromCookie,
  revokePairedDevice,
  touchPairedSession
} from "./governance/pairing";
import { proposePromotion, reviewPromotion } from "./governance/promotions";
import { status, updateAutoApproveSettings } from "./runtime";
import { searchSessions } from "./execution/search";
import { listToolsets, setToolsetStatus } from "./capabilities/toolsets";
import { cancelSubagent, listSubagents, spawnSubagent } from "./capabilities/subagents";
import { addMcpServer, checkMcpServer, invokeMcpTool, removeMcpServer } from "./integrations/mcp";
import { addMessagingBridge, allowChat, checkMessagingBridge, denyChat, disableMessagingBridge, listAllowedChats, listMessagingMessages, receiveMessagingInput, rejectPendingChat, removeMessagingBridge, sendMessagingOutput } from "./integrations/messaging";
import { inspectImportSource } from "./integrations/importers";
import { providerCatalogWithStatus, withProviderAuthStatus } from "./provider";
import { buildModelCatalog } from "./model-routes";
import { setDefaultModel } from "./runtime/default-model";
import { archiveAgent, createAgent, deleteAgent, listAgents, renameAgent, setAgentProvider, unarchiveAgent, useAgent } from "./capabilities/agents";
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
import { BROWSER_CONNECT_SPAWNED_RESULT, completeBrowserConnectSetup, connectBrowser, disconnectBrowser, getBrowserConnection } from "./capabilities/browser-connect";
import { hermesParityChecks } from "./runtime/parity";
import { acknowledgeNotification, checkRelay, configureRelay, listRelays, queueNotification, sendQueuedNotifications } from "./integrations/relay";
import { cancelTunnel, connectTunnel, disconnectTunnel, getTunnel, PROVIDER_UNAVAILABLE, refreshProviderDetection, selectProvider } from "./integrations/tunnel";
import { isLoopbackHost, isRelayHost, isRuntimeTunnelHost, webBoundRequestAllowed } from "./lib/origin-trust";
import { cookieValue, serializeCookie } from "./lib/cookies";
import { RateLimiter } from "./lib/rate-limit";
import { signUploadParams, verifyUploadSignature } from "./lib/upload-signing";
import { getSetupStatus, removeSetupProvider, setSetupProvider } from "./runtime/setup-api";
import { createSkillFromInput, getSkill, grantConnectorToSkill, installSkillFromBody, listSkills, reloadSkills, rollbackSkill, searchSkills, setSkillStatus, testSkill, updateSkill, validateSkills } from "./capabilities/skills";
import { createChat, deleteChat, getChatSession, getOrCreateAgentChat, listChatSessions, removePendingChatMessageById, renameChat, submitChatMessage, submitThreadReply, syncChatTaskResult } from "./execution/chat";
import { sttStatus } from "./stt";
import { resumeChatTask } from "./execution/chat-task";
import { persistConnectOutcome, safeResume } from "./execution/safe-resume";
import { approvalToolCallId } from "./execution/tool-dispatch";
import { v1Readiness } from "./runtime/readiness";
import { getRun, listRuns } from "./execution/runs";
import { assertCurrentRuntimeUpdateSupported, currentVersionInfo, isUpdateInFlight, refreshVersionInfo, scheduleRuntimeRestart, updateRuntime } from "./runtime/update";
import { projectRoot } from "./paths";
import { readDocSection } from "./docs";
import { isLogStream, readLogTail } from "./state/logs";
import { redactLogTail } from "./runtime/log-redaction";
import { readSecretsEnvBody } from "./state/secrets-env";
import { clearWebTargetCache, resolveWebPort } from "./web-target";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import type { Server, ServerWebSocket } from "bun";

// Error codes deliberately published in error bodies (see the route-table
// catch). Everything else stays message-only.
const PUBLIC_ERROR_CODES = new Set<string>([PROVIDER_UNAVAILABLE]);

type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

// Cap on stored uploads. 50MB by default (matches signed-download's body
// cap); GINI_MAX_UPLOAD_BYTES overrides it (positive finite number) so tests
// can drive the 413 path with a tiny limit.
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
function maxUploadBytes(): number {
  const raw = Number(process.env.GINI_MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES;
}

// TTL (seconds) for a minted upload preview signature. Short by default so a
// signed url that leaks into browser history / a log is dead within minutes;
// clamped to [30s, 600s] so a caller can't request an effectively-permanent
// url. Mirrors createPairing's ttl clamping.
const DEFAULT_UPLOAD_SIGN_TTL_SECONDS = 300;
function uploadSignTtlSeconds(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_UPLOAD_SIGN_TTL_SECONDS;
  return Math.min(600, Math.max(30, Math.floor(requested)));
}

// Extensions the browser can safely render inline (PDFs + raster images) when
// GET /api/files is called with `inline=1`. Everything else — html/htm, svg,
// xml, js, and any unlisted type — is deliberately excluded so it falls
// through to the octet-stream + attachment download path and can never execute
// script in the app origin.
const INLINE_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon"
};

// Upload mimes safe to serve as a TOP-LEVEL inline document under `?inline=1`
// (the file/PDF chip opens the upload in a browser tab as a preview). PDFs +
// raster images render directly with their real type. Anything outside this
// set keeps the attachment-download default — an SVG/HTML/XML upload could run
// script in a top-level navigation, so it is never served inline.
const INLINE_UPLOAD_DIRECT = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon"
]);
// Text-like upload mimes that are safe to PREVIEW once neutralized to
// text/plain: the browser shows the raw text instead of interpreting a .md /
// .csv / .json upload as HTML or executing it. Served inline with a coerced
// content-type so a `text/html`-adjacent payload can't become a script vector.
const INLINE_UPLOAD_TEXT = new Set([
  "text/markdown",
  "text/csv",
  "text/plain",
  "application/json"
]);

// Decide how to serve an upload GET given the `?inline=` query value and the
// stored mime. Returns the content-type to serve with `content-disposition:
// inline`, or null to keep the safe attachment-download default (no inline
// param, or an unsafe/unknown mime). Exported for direct unit coverage of the
// allowlist branches.
export function resolveInlineUpload(
  inlineParam: string | null,
  mimeType: string
): { contentType: string } | null {
  if (!inlineParam) return null;
  if (INLINE_UPLOAD_DIRECT.has(mimeType)) return { contentType: mimeType };
  if (INLINE_UPLOAD_TEXT.has(mimeType)) return { contentType: "text/plain; charset=utf-8" };
  return null;
}

// Per-action audit row for connector.request completion. createConnector
// and checkConnector emit their own connector.create / connector.health
// rows, but neither carries the originating setup id — the audit trail
// would otherwise lose the link between the agent's request and the
// user's resolution. Low risk: the user is the actor and they've already
// inspected the provider before submitting credentials.
async function emitConnectorRequestAudit(
  config: RuntimeConfig,
  setup: { id: string; target: string; taskId?: string; agentId?: string; payload: Record<string, unknown> },
  connectorId: string
): Promise<void> {
  await mutateState(config.instance, (state) => {
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.request",
        target: setup.target,
        risk: "low",
        taskId: setup.taskId,
        runId: setup.taskId ? state.tasks.find((task) => task.id === setup.taskId)?.runId : undefined,
        approvalId: setup.id,
        evidence: {
          provider: String(setup.payload.provider ?? ""),
          providerLabel: typeof setup.payload.providerLabel === "string" ? setup.payload.providerLabel : null,
          // Templateless requests carry no provider id; record the credential
          // name so the audit row is still attributable. NO secret value is
          // ever recorded — the secret stays server-side (ADR browser-fill-secret.md).
          credentialName: typeof setup.payload.credentialName === "string" ? setup.payload.credentialName : null,
          connectorId
        }
      },
      setup.taskId
        ? { taskId: setup.taskId }
        : setup.agentId
          ? { agentId: setup.agentId }
          : { system: true }
    );
  });
}

export function createHandler(config: RuntimeConfig): (request: Request) => Response | Promise<Response> {
  // Ensure a spawned Chrome is live for a browser.connect sign-in, relaunching
  // it headless and navigating to the recorded target page when it isn't (a
  // gateway restart / Chrome crash drops the in-process handle while the
  // durable setup row survives). Returns null on success, or a JSON error
  // Response. The navigate runs the same SSRF / domain-policy gate as any tool
  // navigation. Shared by /open-browser (stage 1) and the frames/input recovery
  // path (a reconnect after a restart skips /open-browser). Refuses when the
  // user's own Chrome is attached over CDP (no spawned browser to screencast).
  async function ensureSpawnedBrowserForSignIn(
    setup: { id: string; taskId?: string; payload: Record<string, unknown> }
  ): Promise<Response | null> {
    // The persisted cdp record is the authoritative transport signal — check it
    // FIRST, before the spawned-screencast fast path. When the user has
    // attached their OWN Chrome over CDP, there is no spawned screencast to
    // show, and relaunch/navigate would drive their external Chrome to the
    // recorded URL (a stale Connect card racing a cdp attach). A narrow window
    // exists where a cdp record is persisted but a previously-spawned handle is
    // still live (getScreencastPort would briefly report non-null); checking cdp
    // first makes the record win deterministically rather than screencasting a
    // soon-to-be-torn-down spawned Chrome. The dispatch guard stops NEW cards on
    // cdp; this covers an already-minted card hitting /open-browser or a stamped
    // card's frames/input reconnect.
    if ((readState(config.instance).browser?.mode ?? null) === "cdp") {
      return json(
        { error: "Your own Chrome is attached over CDP, so there's no in-chat browser to open. Complete this step directly in your Chrome window, then continue." },
        409
      );
    }
    if (getScreencastPort() !== null) return null;
    const targetUrl = typeof setup.payload.url === "string" ? setup.payload.url : "";
    if (!targetUrl) {
      return json({ error: "The agent's browser isn't running and no page URL is recorded; cannot start sign-in." }, 409);
    }
    const navResult = JSON.parse(await browserNavigate(setup.taskId ?? `browser-connect-${setup.id}`, { url: targetUrl }, config)) as {
      success?: boolean;
      error?: string;
    };
    if (!navResult.success || getScreencastPort() === null) {
      return json({ error: navResult.error ?? "Could not start the agent's browser for sign-in." }, 409);
    }
    return null;
  }

  // Resolve the live screencast bridge for an active browser.connect setup,
  // relaunching the headless spawned Chrome first when it isn't running. Both
  // the frames SSE and the input relay call this: an already-stamped sign-in
  // card (signInStarted + screencast) skips /open-browser on a reconnect and
  // hits these endpoints directly, so the relaunch recovery can't live only in
  // /open-browser — a gateway restart / Chrome crash would otherwise leave the
  // modal reconnecting into a permanent 409. Returns the bridge, or a JSON
  // error Response.
  async function resolveScreencastBridgeOrError(
    setup: { id: string; taskId?: string; payload: Record<string, unknown> }
  ): Promise<ScreencastBridge | Response> {
    // Only relaunch when there's genuinely no browser to screencast: a live (or
    // still-starting) bridge already held by this setup is reusable even if
    // getScreencastPort() momentarily reads null, so skip the relaunch and let
    // getOrStartBridge hand back the existing bridge.
    if (!hasLiveBridgeForOwner(setup.id)) {
      const relaunchError = await ensureSpawnedBrowserForSignIn(setup);
      if (relaunchError) return relaunchError;
    }
    const preferUrl = setup.taskId ? peekCurrentBrowserUrl(setup.taskId) : undefined;
    const preferTargetId = setup.taskId ? await peekCurrentBrowserTargetId(setup.taskId) : undefined;
    let bridge: ScreencastBridge;
    try {
      bridge = await getOrStartBridge(setup.id, { preferUrl, preferTargetId });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    // Re-check the setup is STILL the active sign-in after the relaunch +
    // bridge-build awaits: a /complete or /cancel can commit in that window,
    // flipping the row terminal (and a cancel's stopActiveBridge bumps the
    // generation BEFORE getOrStartBridge captured it, so the stale-start guard
    // doesn't fire). Without this re-check we'd hand back a freshly-built bridge
    // for a cancelled/completed setup — an orphaned CDP socket nothing tears
    // down. Stop it and 404 so the caller (modal) stops reconnecting.
    const current = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
    if (
      !current ||
      current.status !== "pending" ||
      current.payload.screencast !== true ||
      current.payload.signInStarted !== true
    ) {
      await stopActiveBridge(setup.id);
      return json({ error: "Screencast setup request not active" }, 404);
    }
    return bridge;
  }

  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/api\/status$/, () => json(status(config))],
    // `updateInProgress` reports the gateway's single-flight update guard.
    // The browser's UpdateGate polls it while blurred and extends its stall
    // deadline only while the gateway says work is still happening, so a
    // long build doesn't strand the user behind a released-too-early gate.
    ["GET", /^\/api\/version$/, () => json({ ...currentVersionInfo(), updateInProgress: isUpdateInFlight() })],
    ["POST", /^\/api\/update\/check$/, async () => json(await refreshVersionInfo())],
    ["POST", /^\/api\/update$/, async () => {
      assertCurrentRuntimeUpdateSupported();
      // updateRuntime runs its long steps (git fetch, installs, web build)
      // as awaited async spawns, so the gateway keeps answering /api/status
      // for the whole window. A concurrent POST while one update is in
      // flight rejects with "gini update already in progress." → 409.
      const result = await updateRuntime(projectRoot());
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
    // Drop a queued (not-yet-dispatched) message from the session's pending
    // queue (ADR chat-message-queue.md). 404 when the id isn't queued.
    ["DELETE", /^\/api\/chat\/([^/]+)\/pending\/([^/]+)$/, async (_request, params) => {
      const removed = await removePendingChatMessageById(config, params[0], params[1]);
      return removed ? json({ removed: true }) : json({ error: "Pending message not found" }, 404);
    }],
    // Resolves (or lazily creates) the single canonical chat session for an
    // agent — the one-chat-per-agent IA. Stable across calls for the same
    // agent id.
    ["GET", /^\/api\/agents\/([^/]+)\/chat$/, async (_request, params) => json(await getOrCreateAgentChat(config.instance, params[0]))],
    // File upload. Accepts multipart/form-data with a `file` part. The bytes
    // are stored on disk under ~/.gini/instances/<instance>/uploads/<id>.<ext>
    // and the response carries the upload ref the client attaches to the
    // next chat message via /messages { content, images: [{ id, ... }] }.
    ["POST", /^\/api\/uploads$/, async (request) => {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        return json({ error: "Expected multipart/form-data with a 'file' part" }, 400);
      }
      // Bound stored uploads. Reject on the declared content-length before
      // buffering the body, then re-check the decoded byte length below so a
      // missing/forged header still can't exceed the cap.
      const cap = maxUploadBytes();
      if (Number(request.headers.get("content-length") ?? 0) > cap) {
        return json({ error: "Upload too large." }, 413);
      }
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return json({ error: "Missing 'file' part" }, 400);
      // Prefer an explicit `filename` form field (mobile sends the original
      // name here because expo-file-system multipart can't set the part
      // filename) over the streamed part's name. Web doesn't send the field,
      // so it falls back to the File part's own name.
      const filenameField = form.get("filename");
      const filename =
        typeof filenameField === "string" && filenameField.length > 0
          ? filenameField
          : file instanceof File ? file.name : undefined;
      const mimeType = file.type || "application/octet-stream";
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Accept any plausible MIME — storage already handles arbitrary file
      // types (PDF, CSV, logs, code). Vision-only callers gate on image/*
      // downstream (vision_query, the image_url path in buildAttachmentContent),
      // so a non-image upload never lands in a vision call. Reject only
      // structurally invalid mimes (415) and empty bodies (400).
      if (!isPlausibleMime(mimeType)) {
        return json({ error: `Unsupported upload type: ${mimeType}` }, 415);
      }
      if (bytes.length === 0) return json({ error: "Upload is empty." }, 400);
      if (bytes.length > cap) return json({ error: "Upload too large." }, 413);
      const stored = storeUpload(config.instance, bytes, mimeType, filename);
      return json(stored, 201);
    }],
    // Mint a short-lived SIGNED preview url for an upload. Bearer-gated (it
    // rides the same authorized() gate as every route), so only an already-
    // authenticated client — e.g. the mobile app holding its device token —
    // can presign. The response carries a relative `path` (with `?inline=1`
    // already applied) plus the absolute `exp`; the client prepends its known
    // gateway origin. That signed url then authorizes a header-less GET from an
    // in-app browser until `exp`. Returns 404 for an unknown id so a signature
    // is never minted for bytes that don't exist.
    ["POST", /^\/api\/uploads\/([^/]+)\/sign$/, (request, params) => {
      const id = params[0]!;
      if (!uploadStat(config.instance, id)) return json({ error: "Upload not found" }, 404);
      const ttlSeconds = uploadSignTtlSeconds(new URL(request.url).searchParams.get("ttl"));
      const expUnixSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
      const { exp, sig } = signUploadParams(config.token, id, expUnixSeconds);
      const path = `/api/uploads/${encodeURIComponent(id)}?inline=1&exp=${exp}&sig=${sig}`;
      return json({ path, exp });
    }],
    ["HEAD", /^\/api\/uploads\/([^/]+)$/, (_request, params) => {
      const meta = uploadStat(config.instance, params[0]);
      if (!meta) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": meta.mimeType,
          "content-length": String(meta.size),
          // Advertise range support so a probing client (iOS AVPlayer issues a
          // HEAD/ranged GET before streaming) knows it can request byte ranges.
          "accept-ranges": "bytes"
        }
      });
    }],
    ["GET", /^\/api\/uploads\/([^/]+)$/, (request, params) => {
      const upload = readUpload(config.instance, params[0]);
      if (!upload) return json({ error: "Upload not found" }, 404);
      // Common headers shared by the full-body (200) and partial (206)
      // responses. `accept-ranges` tells the client ranged GETs are honored;
      // iOS AVPlayer refuses to start a remote AVURLAsset that streams audio
      // unless the server answers a `Range` request with 206 + Content-Range,
      // which is why an audio bubble's play button was inert (issue: voice
      // playback). Arbitrary MIME is accepted, so the DEFAULT is download +
      // no-sniff: a text/html or SVG upload must never execute as a top-level
      // document on the app origin. The bytes still render inline in
      // <img>/<audio> (subresource loads ignore Content-Disposition). Bare
      // `attachment` (no filename= param) avoids header injection from the
      // stored name.
      //
      // `?inline=1` opts a SAFE-allowlisted upload (PDF + raster image served
      // with its real type; .md/.csv/.json/.txt coerced to text/plain) into
      // `content-disposition: inline` so a file/PDF chip can open it as a
      // preview in a browser tab. Unsafe/unknown mimes ignore the param and
      // keep the attachment default — see resolveInlineUpload.
      const inline = resolveInlineUpload(new URL(request.url).searchParams.get("inline"), upload.mimeType);
      const commonHeaders: Record<string, string> = {
        "content-type": inline ? inline.contentType : upload.mimeType,
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": inline ? "inline" : "attachment",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes"
      };
      const total = upload.bytes.byteLength;
      const range = parseByteRange(request.headers.get("range"), total);
      if (range === "unsatisfiable") {
        // A syntactically valid range that falls outside the file: RFC 7233
        // requires 416 with a Content-Range stating the full length.
        return new Response(null, {
          status: 416,
          headers: { ...commonHeaders, "content-range": `bytes */${total}` }
        });
      }
      if (range) {
        const slice = upload.bytes.subarray(range.start, range.end + 1);
        const buffer = slice.buffer.slice(
          slice.byteOffset,
          slice.byteOffset + slice.byteLength
        ) as ArrayBuffer;
        return new Response(buffer, {
          status: 206,
          headers: {
            ...commonHeaders,
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${range.start}-${range.end}/${total}`
          }
        });
      }
      const buffer = upload.bytes.buffer.slice(
        upload.bytes.byteOffset,
        upload.bytes.byteOffset + total
      ) as ArrayBuffer;
      return new Response(buffer, {
        status: 200,
        headers: { ...commonHeaders, "content-length": String(total) }
      });
    }],
    // Read a workspace file by relative path so the web app can show the
    // contents (and absolute path) of files the agent generated in chat. The
    // path is resolved and validated inside the workspace root;
    // `assertInsideWorkspace` throws on escape, which we map to 400 rather
    // than letting it bubble to the default 500.
    ["GET", /^\/api\/files$/, (request) => {
      const path = new URL(request.url).searchParams.get("path");
      if (!path) return json({ error: "Missing 'path' query parameter" }, 400);
      let absolutePath: string;
      try {
        absolutePath = assertInsideWorkspace(config.workspaceRoot, path);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      // Raw download mode: stream the file bytes back as an attachment so the
      // web app's Download button saves the original file. Always served as
      // application/octet-stream + content-disposition: attachment so the
      // browser never renders HTML/SVG from the app origin (XSS-safe).
      if (new URL(request.url).searchParams.get("raw")) {
        try {
          const stat = statSync(absolutePath);
          if (!stat.isFile()) return json({ error: "Not a file" }, 400);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return json({ error: "File not found" }, 404);
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
        // Inline mode: for an allowlist of types the browser can safely embed
        // (PDFs + raster images), serve with the real content-type and
        // content-disposition: inline so the preview drawer can render them in
        // an <iframe>/<img>. Non-allowlisted types (html/svg/xml/js/etc.) skip
        // this branch and fall through to the attachment download below.
        const dot = basename(absolutePath).lastIndexOf(".");
        const ext = dot > 0 ? basename(absolutePath).slice(dot + 1).toLowerCase() : "";
        if (new URL(request.url).searchParams.get("inline") && INLINE_MIME[ext]) {
          return new Response(Bun.file(absolutePath), {
            headers: {
              "content-type": INLINE_MIME[ext],
              "content-disposition": "inline",
              "cache-control": "private, max-age=0"
            }
          });
        }
        // POSIX filenames may contain bytes (CR/LF, high-bit chars) that Bun
        // rejects as a header value, which would 500 the download. Emit an
        // ASCII-safe `filename` fallback plus an RFC 5987 `filename*` form
        // that carries the original bytes percent-encoded as UTF-8.
        const rawName = basename(absolutePath);
        const asciiName = rawName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
        const contentDisposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`;
        return new Response(Bun.file(absolutePath), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": contentDisposition,
            "cache-control": "private, max-age=0"
          }
        });
      }
      const MAX = 512 * 1024;
      try {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) return json({ error: "Not a file" }, 400);
        const name = basename(absolutePath);
        // Read at most MAX bytes through a file descriptor so memory stays
        // bounded no matter how large the file is on disk.
        const cap = Math.min(stat.size, MAX);
        const buffer = Buffer.alloc(cap);
        const fd = openSync(absolutePath, "r");
        let read = 0;
        try {
          while (read < cap) {
            const n = readSync(fd, buffer, read, cap - read, read);
            if (n === 0) break;
            read += n;
          }
        } finally {
          closeSync(fd);
        }
        const data = buffer.subarray(0, read);
        // A NUL byte in the leading sample is the standard text/binary
        // heuristic (matches git / `grep -I`).
        const binary = data.subarray(0, 8000).includes(0);
        if (binary) {
          return json({ path, absolutePath, name, bytes: stat.size, content: null, truncated: false, binary: true });
        }
        return json({ path, absolutePath, name, bytes: stat.size, content: data.toString("utf8"), truncated: stat.size > MAX, binary: false });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return json({ error: "File not found" }, 404);
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }],
    // Serve a doc (or a single #anchor section) from the repo docs/ tree so the
    // app can render referenced docs inline instead of linking out. The web
    // DocReference component derives `<path>?section=<slug>` from the hosted
    // docs URL. Read-only and confined under docs/; the central bearer gate
    // already covers it.
    ["GET", /^\/api\/docs\/(.+)$/, (request, params) => {
      const path = params[0];
      const section = new URL(request.url).searchParams.get("section") ?? undefined;
      try {
        return json(readDocSection(path, section));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return json({ error: "Doc not found" }, 404);
        }
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }],
    // Speech-to-text readiness. Lets clients warn before the first voice
    // message that the local whisper model still needs its one-time download.
    ["GET", /^\/api\/stt\/status$/, () => json(sttStatus())],
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
    // Thread endpoints (Phase 0c). A thread is a span of chat_blocks inside
    // the agent's single session, tagged thread_id and rooted at the
    // main-chat assistant block it branched from. All validate the session
    // exists so a stale link 404s rather than returning an empty list.
    ["GET", /^\/api\/chat\/([^/]+)\/threads$/, (_request, params) => {
      const sessionId = params[0];
      const state = readState(config.instance);
      if (!state.chatSessions.some((s) => s.id === sessionId)) {
        return json({ error: `Chat session not found: ${sessionId}` }, 404);
      }
      return json(summarizeThreads(config.instance, sessionId));
    }],
    ["GET", /^\/api\/chat\/([^/]+)\/threads\/([^/]+)\/blocks$/, (_request, params) => {
      const sessionId = params[0];
      const state = readState(config.instance);
      if (!state.chatSessions.some((s) => s.id === sessionId)) {
        return json({ error: `Chat session not found: ${sessionId}` }, 404);
      }
      return json(listThreadBlocks(config.instance, sessionId, params[1]));
    }],
    ["POST", /^\/api\/chat\/([^/]+)\/threads\/([^/]+)\/messages$/, async (request, params) => json(await submitThreadReply(config, params[0], params[1], await body(request)), 201)],
    // Cross-agent thread inbox: every thread across all canonical agent
    // chats, enriched with the owning agent's display name, newest reply
    // first. `?filter=all|unread` is accepted but never filtered server-side
    // — unread is computed client-side (web tracks read-state in
    // localStorage; server-side read-state is per-device/mobile only), so
    // the server always returns the full list and the client hides the read
    // ones for filter=unread.
    ["GET", /^\/api\/threads$/, (_request) => {
      const state = readState(config.instance);
      const agentSessions = state.chatSessions.filter((s) => s.kind === "agent");
      const sessionIds = agentSessions.map((s) => s.id);
      const agentNameById = new Map(state.agents.map((a) => [a.id, a.name]));
      const summaries = summarizeThreadsForInstance(config.instance, sessionIds)
        .map((summary) => ({
          ...summary,
          agentName: summary.agentId ? agentNameById.get(summary.agentId) ?? summary.agentId : undefined
        }))
        // threadId tiebreak keeps same-millisecond threads from swapping
        // between polls.
        .sort(
          (a, b) =>
            b.lastReplyAt.localeCompare(a.lastReplyAt) || a.threadId.localeCompare(b.threadId)
        );
      return json(summaries);
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
      // the dispatcher can per-device suppress a redundant completion push
      // to THIS device while it's watching. Web/CLI clients don't send it
      // (they have no APNs token), so they aren't in the per-device
      // registry — but the stream factory below DOES record them in the
      // pushless (per-session) registry, which lets the dispatcher
      // downgrade the user's OTHER devices' completion alert to a silent
      // badge refresh while the chat is open on the web.
      const deviceToken = deviceTokenFromRequest(config, request, credential);
      // Optional client-named stream id. When present it's woven into the
      // watch handle so POST /push/unwatch?streamId= can clear exactly
      // this stream (the screen that opened it) without disturbing a
      // sibling stream the client holds on the same session.
      const streamId = (new URL(request.url).searchParams.get("streamId") ?? "").trim() || null;
      return chatBlockStream(config, request, params[0], deviceToken, streamId);
    }],
    ["GET", /^\/api\/runs$/, () => json(listRuns(config))],
    ["GET", /^\/api\/runs\/([^/]+)$/, (_request, params) => json(getRun(config, params[0]))],
    ["GET", /^\/api\/tasks$/, (request) => {
      const agentId = agentIdFilter(request);
      const tasks = readState(config.instance).tasks;
      return json(agentId ? tasks.filter((task) => task.agentId === agentId) : tasks);
    }],
    ["GET", /^\/api\/usage$/, (request) => {
      const agentId = agentIdFilter(request);
      const days = Number(new URL(request.url).searchParams.get("days") ?? 14);
      return json(dailyUsage(config, { days: Number.isFinite(days) ? days : 14, agentId: agentId ?? undefined }));
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
    // -------------------------------------------------------------------
    // Authorization endpoints (agent-actor): the user approves or denies;
    // the runtime then performs the side-effecting action. See
    // docs/adr/authorization-vs-setup-request.md.
    ["GET", /^\/api\/authorizations$/, (request) => {
      const agentId = agentIdFilter(request);
      const rows = readState(config.instance).authorizations;
      return json(agentId ? rows.filter((a) => a.agentId === agentId) : rows);
    }],
    ["POST", /^\/api\/authorizations\/([^/]+)\/approve$/, async (_request, params) =>
      json(await decideApproval(config, params[0], "approve"))],
    ["POST", /^\/api\/authorizations\/([^/]+)\/deny$/, async (_request, params) =>
      json(await decideApproval(config, params[0], "deny"))],

    // -------------------------------------------------------------------
    // SetupRequest endpoints (user-actor): the user performs a setup step
    // and signals completion. The /complete handler owns the per-action
    // side effect (createConnector + checkConnector for connector.request;
    // playwright.fill for browser.fill_secret; addMessagingBridge /
    // allowChat / removeMessagingBridge for the messaging.* actions;
    // nothing extra for browser.connect — its side effect ran inside
    // /open-browser). The messaging.* and browser.fill_secret branches
    // delegate to bounded runtime modules in src/execution/* that own the
    // atomic resolve-then-side-effect-then-resume sequence; the connector
    // and browser.connect branches resolve inline.
    ["GET", /^\/api\/setup-requests$/, (request) => {
      const agentId = agentIdFilter(request);
      const rows = readState(config.instance).setupRequests;
      return json(agentId ? rows.filter((s) => s.agentId === agentId) : rows);
    }],
    ["POST", /^\/api\/setup-requests\/([^/]+)\/complete$/, async (request, params) => {
      const setupId = params[0];
      const state = readState(config.instance);
      const setup = state.setupRequests.find((s) => s.id === setupId);
      if (!setup) return json({ error: "Setup request not found" }, 404);
      if (setup.status !== "pending") return json({ error: `Setup request is already ${setup.status}` }, 410);
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : {};

      if (setup.action === "messaging.add_bridge") {
        // Thin delegate to the bounded module — mirrors the
        // browser.fill_secret branch's two-line shape. The lifecycle
        // (kind parsing, pre-resolve field + token-format validation,
        // atomic resolve, addMessagingBridge, chat resume with
        // failTask recovery) lives in src/execution/messaging-bridge-connect.ts
        // so it can be unit-tested in isolation and so http.ts stays
        // a routing layer per the AGENTS.md boundary rule.
        const result = await runMessagingBridgeConnect(config, setup, secrets, payload.deliveryTargets);
        return json(result.body, result.status);
      }

      if (setup.action === "messaging.approve_pairing") {
        // Approve / Reject for an inbound Telegram pairing request.
        // Delegate forwards `payload.reject` so a single endpoint
        // covers both outcomes; allowChat / rejectPendingChat live
        // inside the bounded module along with the atomic
        // resolveSetupRequest + safeResume wrapping.
        const result = await runMessagingPairingConnect(config, setup, { reject: payload.reject });
        return json(result.body, result.status);
      }

      if (setup.action === "messaging.remove_bridge") {
        // Destructive bridge teardown from chat. Same shape as
        // add_bridge — atomic resolveSetupRequest BEFORE
        // removeMessagingBridge, then safeResume back into the
        // chat-task loop with the outcome.
        const result = await runMessagingRemoveConnect(config, setup);
        return json(result.body, result.status);
      }

      if (setup.action === "browser.fill_secret") {
        // The fill_secret flow is bounded inside
        // src/execution/browser-fill-secrets.ts. The handler here is
        // a thin routing seam: parse the body's `secrets` field,
        // delegate to the module, return its {status, body} envelope
        // as the HTTP response. All of the runtime concerns — slot
        // validation, structural approved-URL check, atomic setup-request
        // resolution, per-slot fill with per-slot origin /
        // task-status re-checks, redacted audit row, chat-task
        // resume — live in the bounded module so they can be
        // unit-tested in isolation.
        const result = await runFillSecretConnect(config, setup, secrets);
        return json(result.body, result.status);
      }

      if (setup.action === "chat.choice") {
        // ask_user's single-select answer. Body is { choice: { label } } for a
        // listed option (validated against the options the dispatcher stored
        // in the TRUSTED setup payload) or { choice: { other } } for the
        // card's freeform input. Validation happens BEFORE the claim: a bad
        // body 400s and leaves the row pending so the user can pick again.
        // Skip is the /cancel endpoint, not a /complete body shape.
        const choice = payload.choice && typeof payload.choice === "object" && !Array.isArray(payload.choice)
          ? payload.choice as { label?: unknown; other?: unknown }
          : null;
        const options = Array.isArray(setup.payload.options)
          ? (setup.payload.options as Array<{ label?: unknown; description?: unknown }>)
          : [];
        let toolResult: string;
        let outcomeMessage: string;
        if (choice && typeof choice.label === "string") {
          const match = options.find((o) => o && typeof o === "object" && o.label === choice.label);
          if (!match) {
            return json({ error: `Unknown option label: ${choice.label}` }, 400);
          }
          const description = typeof match.description === "string" ? match.description : "";
          toolResult = `User selected: "${choice.label}"${description ? ` — ${description}` : ""}`;
          outcomeMessage = `You selected: ${choice.label}`;
        } else if (choice && typeof choice.other === "string" && choice.other.trim().length > 0) {
          const other = choice.other.trim();
          toolResult = `User answered: "${other}"`;
          outcomeMessage = `You answered: ${other}`;
        } else {
          return json({ error: "Body must be { choice: { label } } for a listed option or { choice: { other } } for a freeform answer." }, 400);
        }

        // Atomically claim the row, then persist the human-readable outcome
        // (so the resolved card reads truthfully after reload) and resume the
        // chat-task loop detached — same shape as connector.request's winning
        // path, minus side effects (nothing is created here).
        await resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false });
        await persistConnectOutcome(config, setupId, { ok: true, message: outcomeMessage });
        const choiceToolCallId = typeof setup.payload.toolCallId === "string" ? setup.payload.toolCallId : undefined;
        if (setup.taskId && choiceToolCallId) {
          void safeResume(config, setup.taskId, choiceToolCallId, toolResult, {
            context: "chat.choice",
            approvalId: setupId
          });
        }
        return json({ ok: true });
      }

      if (setup.action === "confirmation.request") {
        // request_confirmation's Confirm button. The body carries no fields —
        // hitting /complete IS the confirmation (Cancel is the /cancel
        // endpoint). Resume the chat-task loop with an unambiguous boolean tool
        // result {confirmed:true} so the model performs the irreversible action
        // itself. Same shape as the chat.choice winning path: atomically claim
        // the row, persist a human-readable outcome (so the resolved card reads
        // truthfully after reload), then resume detached. No side effects run
        // here — the agent does the send on resume.
        await resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false });
        await persistConnectOutcome(config, setupId, { ok: true, message: "Confirmed" });
        const confirmToolCallId = typeof setup.payload.toolCallId === "string" ? setup.payload.toolCallId : undefined;
        if (setup.taskId && confirmToolCallId) {
          void safeResume(config, setup.taskId, confirmToolCallId, JSON.stringify({ confirmed: true }), {
            context: "confirmation.request",
            approvalId: setupId
          });
        }
        return json({ ok: true });
      }

      if (setup.action === "connector.request") {
        const scopes = Array.isArray(payload.scopes) ? payload.scopes.map(String) : [];
        // Two payload shapes (see SetupRequest.target doc in types.ts):
        //   known provider → {provider, providerLabel, fields, ...}
        //   templateless    → {credentialName, credentialType:"api-key", credentialLabel, mcpUrl?}
        // The trusted shape (name, type, metadata) comes from the SETUP
        // PAYLOAD the dispatcher minted, NOT the browser-supplied body — the
        // body carries only the secret. Threading `type`/`metadata` here makes
        // a templateless request land a TYPED record; known-provider requests
        // already get typed via the module's credentialTemplate inside
        // createConnector, so we leave their type unset and let that path stand.
        // Templateless requests are api-key ONLY (oauth2 needs a provider
        // module / setup skill — see docs/adr/chat-credential-provisioning.md).
        const credentialType = setup.payload.credentialType === "api-key"
          ? setup.payload.credentialType
          : undefined;
        const providerId = String(setup.payload.provider ?? "");
        const providerLabel = typeof setup.payload.providerLabel === "string"
          ? setup.payload.providerLabel
          : providerId;
        const credentialName = typeof setup.payload.credentialName === "string"
          ? setup.payload.credentialName
          : "";
        const credentialLabel = typeof setup.payload.credentialLabel === "string"
          ? setup.payload.credentialLabel
          : credentialName;
        const isTemplateless = Boolean(credentialType) && !providerId;
        // Templateless requests carry no provider module, so use the same
        // "generic" provider key the type-driven Add Connector dialog uses; the
        // explicit `type` makes createConnector stamp a typed record regardless.
        const provider = providerId || "generic";
        // For a templateless api-key, derive metadata from the TRUSTED setup
        // payload only: an mcpUrl gets an mcp binding. The api-key name IS its
        // env var, so there is no envMap to mint and nothing is read from the
        // browser body. Known-provider requests pass no metadata so the
        // module's template fills it.
        const metadata: Record<string, unknown> | undefined =
          isTemplateless && typeof setup.payload.mcpUrl === "string" && setup.payload.mcpUrl.length > 0
            ? { mcp: { url: setup.payload.mcpUrl, headerName: "Authorization", scheme: "Bearer" } }
            : undefined;
        // Connector name: the credential name for templateless, else the
        // browser-supplied override (back-compat) falling back to the label.
        const overrideName = isTemplateless
          ? credentialName
          : typeof payload.name === "string" && payload.name.trim().length > 0
            ? payload.name.trim()
            : providerLabel;

        const skillId = typeof setup.payload.skillId === "string" ? setup.payload.skillId : "";
        const toolCallId = typeof setup.payload.toolCallId === "string" ? setup.payload.toolCallId : undefined;

        // Atomically claim THIS setup request BEFORE any observable side effect
        // (createConnector + secret write, grant, enable, audit, resume). The
        // claim transitions pending→completed inside the per-instance
        // mutateState lock and throws ApprovalRaceLostError ("already <status>")
        // when the row is no longer pending — the route's catch surfaces that
        // as an error response. A double-submit's loser, and any complete that
        // races a cancel, throws here and performs ZERO side effects: a cancel
        // that wins prevents the create AND the grant entirely. We claim with
        // resumeChatTask:false / no toolResult so the resume is staged LATER,
        // exactly once, on the winning claim. Mirrors the skill.grant_connector
        // branch below.
        await resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false });

        // Only the winner reaches here. Every post-claim path — successful
        // create + grant + enable + resume, probe failure, or an UNEXPECTED
        // throw (duplicate credential name, malformed secret, grant/enable
        // error) — must persist an outcome and resume the task exactly once.
        // Without this wrapper, a throw after the claim returns the route's
        // catch-all 500 while the row sits `completed` and the task stays
        // `waiting_approval` — stranded with no live executor. The catch below
        // mirrors the probe-failure handling: persist a failure outcome and
        // safeResume the task with a failure message so the agent can re-issue
        // request_connector.
        // Track a connector created during THIS attempt so the post-claim
        // catch can roll it back. Without this, a throw AFTER a successful
        // create + healthy probe (e.g. an audit/grant/enable failure) would
        // leave a healthy connector behind; the agent then re-requests, hits
        // the existing-healthy fast path, and skips the missing skill grant —
        // the skill stays env-denied. Only set for connectors this attempt
        // created, so the rollback never touches a pre-existing record.
        let createdConnectorId: string | undefined;
        try {
        // Create the typed record, then probe.
        const connector = await createConnector(config, {
          name: overrideName,
          provider,
          ...(isTemplateless ? { type: credentialType } : {}),
          scopes,
          secrets,
          ...(metadata ? { metadata } : {})
        });
        createdConnectorId = connector.id;
        const probed = await checkConnector(config, connector.id);
        if (probed.health !== "healthy") {
          // The secret was wrong/unreachable. The row is already claimed
          // (the race window is closed), so it cannot bounce back to pending
          // for an in-place retype — instead drop the orphaned unhealthy
          // record, persist the failure outcome so a reloaded card reads
          // truthfully, and resume the chat-task with the failure so the agent
          // can re-issue request_connector for a fresh card. Mirrors the
          // messaging.add_bridge side-effect-failure path.
          const message = probed.message ?? "Connector probe failed; please verify the credentials and retry.";
          try {
            await deleteConnector(config, connector.id);
          } catch {
            // Best-effort cleanup — a leftover unhealthy record is inert
            // (inactive skills never resolve env from it) and far less
            // harmful than failing the response over a delete throw.
          }
          await persistConnectOutcome(config, setupId, { ok: false, message });
          if (setup.taskId && toolCallId) {
            await safeResume(
              config,
              setup.taskId,
              toolCallId,
              `Could not connect ${isTemplateless ? credentialLabel : providerLabel}: ${message}. Tell the user the credential was rejected; you can call request_connector again so they can re-enter it.`,
              { context: "connector.request", approvalId: setupId }
            );
          }
          return json({ ok: false, connector: probed, message });
        }
        await emitConnectorRequestAudit(config, setup, connector.id);
        // Auto-grant to the requesting skill (LOCKED decision). When the
        // dispatcher minted this card with a `skillId`, the human entering the
        // secret for that named skill IS the consent — so completing the card
        // both creates the credential AND grants it to the skill, no second
        // consent card. The model can't forge this because it never sees the
        // secret. GUARD: only auto-grant when the named skill actually DECLARES
        // this credential in its requiredCredentials. The model supplies
        // skillId, so without this check it could grant a credential a skill
        // never declared (or target a different skill); the credential model's
        // "a skill only gets credentials it declared + the user granted" must
        // hold. When the skill does not declare the credential, the connector
        // is still created — it just isn't granted or enabled.
        if (skillId) {
          let skill: SkillRecord | undefined;
          try {
            skill = getSkill(config, skillId);
          } catch {
            // Unknown skillId — create the connector but grant nothing.
            skill = undefined;
          }
          if (skill && (skill.requiredCredentials ?? []).includes(connector.name)) {
            await grantConnectorToSkill(config, skillId, connector.name);
            // Enable ONLY when the skill is now fully satisfiable: every
            // required credential resolves to a configured + healthy connector
            // AND is granted. isSkillActive covers the resolution half (a
            // required credential with no connector row at all keeps it
            // inactive — firstUngrantedCredential alone would miss that); the
            // firstUngrantedCredential check covers the consent half. A
            // multi-credential skill stays disabled until the next missing
            // credential is requested separately.
            const granted = getSkill(config, skillId);
            const afterState = readState(config.instance);
            if (isSkillActive(afterState, granted) && !firstUngrantedCredential(afterState, granted)) {
              await setSkillStatus(config, skillId, "enabled");
            }
          }
        }

        const connectedLabel = isTemplateless ? credentialLabel : providerLabel;
        // Resume the chat-task LAST, exactly once, on the winning claim. The
        // request was already claimed above, so reuse the resume wiring
        // directly (calling resolveSetupRequest again would throw on the
        // now-completed row). A losing racer never reaches here. Route it
        // through safeResume so a throw from the chat-task loop AFTER the
        // mutations landed flips the task out of the orphan-running state
        // instead of being left dangling. Fire it DETACHED (no await): the
        // connector is already saved + granted, so the connect modal should
        // close as soon as this responds rather than hang until the resumed
        // agent run finishes streaming. safeResume owns its own failure
        // recovery (trace + failTask), so the detached run can't reject
        // unhandled.
        if (setup.taskId && toolCallId) {
          void safeResume(
            config,
            setup.taskId,
            toolCallId,
            `Connected to ${connectedLabel}. Proceed with the original request.`,
            { context: "connector.request", approvalId: setupId }
          );
        }
        return json({ ok: true, connector: probed });
        } catch (error) {
          // An unexpected throw after the claim (createConnector duplicate
          // name, malformed secret, grant/enable error). The probe-failure
          // path above already handled its own resume + return, so we only
          // reach here for errors OTHER than a clean probe failure. Persist a
          // failure outcome and resume the task so it never strands at
          // waiting_approval. Mirrors the probe-failure cleanup.
          const message = error instanceof Error ? error.message : String(error);
          // Roll back a connector created during THIS attempt. The create +
          // probe may have succeeded and a LATER step (audit, grant, enable)
          // thrown, leaving a healthy record behind. Drop it so a re-request
          // starts fresh and creates + grants cleanly instead of short-circuiting
          // on the existing-healthy fast path (which would skip the skill grant).
          // Mirrors the probe-fail orphan cleanup; best-effort so a delete throw
          // never masks the original failure.
          if (createdConnectorId) {
            try {
              await deleteConnector(config, createdConnectorId);
            } catch {
              // A leftover record is inert; failing the response over a delete
              // throw would be worse than leaving it.
            }
          }
          await persistConnectOutcome(config, setupId, { ok: false, message });
          if (setup.taskId && toolCallId) {
            await safeResume(
              config,
              setup.taskId,
              toolCallId,
              `Could not connect ${isTemplateless ? credentialLabel : providerLabel}: ${message}. Tell the user setup failed; you can call request_connector again so they can re-enter it.`,
              { context: "connector.request", approvalId: setupId }
            );
          }
          return json({ ok: false, message }, statusFromErrorMessage(message));
        }
      }

      if (setup.action === "browser.connect") {
        // Screencast path (the only sign-in path): the agent never left its
        // headless spawned Chrome — the user just signed in through the modal,
        // so cookies are already in the shared context. Tear down the screencast
        // bridge and resume the task headless with no relaunch.
        if (setup.payload.screencast === true) {
          const result = JSON.stringify({ success: true, connected: true, mode: "screencast" });
          // Mark the setup terminal BEFORE tearing the bridge down: a frames /
          // input request racing this completion would otherwise pass the
          // status==="pending" gate in the teardown gap and recreate an orphaned
          // bridge. Resolving first makes that racer 404 instead.
          await resolveSetupRequest(config, setupId, "complete", { actor: "user", toolResult: result, awaitResume: false });
          await stopActiveBridge(setupId);
          return json({ ok: true });
        }
        // Non-screencast fallback (the user finished acting directly in the
        // spawned Chrome). Claim the row terminal BEFORE writing the rich
        // `browser.connect` audit row, mirroring the screencast path above and
        // the connector/skill branches: a double-submit's loser (or a complete
        // racing a cancel) throws ApprovalRaceLostError at the claim and writes
        // ZERO side effects, so the audit row can't be duplicated. The shared
        // result constant is the claim's toolResult; completeBrowserConnectSetup
        // writes the audit row (and returns the same constant, which we already
        // staged here).
        await resolveSetupRequest(config, setupId, "complete", { actor: "user", toolResult: BROWSER_CONNECT_SPAWNED_RESULT, awaitResume: false });
        const { ok } = await completeBrowserConnectSetup(config, setup);
        return json({ ok });
      }

      if (setup.action === "skill.grant_connector") {
        // Per-(skill, credential) consent (ADR skill-connector-consent.md).
        // No secrets are entered here — the credential already lives in the
        // connector record; this card only records the user's consent for
        // the skill to use it. Append the grant, then check whether the skill
        // still has ungranted credentials. The skill is enabled (and "enabled"
        // reported) ONLY when ALL of them are granted — for a multi-credential
        // skill we mint the NEXT grant card and keep the task pending rather
        // than enabling on the first grant. This is server-driven so we never
        // claim "enabled" while credentials remain env-denied.
        const skillId = String(setup.payload.skillId ?? "");
        const credentialName = String(setup.payload.credentialName ?? "");
        const credentialLabel = typeof setup.payload.credentialLabel === "string"
          ? setup.payload.credentialLabel
          : credentialName;
        const toolCallId = typeof setup.payload.toolCallId === "string"
          ? setup.payload.toolCallId
          : undefined;

        // Atomically claim THIS setup request BEFORE any observable side
        // effect (grant write, skill enable, audit row, next-card mint,
        // resume). resolveSetupRequest transitions pending→completed inside
        // the per-instance mutateState lock and throws ApprovalRaceLostError
        // ("already <status>") if the row is no longer pending — which the
        // route's catch surfaces as an error response. The loser of a
        // double-complete, and any complete that races a cancel (the row is
        // already non-pending), throws here and performs ZERO side effects.
        // We claim with resumeChatTask:false / no toolResult so the resume is
        // staged LATER, as the final step, exactly once on the winning claim.
        // skill.grant_connector deliberately emits no Working phase on
        // complete (see SETUP_COMPLETE_EMITS_WORKING_PHASE in src/agent.ts):
        // the multi-credential flow below mints the NEXT grant card without a
        // new gate block, and the old gate block staying newest is what keeps
        // the thread truthfully waiting on the next credential.
        await resolveSetupRequest(config, setupId, "complete", { actor: "user", resumeChatTask: false });

        // Only the winner reaches here. Record the grant for the approved
        // credential by NAME, then check whether the skill still has ungranted
        // credentials. `firstUngrantedCredential` is the same predicate
        // setSkillStatusTool uses (a credential needs consent when it carries a
        // secret), so the two stay in lockstep. The skill is enabled ONLY when
        // ALL of them are granted — for a multi-credential skill we mint the
        // NEXT grant card and keep the task pending rather than enabling on the
        // first grant.
        const skill = await grantConnectorToSkill(config, skillId, credentialName);
        const nextUngranted = firstUngrantedCredential(readState(config.instance), skill);

        if (nextUngranted) {
          // More credentials to grant — mint the next grant card attached to
          // the same task + tool call, leaving the task pending (not enabled).
          // The web reconciles the new pending card from the setup-requests
          // query (refreshed by the setup SSE event). Dedupe to the same task
          // as a second safety layer — a retried mint must not double up.
          const nextLabel = nextUngranted.label;
          const reason = `Skill "${skill.name}" requests access to your ${nextLabel} credential. Granting lets its scripts use ${nextLabel}; you can revoke by disabling the skill.`;
          await mutateState(config.instance, (mutable) => {
            const dup = mutable.setupRequests.find(
              (s) =>
                s.status === "pending" &&
                s.action === "skill.grant_connector" &&
                s.taskId === setup.taskId &&
                s.payload.skillId === skillId &&
                s.payload.credentialName === nextUngranted.name
            );
            if (dup) return;
            const approval = createSetupRequest(mutable, {
              taskId: setup.taskId,
              action: "skill.grant_connector",
              target: nextLabel,
              reason,
              payload: { skillId, skillName: skill.name, credentialName: nextUngranted.name, credentialLabel: nextLabel, toolCallId }
            });
            if (setup.taskId) {
              const item = findTask(mutable, setup.taskId);
              item.approvalIds.push(approval.id);
              item.updatedAt = now();
            }
          });
          return json({ ok: true });
        }

        // All credentials granted: enable the skill, then resume the chat task
        // LAST and exactly once with the success toolResult. The request was
        // already claimed above, so we reuse resolveSetupRequest's internal
        // resume wiring (approvalToolCallId + resumeChatTask) directly rather
        // than calling resolveSetupRequest again (which would throw on the
        // now-completed row). A losing racer never reaches this enable/resume.
        await setSkillStatus(config, skillId, "enabled");
        if (setup.taskId) {
          const resumeToolCallId = approvalToolCallId(setup.payload);
          if (resumeToolCallId) {
            await resumeChatTask(
              config,
              setup.taskId,
              resumeToolCallId,
              `Granted ${credentialLabel} to skill "${skill.name}"; skill enabled.`
            );
          }
        }
        return json({ ok: true });
      }

      return json({ error: `Setup request ${setupId} action not supported: ${setup.action}` }, 400);
    }],
    ["POST", /^\/api\/setup-requests\/([^/]+)\/cancel$/, async (_request, params) => {
      // If this cancels an active sign-in screencast, tear the bridge down so
      // the raw-CDP socket to the headless Chrome doesn't dangle. The agent's
      // browser itself stays up (the bridge is only the screencast channel).
      // Resolve (mark terminal) BEFORE stopping the bridge so a racing
      // frames/input request fails the status==="pending" gate instead of
      // recreating an orphaned bridge in the teardown gap.
      const cancelResult = await resolveSetupRequest(config, params[0], "cancel", { actor: "user", awaitResume: false });
      // Stop the bridge unconditionally for the cancelled setup id rather than
      // gating on a pre-claim screencast read: payload.screencast can flip true
      // (via /open-browser) in the window between reading and the atomic claim,
      // so a stale read could skip a teardown that's actually needed.
      // stopActiveBridge(owner) is owner-scoped — a no-op when nothing or a
      // DIFFERENT setup holds the bridge — so calling it always is safe.
      await stopActiveBridge(params[0]);
      return json(cancelResult);
    }],
    // Stage 1 of the browser.connect two-stage flow. The chat UI's
    // "Connect" button POSTs here on a browser.connect SetupRequest:
    //   1. Validate the setup-request is browser.connect and pending.
    //   2. Confirm the agent's spawned headless Chrome is live (it usually is
    //      by this point — the agent asks to sign in only after hitting a wall
    //      while browsing; if not, the relaunch path below revives it). Open an
    //      in-chat screencast of that headless Chrome over its CDP debug port.
    //      There is NO visible-window fallback (the managed-window mode was
    //      removed — issue #420). This screencast path is for the SPAWNED
    //      browser; a user on the cdp transport signs in on their own Chrome.
    //   3. Mark payload.signInStarted = true while keeping the row pending. The
    //      UI re-renders with "I've signed in" / "Cancel" buttons; "I've signed
    //      in" POSTs to /complete which tears the screencast bridge down and
    //      resumes the task headless (cookies already in the shared profile).
    ["POST", /^\/api\/setup-requests\/([^/]+)\/open-browser$/, async (_request, params) => {
      const setupId = params[0];
      const before = readState(config.instance);
      const setup = before.setupRequests.find((s) => s.id === setupId);
      if (!setup) return json({ error: "Setup request not found" }, 404);
      if (setup.action !== "browser.connect") {
        return json({ error: `Setup request ${setupId} is not a browser.connect (${setup.action})` }, 400);
      }
      if (setup.status !== "pending") {
        return json({ error: `Setup request is already ${setup.status}` }, 410);
      }
      const targetUrl = typeof setup.payload.url === "string" ? setup.payload.url : "";
      if (targetUrl) {
        const blocked = safetyCheck(targetUrl);
        if (blocked) return json({ error: blocked }, 400);
      }
      // Screencast is the ONLY sign-in path: the user signs in through the
      // in-chat modal that screencasts the agent's headless spawned Chrome over
      // its CDP debug port. Usually the spawned Chrome is already live (the
      // agent just hit a sign-in wall while browsing). But a gateway restart /
      // Chrome crash / `gini browser disconnect` drops the in-process handle
      // while the durable setup row survives — relaunch it headless and navigate
      // to the recorded page rather than stranding the user on a card that can
      // never open (shared with the frames/input reconnect recovery).
      const relaunchError = await ensureSpawnedBrowserForSignIn(setup);
      if (relaunchError) return relaunchError;
      let stamped = false;
      await mutateState(config.instance, (state) => {
        const item = state.setupRequests.find((s) => s.id === setupId);
        // Re-check status INSIDE the mutation, not just existence: a /cancel
        // (or /complete) can commit between the pre-read pending check above and
        // this lock, and stamping signInStarted/screencast onto an already
        // terminal row would mark a cancelled sign-in as live.
        if (!item || item.status !== "pending") return;
        // Idempotency guard: /open-browser keeps the row pending, so two
        // concurrent opens (double-click / retry) would both pass the pending
        // check and each write a duplicate stage:open-browser audit row + trace.
        // Skip when already stamped so the audit/trace fire exactly once.
        if (item.payload.signInStarted === true) {
          stamped = true;
          return;
        }
        stamped = true;
        item.payload = {
          ...item.payload,
          signInStarted: true,
          screencast: true,
          openedAt: new Date().toISOString()
        };
        const reasonTarget = typeof setup.payload.reason === "string" && setup.payload.reason.length > 0
          ? setup.payload.reason
          : setup.target;
        addAudit(
          state,
          {
            actor: "user",
            action: "browser.connect",
            target: reasonTarget,
            risk: "medium",
            taskId: setup.taskId,
            runId: setup.taskId ? state.tasks.find((task) => task.id === setup.taskId)?.runId : undefined,
            approvalId: setup.id,
            evidence: { stage: "open-browser", mode: "screencast", headless: true }
          },
          setup.taskId ? { taskId: setup.taskId } : setup.agentId ? { agentId: setup.agentId } : { system: true }
        );
        if (item.taskId) {
          appendTrace(config.instance, item.taskId, {
            type: "approval",
            message: "Browser connect: sign-in screencast opened, awaiting sign-in",
            data: { setupRequestId: setupId }
          });
        }
      });
      if (!stamped) {
        // The row was completed/cancelled by a racing request between the
        // pre-read check and the mutation lock — don't report a live sign-in.
        const raced = readState(config.instance).setupRequests.find((s) => s.id === setupId);
        return json({ error: `Setup request is already ${raced?.status ?? "gone"}` }, 410);
      }
      const refreshedScreencast = readState(config.instance).setupRequests.find((s) => s.id === setupId);
      return json({ ok: true, setupRequest: refreshedScreencast, screencast: true });
    }],

    // Live sign-in screencast: stream JPEG frames of the agent's headless
    // browser to the in-chat modal as Server-Sent Events. Mirrors the
    // chatBlockStream auth/lifecycle pattern; the bearer gate above already
    // accepted the request, and the BFF injects that bearer server-side so the
    // browser never holds the gateway token. The screencast attaches to the
    // ALREADY-running spawned Chrome (raw CDP over its debug port) — it never
    // launches a browser and never accepts a port from the client.
    ["GET", /^\/api\/browser\/screencast\/([^/]+)\/frames$/, async (_request, params) => {
      const setupId = params[0];
      const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
      // Gate on the live approval window, not just existence: a completed /
      // cancelled / not-yet-started setup must not (re)open a screencast. This
      // also closes the stale-EventSource-reconnect path — after /complete
      // stops the bridge, a lingering reconnect can't rebuild a live drive
      // channel because the setup is no longer pending.
      if (
        !setup ||
        setup.action !== "browser.connect" ||
        setup.status !== "pending" ||
        setup.payload.screencast !== true ||
        setup.payload.signInStarted !== true
      ) {
        return json({ error: "Screencast setup request not active" }, 404);
      }
      // Resolve the bridge, relaunching the headless Chrome first if it isn't
      // running (a reconnect after a gateway/Chrome restart lands here, not on
      // /open-browser). Binds to the exact page the requesting task drove via
      // the helper's preferUrl/preferTargetId.
      const resolved = await resolveScreencastBridgeOrError(setup);
      if (resolved instanceof Response) return resolved;
      const bridge = resolved;
      const encoder = new TextEncoder();
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      const stream = new ReadableStream({
        start(controller) {
          const sendFrame = (frame: { data: string; meta: Record<string, unknown> }) => {
            try {
              controller.enqueue(
                encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
              );
            } catch {
              // controller already closed — drop the frame
            }
          };
          // onUrl: stream the gateway-sourced page URL so the modal shows the
          // operator which origin they're signing into (it has no address bar).
          const sendUrl = (url: string) => {
            try {
              controller.enqueue(encoder.encode(`event: url\ndata: ${JSON.stringify({ url })}\n\n`));
            } catch {
              // controller already closed — drop it
            }
          };
          // Allocate the keepalive interval BEFORE subscribing: subscribe() can
          // fire onClose SYNCHRONOUSLY when the bridge is already closed (the
          // closed-state short-circuit), and that handler clears `keepalive`.
          // If we set the interval up after subscribe(), a synchronous onClose
          // would run while keepalive is still undefined, then we'd install an
          // interval nothing ever clears — a leaked timer on a closed stream.
          // Comment keepalive so proxies don't idle-close the stream between
          // frames (a static page emits no frames until it changes).
          keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              // closed
            }
          }, 15_000);
          if (typeof keepalive.unref === "function") keepalive.unref();
          // onClose: when the CDP bridge dies, close the stream so the modal's
          // EventSource reconnects (and re-hits the gate, 404ing if the setup is
          // gone) instead of dangling on a stale frame behind keepalives.
          unsubscribe = bridge.subscribe(
            sendFrame,
            () => {
              if (keepalive) clearInterval(keepalive);
              try {
                controller.close();
              } catch {
                // already closed
              }
            },
            sendUrl
          );
        },
        cancel() {
          unsubscribe?.();
          if (keepalive) clearInterval(keepalive);
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        }
      });
    }],

    // Relay one operator input event (click / move / scroll / drag / key) from
    // the sign-in modal to the headless browser via the screencast bridge.
    // Deliberately has no "navigate" kind: free navigation would bypass the
    // agent's SSRF / domain-policy gate (which lives on browser_navigate).
    ["POST", /^\/api\/browser\/screencast\/([^/]+)\/input$/, async (request, params) => {
      const setupId = params[0];
      const setup = readState(config.instance).setupRequests.find((s) => s.id === setupId);
      if (
        !setup ||
        setup.action !== "browser.connect" ||
        setup.status !== "pending" ||
        setup.payload.screencast !== true ||
        setup.payload.signInStarted !== true
      ) {
        return json({ error: "Screencast setup request not active" }, 404);
      }
      let body: ScreencastInput;
      try {
        body = (await request.json()) as ScreencastInput;
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const resolved = await resolveScreencastBridgeOrError(setup);
      if (resolved instanceof Response) return resolved;
      const bridge = resolved;
      // Relay the remote page's selection back (present for copy/cut/selectall
      // and double/drag selection) so the modal can serve it to the operator's
      // clipboard on a native copy/cut event.
      const { selection } = await bridge.dispatchInput(body);
      return json(selection !== undefined ? { ok: true, selection } : { ok: true });
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
    // Instance log tail for the in-app Logs viewer (ADR logs-viewing.md).
    // Raw by default (the gateway is loopback + bearer-gated and the operator
    // already has filesystem access); `redact=true` reuses crash-report
    // redaction so a copy is safe to attach to a report.
    ["GET", /^\/api\/logs$/, (request) => {
      const url = new URL(request.url);
      const stream = url.searchParams.get("stream") ?? "runtime";
      if (!isLogStream(stream)) return json({ error: `Unknown log stream: ${stream}` }, 400);
      const rawLimit = Number(url.searchParams.get("limit") ?? 500);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 5000) : 500;
      const redactParam = url.searchParams.get("redact");
      const redact = redactParam === "true" || redactParam === "1";
      const tail = readLogTail(config.instance, stream, limit);
      const out = redact ? redactLogTail(tail, { secretsEnvBody: readSecretsEnvBody() }) : tail;
      return json({ ...out, redacted: redact });
    }],
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
    //     Writes the manifest flat to ~/.gini/instances/<instance>/skills/<name>/
    //     and reloads. User skills never nest under a category subfolder.
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
    ["POST", /^\/api\/skills\/([^/]+)\/enable$/, async (_request, params) => {
      // Enabling a skill never grants a connector. A non-bundled credentialed
      // skill enabled here stays env-denied (resolveSkillEnv returns {} for any
      // provider not bundled and not in grantedConnectors) until the user
      // grants it through the skill.grant_connector consent flow (ADR
      // skill-connector-consent.md). That consent path is the only way grants
      // are recorded — enabling must never silently auto-grant, or the model
      // could reach this route to bypass the gate.
      return json(await setSkillStatus(config, params[0], "enabled"));
    }],
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
    // Email watchers (ADR email-watch.md). Thin handlers over the state
    // module: list, add (builds the query + dedicated chat session), remove.
    ["GET", /^\/api\/email\/watchers$/, () => json(listEmailWatchers(config))],
    ["POST", /^\/api\/email\/watchers$/, async (request) => {
      const payload = await body(request);
      // Whole-inbox triage opt-in (ADR email-watch.md): `triage: true` provisions
      // the broad respond-or-flag concern for the active agent, `false` tears it
      // down. Triage is OPT-IN and independent of targeted watches; when triage is
      // the only field, toggle it without creating a normal watcher.
      if (payload.triage !== undefined && payload.triage !== null) {
        if (typeof payload.triage !== "boolean") {
          return json({ error: "Invalid input: triage must be a boolean" }, 400);
        }
        const enabled = await setEmailTriageEnabled(config, readState(config.instance).activeAgentId, payload.triage);
        if (payload.sender === undefined && payload.query === undefined && payload.threadId === undefined) {
          return json({ triage: enabled }, 201);
        }
      }
      return json(await addEmailWatcher(config, {
        sender: typeof payload.sender === "string" ? payload.sender : undefined,
        query: typeof payload.query === "string" ? payload.query : undefined,
        account: typeof payload.account === "string" ? payload.account : undefined,
        objective: typeof payload.objective === "string" ? payload.objective : undefined,
        threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
        followUpAfterHours: typeof payload.followUpAfterHours === "number" ? payload.followUpAfterHours : undefined
      }), 201);
    }],
    ["DELETE", /^\/api\/email\/watchers\/([^/]+)$/, async (_request, params) => json(await removeEmailWatcher(config, params[0]))],
    // PATCH toggles a watcher's enabled flag and/or updates its objective,
    // rebuilding the shared job's watch list (disabling the last enabled
    // watcher tears the shared job down; enabling recreates it; a new
    // objective rides the rebuilt hook config into the next tick). An explicit
    // `objective: null` CLEARS the objective (distinct from omitted = unchanged
    // and "" = rejected by validateObjective).
    ["PATCH", /^\/api\/email\/watchers\/([^/]+)$/, async (request, params) => {
      const payload = await body(request);
      if (payload.enabled === undefined && payload.objective === undefined) {
        return json({ error: "Invalid input: provide enabled (boolean) and/or objective (string or null to clear)" }, 400);
      }
      if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") {
        return json({ error: "Invalid input: enabled must be a boolean" }, 400);
      }
      if (payload.objective !== undefined && payload.objective !== null && typeof payload.objective !== "string") {
        return json({ error: "Invalid input: objective must be a string or null" }, 400);
      }
      let updated = getEmailWatcher(config, params[0]);
      if (!updated) return json({ error: `Email watcher not found: ${params[0]}` }, 404);
      if (payload.objective === null) {
        updated = await clearEmailWatcherObjective(config, params[0]);
      } else if (typeof payload.objective === "string") {
        updated = await setEmailWatcherObjective(config, params[0], payload.objective);
      }
      if (typeof payload.enabled === "boolean") {
        updated = await setEmailWatcherEnabled(config, params[0], payload.enabled);
      }
      if (!updated) return json({ error: `Email watcher not found: ${params[0]}` }, 404);
      return json(updated);
    }],
    // Direct, server-side send of a SAVED Gmail draft by id — the email-draft
    // card's Send button. The agent embeds the gws draft id (+ sending account)
    // in the rendered email-draft fence; the card POSTs them here. No LLM/agent
    // turn runs — the explicit Send click IS the user approval (the global
    // request_confirmation gate), so we stamp an audit row and send via gws.
    // The draft id is validated to gws's opaque-token charset and rides INSIDE
    // the gws --json request body (see gmail-draft-send.ts), never the shell.
    ["POST", /^\/api\/email\/drafts\/send$/, async (request) => {
      const payload = await body(request);
      const draftId = typeof payload.draftId === "string" ? payload.draftId.trim() : "";
      if (!draftId || !/^[A-Za-z0-9_-]+$/.test(draftId)) {
        return json({ ok: false, message: "Invalid input: draftId must be a non-empty opaque token." }, 400);
      }
      const account = typeof payload.account === "string" && payload.account.trim().length > 0 ? payload.account.trim() : undefined;
      // Resolve the sending account → its gws config dir against the registered
      // Google accounts (same resolution the email watchers use). An unresolved
      // / unset account falls back to the default gws session.
      const configDir = await resolveDraftSendConfigDir(account);
      const result = await sendGmailDraft({ draftId, ...(configDir ? { configDir } : {}) });
      if (!result.ok) {
        return json({ ok: false, message: result.message ?? "Failed to send the draft." }, 502);
      }
      // Record the sent id durably (deduped) so the card renders a persistent
      // "Sent" across refresh, and stamp the audit row for the side effect.
      await mutateState(config.instance, (state) => {
        const ids = state.sentDrafts ?? [];
        if (!ids.includes(draftId)) state.sentDrafts = [...ids, draftId];
        addAudit(
          state,
          {
            actor: "user",
            action: "email.draft_sent",
            target: draftId,
            risk: "medium",
            evidence: { draftId, account, messageId: result.messageId }
          },
          { system: true }
        );
      });
      return json({ ok: true, ...(result.messageId ? { messageId: result.messageId } : {}) });
    }],
    // Persistent sent-marker read for the email-draft card. Given a CSV of draft
    // ids, returns the subset already recorded in sentDrafts, so the card can
    // render "Sent" on mount without re-sending.
    ["GET", /^\/api\/email\/drafts\/sent$/, (request) => {
      const requested = new URL(request.url).searchParams.get("ids") ?? "";
      const ids = new Set(requested.split(",").map((s) => s.trim()).filter(Boolean));
      const sent = (readState(config.instance).sentDrafts ?? []).filter((id) => ids.has(id));
      return json({ sent });
    }],
    ["GET", /^\/api\/connectors$/, async () => {
      const connectors = readState(config.instance).connectors;
      // Enrich google-oauth-desktop records with the SEPARATE sign-in
      // liveness signal (from `gws auth status`) so the UI can tell
      // "client creds provisioned" (health) apart from "user session
      // valid" (session). Health stays presence-only; this never feeds
      // the connector.request /complete drop path. Other providers are
      // returned untouched.
      const hasGoogle = connectors.some((c) => c.provider === "google-oauth-desktop");
      const session = hasGoogle ? await gwsSessionStatus() : undefined;
      // The tagged accounts registry is machine-global, so resolve it once and
      // attach to every google-oauth-desktop record alongside `session`.
      const accounts = hasGoogle ? await listAccountsWithStatus() : undefined;
      return json(
        connectors.map((c) =>
          c.provider === "google-oauth-desktop" && session
            ? { ...c, session, accounts }
            : c
        )
      );
    }],
    ["GET", /^\/api\/connectors\/providers$/, () => json(listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      docsUrl: p.docsUrl,
      fields: p.fields,
      secrets: p.secrets,
      hasProbe: Boolean(p.probe),
      hasDetect: Boolean(p.detect),
      // Whether the provider owns a chat-driven setup skill. Drives the Skills
      // page "Set up via chat" routing for providers whose setup is more than
      // pasting a secret (e.g. google-oauth-desktop's gws/gcloud walkthrough),
      // which can't be inferred from field shape now that all its fields are
      // secret.
      hasSetupSkill: Boolean(p.setupSkill),
      // The setup skill NAME (e.g. "google-workspace-setup"), so the Skills
      // page can match a service skill's required-credential connector back
      // to its setup skill and defer the activation pill to it.
      setupSkill: p.setupSkill,
      // Live result of the provider's credentialExternallySatisfied hook
      // (e.g. registered machine-global Google accounts). Lets the Skills
      // page mirror isSkillActive's absent-record fallthrough — the hook
      // only applies when no connector record with the credential name
      // exists; the page enforces that record check itself.
      externallySatisfied: Boolean(p.credentialExternallySatisfied?.()),
      probeIntervalMs: p.probeIntervalMs,
      // Optional credential-template the Add Connector dialog prefills when a
      // provider is picked as a template. Derived from the module's secret
      // bindings: one env binding → api-key (name == that env var, MCP URL
      // from the module's mcpServer); two+ → oauth2 (envMap = purpose→ENV).
      // Modules with no secret spec (presence-only, generic) carry none.
      credentialTemplate: credentialTemplateForProvider(p)
    })))],
    ["POST", /^\/api\/connectors$/, async (request) => {
      const payload = await body(request);
      const secrets = payload.secrets && typeof payload.secrets === "object" && !Array.isArray(payload.secrets)
        ? payload.secrets as Record<string, string>
        : undefined;
      const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined;
      const type = payload.type === "api-key" || payload.type === "oauth2" ? payload.type : undefined;
      return json(await createConnector(config, {
        name: String(payload.name ?? ""),
        provider: String(payload.provider ?? ""),
        type,
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
    // Machine-global tagged Google accounts (multi-account support). The
    // registry + per-account gws config dirs live under ~/.gini/google-accounts;
    // these routes are NOT instance-scoped. registerAccount throws
    // "No signed-in Google session in <dir>" when the dir has no live session.
    ["GET", /^\/api\/google\/accounts$/, async () => json(await listAccountsWithStatus())],
    ["POST", /^\/api\/google\/accounts$/, async (request) => {
      const payload = await body(request);
      const tag = typeof payload.tag === "string" ? payload.tag.trim() : "";
      const configDir = typeof payload.configDir === "string" ? payload.configDir.trim() : "";
      if (!tag || !configDir) {
        return json({ error: "Invalid input: tag and configDir are required" }, 400);
      }
      // Defense-in-depth: only register the adopted default dir (~/.config/gws)
      // or a direct child of the machine-global google-accounts root. Removal is
      // already exact-match-guarded, but this keeps an arbitrary path from ever
      // entering the registry.
      const home = process.env.HOME || homedir();
      const defaultGwsDir = join(home, ".config", "gws");
      if (!isAbsolute(configDir) || (configDir !== defaultGwsDir && dirname(configDir) !== googleAccountsRoot())) {
        return json({ error: "Invalid input: configDir must be ~/.config/gws or a direct child of the google-accounts root" }, 400);
      }
      const adopt = payload.adopt === true;
      try {
        return json(await registerAccount({ tag, configDir, adopt }), 201);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Failed to register account" }, 400);
      }
    }],
    ["PATCH", /^\/api\/google\/accounts\/([^/]+)$/, async (request, params) => {
      const payload = await body(request);
      const tag = typeof payload.tag === "string" ? payload.tag.trim() : "";
      if (!tag) return json({ error: "Invalid input: tag is required" }, 400);
      if (!getGoogleAccount(params[0])) {
        return json({ error: `Google account not found: ${params[0]}` }, 404);
      }
      try {
        retagAccount(params[0], tag);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Failed to retag account" }, 400);
      }
      return json(getGoogleAccount(params[0]));
    }],
    ["DELETE", /^\/api\/google\/accounts\/([^/]+)$/, (_request, params) => {
      removeAccount(params[0]);
      return json({ id: params[0] });
    }],
    ["GET", /^\/api\/improvements$/, () => json(readState(config.instance).improvements)],
    ["POST", /^\/api\/improvements$/, async (request) => json(await proposeImprovement(config, await body(request)), 201)],
    ["POST", /^\/api\/improvements\/([^/]+)\/approve$/, async (_request, params) => json(await reviewImprovement(config, params[0], "approve"))],
    ["POST", /^\/api\/improvements\/([^/]+)\/reject$/, async (_request, params) => json(await reviewImprovement(config, params[0], "reject"))],
    // Skill-learning read surfaces + manual review trigger (ADR
    // skill-learning-from-outcomes.md). The review pass otherwise runs on the
    // slow server loop; POST /review fires it on demand (for testing/dogfood).
    ["GET", /^\/api\/learning\/outcomes$/, () => json(readState(config.instance).skillOutcomes)],
    ["GET", /^\/api\/learning\/findings$/, () => json(readState(config.instance).learningFindings)],
    // Read-only, observational skill reliability scores. Gates nothing — purely
    // a human-facing indicator (ADR skill-learning-from-outcomes.md).
    ["GET", /^\/api\/learning\/scores$/, () => json(computeSkillScores(config))],
    ["POST", /^\/api\/learning\/review$/, async () => json(await runDailyReview(config))],
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
      const device = upsertDevice(config.instance, {
        token,
        credentialId: credential,
        platform: "ios",
        bundleId
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
    // Notification-preview endpoint for the iOS Notification Service
    // Extension (NSE). When a `mutable-content: 1` push lands, the NSE
    // runs on-device and calls this to fetch the real, human-readable
    // title + body, then rewrites the lock-screen banner before display.
    // The APNs wire payload carries only ids + a generic string, so this
    // is the path that surfaces the actual message text WITHOUT it ever
    // transiting Apple's servers (see ADR mobile-push-notifications.md).
    // Bearer-gated like every other /api route; the NSE reads the bearer
    // from the App Group shared container the main app writes on auth.
    ["GET", /^\/api\/push\/preview$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const params = new URL(request.url).searchParams;
      const sessionId = (params.get("sessionId") ?? "").trim();
      const event = (params.get("event") ?? "").trim();
      const approvalId = (params.get("approvalId") ?? "").trim() || undefined;
      const threadId = (params.get("threadId") ?? "").trim() || undefined;
      if (!sessionId) return json({ error: "sessionId is required" }, 400);
      if (event !== "message_completed" && event !== "authorization_requested" && event !== "setup_requested") {
        return json({ error: "event must be message_completed, authorization_requested, or setup_requested" }, 400);
      }
      // Validate the session belongs to this instance so a stale or
      // foreign sessionId 404s rather than leaking a generic empty preview.
      const state = readState(config.instance);
      const session = state.chatSessions.find((s) => s.id === sessionId);
      if (!session) return json({ error: `Chat session not found: ${sessionId}` }, 404);
      const preview = buildNotificationPreview(
        config.instance,
        { event: event as PreviewEvent, sessionId, approvalId, threadId },
        {
          latestAssistantText: latestAssistantTextForSession,
          latestAssistantTextForThread,
          sessionTitle: (_inst, id) =>
            readState(config.instance).chatSessions.find((s) => s.id === id)?.title ?? null,
          authorization: (_inst, id) =>
            readState(config.instance).authorizations.find((a) => a.id === id && a.status === "pending") ?? null,
          setupRequest: (_inst, id) =>
            readState(config.instance).setupRequests.find((s) => s.id === id && s.status === "pending") ?? null
        }
      );
      // No preview ⇒ the underlying content is gone (resolved approval,
      // not-yet-persisted message). 404 tells the NSE to keep the generic
      // as-sent banner instead of blanking it.
      if (!preview) return json({ error: "No preview available" }, 404);
      return json(preview);
    }],
    // Explicit "I've stopped watching" beacon. The SSE stream's own
    // cancel() clears a device's watch-state on disconnect, but behind a
    // relay the gateway-side socket can stay open after the phone is gone
    // (keepalive writes keep succeeding into the relay buffer), so cancel()
    // may never fire and the stale entry permanently suppresses completion
    // pushes for that session. Three callers, narrowest-scope-wins:
    //   - background: app posts with NO sessionId → clear the whole device
    //     bucket (it's watching nothing).
    //   - screen unmount: app posts WITH ?sessionId&streamId → clear only
    //     the one stream that screen opened, leaving a sibling stream on the
    //     SAME session (e.g. the main chat under a Thread View card) intact.
    //   - ?sessionId without streamId (legacy/web): clear the whole session
    //     for the device.
    // Best-effort and idempotent; device-scoped like /read and /badge.
    ["POST", /^\/api\/push\/unwatch$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const params = new URL(request.url).searchParams;
      const sessionId = (params.get("sessionId") ?? "").trim();
      const streamId = (params.get("streamId") ?? "").trim();
      let cleared: number;
      if (sessionId && streamId) {
        cleared = clearStreamWatch(config.instance, dev.token, sessionId, streamId);
      } else if (sessionId) {
        cleared = clearSessionWatch(config.instance, dev.token, sessionId);
      } else {
        cleared = clearDeviceWatch(config.instance, dev.token);
      }
      return json({ ok: true, cleared });
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
    // Mark a chat unread for the calling device. Pins the read cursor
    // to the block before the latest assistant_text so the badge
    // settles at "just the agent's last turn" (typically 1), matching
    // iOS Mail / Messages behavior — not "every block since session
    // start". Sessions with no assistant_text fall back to clearing
    // the cursor entirely so the action still surfaces them as unread.
    ["DELETE", /^\/api\/chat\/([^/]+)\/read$/, async (request, params) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const sessionId = params[0];
      if (!readState(config.instance).chatSessions.some((s) => s.id === sessionId)) {
        return json({ error: `Chat session not found: ${sessionId}` }, 404);
      }
      markUnread(config.instance, sessionId, dev.token);
      return json({ ok: true });
    }],
    ["GET", /^\/api\/badge$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      // Badge totals are per-device (see /read endpoint comment).
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const unread = unreadCountForDevice(config.instance, dev.token, unreachableSessionIds(config));
      return json({ unread });
    }],
    // Per-session unread counts for the calling device. Powers the
    // mobile chat list's per-row badge (blue pill + count) — /badge
    // gives the cross-session total, /unread gives the breakdown so
    // the list can mark each row independently. Sessions with zero
    // unread blocks are omitted; callers default to 0.
    ["GET", /^\/api\/unread$/, async (request) => {
      const credential = await resolveCredentialFromBearer(config, bearerFromRequest(request));
      if (!credential) return json({ error: "Unauthorized" }, 401);
      const dev = requireDeviceToken(config, request, credential);
      if (!dev.ok) return json({ error: dev.reason }, dev.status);
      const counts = unreadCountsByDevice(config.instance, dev.token, unreachableSessionIds(config));
      return json({ counts: Object.fromEntries(counts) });
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
    // Catalog rows carry the persistent per-provider auth status (issue #233)
    // so Settings can render "Needs re-authentication" instead of presence-only
    // "Connected" when a provider call failed on a dead credential.
    ["GET", /^\/api\/providers\/catalog$/, () => json(withProviderAuthStatus(
      providerCatalogWithStatus(config.provider?.name, config.provider?.apiKeyEnv, config.provider?.baseUrl),
      readState(config.instance).providerAuthFailures
    ))],
    // Model-first view of the same catalog: canonical models with the routes
    // (configured providers) that serve them. Drives the model picker in the
    // web Settings page and chat Settings tab (ADR model-first-selection.md).
    ["GET", /^\/api\/providers\/models$/, () => json(buildModelCatalog(providerCatalogWithStatus(config.provider?.name, config.provider?.apiKeyEnv, config.provider?.baseUrl)))],
    // Set the default model (what new chats start with): writes the instance
    // provider AND the default agent's override — the latter is what the
    // default chat actually resolves through. Body: { provider, model }.
    ["POST", /^\/api\/settings\/default-model$/, async (request) => {
      const result = await setDefaultModel(config, await body(request));
      return json(result, result.ok ? 200 : 400);
    }],
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
    ["POST", /^\/api\/setup\/provider\/remove$/, async (request) => {
      const payload = await body(request);
      const providerName = typeof payload.provider === "string" ? payload.provider : "";
      const result = await removeSetupProvider(config, providerName);
      return json(result, result.ok ? 200 : 400);
    }],
    ["GET", /^\/api\/agents$/, () => json(listAgents(config))],
    ["POST", /^\/api\/agents$/, async (request) => json(await createAgent(config, await body(request)), 201)],
    ["POST", /^\/api\/agents\/([^/]+)\/use$/, async (_request, params) => json(await useAgent(config, params[0]))],
    // Select (or clear) this agent's provider/model. Body: { providerName, model }
    // to set, or both blank/omitted to clear and fall back to the instance
    // default. Credential setup stays on the instance-level setup/provider route.
    ["POST", /^\/api\/agents\/([^/]+)\/provider$/, async (request, params) => json(await setAgentProvider(config, decodeURIComponent(params[0]), await body(request)))],
    // Archive (soft-delete) / restore an agent. Body-less POSTs, mirroring /use.
    ["POST", /^\/api\/agents\/([^/]+)\/archive$/, async (_request, params) => json(await archiveAgent(config, decodeURIComponent(params[0])))],
    ["POST", /^\/api\/agents\/([^/]+)\/unarchive$/, async (_request, params) => json(await unarchiveAgent(config, decodeURIComponent(params[0])))],
    ["PATCH", /^\/api\/agents\/([^/]+)$/, async (request, params) => json(await renameAgent(config, decodeURIComponent(params[0]), String((await body(request)).name ?? "")))],
    ["DELETE", /^\/api\/agents\/([^/]+)$/, async (_request, params) => json(await deleteAgent(config, params[0]))],
    ["GET", /^\/api\/parity\/hermes$/, () => json(hermesParityChecks(config))],
    ["GET", /^\/api\/readiness\/v1$/, () => json(v1Readiness(config))],
    ["GET", /^\/api\/relays$/, () => json(listRelays(config))],
    ["POST", /^\/api\/relays$/, async (request) => json(await configureRelay(config, await body(request)), 201)],
    ["POST", /^\/api\/relays\/([^/]+)\/health$/, async (_request, params) => json(await checkRelay(config, params[0]))],
    // Tunnel connectivity (ADR tunnel-connectivity.md). Every route returns
    // the full TunnelState so one fetch drives the selection/connect/connected
    // UI. connect() flips to "connecting" and runs the selected provider's
    // background flow (gini-relay: OAuth-loopback login + frpc; manual
    // drivers: tailscale serve / a spawned agent, no login); the UI polls
    // GET /api/tunnel until status flips to "connected" (with url) or "error".
    // `?detect=1` (the panel-open / CLI-status path) re-probes the manual
    // driver prerequisites first, so a freshly-installed CLI flips its catalog
    // row without a runtime restart; plain polling GETs never spawn detection.
    ["GET", /^\/api\/tunnel$/, async (request) => {
      if (new URL(request.url).searchParams.get("detect") === "1") {
        await refreshProviderDetection(true).catch(() => {});
      }
      return json(getTunnel(config));
    }],
    ["POST", /^\/api\/tunnel\/select$/, async (request) => json(await selectProvider(config, String((await body(request)).provider ?? "")))],
    ["POST", /^\/api\/tunnel\/connect$/, async (request) => {
      const payload = await body(request);
      const provider = typeof payload.provider === "string" && payload.provider.length > 0 ? payload.provider : undefined;
      return json(await connectTunnel(config, provider));
    }],
    ["POST", /^\/api\/tunnel\/cancel$/, async () => json(await cancelTunnel(config))],
    ["POST", /^\/api\/tunnel\/disconnect$/, async () => json(await disconnectTunnel(config))],
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

  // The inner closure runs the full request lifecycle; the outer wrapper
  // compresses the final response before it goes out over the relay.
  const handle = async (request: Request, url: URL): Promise<Response> => {
    // CORS preflight: short-circuit before auth so browsers can probe
    // protected endpoints. Returning a 401 on OPTIONS would prevent the
    // browser from ever sending the real bearer-carrying request.
    if (request.method === "OPTIONS" && request.headers.get("access-control-request-method")) {
      return preflightResponse(request);
    }
    // iOS universal-links association: a fixed public file served before the
    // host/session gates so Apple's CDN (a no-Origin GET) can fetch it on any
    // relay subdomain to validate the app's `applinks:*.<relayDomain>` claim.
    if (request.method === "GET" && url.pathname === APPLE_APP_SITE_ASSOCIATION_PATH) {
      return appleAppSiteAssociationResponse();
    }
    // The gateway owns only its NATIVE /api/* surface. The Next BFF namespace
    // (/api/runtime/*) and all non-/api traffic are web-bound (isWebProxyPath)
    // and proxied to the web server instead, so the browser's token-injecting
    // BFF calls reach Next rather than hitting this bearer gate. The same
    // predicate gates WS routing in src/server.ts so the two can't drift.
    if (!isWebProxyPath(url.pathname)) {
      if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
        // This legacy code-claim endpoint is public (it predates the bearer gate)
        // and, now that the gateway is the relay-facing front, reachable from the
        // internet. The code is a 6-digit value, so without throttling an
        // attacker could brute-force a pending code within its TTL to mint a
        // device bearer. Rate-limit it the same way the new request flow is
        // gated; a legitimate single mobile/CLI claim stays well under capacity.
        if (!pairingClaimAllowed(request)) {
          return withCors(request, json({ error: "Too many pairing attempts. Try again shortly." }, 429));
        }
        try {
          return withCors(request, json(await claimPairing(config, await body(request)), 201));
        } catch (error) {
          return withCors(request, json({ error: error instanceof Error ? error.message : String(error) }, 400));
        }
      }
      // Relay device-pairing API: gateway-handled before the bearer gate so it
      // can enforce its own loopback-vs-public rules from the true inbound Host.
      // The paths are enumerated (isDevicePairingPath) rather than prefix-matched
      // so a future /api/pairing/request-* route can't silently bypass the bearer
      // gate. The handler can throw (approve/reject of a stale request), so wrap
      // it in the same JSON error envelope the route table uses.
      if (isDevicePairingPath(url.pathname)) {
        try {
          return await handlePairingRoutes(request, url, config);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return withCors(request, json({ error: message }, statusFromErrorMessage(message)));
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
            // A machine-readable `code` rides along ONLY for the codes we
            // deliberately publish (clients branch on the failure kind
            // instead of parsing the human message). Allowlisted so a stray
            // Node errno (`ENOENT`…) on a thrown fs error can't silently
            // widen the public API shape.
            const raw = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
            const code = typeof raw === "string" && PUBLIC_ERROR_CODES.has(raw) ? raw : undefined;
            return withCors(request, json(code ? { error: message, code } : { error: message }, statusFromErrorMessage(message)));
          }
        }
      }
      return withCors(request, json({ error: "Not found" }, 404));
    }
    // Single-front trust boundary: validate the inbound Host/Origin for every
    // web-bound request BEFORE proxying. The inner web child binds loopback and
    // is relay-agnostic, so this is the one place DNS-rebinding / CSRF are
    // stopped for the token-injecting proxied surface. Page/asset paths 404
    // (don't confirm the host); the /api/runtime/* BFF namespace 403s so a
    // programmatic caller sees the refusal. See src/lib/origin-trust.ts.
    if (!webBoundRequestAllowed(request)) {
      return url.pathname.startsWith("/api/")
        ? withCors(request, json({ error: "Forbidden" }, 403))
        : withCors(request, new Response("Not found", { status: 404 }));
    }
    // Relay session gate: a web request on a non-loopback (relay/allowlisted)
    // front must carry a valid gini_session cookie. Loopback is trusted with no
    // pairing. Unpaired page navigations are redirected to /pair; unpaired
    // /api/runtime/* calls get a 401. Bootstrap paths (the /pair page + assets)
    // stay reachable so a new device can run the handshake.
    //
    // DELIBERATE: this pairing handshake is the ONLY relay-specific gate. Once a
    // relay session is admitted here it is a full MIRROR of the loopback operator
    // — same admin powers, including approving/adding devices and creating
    // pairing codes via the BFF. Do NOT add per-route relay refusals downstream
    // that make a paired relay session less capable than loopback. See ADR
    // device-pairing-auth.md ("Relay sessions mirror loopback").
    const webHost = request.headers.get("host") ?? url.host;
    let gatedSessionToken: string | undefined;
    let reissueSessionDocumentNav = false;
    if (relaySessionGateRequired(webHost, url.pathname)) {
      const sessionToken = sessionCookieValue(request);
      if (!sessionToken || !resolveSessionFromCookie(config, sessionToken)) {
        return url.pathname.startsWith("/api/")
          ? withCors(request, json({ error: "Unauthorized" }, 401))
          : new Response(null, { status: 302, headers: { location: "/pair" } });
      }
      // Refresh last-seen on full page loads only (not every asset) so the
      // Active Sessions list stays current without per-request writes. Swallow
      // failures: this is a best-effort bookkeeping write, and an unhandled
      // rejection here (e.g. a transient writeState ENOSPC/EROFS) would reach the
      // global unhandledRejection handler, which exits the gateway process.
      if (request.headers.get("sec-fetch-dest") === "document") {
        void touchPairedSession(config, sessionToken).catch(() => {});
        // Re-issue the session cookie on each document navigation so an active
        // session slides its Max-Age window forward. The server session never
        // expires (no expiresAt), but browsers cap a persistent cookie at 400
        // days (RFC 6265bis), so without this slide a daily user would still be
        // bounced to /pair exactly 400 days after first pairing — expiry in all
        // but name. Sliding on the same cadence as touchPairedSession keeps an
        // in-use session's cookie effectively permanent; only a session left
        // untouched for 400 continuous days drops its cookie.
        reissueSessionDocumentNav = true;
      }
      // Carry the validated token into proxyWeb so a long-lived SSE stream can be
      // re-validated and torn down if this session is revoked mid-stream — the
      // gate only runs once per connection, so without this an open event stream
      // would outlive a revocation. Loopback (un-gated) needs no such check.
      gatedSessionToken = sessionToken;
    }
    const proxied = await proxyWeb(request, url, config, gatedSessionToken);
    if (reissueSessionDocumentNav && gatedSessionToken) {
      const secure = pairingCookieSecure(request, webHost);
      const refreshed = new Headers(proxied.headers);
      refreshed.append(
        "set-cookie",
        serializeCookie(sessionCookieName(secure), gatedSessionToken, {
          ...sessionCookieAttributes,
          secure,
          maxAge: SESSION_COOKIE_TTL_SECONDS
        })
      );
      // Slide gini_client on the SAME cadence as the session — but only when the
      // browser already holds one. Both cookies share the 400-day cap, yet the
      // session slides on navigation while a fixed-lifetime gini_client would
      // lapse at day 400 for a daily-active browser that never re-pairs; a later
      // re-pair would then mint a fresh clientId and fail to supersede the slid
      // session. Re-issuing only when a value is present avoids minting a
      // write-only id for a mid-first-pair or pre-upgrade browser that sent none.
      const clientId = clientCookieValue(request, secure);
      if (clientId) {
        refreshed.append(
          "set-cookie",
          serializeCookie(clientCookieName(secure), clientId, {
            ...sessionCookieAttributes,
            secure,
            maxAge: CLIENT_COOKIE_TTL_SECONDS
          })
        );
      }
      return new Response(proxied.body, { status: proxied.status, statusText: proxied.statusText, headers: refreshed });
    }
    return proxied;
  };

  return async (request: Request) => {
    const url = new URL(request.url);
    const response = await handle(request, url);
    // Compress the gateway's OWN native /api responses before they hit the
    // bandwidth-capped relay — the large JSON bodies (/api/state, /api/tasks)
    // are the whole point. Deliberately scoped to the native surface:
    // web-proxy paths (the Next BFF + /_next/* + static assets, anything
    // isWebProxyPath matches) are excluded because (a) those responses are
    // reachable UNAUTHENTICATED via the pairing-bootstrap allowlist, so
    // compressing them would let a remote client burn gateway CPU on
    // brotli before any session check, and (b) the web child already gzips
    // its own assets, so re-compressing here is redundant. maybeCompress
    // still no-ops on already-encoded/SSE/small/incompressible bodies.
    if (isWebProxyPath(url.pathname)) return response;
    return maybeCompress(request, response);
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

// A path is web-bound — reverse-proxied to Next.js (UI, assets, the
// /api/runtime BFF namespace, HMR) — when it is NOT part of the gateway's own
// native /api surface. Shared by the HTTP fall-through and the WS upgrade so
// the two routings can't drift.
export function isWebProxyPath(pathname: string): boolean {
  return !pathname.startsWith("/api/") || pathname.startsWith("/api/runtime/");
}

// The runtime self-describe banner — served on a web PAGE path when the web
// server isn't reachable (web down, or a --no-web instance). The banner's
// natural home is exactly the case where the UI isn't there to serve.
function runtimeBanner(request: Request, config: RuntimeConfig): Response {
  // The web-down self-describe. Some bootstrap paths (/pair, /_next/*, static
  // assets) are exempt from the relay session gate, so a remote relay visitor can
  // reach this banner during the web child's post-restart startup window. Only
  // loopback (the local operator) gets the full self-describe; a non-loopback
  // caller gets the bare name/message and never the instance, port, or web-URL
  // hint, so the banner can't leak deployment details over the relay.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const detail = isLoopbackHost(host)
    ? { instance: config.instance, port: config.port, ui_url_hint: process.env.GINI_WEB_URL ?? null }
    : {};
  return withCors(request, json({
    name: "gini-runtime",
    message: "Gini runtime API. The Next.js control plane runs on a separate port; see `gini status`.",
    ...detail
  }));
}

// Fallback when the web upstream can't be reached. API-shaped paths (the
// /api/runtime BFF namespace) get a 502 so a programmatic caller sees a clear
// failure rather than a 200 banner it might parse as success; page/asset paths
// get the self-describe banner.
function proxyFallback(request: Request, url: URL, config: RuntimeConfig): Response {
  if (url.pathname.startsWith("/api/")) {
    return withCors(request, json({ error: "Web UI not running" }, 502));
  }
  return runtimeBanner(request, config);
}

// How often a relay-gated SSE stream re-checks that its session is still valid.
// The relay gate validates once at connect time; a revocation must also tear
// down an already-open stream, so we re-resolve the session on this cadence and
// abort the proxied connection when it's gone — bounding the post-revoke leak.
// Overridable via env so tests can shrink the cadence instead of waiting 5s.
function sessionRevalidateMs(): number {
  const raw = Number(process.env.GINI_SESSION_REVALIDATE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

// Drop the gateway's own cookies from a forwarded Cookie header, preserving all
// other cookie segments verbatim (no decode/re-encode, so arbitrary inner-app
// cookie values can't be corrupted).
function stripGatewayCookies(headers: Headers): void {
  const raw = headers.get("cookie");
  if (!raw) return;
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const eq = part.indexOf("=");
      const name = (eq < 0 ? part : part.slice(0, eq)).trim();
      return !GATEWAY_ONLY_COOKIES.has(name);
    });
  if (kept.length > 0) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
}

async function proxyWeb(request: Request, url: URL, config: RuntimeConfig, sessionToken?: string): Promise<Response> {
  const port = await resolveWebPort(config);
  if (port === null) return proxyFallback(request, url, config);
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
  // Present the inner web child a loopback request. It binds loopback and is
  // relay-agnostic, so it must never see the external relay Host/Origin — the
  // gateway already validated those in webBoundRequestAllowed. Rewriting both
  // satisfies the child's loopback trust lane and lets it drop all relay
  // awareness. A fresh Headers copy avoids mutating the original request.
  const headers = new Headers(request.headers);
  headers.set("host", `127.0.0.1:${port}`);
  if (headers.has("origin")) headers.set("origin", `http://127.0.0.1:${port}`);
  stripGatewayCookies(headers);
  // decompress: false tells Bun not to auto-decompress the upstream response.
  // That keeps Content-Encoding and Content-Length consistent so the browser
  // can decompress normally. Without it, Bun decompresses the body but leaves
  // the stale headers, causing ERR_CONTENT_DECODING_FAILED in browsers.
  const init: BunFetchRequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    decompress: false,
  };
  // For a relay-gated request, drive the upstream fetch from our own
  // AbortController (chained to the client's signal) so the stream re-validator
  // below can abort the upstream connection on revocation. Un-gated (loopback)
  // requests pass the client's signal straight through, unchanged.
  let ac: AbortController | null = null;
  if (sessionToken) {
    ac = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) ac.abort();
      else request.signal.addEventListener("abort", () => ac!.abort(), { once: true });
    }
    init.signal = ac.signal;
  } else if (request.signal) {
    init.signal = request.signal;
  }
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  try {
    const upstream = await fetch(target, init);
    // Rewrite an absolute redirect that points back at the loopback web target
    // into a relative path. The web child builds redirects (e.g. the setup
    // gate's /setup) from the loopback Host the gateway forwarded, so an
    // absolute Location would send a remote tunnel browser to its own
    // 127.0.0.1. A relative Location resolves against the origin the browser
    // actually used (relay or loopback).
    const location = upstream.headers.get("location");
    const loopbackBase = `http://127.0.0.1:${port}`;
    if (location && location.startsWith(loopbackBase)) {
      const headers = new Headers(upstream.headers);
      headers.set("location", location.slice(loopbackBase.length) || "/");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    }
    // Re-validate long-lived relay SSE streams: a revoked/expired session must
    // not keep receiving events just because its connection opened while valid.
    // Poll the session on an interval and abort the proxied connection when it
    // resolves to nothing; the browser then reconnects and the gate refuses it.
    if (ac && upstream.body && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const controller = ac;
      const interval = setInterval(() => {
        if (!resolveSessionFromCookie(config, sessionToken!)) controller.abort();
      }, sessionRevalidateMs());
      const clearTimer = () => clearInterval(interval);
      // Clear the revalidation timer on EVERY termination path, not just a
      // graceful close: abort (revocation / client disconnect), upstream error,
      // graceful end, and downstream cancel. A TransformStream flush would only
      // catch the graceful close and leak the interval on error/cancel, so wrap
      // the upstream body in a reader loop that clears in all branches.
      controller.signal.addEventListener("abort", clearTimer, { once: true });
      const reader = upstream.body.getReader();
      const body = new ReadableStream({
        async pull(streamController) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimer();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (err) {
            clearTimer();
            streamController.error(err);
          }
        },
        cancel(reason) {
          clearTimer();
          return reader.cancel(reason);
        }
      });
      return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    }
    return upstream;
  } catch {
    // The port validated but the upstream died inside the validation-cache
    // window (web restart/crash). Drop the stale entry so the next request
    // re-validates, and fall back instead of surfacing a generic 500.
    clearWebTargetCache(config.instance);
    return proxyFallback(request, url, config);
  }
}

// How long to wait for a proxied upstream WebSocket to finish its handshake
// before tearing it down. Next HMR opens in well under a second; this is a
// generous ceiling that just bounds buffering on a hung/slow upstream.
const WS_HANDSHAKE_TIMEOUT_MS = 15_000;

// WebSocket close codes that close() accepts: 1000, or the 3000-4999
// application range. Upstream may report reserved codes (1005/1006/1015) that
// throw if forwarded; normalize anything else to 1011 (internal error).
function safeCloseCode(code?: number): number {
  return code === 1000 || (typeof code === "number" && code >= 3000 && code <= 4999) ? code : 1011;
}

// Per-connection state for a proxied WebSocket. Frames are normalized to
// `string | ArrayBuffer` (binary coerced to a concrete ArrayBuffer) so both
// the upstream and client send() signatures accept them. Frames that arrive
// before the far side's handshake completes are buffered so the HMR handshake
// (and any early client frame) is never dropped.
interface WsProxyData {
  upstream: WebSocket;
  toClient: Array<string | ArrayBuffer>;
  toUpstream: Array<string | ArrayBuffer>;
  clientOpen: boolean;
  upstreamOpen: boolean;
  upstreamClosed: boolean;
  client?: ServerWebSocket<WsProxyData>;
}

// Coerce a Buffer/typed-array frame to a standalone ArrayBuffer (copying the
// exact byte window), leaving strings untouched.
function wsFrame(data: string | ArrayBuffer | ArrayBufferView): string | ArrayBuffer {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

// Reverse-proxy a WebSocket upgrade (Next.js HMR lives at /_next/webpack-hmr)
// to the live web server. fetch() can't carry an upgrade, so we bridge two
// sockets: dial the upstream WS, accept the client WS via server.upgrade, and
// pump frames both ways. The websocket handler below does the pumping.
export async function proxyWebSocketUpgrade(request: Request, server: Server<WsProxyData>, config: RuntimeConfig): Promise<Response | undefined> {
  const port = await resolveWebPort(config);
  if (port === null) return new Response("Web UI not running", { status: 502 });
  const url = new URL(request.url);
  const wsUrl = `ws://127.0.0.1:${port}${url.pathname}${url.search}`;
  const proto = request.headers.get("sec-websocket-protocol");
  const upstream = proto
    ? new WebSocket(wsUrl, proto.split(",").map((p) => p.trim()))
    : new WebSocket(wsUrl);
  upstream.binaryType = "arraybuffer";
  const data: WsProxyData = { upstream, toClient: [], toUpstream: [], clientOpen: false, upstreamOpen: false, upstreamClosed: false };
  // Bound the handshake: if the upstream never opens (slow/hung web server),
  // tear it down rather than buffering client frames into toUpstream forever.
  const handshakeTimer = setTimeout(() => {
    if (!data.upstreamOpen) { try { upstream.close(); } catch { /* already closing */ } }
  }, WS_HANDSHAKE_TIMEOUT_MS);
  upstream.addEventListener("open", () => {
    clearTimeout(handshakeTimer);
    data.upstreamOpen = true;
    for (const m of data.toUpstream) { try { upstream.send(m); } catch { /* dropped */ } }
    data.toUpstream = [];
  });
  upstream.addEventListener("message", (event) => {
    const payload = wsFrame(event.data as string | ArrayBuffer | ArrayBufferView);
    if (data.clientOpen && data.client) { try { data.client.send(payload); } catch { /* dropped */ } }
    else data.toClient.push(payload);
  });
  // Register failure handlers immediately — an upstream that dies BEFORE the
  // client socket opens (e.g. a refused dial during a web restart) would
  // otherwise leave the client half-open with frames buffered forever. If the
  // client is already up we close it now; if not, open() reads upstreamClosed.
  const onUpstreamDown = (code?: number) => {
    clearTimeout(handshakeTimer);
    data.upstreamClosed = true;
    // Normalize the code (reserved codes like 1006 throw) and omit the reason
    // (an over-long upstream reason would also throw on close()).
    if (data.client) { try { data.client.close(safeCloseCode(code)); } catch { /* already closed */ } }
  };
  upstream.addEventListener("close", (event) => onUpstreamDown(event.code));
  upstream.addEventListener("error", () => {
    // A failed dial means the validated port may be stale; drop it so the next
    // request re-validates (mirrors the HTTP proxy's fetch-failure handling).
    clearWebTargetCache(config.instance);
    onUpstreamDown();
  });
  if (!server.upgrade(request, { data })) {
    upstream.close();
    return new Response("WebSocket upgrade failed", { status: 426 });
  }
  return undefined;
}

// Bun.serve `websocket` handler for proxied client sockets. Wired in
// src/server.ts. Pairs with proxyWebSocketUpgrade above.
//
// perMessageDeflate is OFF: the upstream client already hands us decompressed
// frames, so re-compressing on the browser leg only risks RSV-bit mismatches
// (the browser rejecting frames it didn't negotiate compression for). Frames
// pass through uncompressed end to end.
export const webSocketProxyHandler = {
  perMessageDeflate: false as const,
  open(ws: ServerWebSocket<WsProxyData>) {
    ws.data.client = ws;
    ws.data.clientOpen = true;
    // The upstream may have died during the upgrade window; its failure
    // handler (registered at dial time) couldn't reach a client that didn't
    // exist yet, so honor the flag here.
    if (ws.data.upstreamClosed) { try { ws.close(); } catch { /* already closed */ } return; }
    for (const m of ws.data.toClient) { try { ws.send(m); } catch { /* dropped */ } }
    ws.data.toClient = [];
  },
  message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer) {
    const frame = wsFrame(message);
    if (ws.data.upstreamOpen) { try { ws.data.upstream.send(frame); } catch { /* dropped */ } }
    else ws.data.toUpstream.push(frame);
  },
  close(ws: ServerWebSocket<WsProxyData>) {
    try { ws.data.upstream.close(); } catch { /* already closed */ }
  },
};

// Below this size, compression's header + CPU cost isn't worth it (and tiny
// JSON bodies move through the relay in one round-trip anyway). 1 KB is the
// usual break-even; the giant wins (/api/state, /api/tasks) are megabytes.
const COMPRESS_MIN_BYTES = 1024;
// Brotli quality for on-the-fly response compression. q4 is the measured sweet
// spot on this runtime: on a 9,322,556-byte /api/state body it compressed in
// 15.64ms/call (FASTER than gzip's 17.68ms) to 539,054 bytes (21.73% smaller
// than gzip's 688,677 bytes), averaged over 20 runs. Higher qualities cost more
// CPU for little gain (q5: 34.17ms -> 491,246 bytes; q6: 40.50ms -> 486,896
// bytes) and q11 runs multiple seconds, so they're avoided. br q4 is thus a
// strict win over gzip on both axes; gzip stays as the fallback for clients
// that only accept it.
const BROTLI_QUALITY = 4;
// Content types worth compressing. Text-shaped, highly-compressible payloads.
// Deliberately EXCLUDES text/event-stream — an SSE body is an open-ended stream
// whose arrayBuffer() would never resolve, so it must pass through untouched.
function isCompressibleContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/event-stream")) return false;
  return (
    ct.startsWith("application/json") ||
    ct.startsWith("text/") ||
    ct.startsWith("application/javascript") ||
    ct.startsWith("application/xml") ||
    ct.includes("+json") ||
    ct.includes("+xml")
  );
}
// Pick the response Content-Encoding from the client's Accept-Encoding,
// preferring brotli (best ratio AND faster than gzip at q4) over gzip. Returns
// null when the client accepts neither, or explicitly opts a codec out with
// `q=0`. Tolerant of the usual `br, gzip` / `gzip;q=1.0, br;q=0` shapes — we
// only need presence + a non-zero q, not full q-value ranking, since br is
// always our first choice when offered.
function negotiateEncoding(request: Request): "br" | "gzip" | null {
  const ae = request.headers.get("accept-encoding");
  if (!ae) return null;
  const accepted = new Set<string>();
  for (const part of ae.toLowerCase().split(",")) {
    const [enc, ...params] = part.trim().split(";");
    const name = enc.trim();
    if (name !== "br" && name !== "gzip") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue; // explicit opt-out
    accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}
// Compress a response body with the client's negotiated encoding (brotli
// preferred, gzip fallback) when the body is a compressible, non-streaming
// payload over the size threshold. Buffers the body (safe because we've
// excluded SSE by content-type), compresses, and rewrites the headers: set
// Content-Encoding, drop the stale Content-Length (the new length is the
// compressed size, which the Response recomputes), and append `Accept-Encoding`
// to Vary so a shared cache keys on it. A response that's already encoded, too
// small, streamed, or an incompressible type passes straight through.
//
// This is the single biggest transport win on a bandwidth-capped relay: a
// JSON body of several MB compresses to a fraction of its size, so the
// fixed-rate tunnel ships far fewer bytes.
async function maybeCompress(request: Request, response: Response): Promise<Response> {
  const encoding = negotiateEncoding(request);
  if (!encoding) return response;
  // Never re-encode an already-encoded body (e.g. an upstream Next response
  // we proxied that already carries Content-Encoding).
  if (response.headers.has("content-encoding")) return response;
  // No body to compress (204/304, HEAD, or an empty body).
  if (!response.body || response.status === 204 || response.status === 304) return response;
  // Never compress a byte-range / partial response. A Content-Range is
  // computed against the UNENCODED representation (RFC 7233 §4.2), so adding
  // Content-Encoding to a 206 slice — or to any response answering a Range
  // request — corrupts the range contract for a client reassembling ranges.
  // The native /api/uploads/:id media endpoint serves such 206s.
  if (response.status === 206 || response.headers.has("content-range") || request.headers.has("range")) {
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!isCompressibleContentType(contentType)) return response;
  // Buffer the body. Safe: SSE (the only never-ending body) was excluded by
  // the content-type guard above.
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength < COMPRESS_MIN_BYTES) {
    // Too small to be worth it — rebuild the response from the buffered
    // bytes (the original body stream is already consumed).
    return new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  const compressed = encoding === "br"
    ? brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        // Hint the input size so brotli sizes its window without
        // over-allocating.
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength
      }
    })
    : Bun.gzipSync(raw);
  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.delete("content-length"); // recomputed from the new body
  const priorVary = headers.get("vary");
  headers.set("vary", priorVary ? `${priorVary}, Accept-Encoding` : "Accept-Encoding");
  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

// --- Relay device-pairing (operator-approved cookie sessions) ---------------
// See ADR device-pairing-auth.md. gini_pair carries the per-request binding
// secret (scoped to /api/pairing so it only rides pairing calls); gini_session
// carries the minted session token (scoped to the whole app).
//
// gini_session uses the `__Host-` prefix when issued over a secure transport and
// the plain name otherwise. On the shared relay registrable domain
// (*.gini-relay.lilaclabs.ai) a sibling tenant could set a Domain-scoped
// `gini_session` that the browser also sends to the victim's subdomain; the
// cookie parser's last-duplicate-wins would let it override the victim's
// host-only cookie (a session/handshake denial — the tossed value still fails the
// server-side hash check, so this is availability, not forgery). `__Host-`
// cookies forbid a Domain attribute, so the browser rejects the sibling's tossed
// cookie and the victim's prefixed cookie always wins. The prefix is conditional
// because `__Host-` mandates Secure, which a deliberately-supported plain-http
// GINI_TRUSTED_ORIGINS front cannot use (pairingCookieSecure() returns false
// there) — that front keeps the plain name. gini_pair stays plain: it is
// single-use, cleared on claim, and Path-scoped to /api/pairing (incompatible
// with `__Host-`'s Path=/ requirement), whereas gini_session is the durable,
// owner-equivalent credential and the high-value tossing target.
const PAIR_BIND_COOKIE = "gini_pair";
export const SESSION_COOKIE = "gini_session";
const SESSION_COOKIE_SECURE = `__Host-${SESSION_COOKIE}`;

// Stable per-browser id cookie. Unlike gini_session (which a re-pair re-mints) it
// persists across re-pairs, so device identity can key on it instead of the
// fuzzy User-Agent label — two distinct browsers on one relay subdomain with the
// same User-Agent then no longer evict each other on re-pair. It mirrors
// gini_session, NOT gini_pair: it is durable and Path=/ (the `__Host-` prefix
// mandates Path=/, which gini_pair's /api/pairing scope can't use). It carries no
// secret — only an opaque dedup id — so it is not a credential; the gini_session
// token remains the entire access decision.
const CLIENT_COOKIE = "gini_client";
const CLIENT_COOKIE_SECURE = `__Host-${CLIENT_COOKIE}`;
// Native (cookieless) clients send the same id in this header instead.
const CLIENT_ID_HEADER = "x-gini-client-id";

// The session cookie NAME to issue: `__Host-`-prefixed on a secure front (so a
// sibling-subdomain Domain cookie can't toss it), plain otherwise.
function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

// Read the session token from whichever name was issued: prefer the secure
// `__Host-` cookie (authoritative on a secure front and un-tossable), fall back
// to the plain name (a plain-http front, or a session minted before the prefix).
export function sessionCookieValue(request: Request): string | undefined {
  return cookieValue(request, SESSION_COOKIE_SECURE) ?? cookieValue(request, SESSION_COOKIE);
}

// The client-id cookie NAME to issue: `__Host-`-prefixed on a secure front,
// plain otherwise. Mirrors sessionCookieName so the two stay in lockstep.
function clientCookieName(secure: boolean): string {
  return secure ? CLIENT_COOKIE_SECURE : CLIENT_COOKIE;
}

// Read the per-browser client id. On a secure front read ONLY the un-tossable
// `__Host-gini_client` — NOT the plain name. Unlike gini_session (whose value is
// hash-validated and fails closed on a tossed value), the client id is used
// verbatim as an identity key with no server-side check, so honoring a plain
// `gini_client` that a sibling subdomain tossed onto the shared registrable domain
// would let two browsers collapse to one identity (the very eviction this guards
// against). On a secure front the gateway only ever issues the `__Host-` name, so
// dropping the plain fallback loses nothing legitimate. The plain name is read
// only on a plain-http front, which can't use `__Host-` at all.
export function clientCookieValue(request: Request, secure: boolean): string | undefined {
  if (secure) return cookieValue(request, CLIENT_COOKIE_SECURE);
  return cookieValue(request, CLIENT_COOKIE);
}

// Gateway-owned cookies that must never reach the inner web child: it is
// relay-agnostic and authenticates via the BFF's owner bearer, never these, so
// stripping them (in proxyWeb) keeps the pairing credentials from crossing into
// the inner app. Both session and client cookie names are stripped.
const GATEWAY_ONLY_COOKIES = new Set([
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  PAIR_BIND_COOKIE,
  CLIENT_COOKIE,
  CLIENT_COOKIE_SECURE
]);
// `gini_session` cookie Max-Age, pinned to the browser-max 400 days (the server
// session itself never expires; see SESSION_COOKIE_MAX_AGE_MS). Re-issued on each
// document navigation so an active session's window slides forward.
const SESSION_COOKIE_TTL_SECONDS = Math.floor(SESSION_COOKIE_MAX_AGE_MS / 1000);
const PAIR_BIND_COOKIE_TTL_SECONDS = 3600;
// The client id must live at least as long as the session it identifies, so it
// shares the session cookie's 400-day browser-max lifetime. A shorter lifetime
// would let gini_client lapse while a still-alive session slides past it (the
// session cookie is re-issued on navigation), after which a re-pair would mint a
// fresh clientId and fail to supersede the prior session — a stale duplicate.
const CLIENT_COOKIE_TTL_SECONDS = SESSION_COOKIE_TTL_SECONDS;
// Flood control on the public create endpoint. Keyed on the inbound Host (the
// relay subdomain is un-forgeable — the relay owns its DNS), NOT on
// X-Forwarded-For, which a client can spoof to mint fresh buckets. A separate
// global bucket backstops the per-host limit so many distinct hosts can't add
// up to an unbounded flood. The MAX_PENDING cap is enforced atomically inside
// createPairingRequest (see src/state/records.ts), not here.
const pairingHostLimiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 });
const pairingGlobalLimiter = new RateLimiter({ capacity: 40, refillPerSec: 40 / 60 });
// Separate buckets for the legacy public code-claim endpoint so brute-force
// attempts there can't be confused with (or starve) the request-create budget,
// and vice versa. Same capacity/refill shape — a real claim is a single POST.
const pairingClaimHostLimiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 });
const pairingClaimGlobalLimiter = new RateLimiter({ capacity: 40, refillPerSec: 40 / 60 });

// Test hook: drop the in-process pairing limiter buckets so a test file's many
// create calls don't deplete the shared module-level buckets across tests.
export function resetPairingLimiters(): void {
  pairingHostLimiter.reset();
  pairingGlobalLimiter.reset();
  pairingClaimHostLimiter.reset();
  pairingClaimGlobalLimiter.reset();
}

const sessionCookieAttributes = { httpOnly: true, sameSite: "Lax" as const, path: "/" };
const bindCookieAttributes = { httpOnly: true, sameSite: "Lax" as const, path: "/api/pairing" };

function randomBindSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Whether to set Secure on pairing cookies. The relay front is always HTTPS,
// loopback is a secure context, and a runtime-managed tunnel front (tailscale
// serve / ngrok / cloudflared) only ever publishes https URLs — all three get
// Secure regardless of what the proxied hop looks like. A plain-http
// GINI_TRUSTED_ORIGINS front would otherwise have its Secure cookie silently
// dropped by the browser; honor X-Forwarded-Proto / the request scheme so such
// a front can still pair.
function pairingCookieSecure(request: Request, host: string): boolean {
  if (isRelayHost(host) || isLoopbackHost(host) || isRuntimeTunnelHost(host)) return true;
  if ((request.headers.get("x-forwarded-proto") ?? "").toLowerCase() === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function pairingCreateAllowed(request: Request): boolean {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  // Both buckets must admit the request; consume per-host first, then global.
  return pairingHostLimiter.tryConsume(host) && pairingGlobalLimiter.tryConsume("global");
}

// Clamp a client-supplied device label before it is stored and shown on the
// operator's approval row: strip control chars, collapse whitespace, trim, and
// cap length. Returns undefined for absent/blank input so the state layer applies
// the User-Agent-derived fallback ("…"/"Unknown device") in one place.
function sanitizeDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Drop control characters (codepoint below 0x20, and DEL 0x7f) by codepoint so
  // no literal control chars live in this source; then collapse whitespace, trim,
  // and cap length.
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

function pairingClaimAllowed(request: Request): boolean {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return pairingClaimHostLimiter.tryConsume(host) && pairingClaimGlobalLimiter.tryConsume("global");
}

// A non-browser pairing client (the native mobile app). It cannot read the
// HttpOnly gini_pair / gini_session cookies, so it carries the per-request
// binding secret in a header and needs the session token returned in the claim
// BODY. Recognising it must be unforgeable from a browser: browsers always send
// Sec-Fetch-* on fetch/XHR and JS cannot set or strip those (forbidden header
// names), so their ABSENCE is a reliable "not a browser" signal — an XSS on the
// /pair page can therefore never coax the token into the body. We also require
// an explicit opt-in header (so a pre-Sec-Fetch browser that merely lacks the
// headers is still excluded) and a trusted front (relay, loopback, or a
// runtime-managed tunnel's connected host). This single
// gate authorises BOTH the no-Origin CSRF exemption on the POST device routes
// AND the in-body bind secret / session token — keeping the browser flow
// (cookie-only, no body token) byte-for-byte unchanged. See ADR
// device-pairing-auth.md ("Native pairing client").
function isNativePairingClient(request: Request, host: string): boolean {
  if (request.headers.get("x-gini-pair-client") !== "native") return false;
  if (
    request.headers.has("sec-fetch-site")
    || request.headers.has("sec-fetch-mode")
    || request.headers.has("sec-fetch-dest")
  ) {
    return false;
  }
  // Also require no Origin. Sec-Fetch absence alone is not enough: a pre-16.4
  // Safari or an iOS-15 WKWebView/SFSafariViewController sends NO Sec-Fetch yet
  // DOES send Origin on an unsafe POST (Origin-on-same-origin-POST shipped years
  // before Fetch Metadata), so such a browser could otherwise forge native mode
  // and an XSS on /pair could exfiltrate the in-body secret/token. The native
  // client (Expo/RN fetch) sends no Origin, so this never affects it.
  if (request.headers.has("origin")) return false;
  // Trusted fronts: the relay, loopback, and a runtime-managed tunnel's
  // connected host — the same provider-owned-DNS reasoning as the web lanes,
  // so the mobile app can pair through a tailscale/ngrok/cloudflare front too.
  return isRelayHost(host) || isLoopbackHost(host) || isRuntimeTunnelHost(host);
}

// The per-request binding secret, sourced by the single native gate: a verified
// native client reads ONLY the X-Gini-Pair-Secret header, a browser ONLY the
// HttpOnly gini_pair cookie. Header-only for native is deliberate — iOS
// NSURLSession auto-attaches a persisted gini_pair cookie, and a cookie-first
// read would prefer a STALE cookie from a prior/abandoned attempt over the fresh
// header secret, yielding an intermittent bind_mismatch. Native is cookieless by
// construction (create sets no cookie for it), so the header is the only source.
function pairBindSecret(request: Request, native: boolean): string | undefined {
  if (native) return request.headers.get("x-gini-pair-secret") ?? undefined;
  return cookieValue(request, PAIR_BIND_COOKIE) ?? undefined;
}

// iOS universal-links association file. A wildcard associated domain
// (`applinks:*.<relayDomain>`) is validated by Apple PER SUBDOMAIN, not at the
// apex — so the gateway, which serves each relay subdomain through the tunnel,
// hosts this. Must be public, reachable unpaired, and served with no redirect
// (Apple's CDN refuses redirected AASA). The appID is the Apple Team ID +
// bundle id; env-overridable so a team/bundle change needs no code edit. See
// docs/adr/device-pairing-auth.md ("Native pairing client").
const APPLE_APP_SITE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";

function iosAppId(): string {
  return process.env.GINI_IOS_APP_ID ?? "WB6Y3K67AB.ai.lilaclabs.gini.mobile";
}

export function appleAppSiteAssociationResponse(): Response {
  // Modern `components` form. Claim the bare relay origin (the link a user taps)
  // plus the /pair entry so a tap opens the app straight into the handshake;
  // assets and /api are left to the browser/native surfaces.
  const body = JSON.stringify({
    applinks: {
      details: [
        {
          appIDs: [iosAppId()],
          components: [
            { "/": "/", comment: "Bare relay origin opens the Gini app to pair." },
            { "/": "/pair", comment: "Pairing entry." },
            { "/": "/pair/*", comment: "Pairing entry subpaths." }
          ]
        }
      ]
    }
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Apple caches via its CDN regardless; a short max-age keeps a tunnel
      // restart from pinning a stale association for long.
      "cache-control": "public, max-age=3600"
    }
  });
}

// Paths an UNPAIRED relay browser may still reach so it can run the pairing
// handshake: the /pair page, Next's build assets, and static files. Never an
// /api path (those are gated separately).
export function isPairingBootstrapPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname === "/pair" || pathname.startsWith("/pair/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return /\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|css|js|map|json|txt)$/.test(pathname);
}

// True when a web-bound request must carry a valid gini_session cookie: a
// non-loopback (relay/allowlisted) front on a non-bootstrap path. Shared by the
// HTTP fall-through (src/http.ts) and the WS upgrade (src/server.ts) so the two
// relay-session gates can't drift; each caller keeps its own transport-specific
// rejection (HTTP redirects page navs / 401s the API; WS returns a flat 401).
export function relaySessionGateRequired(host: string, pathname: string): boolean {
  return !isLoopbackHost(host) && !isPairingBootstrapPath(pathname);
}

// Exactly the device-pairing paths the gateway handles natively before the
// bearer gate — enumerated, not prefix-matched, so a future
// /api/pairing/request-* route is NOT silently captured here and must be added
// deliberately. Mirrors the route matching inside handlePairingRoutes.
function isDevicePairingPath(pathname: string): boolean {
  if (pathname === "/api/pairing/request" || pathname === "/api/pairing/requests") return true;
  if (/^\/api\/pairing\/requests\/[^/]+\/(approve|reject)$/.test(pathname)) return true;
  return /^\/api\/pairing\/request\/[^/]+(\/(claim|cancel))?$/.test(pathname);
}

// Gateway-handled pairing API. Lives on the native /api surface but is
// special-cased BEFORE the bearer gate so it can apply its own trust rules from
// the TRUE inbound Host/Origin: admin routes require loopback OR a valid
// gini_session (the mirror model — a paired relay session is admin like
// loopback); device routes are public but bound to the gini_pair cookie.
async function handlePairingRoutes(request: Request, url: URL, config: RuntimeConfig): Promise<Response> {
  const host = request.headers.get("host") ?? url.host;
  // Host/Origin/CSRF trust for every pairing call (same gate as the proxied
  // surface). Blocks cross-site POSTs and untrusted hosts. The native mobile
  // app sends no Origin (so the browser CSRF gate would refuse its POSTs) and is
  // not a confused deputy — a verified native client on a trusted front is
  // exempt. Browsers still go through webBoundRequestAllowed; the admin routes
  // below re-validate the session regardless.
  const native = isNativePairingClient(request, host);
  if (!webBoundRequestAllowed(request) && !native) return json({ error: "Forbidden" }, 403);
  const path = url.pathname;
  const method = request.method;

  // Admin routes — an admin is the loopback operator OR any PAIRED session. A
  // relay browser calls these SAME-ORIGIN (so webBoundRequestAllowed above already
  // enforced relay-Origin==relay-Host CSRF trust) and carries its gini_session
  // cookie, which we validate here: once paired, a relay session is a full mirror
  // of loopback and can approve/add devices exactly like 127.0.0.1. An UNPAIRED
  // relay visitor has no session, so it is refused. The only relay-specific gate
  // is the initial pairing handshake. See ADR device-pairing-auth.md ("Relay
  // sessions mirror loopback"). DELIBERATE — do not narrow this back to loopback.
  const isList = path === "/api/pairing/requests";
  const approve = path.match(/^\/api\/pairing\/requests\/([^/]+)\/approve$/);
  const reject = path.match(/^\/api\/pairing\/requests\/([^/]+)\/reject$/);
  if (isList || approve || reject) {
    const sessionToken = sessionCookieValue(request);
    const isAdmin = isLoopbackHost(host) || Boolean(sessionToken && resolveSessionFromCookie(config, sessionToken));
    if (!isAdmin) return json({ error: "Forbidden" }, 403);
    if (method === "GET" && isList) return json({ requests: await listPairingRequests(config) });
    if (method === "POST" && approve) return json({ request: await approvePairing(config, approve[1]!) });
    if (method === "POST" && reject) return json({ request: await rejectPairing(config, reject[1]!) });
    return json({ error: "Not found" }, 404);
  }

  // Device: create a request (public, rate-limited, sets the binding cookie).
  if (method === "POST" && path === "/api/pairing/request") {
    if (!pairingCreateAllowed(request)) {
      return json({ error: "Too many pairing requests. Try again shortly." }, 429);
    }
    const bindSecret = randomBindSecret();
    // Optional human label the native client supplies in the body (e.g. its model
    // name) so the operator's approval row reads "iPhone 16 Pro" rather than
    // "Unknown device". Absent/blank → undefined, and the state layer falls back
    // to the User-Agent-derived label.
    const deviceName = sanitizeDeviceName((await body(request)).deviceName);
    // The stable per-browser/per-install id. A browser already paired here re-sends
    // its gini_client cookie (reused as-is so identity is stable across re-pairs);
    // a first-time browser sends none, so the gateway mints one and persists it as
    // the cookie below (always a string for the browser path). A native client owns
    // its id locally and sends it in the X-Gini-Client-ID header — the gateway must
    // NEVER mint one for native: a server-minted id is write-only to a cookieless
    // client (it can't be echoed back), so each re-pair would get a fresh id and
    // stack a second active session. A native client with no header therefore gets
    // clientId=undefined and keeps the legacy origin+name supersede. An empty
    // header/cookie is treated as absent.
    const cookieSecure = pairingCookieSecure(request, host);
    const browserClientId = clientCookieValue(request, cookieSecure) || randomBindSecret();
    const clientId = native ? request.headers.get(CLIENT_ID_HEADER) || undefined : browserClientId;
    let created: Awaited<ReturnType<typeof requestPairing>>;
    try {
      created = await requestPairing(config, {
        userAgent: request.headers.get("user-agent") ?? "",
        relayHost: host,
        bindSecret,
        deviceName,
        clientId
      });
    } catch (error) {
      // Cap enforced atomically inside the create mutation.
      if (error instanceof PairingCapExceededError) return json({ error: error.message }, 429);
      throw error;
    }
    // Browsers receive the binding secret ONLY as the HttpOnly gini_pair cookie.
    // A verified native client is cookieless: it gets the secret in the body and
    // echoes it back via X-Gini-Pair-Secret, and we set NO cookie for it — an iOS
    // cookie jar would otherwise persist a gini_pair the gateway never reads and
    // that could go stale across attempts.
    const response = json(
      native ? { id: created.id, code: created.code, bindSecret } : { id: created.id, code: created.code },
      201
    );
    if (!native) {
      const secure = cookieSecure;
      response.headers.append(
        "set-cookie",
        serializeCookie(PAIR_BIND_COOKIE, bindSecret, {
          ...bindCookieAttributes,
          secure,
          maxAge: PAIR_BIND_COOKIE_TTL_SECONDS
        })
      );
      // Persist the per-browser id (minted fresh or refreshing an existing one's
      // Max-Age). Native clients own their id locally and stay cookieless.
      response.headers.append(
        "set-cookie",
        serializeCookie(clientCookieName(secure), browserClientId, {
          ...sessionCookieAttributes,
          secure,
          maxAge: CLIENT_COOKIE_TTL_SECONDS
        })
      );
    }
    return response;
  }

  // Device: poll own request status (bind-checked — the binding cookie must
  // match this request, not merely exist).
  const poll = path.match(/^\/api\/pairing\/request\/([^/]+)$/);
  if (method === "GET" && poll) {
    const bindSecret = pairBindSecret(request, native);
    if (!bindSecret) return json({ error: "Unauthorized" }, 401);
    const result = pollPairingStatus(config, poll[1]!, bindSecret);
    if (!result.ok) return json({ error: result.reason }, result.reason === "not_found" ? 404 : 403);
    return json({ status: result.status });
  }

  // Device: claim an approved request → mint the session, set the cookie.
  const claim = path.match(/^\/api\/pairing\/request\/([^/]+)\/claim$/);
  if (method === "POST" && claim) {
    const bindSecret = pairBindSecret(request, native);
    if (!bindSecret) return json({ error: "Unauthorized" }, 401);
    const result = await claimPairingSession(config, claim[1]!, bindSecret);
    if (!result.ok) {
      const code = result.reason === "not_found" ? 404 : result.reason === "bind_mismatch" ? 403 : 409;
      return json({ error: result.reason }, code);
    }
    const secure = pairingCookieSecure(request, host);
    // Browsers: the success signal is the 200 + the gini_session Set-Cookie
    // below, never the body (an HttpOnly cookie an XSS can't exfiltrate). A
    // verified native client, which can't read Set-Cookie, gets the token in the
    // body so it can store it and send it as `Authorization: Bearer` — the same
    // token, just the transport a non-browser needs.
    const response = json(native ? { ok: true, token: result.token } : { ok: true });
    if (!native) {
      response.headers.append(
        "set-cookie",
        serializeCookie(sessionCookieName(secure), result.token, { ...sessionCookieAttributes, secure, maxAge: SESSION_COOKIE_TTL_SECONDS })
      );
      // The binding cookie is single-use; clear it now that the session is minted.
      // (A native client set no gini_pair cookie, so there's nothing to clear.)
      response.headers.append("set-cookie", serializeCookie(PAIR_BIND_COOKIE, "", { ...bindCookieAttributes, secure, maxAge: 0 }));
    }
    return response;
  }

  // Device: cancel own pending/approved request (binding cookie required).
  const cancel = path.match(/^\/api\/pairing\/request\/([^/]+)\/cancel$/);
  if (method === "POST" && cancel) {
    const bindSecret = pairBindSecret(request, native);
    if (!bindSecret) return json({ error: "Unauthorized" }, 401);
    const result = await cancelPairing(config, cancel[1]!, bindSecret);
    if (!result.ok) return json({ error: result.reason }, result.reason === "not_found" ? 404 : 403);
    const response = json({ ok: true });
    response.headers.append(
      "set-cookie",
      serializeCookie(PAIR_BIND_COOKIE, "", { ...bindCookieAttributes, secure: pairingCookieSecure(request, host), maxAge: 0 })
    );
    return response;
  }

  return json({ error: "Not found" }, 404);
}

// A GET (or HEAD) for a single upload may be authorized by a capability
// SIGNATURE (`?exp=&sig=`) instead of a bearer, so a mobile in-app browser —
// which can't attach the bearer header or carry the gateway cookie — can open
// a preview url. The signature is HMAC'd with the owner config token, scoped to
// the exact upload id in the path, and expires. It authorizes ONLY this route;
// `authorized` falls through to it only after the bearer check fails. See
// src/lib/upload-signing.ts and ADR outbound-chat-attachments.md.
const UPLOAD_GET_PATH = /^\/api\/uploads\/([^/]+)$/;
function signedUploadAccess(request: Request, config: RuntimeConfig): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  const match = url.pathname.match(UPLOAD_GET_PATH);
  if (!match) return false;
  return verifyUploadSignature(
    config.token,
    match[1]!,
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
    Date.now()
  );
}

async function authorized(request: Request, config: RuntimeConfig): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const queryToken = new URL(request.url).searchParams.get("token");
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
  if (await authorizedBearer(config, bearer ?? undefined)) return true;
  // No valid bearer — accept a scoped, unexpired upload capability signature.
  return signedUploadAccess(request, config);
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

// Session ids the user has no surface to open, and therefore no way to
// mark read. The badge / unread endpoints exclude these so they don't
// count blocks that can never be cleared — otherwise the iOS app-icon
// badge pins at a number with no UI to drain it. Two ways a session
// becomes unreachable, both hidden by every client's list filters:
//   1. The session itself is archived (`archivedAt`) — e.g. a deleted
//      recurring-job channel. Hidden by the `!archivedAt` filter on the
//      web rail and mobile channel list, regardless of `kind`.
//   2. A non-channel session whose owning agent is archived — the agent's
//      own chat: its canonical `kind: "agent"` session AND any hidden
//      legacy `kind: undefined` session it still owns (Resolved Decision A
//      keeps demoted legacy sessions kind-less and hidden, never deleted).
//      The session keeps no `archivedAt` of its own (archiveAgent stamps
//      only the agent), but both clients render archived agents in a
//      Restore-only group with no affordance to open their chats, so the
//      chat is unreachable until the agent is restored. This deliberately
//      EXCLUDES a job CHANNEL (`kind: "channel"` / `origin: "job"`): the
//      rails list channels by kind/origin + `!archivedAt`, never by agent
//      state, so a channel stays visible and openable even when its owning
//      agent is archived and must keep counting until archived in its own
//      right. Hence the predicate is `!isJobChannel`, not `kind === "agent"`
//      — narrowing it to `=== "agent"` would re-pin the badge on hidden
//      legacy sessions of archived agents.
// Reachability state lives in the JSON store (chatSessions + agents),
// not memory.db, so it's resolved here and passed to the SQLite
// accounting as an exclusion set.
function unreachableSessionIds(config: RuntimeConfig): string[] {
  const state = readState(config.instance);
  const archivedAgentIds = new Set(
    state.agents.filter((agent) => agent.archivedAt).map((agent) => agent.id)
  );
  const ids = new Set<string>();
  for (const session of state.chatSessions) {
    if (session.archivedAt) {
      ids.add(session.id);
      continue;
    }
    // A job channel stays on the rail (clients key on kind/origin +
    // !archivedAt, never on agent state), so it's still reachable even
    // when its owning agent is archived — leave it counting. Only the
    // agent's own chat disappears with the agent.
    const isJobChannel = session.kind === "channel" || session.origin === "job";
    if (!isJobChannel && session.agentId && archivedAgentIds.has(session.agentId)) {
      ids.add(session.id);
    }
  }
  return [...ids];
}

function json(value: unknown, statusCode = 200): Response {
  return Response.json(value, { status: statusCode });
}

// Parse a single HTTP Range header against a known total byte length. Handles
// the three forms that matter for media streaming: `bytes=start-end`,
// `bytes=start-` (open-ended, to EOF), and `bytes=-suffix` (the last N bytes).
// Returns the resolved inclusive [start, end] for a satisfiable range,
// "unsatisfiable" for a syntactically valid range that lies past the file (→
// 416), or null when there's no/unsupported Range header (→ serve the full
// body). Multi-range requests (a comma in the spec) are intentionally declined
// to null — AVPlayer never sends them, and serving the whole body is a valid
// response to any Range request.
function parseByteRange(
  header: string | null,
  total: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  // An empty file can't satisfy any range; RFC 7233 maps that to 416.
  if (total === 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix form `bytes=-N`: the final N bytes. `bytes=-0` is unsatisfiable.
    if (rawEnd === "") return null;
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    // A start at or past EOF is a valid-but-unsatisfiable range (→ 416). Check
    // this before clamping `end`, otherwise an open-ended `bytes=<past-eof>-`
    // collapses to start > end and would be misread as a malformed range.
    if (start >= total) return "unsatisfiable";
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (start > end) return null;
    end = Math.min(end, total - 1);
  }
  return { start, end };
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
  // Pairing approve/reject of a missing or already-resolved request.
  if (message === "Pairing request not found.") return 404;
  if (message.startsWith("Pairing request is already")) return 409;
  // Chat-session and thread submit paths (submitChatMessage,
  // submitThreadReply) throw these when the target was deleted or never
  // existed. Map to 404 so a stale link surfaces a clean not-found rather
  // than the catch-all 500.
  if (message.startsWith("Chat session not found")) return 404;
  if (message.startsWith("Thread not found")) return 404;
  // Agent create/rename name validation throws user-input errors that should
  // surface as 400 rather than the catch-all 500.
  if (message === "Agent name is required.") return 400;
  if (message === "New agent name is required.") return 400;
  if (message === '"default" is a reserved name.') return 400;
  if (message.startsWith("Invalid input")) return 400;
  // Agent delete/archive guards (default agent, active agent) and the
  // archived-agent activation guard throw user-input errors that should
  // surface as 400 rather than the catch-all 500.
  if (message.startsWith("Cannot delete")) return 400;
  if (message.startsWith("Cannot archive")) return 400;
  if (message.startsWith("Cannot use an archived agent")) return 400;
  // Hindsight memory routes (/memory/retain, /memory/recall,
  // /memory/reflect) and identity-file edit tools throw this when no
  // agent is active. Map to 400 so callers see a clean user-input error
  // rather than a 500.
  if (message.includes("no active agent")) return 400;
  // Browser-connect user-input failures: a bad cdpUrl (malformed, unsupported
  // protocol, blocked SSRF target) and an unreachable CDP endpoint are all
  // user-correctable, so forward them to 400 with the original text rather than
  // a generic "internal error".
  if (message.startsWith("Invalid cdpUrl")) return 400;
  if (message.startsWith("Unsupported cdpUrl protocol")) return 400;
  if (message.startsWith("Could not reach CDP endpoint")) return 400;
  // Browser discovery failures (no Chrome and no bundled Chromium to fall
  // back to) are user-correctable, so forward them to 400 with the original
  // text rather than a generic "internal error".
  if (message.startsWith("Could not locate")) return 400;
  if (message.startsWith("Web update is only available")) return 400;
  // updateRuntime's single-flight guard: a second POST /api/update while one
  // is running is a conflict, not a server error.
  if (message.startsWith("gini update already in progress")) return 409;
  // Messaging-bridge surface throws plain Error strings rather than the
  // "Invalid input:" prefix the rest of the codebase uses. Map the
  // expected user-error shapes to 400 / 404 so the HTTP layer doesn't
  // collapse them to a misleading 500.
  if (message.startsWith("Messaging bridge not found")) return 404;
  if (message.startsWith("Messaging bridge is not configured")) return 400;
  if (message.startsWith("Messaging bridge name is required")) return 400;
  // rejectPendingChat throws these when the operator clicks Reject
  // on a stale card (the pending row was re-DM'd and the code rotated)
  // or on a card whose chat was already enrolled by a parallel
  // operator. Both are user-input class — 400, not 500.
  if (message.startsWith("Cannot reject")) return 400;
  if (message.startsWith("Pairing request for chat")) return 400;
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
  // Tunnel selection/connect surface user-input failures (unknown or
  // disabled provider, nothing selected) as plain Error strings. Map them
  // to 400 so the panel can render the original reason rather than a 500.
  if (message.startsWith("Unknown tunnel provider")) return 400;
  if (message.startsWith("No tunnel provider selected")) return 400;
  if (/^Tunnel provider .+ is not available/.test(message)) return 400;
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
  deviceToken: string | null,
  streamId: string | null = null
): Response {
  let closed = false;
  let keepalive: Timer | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeSession: (() => void) | undefined;
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
  const initialSession = state.chatSessions.find((s) => s.id === sessionId);
  if (!initialSession) {
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
      // Mobile clients (with a valid X-Device-Token) register on the
      // per-device registry so the dispatcher can skip a redundant
      // completion push to THIS device — its open stream delivers the
      // block directly. Registering under a credential key instead would
      // wrongly suppress pushes to a foregrounded sibling device sharing
      // the same credential, so the device token is load-bearing here.
      //
      // Web/CLI clients carry NO X-Device-Token header. They register on
      // the pushless (per-session) registry so the dispatcher knows a
      // human is reading this chat on the web and can downgrade the OTHER
      // devices' completion alert to a silent badge refresh (no buzz for a
      // message the user is already looking at). The entry lives only
      // while the stream is open, so a client that sends and then closes
      // the tab leaves nothing behind and the phone gets its normal alert.
      //
      // The header-PRESENT-but-invalid case (a stale rotated token, or a
      // token paired to a different credential) is neither: deviceToken is
      // null, but treating it as web presence would let a real phone whose
      // persisted token went stale silence its OWN completion alerts on
      // cold launch (the mobile client primes a possibly-stale token onto
      // the handshake before it re-registers). So we register nothing for
      // that case — no per-device skip, no pushless downgrade — which is
      // the safe default (the phone keeps getting its alert).
      const rawDeviceHeader = request.headers.get("x-device-token");
      const deviceHeaderAbsent = !rawDeviceHeader || !rawDeviceHeader.trim();
      if (deviceToken) {
        unregisterSubscription = addSseSubscription(config.instance, deviceToken, sessionId, streamId ?? undefined);
      } else if (deviceHeaderAbsent) {
        unregisterSubscription = addPushlessSubscription(config.instance, sessionId);
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

      // Emit the current session record so subscribers always have a
      // title without a separate REST round-trip. The mobile chat
      // detail header reads from this; the web client can use it too
      // (or ignore it). Live updates flow through subscribeChatSession
      // below — currently fired on rename (explicit + auto-generated).
      // Frames omit an `id:` line; chat_session events are not
      // Last-Event-ID replayable. Reconnects always re-emit the
      // current record from this initial send, so missing a transient
      // rename frame is harmless.
      controller.enqueue(
        encoder.encode(
          `event: chat_session\ndata: ${JSON.stringify(initialSession)}\n\n`
        )
      );

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

      // Subscribe to session-record updates (title renames). Publishers
      // fire after mutateState resolves so the on-disk state matches the
      // event payload.
      unsubscribeSession = subscribeChatSession(config.instance, sessionId, (session) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(
            `event: chat_session\ndata: ${JSON.stringify(session)}\n\n`
          )
        );
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
      if (unsubscribeSession) unsubscribeSession();
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
