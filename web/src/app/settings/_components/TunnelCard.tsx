"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { Loader2, RefreshCw, RotateCw } from "lucide-react";

interface TunnelSnapshot {
  enabled: boolean;
  secret: string | null;
  publicUrl: string | null;
  secretRevision: string | null;
  lastError: string | null;
  appleNotes: {
    enabled: boolean;
    notesAvailable: boolean | null;
    lastError: string | null;
  };
}

export function TunnelCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tunnel"],
    queryFn: () => api<TunnelSnapshot>("/tunnel"),
    refetchInterval: 5_000
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tunnel"] });
    qc.invalidateQueries({ queryKey: ["tunnel-launcher"] });
  };

  const enable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    onSuccess: () => { toast.success("Tunnel enabled"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const disable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => { toast.success("Tunnel disabled"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const rotate = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ rotateSecret: true }) }),
    onSuccess: () => { toast.success("Secret rotated"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const toggleNotes = useMutation({
    mutationFn: (enabled: boolean) =>
      api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ appleNotes: { enabled } }) }),
    onSuccess: (_, enabled) => { toast.success(`Apple Notes mirror ${enabled ? "enabled" : "disabled"}`); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const refreshNotes = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel/refresh-notes", { method: "POST" }),
    onSuccess: () => { toast.success("Notes refreshed"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const [showSecret, setShowSecret] = useState(false);

  const busy = enable.isPending || disable.isPending || rotate.isPending || toggleNotes.isPending || refreshNotes.isPending;
  const showQr = Boolean(data?.enabled && data?.publicUrl);

  return (
    <Card data-testid="tunnel-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Mobile tunnel
              {isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : data?.enabled ? (
                <Badge variant="secondary" data-testid="tunnel-status-pill">live</Badge>
              ) : (
                <Badge variant="outline" data-testid="tunnel-status-pill">off</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Cloudflare quick tunnel gated by a per-instance 192-bit secret. Scan from your phone to reach this
              gateway anywhere.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {data?.enabled ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => disable.mutate()}>
                Disable
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => enable.mutate()}>
                Enable
              </Button>
            )}
            <Button size="icon" variant="ghost" disabled={busy || !data?.enabled} onClick={() => rotate.mutate()} aria-label="Rotate secret">
              <RotateCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showQr ? (
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <img
              src={`/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(data?.secretRevision ?? "")}`}
              alt="Tunnel QR"
              className="h-48 w-48 rounded border bg-white p-2"
              data-testid="tunnel-settings-qr"
            />
            <div className="space-y-2 text-sm">
              <div>
                <div className="text-muted-foreground">Public URL</div>
                <code className="break-all text-xs">{data?.publicUrl}</code>
              </div>
              <div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  Secret
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setShowSecret((s) => !s)}>
                    {showSecret ? "Hide" : "Show"}
                  </Button>
                </div>
                <code className="text-xs">
                  {showSecret ? data?.secret : "•".repeat(data?.secret?.length ?? 32)}
                </code>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Enable the tunnel to publish a Cloudflare URL. The QR contains a one-time secret and a session
            cookie scopes future requests to this exact tunnel hostname.
          </p>
        )}

        {data?.lastError ? (
          <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <span className="font-medium">Last error:</span> {data.lastError}
          </p>
        ) : null}

        <div className="space-y-2 rounded border bg-muted/30 px-3 py-3 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Apple Notes mirror</div>
              <div className="text-xs text-muted-foreground">
                Opt-in. The live URL is written into iCloud Notes so your phone sees the new URL after a restart.
              </div>
            </div>
            <Button
              size="sm"
              variant={data?.appleNotes.enabled ? "outline" : "default"}
              disabled={busy}
              onClick={() => toggleNotes.mutate(!data?.appleNotes.enabled)}
            >
              {data?.appleNotes.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
          {data?.appleNotes.enabled ? (
            <div className="flex items-center gap-2 text-xs">
              {data?.appleNotes.notesAvailable === false ? (
                <Badge variant="destructive">Unavailable</Badge>
              ) : data?.appleNotes.notesAvailable === true ? (
                <Badge variant="secondary">Available</Badge>
              ) : (
                <Badge variant="outline">Probing…</Badge>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => refreshNotes.mutate()}>
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh
              </Button>
              {data?.appleNotes.lastError ? (
                <span className="text-destructive">{data.appleNotes.lastError}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
