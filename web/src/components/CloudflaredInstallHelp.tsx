"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CloudflaredInstallHint } from "@/lib/cloudflared-install-hint";

/** Actionable, platform-appropriate guidance shown when the tunnel couldn't
 *  auto-install cloudflared. Replaces the old raw three-OS error blob: one
 *  copy-pasteable command for the gateway's detected platform, a copy button,
 *  and a link to the releases page. */
export function CloudflaredInstallHelp({ hint, message }: { hint: CloudflaredInstallHint; message: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hint.command);
      setCopied(true);
      toast.success("Install command copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't access the clipboard — select and copy the command manually");
    }
  };

  return (
    <div
      className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
      data-testid="cloudflared-install-help"
    >
      <div className="flex items-start gap-2">
        <Download className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>{message}</span>
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 break-all rounded bg-background/60 px-2 py-1 font-mono text-xs"
          data-testid="cloudflared-install-command"
        >
          {hint.command}
        </code>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={copy}
          aria-label="Copy install command"
          data-testid="cloudflared-copy-command"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <a
        href={hint.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
        data-testid="cloudflared-releases-link"
      >
        cloudflared releases <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
