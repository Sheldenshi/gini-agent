"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { ChatAllowlistView } from "@runtime/integrations/messaging";

export interface McpRow { id: string; name: string; status: string; command: string; lastHealthAt?: string }
export interface MessagingRow { id: string; name: string; status: string; kind: string }

export function McpCard({
  servers,
  healthPending,
  disablePending,
  onHealth,
  onDisable
}: {
  servers: McpRow[];
  healthPending: boolean;
  disablePending: boolean;
  onHealth: (id: string) => void;
  onDisable: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">MCP servers</CardTitle>
        <CardDescription>{servers.length} configured</CardDescription>
      </CardHeader>
      <CardContent>
        {servers.length === 0 ? (
          <EmptyState title="No MCP servers" />
        ) : (
          <ul className="divide-y divide-border">
            {servers.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{item.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{item.command}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.status} />
                  <Button size="sm" variant="outline" disabled={healthPending} onClick={() => onHealth(item.id)}>Health</Button>
                  <Button size="sm" variant="outline" disabled={disablePending || item.status === "disabled"} onClick={() => onDisable(item.id)}>Disable</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function MessagingCard({
  bridges,
  healthPending,
  disablePending,
  onHealth,
  onDisable
}: {
  bridges: MessagingRow[];
  healthPending: boolean;
  disablePending: boolean;
  onHealth: (id: string) => void;
  onDisable: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Messaging bridges</CardTitle>
        <CardDescription>{bridges.length} configured</CardDescription>
      </CardHeader>
      <CardContent>
        {bridges.length === 0 ? (
          <EmptyState title="No bridges" />
        ) : (
          <ul className="divide-y divide-border">
            {bridges.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm">{item.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{item.kind}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill value={item.status} />
                    <Button size="sm" variant="outline" disabled={healthPending} onClick={() => onHealth(item.id)}>Health</Button>
                    <Button size="sm" variant="outline" disabled={disablePending || item.status === "disabled"} onClick={() => onDisable(item.id)}>Disable</Button>
                  </div>
                </div>
                {item.kind === "telegram" && item.status === "configured" ? (
                  <TelegramPendingRequests bridgeId={item.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Pending pairing requests for a Telegram bridge. Polls the bridge's chat
// allowlist every 3 s; each chat that messaged the bot but isn't yet on
// the allowlist surfaces here as an Approve/Reject row. The underlying
// state lives on the bridge as `metadata.recentDeniedChats`, populated by
// the Telegram poller every time a non-allowlisted update arrives.
function TelegramPendingRequests({ bridgeId }: { bridgeId: string }) {
  const invalidate = useInvalidate();
  const chats = useQuery({
    queryKey: ["messaging", bridgeId, "chats"],
    queryFn: () => api<ChatAllowlistView>(`/messaging/${encodeURIComponent(bridgeId)}/chats`),
    refetchInterval: 3_000
  });
  const approve = useMutation({
    mutationFn: (chatId: number) =>
      api(`/messaging/${encodeURIComponent(bridgeId)}/allow`, {
        method: "POST",
        body: JSON.stringify({ chatId })
      }),
    onSuccess: () => {
      toast.success("Chat approved");
      invalidate(["messaging", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const reject = useMutation({
    mutationFn: (chatId: number) =>
      api(`/messaging/${encodeURIComponent(bridgeId)}/reject-pending`, {
        method: "POST",
        body: JSON.stringify({ chatId })
      }),
    onSuccess: () => {
      toast.message("Request rejected");
      invalidate(["messaging"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const pending = chats.data?.recentDeniedChats ?? [];
  const busy = approve.isPending || reject.isPending;

  if (pending.length === 0) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden />
        <span className="text-sky-600 dark:text-sky-400 font-medium">
          Listening for new pairing requests…
        </span>
        <span>To add a sender, have them message your bot — their request will appear here.</span>
      </div>
    );
  }

  return (
    <ul className="mt-1 flex flex-col gap-2">
      {pending.map((entry) => (
        <li
          key={entry.chatId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              Pairing request from {entry.sender ?? "unknown sender"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {entry.chatType} · chat {entry.chatId}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 rounded-full bg-sky-500 px-3 text-xs font-semibold text-white hover:bg-sky-600"
              disabled={busy}
              onClick={() => approve.mutate(entry.chatId)}
            >
              <Check className="mr-1 h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              disabled={busy}
              onClick={() => reject.mutate(entry.chatId)}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
