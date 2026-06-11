"use client";

import { useState } from "react";
import { Mail, Copy, Check } from "lucide-react";

// Inline email-draft card. The agent emits a ```email-draft fenced block after
// saving a Gmail draft; MarkdownContent routes that block here so the user can
// read the draft in the chat instead of being told to open Gmail and search.
//
// The fenced block is plain text: optional RFC-style header lines
// (To/Cc/Bcc/From/Subject, case-insensitive) up to the first blank line, then
// the body. Everything renders read-only — there is no send/open affordance;
// the authoritative draft already lives in Gmail.

const HEADER_KEYS = ["to", "cc", "bcc", "from", "subject"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const HEADER_LABEL: Record<HeaderKey, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  from: "From",
  subject: "Subject"
};

function parseDraft(raw: string): { headers: Array<[HeaderKey, string]>; body: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const headers: Array<[HeaderKey, string]> = [];
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
    break; // first non-header line ends the header section; body starts here
  }
  const body = lines.slice(i).join("\n").trim();
  return { headers, body };
}

export function EmailDraftCard({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false);
  const { headers, body } = parseDraft(raw.trim());

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
    </div>
  );
}
