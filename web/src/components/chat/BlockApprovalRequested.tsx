"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RiskPill, StatusPill } from "@/components/StatusPill";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate, useProviders } from "@/lib/queries";
import type { Approval, ApprovalRequestedBlock } from "@runtime/types";
import { parseFillSecretSlots, type FillSecretSlot } from "@/lib/fill-secrets-types";

// Inline Approve / Deny / Connect actions for an approval_requested block.
// The block itself carries `approvalId`, `action`, `risk`, and `summary`
// directly from the wire, so the bubble can render without a join. The
// `connector.request` Connect flow still needs the approval payload
// (provider id, provider label) for the AddConnectorDialog — we fetch
// that lazily through the existing useApprovals() cache rather than
// adding a new per-id endpoint.
//
// Once the approval is resolved (approved / denied / connected), the
// runtime updates the corresponding tool_call block's status and the
// approval_requested block becomes historical. We keep rendering the
// bubble so the chat log stays complete; the buttons disable themselves
// once the approval is no longer pending.
export function BlockApprovalRequested({ block }: { block: ApprovalRequestedBlock }) {
  const invalidate = useInvalidate();
  const approvals = useApprovals();
  const providers = useProviders();
  const [expanded, setExpanded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Find the matching approval row so the Connect dialog has the
  // provider id from `approval.payload.provider`. The approval may not
  // yet be in the cache on first render — the Connect button stays
  // disabled until the row loads so the dialog never opens without the
  // provider id it needs.
  const approval = (approvals.data ?? []).find((a) => a.id === block.approvalId) ?? null;
  const isPending = approval ? approval.status === "pending" : true;

  const decide = useMutation({
    mutationFn: ({ op }: { op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${block.approvalId}/${op}`, { method: "POST" }),
    onSuccess: () => {
      // Refresh the surfaces that mirror approval state. The chat page
      // itself updates via the per-session SSE block stream, but
      // /permissions and /activity rely on the React Query cache.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      // Clear any typed credentials regardless of outcome. The Deny
      // button on a fill_secret or messaging.add_bridge card never
      // invokes the respective submit mutation (and therefore never
      // hits its onSettled clear), so without this hook a user who
      // typed a credential and then clicked Deny would leave the
      // typed value sitting in React state until the chat view
      // unmounts. Cheap on every other approval action — the setters
      // are no-ops when the record / string is already empty.
      setFillValues({});
      setBridgeToken("");
    }
  });

  const connect = useMutation({
    mutationFn: async (body: CreateConnectorBody) => {
      const response = await api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/approvals/${block.approvalId}/connect`,
        {
          method: "POST",
          body: JSON.stringify({
            secrets: body.secrets,
            scopes: body.scopes,
            name: body.name
          })
        }
      );
      return response;
    },
    onSuccess: (result) => {
      if (result.ok) {
        setConnectOpen(false);
        setConnectError(null);
        invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        setConnectError(
          result.message ?? "Could not connect. Please verify the credentials and try again."
        );
        invalidate(["connectors"]);
      }
    },
    onError: (error: Error) => {
      setConnectError(error.message);
    }
  });

  const isConnectorRequest = block.action === "connector.request";
  const isBrowserFillSecret = block.action === "browser.fill_secret";
  const isMessagingAddBridge = block.action === "messaging.add_bridge";
  const isMessagingApprovePairing = block.action === "messaging.approve_pairing";
  const isMessagingRemoveBridge = block.action === "messaging.remove_bridge";
  const providerId = isConnectorRequest && approval
    ? String(approval.payload?.provider ?? "")
    : "";
  const providerLabel = isConnectorRequest && approval
    ? typeof approval.payload?.providerLabel === "string"
      ? (approval.payload.providerLabel as string)
      : providerId
    : "";
  const fillSlots: FillSecretSlot[] = isBrowserFillSecret && approval
    ? parseFillSecretSlots(approval.payload?.slots)
    : [];
  const bridgeKind = isMessagingAddBridge && approval
    ? (approval.payload?.kind === "telegram" || approval.payload?.kind === "discord"
        ? (approval.payload.kind as "telegram" | "discord")
        : "telegram")
    : null;
  const bridgeKindLabel = bridgeKind === "discord" ? "Discord" : "Telegram";
  const suggestedBridgeName = isMessagingAddBridge && approval
    && typeof approval.payload?.suggestedName === "string"
    ? (approval.payload.suggestedName as string)
    : "";
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [bridgeName, setBridgeName] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  // Sticky outcome marker. The /connect handler resolves the approval
  // BEFORE addMessagingBridge runs, so a create-after-resolve failure
  // returns ok:false while the approval is already approved. Without
  // this state, the past-tense summary would unconditionally read
  // "Bridge added" on any approved row — including the failed-create
  // case. Track the last submit's outcome so the resolved-state
  // summary can tell the truth.
  const [bridgeResultOk, setBridgeResultOk] = useState<boolean | null>(null);
  const [bridgeResultMessage, setBridgeResultMessage] = useState<string | null>(null);
  // Synchronous single-flight guard for the Add-bridge click. The
  // button's `disabled={bridgeSubmit.isPending}` only flips on the
  // next React render — a same-frame double-click can fire the
  // mutation twice before that render lands, and the runtime has no
  // name-uniqueness check on bridges, so two creates would produce
  // two encrypted secret files keyed off two distinct bridge ids
  // (one of which is orphaned). Mirrors the submittingRef pattern in
  // web/src/app/settings/_components/MessagingCard.tsx that was
  // added for the same reason on the settings dialog.
  const bridgeSubmittingRef = useRef(false);
  // Seed the name input with the agent's suggestedName the first time
  // the approval row resolves out of the cache. Without this, the
  // first render fires before useApprovals() lands the row and the
  // input would stay empty even after the suggestion arrives. Keyed
  // on approvalId so a brand-new card (e.g. the agent re-issues the
  // tool after a denied submission) re-seeds rather than carrying
  // the prior session's value.
  useEffect(() => {
    if (!isMessagingAddBridge) return;
    if (bridgeName.length > 0) return;
    if (suggestedBridgeName.length === 0) return;
    setBridgeName(suggestedBridgeName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMessagingAddBridge, suggestedBridgeName, block.approvalId]);
  const fillSubmit = useMutation({
    mutationFn: async () => {
      // Submit value never leaves this function's request scope.
      // The /connect endpoint detects action=browser.fill_secret and
      // pipes each entry's value into playwright.fill on the live
      // page. Local state is cleared in onSettled below regardless of
      // outcome so the value never lingers in React state past the
      // click — including on partial-fail (where the gateway has
      // already resolved the approval and retry is meaningless) and
      // on network/abort errors.
      const response = await api<{ ok: boolean; message?: string; filledSlots?: string[] }>(
        `/approvals/${block.approvalId}/connect`,
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
      // Always invalidate approvals: the gateway resolves the
      // approval atomically before running fills, so on both ok and
      // !ok paths the approval status has flipped out of "pending"
      // and the card needs to re-render with isPending=false (Submit
      // disabled, inputs hidden). Without this, ok:false would leave
      // a stale "pending" cache and the Submit button would stay
      // enabled offering a retry that the gateway would 410-Gone.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      // Belt-and-braces: clear typed credentials from React state
      // regardless of outcome (success, partial-fail, network error,
      // abort). The card stays mounted across the chat session for
      // history-completeness, so without this hook a stale value
      // would linger in the React fiber tree (and React DevTools)
      // for the duration of the session.
      setFillValues({});
    }
  });
  const fillReady = isBrowserFillSecret
    && fillSlots.length > 0
    && fillSlots.every((s) => typeof fillValues[s.name] === "string" && fillValues[s.name].length > 0);

  // Submitter for the messaging.add_bridge card. Same shape as
  // fillSubmit above — POST /api/approvals/<id>/connect with a
  // `secrets` envelope, clear the typed token on success/error/abort
  // so it never lingers in the React fiber tree past the click.
  // Failures surface inline (so the operator can retry without the
  // card tearing down) AND invalidate the approval cache so a
  // 410-Gone follow-up flips the card out of pending state.
  const bridgeSubmit = useMutation({
    mutationFn: async () => {
      const response = await api<{ ok: boolean; message?: string; bridge?: { id?: string; name?: string } }>(
        `/approvals/${block.approvalId}/connect`,
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
      // Always invalidate approvals/tasks/chat — the gateway resolves
      // the approval BEFORE addMessagingBridge runs, so even on
      // ok:false the approval status has flipped out of "pending"
      // and the card must re-render with isPending=false. Without
      // this, a failed create would leave the Submit button enabled
      // and a retry would be 410-Gone. Mirrors the fillSubmit
      // precedent above.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
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
      // resolveApproval landed, so the cache must refresh to flip
      // the card out of the stale pending state. The fillSubmit
      // precedent fires its own invalidate via onSuccess on both
      // ok and !ok paths; the onError seam is the equivalent for
      // pre-response throws.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      // Drop the typed bot token regardless of outcome — the token
      // has either landed in the encrypted per-instance secret store
      // (success) or been rejected upstream (failure), and there's
      // no replay value in keeping it inspectable in React DevTools.
      setBridgeToken("");
      // Release the synchronous click guard so a follow-up retry
      // (after an ok:false from /connect) actually fires. Reset here
      // — not in onSuccess or onError alone — so every termination
      // path (success, server-side ok:false, network error, abort)
      // clears the ref.
      bridgeSubmittingRef.current = false;
    }
  });
  const bridgeReady = isMessagingAddBridge
    && bridgeName.trim().length > 0
    && bridgeToken.trim().length > 0;

  // === messaging.approve_pairing card state ===
  const pairingPayload = isMessagingApprovePairing && approval ? approval.payload : null;
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
  // Track which side of the resolved card the user took so the
  // past-tense summary distinguishes "Pairing approved" from
  // "Pairing rejected" instead of leaning on `approval.status` alone
  // (which is just `approved` in both cases — Reject is also a
  // /connect call, not a /deny).
  const [pairingOutcome, setPairingOutcome] = useState<"approved" | "rejected" | null>(null);
  const pairingSubmittingRef = useRef(false);
  const pairingSubmit = useMutation({
    mutationFn: async (variant: { reject: boolean }) => {
      const response = await api<{ ok: boolean; message?: string; enrolled?: boolean; rejected?: boolean }>(
        `/approvals/${block.approvalId}/connect`,
        {
          method: "POST",
          body: JSON.stringify(variant.reject ? { reject: true } : {})
        }
      );
      return { response, variant };
    },
    onSuccess: ({ response, variant }) => {
      // Always invalidate — server resolves the approval BEFORE the
      // side effect, so the cache must refresh regardless of ok value
      // to flip the card out of pending state. Same precedent as the
      // bridge submitter and fillSubmit.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
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
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      pairingSubmittingRef.current = false;
    }
  });

  // === messaging.remove_bridge card state ===
  const removePayload = isMessagingRemoveBridge && approval ? approval.payload : null;
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
        `/approvals/${block.approvalId}/connect`,
        { method: "POST", body: JSON.stringify({}) }
      );
      return response;
    },
    onSuccess: (response) => {
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
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
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "messaging"]);
    },
    onSettled: () => {
      removeSubmittingRef.current = false;
    }
  });

  // Once the approval is no longer pending, drop the amber accent so
  // the bubble visually reads as historical rather than an active
  // prompt. The buttons still render in their resolved-state form
  // below (status pill instead of dead Submit/Deny) so the user
  // sees what happened without it looking like they still need
  // to act.
  const cardClass = isPending
    ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    : "rounded-lg border border-border bg-background/40 p-3";
  // Past-tense the summary once resolved so "Enter credentials..."
  // doesn't keep reading as an active ask after the user has
  // already submitted (or denied). Display-only — the underlying
  // block.summary on the wire stays as the agent's original
  // reason text.
  const displaySummary = !isPending && approval && isBrowserFillSecret
    ? approval.status === "approved"
      ? `Credentials submitted. (${block.summary})`
      : approval.status === "denied"
        ? `Request denied. (${block.summary})`
        : block.summary
    : !isPending && approval && isMessagingAddBridge
      ? approval.status === "approved"
        // The /connect handler resolves the approval BEFORE
        // addMessagingBridge runs, so a successful resolve does NOT
        // imply the bridge exists. Trust the sticky outcome marker
        // set by bridgeSubmit's onSuccess/onError; default to "added"
        // only when the most recent submit actually returned ok:true,
        // OR when there's no local outcome to consult (e.g. resumed
        // from history). bridgeResultOk === false means the create
        // failed after resolve — render that truthfully so the past
        // tense doesn't lie.
        ? bridgeResultOk === false
          ? `Bridge create failed${bridgeResultMessage ? `: ${bridgeResultMessage}` : ""}. (${block.summary})`
          : `${bridgeKindLabel} bridge added. (${block.summary})`
        : approval.status === "denied"
          ? `Request denied. (${block.summary})`
          : block.summary
      : !isPending && approval && isMessagingApprovePairing
        ? approval.status === "approved"
          // Same resolve-before-side-effect ordering means we can't
          // read "approved" → "pairing approved". The pairing outcome
          // ref distinguishes Approve vs Reject (both POST /connect)
          // from the failed-after-resolve case.
          ? pairingOutcome === "rejected"
            ? `Pairing rejected. (${block.summary})`
            : pairingOutcome === "approved"
              ? `Pairing approved. (${block.summary})`
              : `Pairing resolved. (${block.summary})`
          : approval.status === "denied"
            ? `Request denied. (${block.summary})`
            : block.summary
        : !isPending && approval && isMessagingRemoveBridge
          ? approval.status === "approved"
            ? removeResultOk === false
              ? `Bridge removal failed${removeError ? `: ${removeError}` : ""}. (${block.summary})`
              : `Bridge removed. (${block.summary})`
            : approval.status === "denied"
              ? `Request denied. (${block.summary})`
              : block.summary
          : block.summary;
  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-foreground">{block.action}</span>
        <RiskPill value={block.risk} />
        {!isPending && approval ? <StatusPill value={approval.status} /> : null}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{displaySummary}</p>
      {expanded && approval ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      ) : null}
      {isBrowserFillSecret && fillSlots.length > 0 && isPending ? (
        <div className="mt-2 space-y-2">
          {/*
            Prominent "fill destination" badge so the user can spot a
            mismatch between the agent's claimed labels and the actual
            page the secret will land on. The agent controls
            slot.label and block.summary; the page URL is captured by
            the gateway at approval-creation time and is the only
            non-spoofable element on this card. If the agent were
            prompt-injected to ask for "GitHub password" while the
            captured page is `https://evil.com/phishing`, this badge
            is what lets the user see the mismatch.
          */}
          {(() => {
            // Read from approval.payload.approvedUrl — the canonical
            // load-bearing field the gateway compares against the
            // live page URL. approval.target currently mirrors the
            // same value, but the dispatcher's own comment marks
            // target as "the human-readable label" and approvedUrl
            // as "the load-bearing equality check," so a future
            // change to target's format must not silently change
            // what the user sees on the card. Fall back to target
            // for legacy approvals minted before the payload field
            // existed.
            const approvedUrlField = typeof approval?.payload?.approvedUrl === "string"
              ? approval.payload.approvedUrl
              : undefined;
            const destination = approvedUrlField ?? approval?.target;
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
              <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.approvalId}-${slot.name}`}>
                {slot.label}
              </label>
              <Input
                id={`${block.approvalId}-${slot.name}`}
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
            Kind badge mirroring the fill-secret "Fill destination"
            band — gives the operator a non-spoofable signal of what
            kind of bridge will be created. The agent supplies the
            suggested name + reason text; the kind is structurally
            pinned in the approval payload at dispatch time and is
            the only field the model cannot rewrite at /connect time.
          */}
          <div className="rounded-md border border-amber-500/30 bg-background/40 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">Bridge kind: </span>
            <span className="font-mono">{bridgeKindLabel}</span>
          </div>
          <div className="space-y-1">
            <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.approvalId}-bridge-name`}>
              Name
            </label>
            <Input
              id={`${block.approvalId}-bridge-name`}
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
            <label className="block text-[11px] text-muted-foreground" htmlFor={`${block.approvalId}-bridge-token`}>
              Bot token
            </label>
            <Input
              id={`${block.approvalId}-bridge-token`}
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
      <div className={isPending ? "mt-2 flex gap-2" : "hidden"}>
        {isConnectorRequest ? (
          <>
            <Button
              size="sm"
              disabled={connect.isPending || !isPending || !approval}
              onClick={() => {
                setConnectError(null);
                setConnectOpen(true);
              }}
            >
              Connect {providerLabel || "provider"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
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
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Deny
            </Button>
          </>
        ) : isMessagingAddBridge ? (
          <>
            <Button
              size="sm"
              disabled={bridgeSubmit.isPending || !isPending || !bridgeReady}
              onClick={() => {
                // Synchronous ref flip BEFORE mutate() so a
                // same-frame second click (before React commits the
                // disabled={isPending} render) short-circuits here
                // instead of minting a second bridge.
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
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Cancel
            </Button>
          </>
        ) : isMessagingApprovePairing ? (
          <>
            <Button
              size="sm"
              disabled={pairingSubmit.isPending || !isPending}
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
              disabled={pairingSubmit.isPending || !isPending}
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
              disabled={removeSubmit.isPending || !isPending}
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
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "approve" })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending || !isPending}
              onClick={() => decide.mutate({ op: "deny" })}
            >
              Deny
            </Button>
          </>
        )}
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
          pending={connect.isPending}
          externalError={connectError}
          onSubmit={(body) => connect.mutate(body)}
        />
      ) : null}
    </div>
  );
}
