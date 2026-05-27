"use client";

// In-app bug reporter. Collects a short freeform description plus a
// couple of optional context fields, attaches whatever runtime info is on
// hand (package version, git sha, instance, page), and shells out to a
// prefilled GitHub new-issue URL on the Lilac-Labs/gini-agent repo. The
// "Copy" button is a fallback for users who'd rather paste the report
// into Slack or grab it before logging into GitHub.

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useStatus } from "@/lib/queries";
import {
  buildIssueUrl,
  formatIssueBody,
  isReportSubmittable,
  type BugReportContext,
  type BugReportInput
} from "@/lib/bug-report";

const EMPTY_INPUT: BugReportInput = {
  title: "",
  whatHappened: "",
  stepsToReproduce: "",
  expected: ""
};

export interface ReportBugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReportBugDialog({ open, onOpenChange }: ReportBugDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `max-h` + `overflow-y-auto` keep the footer reachable on short */}
      {/* viewports (e.g. iPhone SE) and when the field-sizing textareas */}
      {/* grow with a long pasted error log. */}
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* Mount the form only while the dialog is open so each open cycle */}
        {/* gets a fresh useState. Avoids resetting form state in an effect */}
        {/* and keeps the body free of any stale input from a prior session. */}
        {open ? <ReportBugForm onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ReportBugForm({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const status = useStatus();
  const [input, setInput] = useState<BugReportInput>(EMPTY_INPUT);

  // Base diagnostic context that doesn't depend on when the user clicks
  // submit. `reportedAt` is intentionally NOT in here — we want that
  // timestamp pinned to the moment the user actually files the report,
  // not whenever React last re-ran the memo. See buildSubmitContext.
  const baseContext = useMemo<BugReportContext>(() => {
    const version = status.data?.version;
    return {
      packageVersion: version?.packageVersion,
      gitShortSha: version?.git.shortSha ?? null,
      gitBranch: version?.git.branch ?? null,
      instance: status.data?.instance,
      page: pathname ?? undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined
    };
  }, [status.data, pathname]);

  function buildSubmitContext(): BugReportContext {
    return { ...baseContext, reportedAt: new Date().toISOString() };
  }

  const submittable = isReportSubmittable(input);

  function setField<K extends keyof BugReportInput>(key: K, value: BugReportInput[K]) {
    setInput((prev) => ({ ...prev, [key]: value }));
  }

  function openIssue() {
    if (!submittable) return;
    const url = buildIssueUrl(input, buildSubmitContext());
    window.open(url, "_blank", "noopener,noreferrer");
    toast.success("Opening GitHub issue…");
    onClose();
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(formatIssueBody(input, buildSubmitContext()));
      toast.success("Report copied to clipboard");
    } catch {
      // The formatted body lives only in memory — nothing in the DOM
      // matches what we tried to copy, so we can't honestly direct the
      // user to "select the text manually." Point them at the working
      // path (Open issue on GitHub builds the same body into the URL).
      toast.error("Couldn't copy. Use Open issue on GitHub instead.");
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Report a bug</DialogTitle>
        <DialogDescription>
          Opens a prefilled issue on the{" "}
          <a
            href="https://github.com/Lilac-Labs/gini-agent/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Lilac-Labs/gini-agent
          </a>{" "}
          repo. Version and page info are attached automatically.
        </DialogDescription>
      </DialogHeader>
      {/* SECURITY.md asks for vulnerability reports to go to a private */}
      {/* email rather than a public GitHub issue. Surface that here so a */}
      {/* user about to file a security-relevant bug doesn't accidentally */}
      {/* expose details in public. */}
      <div className="rounded-md border border-border bg-amber-500/10 px-3 py-2 text-[12px] text-foreground">
        <strong className="font-medium">Security issue?</strong>{" "}Don&apos;t file it here.
        Email{" "}
        <a
          href="mailto:security@lilaclabs.ai"
          className="underline underline-offset-2 hover:text-foreground"
        >
          security@lilaclabs.ai
        </a>{" "}
        — see{" "}
        <a
          href="https://github.com/Lilac-Labs/gini-agent/blob/main/SECURITY.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          SECURITY.md
        </a>
        .
      </div>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="bug-title">Title</Label>
          <Input
            id="bug-title"
            value={input.title}
            onChange={(e) => setField("title", e.target.value)}
            placeholder="Short summary (optional)"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bug-what">What happened? *</Label>
          <Textarea
            id="bug-what"
            value={input.whatHappened}
            onChange={(e) => setField("whatHappened", e.target.value)}
            placeholder="What broke? Any error messages?"
            rows={4}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bug-steps">Steps to reproduce</Label>
          <Textarea
            id="bug-steps"
            value={input.stepsToReproduce}
            onChange={(e) => setField("stepsToReproduce", e.target.value)}
            placeholder={"1. Open chat\n2. ..."}
            rows={3}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bug-expected">Expected behavior</Label>
          <Textarea
            id="bug-expected"
            value={input.expected}
            onChange={(e) => setField("expected", e.target.value)}
            placeholder="What did you expect to happen?"
            rows={2}
          />
        </div>
        <div className="rounded-md border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Will attach</div>
          <ul className="space-y-0.5">
            {baseContext.packageVersion ? <li>Version {baseContext.packageVersion}</li> : null}
            {baseContext.gitShortSha ? (
              <li>
                Commit {baseContext.gitShortSha}
                {baseContext.gitBranch ? ` (branch ${baseContext.gitBranch})` : ""}
              </li>
            ) : null}
            {baseContext.instance ? <li>Instance {baseContext.instance}</li> : null}
            {baseContext.page ? <li>Page {baseContext.page}</li> : null}
            {baseContext.userAgent ? (
              <li className="truncate" title={baseContext.userAgent}>UA {baseContext.userAgent}</li>
            ) : null}
          </ul>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={copyReport}>
          Copy report
        </Button>
        <Button onClick={openIssue} disabled={!submittable}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open issue on GitHub
        </Button>
      </DialogFooter>
    </>
  );
}
