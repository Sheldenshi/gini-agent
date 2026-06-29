"use client";

import { useEffect, useState } from "react";
import { Mail, Copy, Check, Send } from "lucide-react";
import { api } from "@/lib/api";

// Inline email-draft card. The agent emits a ```email-draft fenced block after
// saving a Gmail draft; MarkdownContent routes that block here so the user can
// read the draft in the chat instead of being told to open Gmail and search.
//
// The fenced block is plain text: optional RFC-style header lines
// (To/Cc/Bcc/From/Subject, case-insensitive) up to the first blank line, then
// the body. Two extra metadata header lines — DraftId and Account — carry the
// saved gws draft id and the account it was saved under; they are EXTRACTED
// (never rendered as recipient rows). When a DraftId is present the card shows a
// Send button that sends the SAVED draft directly server-side (POST
// /api/email/drafts/send) with no agent turn; on mount it asks the gateway
// whether that draft was already sent so the "Sent" state persists across a
// page refresh. With no DraftId the card stays read-only (doc viewer / file
// preview / skills page).

const HEADER_KEYS = ["to", "cc", "bcc", "from", "subject"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const HEADER_LABEL: Record<HeaderKey, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  from: "From",
  subject: "Subject"
};

// The metadata header lines extracted from the fence (not shown as recipients).
const META_KEYS = ["draftid", "account"] as const;

interface ParsedDraft {
  headers: Array<[HeaderKey, string]>;
  body: string;
  draftId?: string;
  account?: string;
}

function parseDraft(raw: string): ParsedDraft {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const headers: Array<[HeaderKey, string]> = [];
  let draftId: string | undefined;
  let account: string | undefined;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++; // consume the blank separator line
      break;
    }
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    const key = match?.[1]?.toLowerCase();
    if (match && key && (HEADER_KEYS as readonly string[]).includes(key)) {
      headers.push([key as HeaderKey, match[2]!.trim()]);
      continue;
    }
    // DraftId / Account are metadata: extract, never render as recipient rows.
    if (match && key && (META_KEYS as readonly string[]).includes(key)) {
      const value = match[2]!.trim();
      if (key === "draftid") draftId = value || undefined;
      else account = value || undefined;
      continue;
    }
    break; // first non-header line ends the header section; body starts here
  }
  const body = lines.slice(i).join("\n").trim();
  return { headers, body, draftId, account };
}

// The card's Send affordance state machine. "idle" shows Send; the click runs
// the direct server-side send; "sent" is the durable terminal state (also the
// initial state when the mount query reports the draft already sent).
type SendState = "idle" | "sending" | "sent" | "error";

export function EmailDraftCard({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false);
  const { headers, body, draftId, account } = parseDraft(raw.trim());
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);

  // On mount (with a draftId) ask the gateway whether THIS draft was already
  // sent, so a page refresh restores the disabled "Sent" state. Best-effort: a
  // failed query just leaves the button clickable.
  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    api<{ sent: string[] }>(`/email/drafts/sent?ids=${encodeURIComponent(draftId)}`)
      .then((res) => {
        if (!cancelled && res.sent.includes(draftId)) setSendState("sent");
      })
      .catch(() => {
        // Leave the button clickable; the send route is the source of truth.
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const onSend = async () => {
    if (!draftId || sendState === "sending" || sendState === "sent") return;
    setSendState("sending");
    setSendError(null);
    try {
      const res = await api<{ ok: boolean; message?: string }>("/email/drafts/send", {
        method: "POST",
        body: JSON.stringify({ draftId, ...(account ? { account } : {}) })
      });
      if (res.ok) {
        setSendState("sent");
      } else {
        setSendState("error");
        setSendError(res.message ?? "Couldn't send the draft.");
      }
    } catch (error) {
      setSendState("error");
      setSendError(error instanceof Error ? error.message : "Couldn't send the draft.");
    }
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission);
      // the card is still readable, so silently no-op.
    }
  };

  const sendLabel =
    sendState === "sending" ? "Sending…" : sendState === "sent" ? "Sent" : "Send";

  return (
    <div className="my-2 overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
        <Mail className="size-[15px] shrink-0" aria-hidden="true" />
        <span className="text-[12px] font-semibold uppercase tracking-wide">Draft</span>
        <button
          type="button"
          onClick={onCopy}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] transition-colors hover:bg-muted"
          aria-label="Copy draft"
        >
          {copied ? (
            <Check className="size-[14px]" aria-hidden="true" />
          ) : (
            <Copy className="size-[14px]" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="px-3 py-2.5">
        {headers.length > 0 ? (
          <dl className="mb-2 space-y-0.5 border-b pb-2 text-[13px]">
            {headers.map(([key, value]) => (
              <div key={key} className="flex gap-1.5">
                <dt className="shrink-0 text-muted-foreground">{HEADER_LABEL[key]}:</dt>
                <dd
                  className={
                    key === "subject"
                      ? "min-w-0 break-words font-semibold text-foreground"
                      : "min-w-0 break-words text-foreground"
                  }
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
          {body}
        </div>
      </div>
      {draftId ? (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          {sendState === "error" && sendError ? (
            <span className="mr-auto min-w-0 break-words text-[12px] text-destructive">{sendError}</span>
          ) : null}
          <button
            type="button"
            onClick={onSend}
            disabled={sendState === "sending" || sendState === "sent"}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            <Send className="size-[14px]" aria-hidden="true" />
            {sendLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
