"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useBrowserConnection,
  useConnectBrowser,
  useDisconnectBrowser
} from "@/lib/queries";

// Connect opens a visible browser so the user can sign in to sites the agent
// needs. Disconnect closes the window; saved sign-ins stay available for later.
export function BrowserSettingsCard() {
  const connect = useConnectBrowser();
  const disconnect = useDisconnectBrowser();
  const status = useBrowserConnection({
    isActive: connect.isPending || disconnect.isPending
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const connected = status.data?.connected ?? false;
  const record = status.data?.record;

  const handleConnect = (mode: "managed" | "cdp") => {
    const body: { cdpUrl?: string } = {};
    if (mode === "cdp") {
      const trimmed = cdpUrl.trim();
      if (!trimmed) {
        toast.error("Paste a CDP URL first.");
        return;
      }
      body.cdpUrl = trimmed;
    }
    connect.mutate(body, {
      onSuccess: () => {
        toast.success(mode === "cdp" ? "Attached to Chrome via CDP." : "Chrome connected.");
        setCdpUrl("");
      },
      onError: (error: Error) => toast.error(error.message)
    });
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast.success("Disconnected.");
        setDisconnectOpen(false);
      },
      onError: (error: Error) => toast.error(error.message)
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Browser sign-ins</CardTitle>
              <CardDescription>
                {connected
                  ? "Chrome is open for sign-in."
                  : "Connect to sign in to sites the agent needs."}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {record ? (
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <Detail
                label="Mode"
                value={
                  record.mode === "managed"
                    ? "Managed (visible Chrome window)"
                    : "External CDP attach"
                }
              />
              <Detail label="Started" value={new Date(record.startedAt).toLocaleString()} />
              {record.pid !== null ? <Detail label="PID" value={String(record.pid)} mono /> : null}
              {record.chromePath ? <Detail label="Binary" value={record.chromePath} mono wrap /> : null}
              {record.dataDir ? <Detail label="Profile" value={record.dataDir} mono wrap /> : null}
              {record.mode === "cdp" ? (
                <Detail label="CDP URL" value={record.cdpUrl} mono wrap />
              ) : null}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              Click Connect to open Chrome and sign in to anything the agent needs to use.
              When you are done, disconnect closes the window. Saved sign-ins stay available
              for future agent browser tasks.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDisconnectOpen(true)}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => handleConnect("managed")}
                  disabled={connect.isPending}
                >
                  {connect.isPending ? "Connecting..." : "Connect"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAdvanced((value) => !value)}
                >
                  {showAdvanced ? "Hide Advanced" : "Advanced"}
                </Button>
              </>
            )}
          </div>

          {!connected && showAdvanced ? (
            <div className="grid gap-3 rounded-md border border-border bg-card/50 p-3 text-xs">
              <div>
                <Label htmlFor="browser-cdp" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Attach to existing Chrome (CDP URL)
                </Label>
                <Input
                  id="browser-cdp"
                  value={cdpUrl}
                  onChange={(event) => setCdpUrl(event.target.value)}
                  placeholder="ws://127.0.0.1:9222/devtools/browser/abc"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Start Chrome with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    --remote-debugging-port=9222
                  </code>{" "}
                  yourself, then paste its websocket debugger URL here. The runtime never
                  touches your Chrome process in this mode.
                </p>
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleConnect("cdp")}
                    disabled={connect.isPending || cdpUrl.trim().length === 0}
                  >
                    Attach via CDP
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {connect.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {connect.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect browser?</DialogTitle>
            <DialogDescription>
              {record?.mode === "managed"
                ? "This closes Chrome. Your saved sign-ins stay available to the agent."
                : "The runtime will drop its CDP attachment but never touch the Chrome process you started."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {record?.mode === "managed" ? (
              "You can connect again whenever you need to sign into another site."
            ) : (
              "Your Chrome process is left alone."
            )}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting..." : "Disconnect Chrome"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
  wrap = false
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-[11px]" : "text-xs"} ${wrap ? "break-all" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
