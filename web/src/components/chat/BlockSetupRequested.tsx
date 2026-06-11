"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CircleHelp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useSetupRequests, useInvalidate, useProviders } from "@/lib/queries";
import type { SetupRequest, SetupRequestedBlock } from "@runtime/types";
import { parseFillSecretSlots, type FillSecretSlot } from "@/lib/fill-secrets-types";

// User-actor gate: the user performs a setup step (sign in, enter
// credentials, fill a form, stand up a messaging bridge, approve an
// inbound pairing). No risk pill — the rule is structural per
// docs/adr/authorization-vs-setup-request.md. The action determines the
// layout (Connect button vs credential dialog vs inline inputs vs
// messaging-bridge form vs pairing/removal confirmation); every path POSTs
// to /api/setup-requests/<id>/{complete,cancel,open-browser}.
export function BlockSetupRequested({ block }: { block: SetupRequestedBlock }) {
  const invalidate = useInvalidate();
  const setupRequests = useSetupRequests();
  const providers = useProviders();
  const [expanded, setExpanded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const setup = (setupRequests.data ?? []).find((s) => s.id === block.setupRequestId) ?? null;
  const isPending = setup ? setup.status === "pending" : true;

  const cancel = useMutation({
    mutationFn: () =>
      api<SetupRequest>(`/setup-requests/${block.setupRequestId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      // Clear any typed credentials regardless of outcome. The Cancel
      // button on a fill_secret or messaging.add_bridge card never invokes
      // the respective submit mutation (and therefore never hits its
      // onSettled clear), so without this hook a user who typed a
      // credential and then clicked Cancel would leave the typed value
      // sitting in React state until the chat view unmounts. Cheap on
      // every other action — the setters are no-ops when the record /
      // string is already empty.
      setFillValues({});
      setBridgeToken("");
    }
  });

  const connect = useMutation({
    mutationFn: async (body: CreateConnectorBody) => {
      // The body carries ONLY the secret. For a templateless request (api-key
      // only) the name/type/metadata are all derived from the TRUSTED setup
      // payload server-side — the api-key name IS its env var, so there is no
      // client-supplied envMap. The secret value reaches the gateway only
      // through this POST and never through the model.
      return api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ secrets: body.secrets, scopes: body.scopes, name: body.name, metadata: body.metadata })
        }
      );
    },
    onSuccess: (result) => {
      if (result.ok) {
        setConnectOpen(false);
        setConnectError(null);
        invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        // The backend now claims the setup row BEFORE createConnector, so a
        // failed connect leaves the row `completed` (with a persisted
        // ok:false connectOutcome) — retrying the same setup id 410s. Close
        // the submit dialog and refresh setup-requests/tasks/chat (like the
        // other resolved cards do) so the card flips out of the retryable
        // dialog into the resolved-failure summary instead of stranding the
        // user on a dialog whose resubmit is Gone. The inline connectError
        // remains visible in that resolved-failure summary. The agent will
        // re-issue request_connector for a fresh card.
        setConnectOpen(false);
        setConnectError(result.message ?? "Could not connect. Please verify the credentials and try again.");
        invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      }
    },
    onError: (error: Error) => {
      // A thrown non-2xx (the backend already claimed the row before throwing)
      // is just as terminal as the ok:false path: the setup id is now Gone, so
      // the submit dialog must close and the same query set must be
      // invalidated so the card transitions to its resolved-failure summary
      // rather than a retryable dialog. The inline connectError stays visible
      // in that summary.
      setConnectOpen(false);
      setConnectError(error.message);
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
    }
  });

  const browserConnect = useMutation({
    mutationFn: async () => {
      const signInStarted = setup?.payload?.signInStarted === true;
      if (signInStarted) {
        return api<{ ok: boolean }>(`/setup-requests/${block.setupRequestId}/complete`, {
          method: "POST",
          body: JSON.stringify({})
        });
      }
      return api<{ ok: boolean }>(`/setup-requests/${block.setupRequestId}/open-browser`, {
        method: "POST"
      });
    },
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "browser"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // skill.grant_connector carries no secret — the credential already lives
  // in the connector record. The card is a pure consent gate: POST an empty
  // body to /complete, which appends the grant, enables the skill, and
  // resumes the chat-task loop. See docs/adr/skill-connector-consent.md.
  const grantSubmit = useMutation({
    mutationFn: async () =>
      api<{ ok: boolean }>(`/setup-requests/${block.setupRequestId}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }),
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const isBrowserConnect = block.action === "browser.connect";
  const isConnectorRequest = block.action === "connector.request";
  const isBrowserFillSecret = block.action === "browser.fill_secret";
  const isSkillGrant = block.action === "skill.grant_connector";
  const isMessagingAddBridge = block.action === "messaging.add_bridge";
  const isMessagingApprovePairing = block.action === "messaging.approve_pairing";
  const isMessagingRemoveBridge = block.action === "messaging.remove_bridge";
  const isChatChoice = block.action === "chat.choice";

  const providerId = isConnectorRequest && setup ? String(setup.payload?.provider ?? "") : "";
  const providerLabel = isConnectorRequest && setup
    ? typeof setup.payload?.providerLabel === "string"
      ? (setup.payload.providerLabel as string)
      : providerId
    : "";
  // Templateless connector.request: the payload carries an api-key
  // credentialType and credentialName with no registered provider. Thread
  // these into the dialog so it renders the type-driven secure input instead
  // of provider fields. (Detection mirrors http.ts: credentialType present &&
  // no provider.) Templateless is api-key ONLY — oauth2 requires a provider
  // module / setup skill (docs/adr/chat-credential-provisioning.md).
  const credentialType = isConnectorRequest && setup
    && setup.payload?.credentialType === "api-key"
    && !providerId
    ? ("api-key" as const)
    : undefined;
  const credentialName = isConnectorRequest && setup && typeof setup.payload?.credentialName === "string"
    ? (setup.payload.credentialName as string)
    : "";
  const credentialLabel = isConnectorRequest && setup && typeof setup.payload?.credentialLabel === "string"
    ? (setup.payload.credentialLabel as string)
    : credentialName;
  const credentialMcpUrl = isConnectorRequest && setup && typeof setup.payload?.mcpUrl === "string"
    ? (setup.payload.mcpUrl as string)
    : "";
  // Server-resolved name of the skill this credential is granted to (the model
  // supplies only the skillId; the dispatcher resolves the name from state).
  // Present only when the request carried a skillId. Drives the consent copy
  // on the card and dialog so the user sees which skill receives the grant
  // from a trusted identity rather than the model-authored reason/title.
  const credentialSkillName = isConnectorRequest && setup && typeof setup.payload?.credentialSkillName === "string"
    ? (setup.payload.credentialSkillName as string)
    : "";
  // What the user is connecting, for the button + resolved-card copy: the
  // provider label (known-provider request) or the templateless credential
  // label/name.
  const connectorLabel = providerLabel || credentialLabel || credentialName || "credential";
  const fillSlots: FillSecretSlot[] = isBrowserFillSecret && setup
    ? parseFillSecretSlots(setup.payload?.slots)
    : [];

  // === chat.choice card state ===
  // Question + options come from the TRUSTED setup payload the dispatcher
  // minted (block.summary carries the question too, as the transcript line).
  const choiceQuestion = isChatChoice && setup && typeof setup.payload?.question === "string"
    ? (setup.payload.question as string)
    : block.summary;
  const choiceOptions: ChoiceOption[] = isChatChoice && setup
    ? parseChoiceOptions(setup.payload?.options)
    : [];

  // === messaging.add_bridge card state ===
  const bridgeKind = isMessagingAddBridge && setup
    ? (setup.payload?.kind === "telegram" || setup.payload?.kind === "discord"
        ? (setup.payload.kind as "telegram" | "discord")
        : "telegram")
    : null;
  const bridgeKindLabel = bridgeKind === "discord" ? "Discord" : "Telegram";
  const suggestedBridgeName = isMessagingAddBridge && setup
    && typeof setup.payload?.suggestedName === "string"
    ? (setup.payload.suggestedName as string)
    : "";

  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [bridgeName, setBridgeName] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  // Sticky outcome marker. The /complete handler resolves the setup request
  // BEFORE addMessagingBridge runs, so a create-after-resolve failure
  // returns ok:false while the row is already completed. Without this
  // state, the past-tense summary would unconditionally read "Bridge added"
  // on any completed row — including the failed-create case. Track the last
  // submit's outcome so the resolved-state summary can tell the truth.
  const [bridgeResultOk, setBridgeResultOk] = useState<boolean | null>(null);
  const [bridgeResultMessage, setBridgeResultMessage] = useState<string | null>(null);
  // Synchronous single-flight guard for the Add-bridge click. The button's
  // `disabled={bridgeSubmit.isPending}` only flips on the next React render
  // — a same-frame double-click can fire the mutation twice before that
  // render lands, and the runtime has no name-uniqueness check on bridges,
  // so two creates would produce two encrypted secret files keyed off two
  // distinct bridge ids (one of which is orphaned). Mirrors the
  // submittingRef pattern in web/src/app/settings/_components/MessagingCard.tsx
  // that was added for the same reason on the settings dialog.
  const bridgeSubmittingRef = useRef(false);
  // Seed the name input with the agent's suggestedName the first time the
  // setup row resolves out of the cache. Without this, the first render
  // fires before useSetupRequests() lands the row and the input would stay
  // empty even after the suggestion arrives. Keyed on setupRequestId so a
  // brand-new card (e.g. the agent re-issues the tool after a cancelled
  // submission) re-seeds rather than carrying the prior session's value.
  useEffect(() => {
    if (!isMessagingAddBridge) return;
    if (bridgeName.length > 0) return;
    if (suggestedBridgeName.length === 0) return;
    setBridgeName(suggestedBridgeName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMessagingAddBridge, suggestedBridgeName, block.setupRequestId]);

  const fillSubmit = useMutation({
    mutationFn: async () => {
      // Submit value never leaves this function's request scope. The
      // /complete endpoint detects action=browser.fill_secret and pipes
      // each entry's value into playwright.fill on the live page. Local
      // state is cleared in onSettled below regardless of outcome so the
      // value never lingers in React state past the click — including on
      // partial-fail (where the gateway has already resolved the request
      // and retry is meaningless) and on network/abort errors.
      const response = await api<{ ok: boolean; message?: string; filledSlots?: string[] }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ secrets: fillValues })
        }
      );
      return response;
    },
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? "Fill failed; the agent will decide whether to retry.");
      }
      // Always invalidate: the gateway resolves the setup request
      // atomically before running fills, so on both ok and !ok paths the
      // status has flipped out of "pending" and the card needs to
      // re-render with isPending=false (Submit disabled, inputs hidden).
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setFillValues({})
  });
  const fillReady = isBrowserFillSecret
    && fillSlots.length > 0
    && fillSlots.every((s) => typeof fillValues[s.name] === "string" && fillValues[s.name].length > 0);

  // Submitter for the messaging.add_bridge card. Same shape as fillSubmit
  // above — POST /api/setup-requests/<id>/complete with a `secrets`
  // envelope, clear the typed token on success/error/abort so it never
  // lingers in the React fiber tree past the click. Failures surface inline
  // (so the operator can retry without the card tearing down) AND invalidate
  // the setup-requests cache so a 410-Gone follow-up flips the card out of
  // pending state.
  const bridgeSubmit = useMutation({
    mutationFn: async () => {
      const response = await api<{ ok: boolean; message?: string; bridge?: { id?: string; name?: string } }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ secrets: { name: bridgeName.trim(), botToken: bridgeToken } })
        }
      );
      return response;
    },
    onSuccess: (result) => {
      setBridgeResultOk(result.ok);
      setBridgeResultMessage(result.message ?? null);
      // Always invalidate setup-requests/tasks/chat — the gateway resolves
      // the setup request BEFORE addMessagingBridge runs, so even on
      // ok:false the status has flipped out of "pending" and the card must
      // re-render with isPending=false. Without this, a failed create would
      // leave the Add button enabled and a retry would be 410-Gone. Mirrors
      // the fillSubmit precedent above.
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
      if (!result.ok) {
        setBridgeError(result.message ?? "Could not add bridge. Please verify the bot token and try again.");
        return;
      }
      setBridgeError(null);
      toast.success(`${bridgeKindLabel} bridge added.`);
    },
    onError: (error: Error) => {
      setBridgeError(error.message);
      setBridgeResultOk(false);
      setBridgeResultMessage(error.message);
      // Network/abort failures can arrive AFTER the server-side
      // resolveSetupRequest landed, so the cache must refresh to flip the
      // card out of the stale pending state. The fillSubmit precedent fires
      // its own invalidate via onSuccess on both ok and !ok paths; the
      // onError seam is the equivalent for pre-response throws.
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      // Drop the typed bot token regardless of outcome — the token has
      // either landed in the encrypted per-instance secret store (success)
      // or been rejected upstream (failure), and there's no replay value in
      // keeping it inspectable in React DevTools.
      setBridgeToken("");
      // Release the synchronous click guard so a follow-up retry (after an
      // ok:false from /complete) actually fires. Reset here — not in
      // onSuccess or onError alone — so every termination path (success,
      // server-side ok:false, network error, abort) clears the ref.
      bridgeSubmittingRef.current = false;
    }
  });
  const bridgeReady = isMessagingAddBridge
    && bridgeName.trim().length > 0
    && bridgeToken.trim().length > 0;

  // === messaging.approve_pairing card state ===
  const pairingPayload = isMessagingApprovePairing && setup ? setup.payload : null;
  const pairingBridgeName = typeof pairingPayload?.bridgeName === "string"
    ? (pairingPayload.bridgeName as string)
    : "";
  const pairingBotUsername = typeof pairingPayload?.botUsername === "string"
    ? (pairingPayload.botUsername as string)
    : "";
  const pairingChatId = typeof pairingPayload?.chatId === "number"
    ? (pairingPayload.chatId as number)
    : null;
  const pairingChatType = typeof pairingPayload?.chatType === "string"
    ? (pairingPayload.chatType as string)
    : "";
  const pairingSender = typeof pairingPayload?.sender === "string"
    ? (pairingPayload.sender as string)
    : "";
  const pairingCode = typeof pairingPayload?.verificationCode === "string"
    ? (pairingPayload.verificationCode as string)
    : "";
  const pairingExpiresAt = typeof pairingPayload?.verificationCodeExpiresAt === "string"
    ? (pairingPayload.verificationCodeExpiresAt as string)
    : "";
  const [pairingError, setPairingError] = useState<string | null>(null);
  // Track which side of the resolved card the user took so the past-tense
  // summary distinguishes "Pairing approved" from "Pairing rejected" instead
  // of leaning on `setup.status` alone (which is just `completed` in both
  // cases — Reject is also a /complete call, not a /cancel).
  const [pairingOutcome, setPairingOutcome] = useState<"approved" | "rejected" | null>(null);
  // Sticky ok/message marker mirroring bridgeResultOk. The /complete handler
  // resolves the setup request BEFORE allowChat / rejectPendingChat runs, so
  // a server-side failure (e.g. rotated verification code, already-enrolled
  // chat) returns ok:false with status already flipped to completed. Without
  // this state, the past-tense summary would unconditionally read "Pairing
  // resolved." on every completed row — masking real failures. The
  // displaySummary branch reads this to render "Pairing failed: ..."
  // truthfully.
  const [pairingResultOk, setPairingResultOk] = useState<boolean | null>(null);
  const [pairingResultMessage, setPairingResultMessage] = useState<string | null>(null);
  const pairingSubmittingRef = useRef(false);
  const pairingSubmit = useMutation({
    mutationFn: async (variant: { reject: boolean }) => {
      const response = await api<{ ok: boolean; message?: string; enrolled?: boolean; rejected?: boolean }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        {
          method: "POST",
          body: JSON.stringify(variant.reject ? { reject: true } : {})
        }
      );
      return { response, variant };
    },
    onSuccess: ({ response, variant }) => {
      // Always invalidate — server resolves the setup request BEFORE the
      // side effect, so the cache must refresh regardless of ok value to
      // flip the card out of pending state. Same precedent as the bridge
      // submitter and fillSubmit.
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
      setPairingResultOk(response.ok);
      setPairingResultMessage(response.message ?? null);
      if (!response.ok) {
        setPairingError(response.message ?? "Could not resolve pairing.");
        return;
      }
      setPairingError(null);
      setPairingOutcome(variant.reject ? "rejected" : "approved");
      toast.success(variant.reject ? "Pairing rejected." : "Pairing approved.");
    },
    onError: (error: Error) => {
      setPairingError(error.message);
      setPairingResultOk(false);
      setPairingResultMessage(error.message);
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      pairingSubmittingRef.current = false;
    }
  });

  // === messaging.remove_bridge card state ===
  const removePayload = isMessagingRemoveBridge && setup ? setup.payload : null;
  const removeBridgeName = typeof removePayload?.bridgeName === "string"
    ? (removePayload.bridgeName as string)
    : "";
  const removeBridgeKind = typeof removePayload?.kind === "string"
    ? (removePayload.kind as string)
    : "";
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeResultOk, setRemoveResultOk] = useState<boolean | null>(null);
  const removeSubmittingRef = useRef(false);
  const removeSubmit = useMutation({
    mutationFn: async () => {
      const response = await api<{ ok: boolean; message?: string; removed?: boolean }>(
        `/setup-requests/${block.setupRequestId}/complete`,
        { method: "POST", body: JSON.stringify({}) }
      );
      return response;
    },
    onSuccess: (response) => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
      setRemoveResultOk(response.ok);
      if (!response.ok) {
        setRemoveError(response.message ?? "Could not remove bridge.");
        return;
      }
      setRemoveError(null);
      toast.success("Bridge removed.");
    },
    onError: (error: Error) => {
      setRemoveError(error.message);
      setRemoveResultOk(false);
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      removeSubmittingRef.current = false;
    }
  });

  const signInStarted = setup?.payload?.signInStarted === true;

  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";

  // Server-side persisted outcome is the source of truth — the /complete
  // handlers write it inside the same mutateState that commits the side
  // effect. React sticky state (bridgeResultOk, pairingResultOk,
  // removeResultOk) is the fast-path signal for the in-flight window before
  // useSetupRequests() refetches, but it can disagree with the server in one
  // specific case: a network/abort error fires onError on the client AFTER
  // the server already committed and persistConnectOutcome wrote ok:true.
  // Trust persistedOutcome when present, fall back to sticky only when the
  // server hasn't written one yet (purely in-flight, no commit). On reload
  // sticky is gone and persistedOutcome remains durable, so the post-reload
  // render still reads the truthful past-tense summary.
  const persistedOutcome = setup?.connectOutcome;
  const effectiveBridgeOk = persistedOutcome
    ? persistedOutcome.ok
    : bridgeResultOk;
  const effectiveBridgeMessage = persistedOutcome?.message ?? bridgeResultMessage ?? null;
  const effectivePairingOk = persistedOutcome
    ? persistedOutcome.ok
    : pairingResultOk;
  const effectivePairingMessage = persistedOutcome?.message ?? pairingResultMessage ?? null;
  const effectiveRemoveOk = persistedOutcome
    ? persistedOutcome.ok
    : removeResultOk;
  const effectiveRemoveMessage = persistedOutcome?.message ?? removeError ?? null;
  // connector.request persists a connectOutcome ONLY on failure (probe failure
  // or a post-claim throw); a successful create + grant returns ok:true and
  // leaves the row completed with no outcome. So a completed row with no
  // failure outcome is the success case. The sticky connectError is the
  // in-flight fast-path before useSetupRequests() refetches.
  const effectiveConnectFailed = persistedOutcome
    ? persistedOutcome.ok === false
    : Boolean(connectError);
  const effectiveConnectMessage = persistedOutcome?.message ?? connectError ?? null;

  // Past-tense the summary once resolved so "Enter credentials..." doesn't
  // keep reading as an active ask after the user has already submitted (or
  // cancelled). Display-only — the underlying block.summary on the wire
  // stays as the agent's original reason text.
  const displaySummary = !isPending && setup && isBrowserFillSecret
    ? setup.status === "completed"
      ? `Credentials submitted. (${block.summary})`
      : setup.status === "cancelled"
        ? `Request cancelled. (${block.summary})`
        : block.summary
    : !isPending && setup && isMessagingAddBridge
      ? setup.status === "completed"
        // The /complete handler resolves the setup request BEFORE
        // addMessagingBridge runs, so a successful resolve does NOT imply
        // the bridge exists. Trust the effective outcome
        // (sticky-then-persisted); only render "added" when we have
        // positive evidence the side effect actually completed.
        ? effectiveBridgeOk === false
          ? `Bridge create failed${effectiveBridgeMessage ? `: ${effectiveBridgeMessage}` : ""}. (${block.summary})`
          : `${bridgeKindLabel} bridge added. (${block.summary})`
        : setup.status === "cancelled"
          ? `Request cancelled. (${block.summary})`
          : block.summary
      : !isPending && setup && isMessagingApprovePairing
        ? setup.status === "completed"
          // Same resolve-before-side-effect ordering as add_bridge: status
          // flips to completed AT resolve time, BEFORE
          // allowChat/rejectPendingChat runs. A server-side failure
          // (rotated code, already-enrolled chat, etc.) returns ok:false
          // while the row is already completed. Effective outcome falls
          // through sticky → persisted so the past-tense summary stays
          // truthful after reload.
          ? effectivePairingOk === false
            ? `Pairing failed${effectivePairingMessage ? `: ${effectivePairingMessage}` : ""}. (${block.summary})`
            : pairingOutcome === "rejected"
              ? `Pairing rejected. (${block.summary})`
              : pairingOutcome === "approved"
                ? `Pairing approved. (${block.summary})`
                : `Pairing resolved. (${block.summary})`
          : setup.status === "cancelled"
            ? `Request cancelled. (${block.summary})`
            : block.summary
        : !isPending && setup && isMessagingRemoveBridge
          ? setup.status === "completed"
            ? effectiveRemoveOk === false
              ? `Bridge removal failed${effectiveRemoveMessage ? `: ${effectiveRemoveMessage}` : ""}. (${block.summary})`
              : `Bridge removed. (${block.summary})`
            : setup.status === "cancelled"
              ? `Request cancelled. (${block.summary})`
              : block.summary
          : !isPending && setup && isConnectorRequest
            ? setup.status === "completed"
              // The backend claims the row at completion (success OR failure),
              // so a completed connector.request is terminal — retrying its
              // setup id 410s. A persisted ok:false outcome marks a failed
              // connect; otherwise the create + grant succeeded. Surface the
              // failure message and that the agent will re-request, rather than
              // leaving "Enter credentials…" reading as still-actionable.
              ? effectiveConnectFailed
                ? `Setup failed${effectiveConnectMessage ? `: ${effectiveConnectMessage}` : ""}. The agent will re-request the credential. (${block.summary})`
                : `Connected ${connectorLabel}${credentialSkillName ? ` for ${credentialSkillName}` : ""}. (${block.summary})`
              : setup.status === "cancelled"
                ? `Request cancelled. (${block.summary})`
                : block.summary
            : !isPending && setup && isChatChoice
              // The /complete handler persists the past-tense selection
              // ("You selected: X" / "You answered: ...") as the outcome
              // message BEFORE responding, so the refetched row already
              // carries it. Skip is a /cancel, so cancelled = skipped.
              ? setup.status === "completed"
                ? `${persistedOutcome?.message ?? "Answered"}. (${block.summary})`
                : setup.status === "cancelled"
                  ? `Skipped. (${block.summary})`
                  : block.summary
              : block.summary;

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">
          {isBrowserConnect ? "Connect to agent's browser" : isSkillGrant ? "Grant skill access" : isChatChoice ? "Question" : block.action}
        </span>
        {!isPending && setup ? <StatusPill value={setup.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      {/* While a pending chat.choice card is mounted, the question renders
          inside the choice body (with its leading icon) — a summary line
          above it would duplicate it. This condition must mirror the
          ChoiceCard mount condition below exactly: until the setup row
          loads, the card isn't rendered, so the summary (which carries the
          question) must stay visible. Resolved chat.choice rows fall back
          to the past-tense summary like every other card. */}
      {!isConnectorRequest && !(isChatChoice && isPending && setup) ? (
        <p className="mt-1 text-xs text-muted-foreground">{displaySummary}</p>
      ) : null}
      {expanded && setup ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(setup.payload, null, 2)}
        </pre>
      ) : null}
      {isConnectorRequest && isPending && credentialSkillName ? (
        // Server-resolved consent anchor: the dispatcher resolved the skillId
        // (model-supplied) to this NAME from state, so it's the trustworthy
        // statement of which skill the credential is granted to — unlike the
        // model-authored reason/title in the summary above.
        <div className="mt-2 rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
          <span className="text-muted-foreground">Grants to skill: </span>
          <span className="font-mono">{credentialSkillName}</span>
        </div>
      ) : null}
      {isBrowserFillSecret && fillSlots.length > 0 && isPending ? (
        <div className="mt-2 space-y-2">
          {/*
            Prominent "fill destination" badge so the user can spot a
            mismatch between the agent's claimed labels and the actual page
            the secret will land on. The agent controls slot.label and
            block.summary; the page URL is captured by the gateway at
            request-creation time and is the only non-spoofable element on
            this card.
          */}
          {(() => {
            const approvedUrlField = typeof setup?.payload?.approvedUrl === "string"
              ? setup.payload.approvedUrl
              : undefined;
            const destination = approvedUrlField ?? setup?.target;
            if (!destination) return null;
            return (
              <div className="rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
                <span className="text-muted-foreground">Fill destination: </span>
                <span className="font-mono">{destination}</span>
              </div>
            );
          })()}
          {fillSlots.map((slot) => (
            <div key={slot.name} className="space-y-1">
              <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.setupRequestId}-${slot.name}`}>
                {slot.label}
              </label>
              <Input
                id={`${block.setupRequestId}-${slot.name}`}
                type={slot.kind}
                value={fillValues[slot.name] ?? ""}
                onChange={(e) => setFillValues((prev) => ({ ...prev, [slot.name]: e.target.value }))}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                disabled={fillSubmit.isPending}
              />
            </div>
          ))}
        </div>
      ) : null}
      {isMessagingAddBridge && isPending ? (
        <div className="mt-2 space-y-2">
          {/*
            Kind badge mirroring the fill-secret "Fill destination" band —
            gives the operator a non-spoofable signal of what kind of bridge
            will be created. The agent supplies the suggested name + reason
            text; the kind is structurally pinned in the payload at dispatch
            time and is the only field the model cannot rewrite at /complete
            time.
          */}
          <div className="rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">Bridge kind: </span>
            <span className="font-mono">{bridgeKindLabel}</span>
          </div>
          <div className="space-y-1">
            <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.setupRequestId}-bridge-name`}>
              Name
            </label>
            <Input
              id={`${block.setupRequestId}-bridge-name`}
              type="text"
              value={bridgeName}
              onChange={(e) => setBridgeName(e.target.value)}
              placeholder={bridgeKind === "discord" ? "my-discord-bot" : "my-telegram-bot"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={bridgeSubmit.isPending}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.setupRequestId}-bridge-token`}>
              Bot token
            </label>
            <Input
              id={`${block.setupRequestId}-bridge-token`}
              type="password"
              value={bridgeToken}
              onChange={(e) => setBridgeToken(e.target.value)}
              placeholder={bridgeKind === "discord" ? "MzA1...Ovy4MCQQ" : "123456789:ABCdef..."}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={bridgeSubmit.isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              {bridgeKind === "discord"
                ? "Open the Discord Developer Portal, create an application, add a bot, and paste its token."
                : "Open Telegram, chat with @BotFather, run /newbot, and paste the token."}
              {" "}Stored encrypted; never leaves your machine.
            </p>
          </div>
          {bridgeError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {bridgeError}
            </p>
          ) : null}
        </div>
      ) : null}
      {isMessagingApprovePairing && isPending && pairingChatId !== null ? (
        <div className="mt-2 space-y-2">
          <div className="rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">Bridge: </span>
            <span className="font-mono">{pairingBridgeName}</span>
            {pairingBotUsername ? (
              <>
                <span className="text-muted-foreground"> · bot </span>
                <span className="font-mono">@{pairingBotUsername}</span>
              </>
            ) : null}
          </div>
          <div className="rounded-md border border-border bg-background/40 p-2 text-xs">
            <p className="text-sm font-medium">
              Pairing request from {pairingSender || "unknown sender"}
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {pairingChatType || "chat"} · chat {pairingChatId}
            </p>
            {pairingCode ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Verification code:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {pairingCode}
                </code>
                {pairingExpiresAt ? (
                  <span className="ml-2">
                    expires {new Date(pairingExpiresAt).toLocaleTimeString()}
                  </span>
                ) : null}
                <span className="ml-2">— confirm with the user before approving.</span>
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Group chats have no per-user verification code. Confirm with the user out-of-band before approving.
              </p>
            )}
          </div>
          {pairingError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {pairingError}
            </p>
          ) : null}
        </div>
      ) : null}
      {isMessagingRemoveBridge && isPending ? (
        <div className="mt-2 space-y-2">
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
            <p className="text-sm font-medium">
              Remove {removeBridgeKind} bridge{" "}
              <span className="font-mono">{removeBridgeName}</span>?
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              This deletes the bridge and its bot token. Past messages stay in history.
            </p>
          </div>
          {removeError ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {removeError}
            </p>
          ) : null}
        </div>
      ) : null}
      {isChatChoice && isPending && setup ? (
        <ChoiceCard
          setupRequestId={block.setupRequestId}
          question={choiceQuestion}
          options={choiceOptions}
          onSkip={() => cancel.mutate()}
          skipPending={cancel.isPending}
        />
      ) : null}
      {/* chat.choice owns its own Submit/Skip row inside ChoiceCard. */}
      <div className={isPending && !isChatChoice ? "mt-2 flex gap-2" : "hidden"}>
        {isBrowserConnect ? (
          <>
            <Button
              size="sm"
              disabled={browserConnect.isPending || !isPending}
              onClick={() => browserConnect.mutate()}
            >
              {signInStarted ? "I've signed in" : "Connect"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isConnectorRequest ? (
          <>
            <Button
              size="sm"
              disabled={connect.isPending || !isPending || !setup}
              onClick={() => {
                setConnectError(null);
                setConnectOpen(true);
              }}
            >
              {/* When a skillId resolved to a name server-side, the consent is
                  about granting this credential to THAT skill, so name it from
                  the trusted identity rather than the model's reason/title. */}
              {credentialSkillName
                ? `Grant ${connectorLabel} to ${credentialSkillName}`
                : `Connect ${connectorLabel}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isBrowserFillSecret ? (
          <>
            <Button
              size="sm"
              disabled={fillSubmit.isPending || !isPending || !fillReady}
              onClick={() => fillSubmit.mutate()}
            >
              Submit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isMessagingAddBridge ? (
          <>
            <Button
              size="sm"
              disabled={bridgeSubmit.isPending || !isPending || !bridgeReady}
              onClick={() => {
                // Synchronous ref flip BEFORE mutate() so a same-frame
                // second click (before React commits the disabled={isPending}
                // render) short-circuits here instead of minting a second
                // bridge.
                if (bridgeSubmittingRef.current) return;
                bridgeSubmittingRef.current = true;
                setBridgeError(null);
                bridgeSubmit.mutate();
              }}
            >
              Add {bridgeKindLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isMessagingApprovePairing ? (
          <>
            <Button
              size="sm"
              disabled={pairingSubmit.isPending || !isPending || !setup}
              onClick={() => {
                if (pairingSubmittingRef.current) return;
                pairingSubmittingRef.current = true;
                setPairingError(null);
                pairingSubmit.mutate({ reject: false });
              }}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pairingSubmit.isPending || !isPending || !setup}
              onClick={() => {
                if (pairingSubmittingRef.current) return;
                pairingSubmittingRef.current = true;
                setPairingError(null);
                pairingSubmit.mutate({ reject: true });
              }}
            >
              Reject
            </Button>
          </>
        ) : isMessagingRemoveBridge ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={removeSubmit.isPending || !isPending || !setup}
              onClick={() => {
                if (removeSubmittingRef.current) return;
                removeSubmittingRef.current = true;
                setRemoveError(null);
                removeSubmit.mutate();
              }}
            >
              Remove
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : isSkillGrant ? (
          <>
            <Button
              size="sm"
              disabled={grantSubmit.isPending || !isPending || !setup}
              onClick={() => grantSubmit.mutate()}
            >
              Grant
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={cancel.isPending || !isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      {connectOpen ? (
        <AddConnectorDialog
          open={connectOpen}
          onOpenChange={(open) => {
            if (!open) {
              setConnectOpen(false);
              setConnectError(null);
            }
          }}
          providers={providers.data ?? []}
          defaultProvider={providerId}
          lockProvider
          mode="request"
          requestCredentialName={credentialName || undefined}
          requestCredentialType={credentialType}
          requestMcpUrl={credentialMcpUrl || undefined}
          requestSkillName={credentialSkillName || undefined}
          pending={connect.isPending}
          externalError={connectError}
          onSubmit={(body) => connect.mutate(body)}
        />
      ) : null}
    </div>
  );
}

// === chat.choice (ask_user) ===

type ChoiceOption = { label: string; description?: string };

// Defensive parse of the dispatcher-minted options array. The dispatcher
// already validated shape (2-6 entries, non-empty distinct labels), so this
// just narrows the unknown payload for rendering.
function parseChoiceOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ChoiceOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { label?: unknown; description?: unknown };
    if (typeof candidate.label !== "string" || candidate.label.length === 0) continue;
    out.push({
      label: candidate.label,
      ...(typeof candidate.description === "string" && candidate.description.length > 0
        ? { description: candidate.description }
        : {})
    });
  }
  return out;
}

// Single-select question card for a pending chat.choice SetupRequest. The
// options come from the trusted setup payload; the card always adds its own
// "Other (type your answer)" freeform row and a subtle Skip affordance
// (Skip = the shared /cancel endpoint, which resumes the agent with a skip
// fallback rather than failing the task). Selection state is the option
// INDEX (or the literal "other" tag for the card-injected freeform row) so
// no model-emitted option label can ever collide with the freeform row.
function ChoiceCard({
  setupRequestId,
  question,
  options,
  onSkip,
  skipPending
}: {
  setupRequestId: string;
  question: string;
  options: ChoiceOption[];
  onSkip: () => void;
  skipPending: boolean;
}) {
  const invalidate = useInvalidate();
  const [selected, setSelected] = useState<number | "other" | null>(null);
  const [otherText, setOtherText] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>(`/setup-requests/${setupRequestId}/complete`, {
        method: "POST",
        body: JSON.stringify(
          selected === "other"
            ? { choice: { other: otherText.trim() } }
            : { choice: { label: typeof selected === "number" ? options[selected]?.label : null } }
        )
      }),
    onSuccess: () => {
      invalidate(["setup-requests", "approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const ready = selected === "other" ? otherText.trim().length > 0 : selected !== null;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">{question}</p>
      </div>
      <div className="space-y-1">
        {options.map((option, index) => (
          <label
            key={option.label}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 hover:bg-background/70"
          >
            <input
              type="radio"
              name={`${setupRequestId}-choice`}
              className="mt-0.5"
              checked={selected === index}
              onChange={() => setSelected(index)}
              disabled={submit.isPending}
            />
            <span>
              <span className="block text-xs text-foreground">{option.label}</span>
              {option.description ? (
                <span className="block text-[11px] text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 hover:bg-background/70">
          <input
            type="radio"
            name={`${setupRequestId}-choice`}
            className="mt-0.5"
            checked={selected === "other"}
            onChange={() => setSelected("other")}
            disabled={submit.isPending}
          />
          <span className="text-xs text-foreground">Other (type your answer)</span>
        </label>
        {selected === "other" ? (
          <Input
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type your answer"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={submit.isPending}
          />
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
          Submit
        </Button>
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          disabled={skipPending || submit.isPending}
          onClick={onSkip}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
