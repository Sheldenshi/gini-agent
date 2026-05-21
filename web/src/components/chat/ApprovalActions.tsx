"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RiskPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useApprovals, useInvalidate } from "@/lib/queries";
import type { Approval } from "@runtime/types";

// Inline Approve / Deny actions rendered under the synthetic
// "Waiting for approval..." placeholder bubble in the chat. Filters
// approvals by the in-flight task id so the user doesn't have to
// navigate to /permissions while in a conversation.
//
// Visibility rules:
//   - Only renders when there's at least one PENDING approval bound to
//     `taskId`. Once decided, the placeholder swaps to the real
//     summary (or the task fails) and this component unmounts.
//   - The "Show command" disclosure is collapsed by default to keep the
//     bubble compact; opening it shows the full payload so the user can
//     audit before deciding.
//   - When `approval.action === "connector.request"` (raised by the
//     `request_connector` tool) we replace the default Approve/Deny pair
//     with an inline form that renders the provider's declared fields
//     directly inside the approval card. The Save button POSTs the
//     field values to /api/approvals/<id>/connect, which creates the
//     connector, probes it, and resolves the approval on success — the
//     existing resume flow handles the rest with no extra chat plumbing.
//     The standalone `AddConnectorDialog` component is still mounted on
//     /connectors for the regular add flow; this card just bypasses it.

// Shape of a provider field as carried on the approval payload. This
// mirrors `ProviderField` from src/integrations/connectors/types.ts;
// we declare it locally so the chat surface can stay decoupled from the
// runtime module path.
interface PayloadField {
  name: string;
  label: string;
  description?: string;
  secret: boolean;
  required?: boolean;
  placeholder?: string;
}

// Render the approval card's reason text with line breaks preserved and
// HTTPS URLs auto-linkified. Skills can embed Cloud Console URLs in the
// `reason` field so the user clicks directly from the inline form body;
// without auto-linkification the URLs render as plain text and require
// copy-paste.
//
// Trailing punctuation (`.`, `,`, `;`, `:`, `!`, `?`, `)`) is stripped
// from the matched URL and treated as text — `https://example.com/foo.`
// links to `https://example.com/foo`, with the dot rendered after the
// anchor. The `reason` is constructed by the runtime from skill
// instructions, not free-form user input, so we don't need to escape
// against XSS beyond React's default text rendering.
function renderReason(text: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, index) => {
    const isUrl = /^https?:\/\//.test(part);
    if (!isUrl) {
      return <span key={index}>{part}</span>;
    }
    const trailingMatch = part.match(/[.,;:!?)]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? part.slice(0, part.length - trailing.length) : part;
    return (
      <span key={index}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="underline text-blue-400 hover:text-blue-300 break-all"
        >
          {url}
        </a>
        {trailing}
      </span>
    );
  });
}

export function ApprovalActions({ taskId }: { taskId: string }) {
  const approvals = useApprovals();
  const invalidate = useInvalidate();
  const [expanded, setExpanded] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Field values for the inline connector.request form, keyed by approval
  // id so two pending connector requests (rare but possible) don't trample
  // each other. The map is sparse: an approval has an entry only after the
  // user types into one of its fields.
  const [requestFields, setRequestFields] = useState<Record<string, Record<string, string>>>({});

  const pending = (approvals.data ?? []).filter(
    (a) => a.taskId === taskId && a.status === "pending"
  );

  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "approve" | "deny" }) =>
      api<Approval>(`/approvals/${id}/${op}`, { method: "POST" }),
    onSuccess: () => {
      // Invalidate everything the chat surface depends on so the placeholder
      // swaps to running → summary as soon as the runtime acks.
      invalidate(["approvals", "tasks", "task", "chat", "events", "audit"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // POSTs the user-entered field values to the approval connect endpoint.
  // The runtime stores every value as a secret (encrypted at rest) so the
  // env binding lookup in resolveSkillEnv can find them; the field's
  // `secret` flag only drives the input type in the UI. On probe failure
  // we keep the form mounted with the inline error message so the user
  // can correct the credential without losing context. On success the
  // endpoint resolves the approval — invalidating the chat surface lets
  // the resumed task's running/summary message render.
  const connect = useMutation({
    mutationFn: async ({ approvalId, secrets }: { approvalId: string; secrets: Record<string, string> }) => {
      const response = await api<{ ok: boolean; message?: string; connector?: unknown }>(
        `/approvals/${approvalId}/connect`,
        {
          method: "POST",
          body: JSON.stringify({ secrets })
        }
      );
      return response;
    },
    onSuccess: (result, vars) => {
      if (result.ok) {
        setConnectError(null);
        // Clear field state for this approval — the card is about to
        // unmount as the approval moves out of `pending`.
        setRequestFields((prev) => {
          if (!(vars.approvalId in prev)) return prev;
          const next = { ...prev };
          delete next[vars.approvalId];
          return next;
        });
        invalidate(["approvals", "tasks", "task", "chat", "events", "audit", "connectors"]);
      } else {
        setConnectError(result.message ?? "Could not connect. Please verify the credentials and try again.");
        // The unhealthy connector row was still created; refresh the list
        // so the Connectors page reflects reality if the user opens it.
        invalidate(["connectors"]);
      }
    },
    onError: (error: Error) => {
      setConnectError(error.message);
    }
  });

  if (pending.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {pending.map((approval) => {
        const isConnectorRequest = approval.action === "connector.request";
        const providerLabel = isConnectorRequest
          ? (typeof approval.payload?.providerLabel === "string"
              ? approval.payload.providerLabel
              : String(approval.payload?.provider ?? "provider"))
          : "";
        // `browser.connect` is a special case: the action's
        // "command" is just opening a Chrome window — there is no
        // raw command line to audit, and surfacing the connect
        // endpoint / bearer token in a "Show command" panel would
        // be more confusing than useful. Render a friendlier label
        // and use the reason (carried on the approval's target /
        // payload.reason) as the body.
        const isBrowserConnect = approval.action === "browser.connect";
        // `||` (not `??`) so an empty-string reason also falls back to
        // the approval target. `??` only fires for null/undefined; a
        // payload that carried `reason: ""` would otherwise render a
        // blank card body.
        const reasonText =
          (typeof approval.payload.reason === "string" && approval.payload.reason.length > 0
            ? approval.payload.reason
            : undefined) || approval.target;

        // Provider fields for the inline form. Payloads predate the
        // typed shape, so we defensively re-validate before rendering.
        const fields: PayloadField[] = isConnectorRequest && Array.isArray(approval.payload?.fields)
          ? (approval.payload.fields as unknown[]).filter(
              (f): f is PayloadField =>
                typeof f === "object"
                && f !== null
                && typeof (f as PayloadField).name === "string"
                && typeof (f as PayloadField).label === "string"
                && typeof (f as PayloadField).secret === "boolean"
            )
          : [];
        const values = requestFields[approval.id] ?? {};
        const requiredMissing = fields.some(
          (field) => field.required && !(values[field.name] ?? "").trim()
        );

        return (
          <div
            key={approval.id}
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">
                {isConnectorRequest
                  ? `Connect ${providerLabel}`
                  : isBrowserConnect
                    ? "Open a browser window"
                    : approval.action}
              </span>
              {/*
                Suppress the MEDIUM-RISK badge for `browser.connect` and
                `connector.request`. Both are gated (the user still chooses
                whether to connect) but the visual framing is softer because
                they're benign sign-in / setup steps, not destructive actions.
                All other approvals keep the badge.
              */}
              {isBrowserConnect || isConnectorRequest ? null : <RiskPill value={approval.risk} />}
              {isBrowserConnect || isConnectorRequest ? null : (
                <button
                  type="button"
                  className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? "Hide details" : "Show details"}
                </button>
              )}
            </div>
            {isConnectorRequest ? (
              <>
                {/*
                  No reason body here: for connector.request approvals the
                  multi-line reason (with URLs) is surfaced as the chat
                  bubble above this card via the synthetic placeholder in
                  getChatSession. Rendering it again inside the form would
                  duplicate the instructions; the form keeps only the title
                  and the input fields.
                */}
                <div className="mt-3 space-y-3">
                  {fields.map((field) => (
                    <div key={field.name} className="space-y-1">
                      <Label htmlFor={`approval-${approval.id}-${field.name}`}>
                        {field.label}
                        {field.required ? " *" : ""}
                      </Label>
                      <Input
                        id={`approval-${approval.id}-${field.name}`}
                        type={field.secret ? "password" : "text"}
                        value={values[field.name] ?? ""}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        onChange={(event) => {
                          const next = event.target.value;
                          setRequestFields((prev) => ({
                            ...prev,
                            [approval.id]: {
                              ...(prev[approval.id] ?? {}),
                              [field.name]: next
                            }
                          }));
                          // Clear the inline error as soon as the user
                          // edits a field — a stale error after a retry
                          // would be confusing.
                          if (connectError) setConnectError(null);
                        }}
                      />
                      {field.description ? (
                        <p className="text-[11px] text-muted-foreground">{field.description}</p>
                      ) : null}
                    </div>
                  ))}
                  {connectError ? <p className="text-xs text-destructive">{connectError}</p> : null}
                </div>
              </>
            ) : isBrowserConnect ? (
              <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/90">
                {renderReason(reasonText)}
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted-foreground">{approval.reason}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-foreground/90">
                  {truncate(approval.target, expanded ? 4000 : 200)}
                </p>
                {expanded ? (
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-2 font-mono text-[10px]">
                    {JSON.stringify(approval.payload, null, 2)}
                  </pre>
                ) : null}
              </>
            )}
            <div className="mt-2 flex gap-2">
              {isConnectorRequest ? (
                <>
                  <Button
                    size="sm"
                    disabled={connect.isPending || requiredMissing}
                    onClick={() => {
                      // Every field's value is sent as a secret — the
                      // runtime encrypts them at rest regardless of the
                      // field's `secret` flag, and resolveSkillEnv only
                      // reads from secretRefs. Storing the non-secret
                      // client_id this way is benign (heavier than
                      // necessary, but auditable) and keeps the env
                      // binding lookup working without a separate
                      // metadata path.
                      const secrets: Record<string, string> = {};
                      for (const field of fields) {
                        const raw = (values[field.name] ?? "").trim();
                        if (!raw) continue;
                        secrets[field.name] = raw;
                      }
                      setConnectError(null);
                      connect.mutate({ approvalId: approval.id, secrets });
                    }}
                  >
                    {connect.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending || connect.isPending}
                    onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: approval.id, op: "approve" })}
                  >
                    {isBrowserConnect ? "Connect" : "Approve"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: approval.id, op: "deny" })}
                  >
                    {isBrowserConnect ? "Cancel" : "Deny"}
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
