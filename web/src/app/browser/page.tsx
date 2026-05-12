"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import {
  useBrowserConnection,
  useConnectBrowser,
  useDisconnectBrowser
} from "@/lib/queries";

// The /browser page lets the user attach a real headed Chrome to the agent
// runtime so authenticated state (cookies, signed-in sessions) becomes
// visible to browser_* tool calls. Two modes:
//
//   - Default: the runtime spawns a managed Chrome with a dedicated user-
//     data-dir under the instance state root. The user signs into the
//     sites they care about in that window.
//   - Advanced: paste an existing CDP ws:// URL to attach to a Chrome the
//     user already started themselves.
//
// Disconnect kills the managed Chrome (or just drops the CDP attachment)
// but leaves the profile directory on disk so the user keeps their
// signed-in state for the next connect.

export default function BrowserPage() {
  const connect = useConnectBrowser();
  const disconnect = useDisconnectBrowser();
  // Tighten the polling cadence while a mutation is in flight so the user
  // sees the new connection status snap into place; idle pages can fall
  // back to the slower 5s cadence to avoid hammering the runtime.
  const status = useBrowserConnection({ isActive: connect.isPending || disconnect.isPending });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [port, setPort] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const connected = status.data?.connected ?? false;
  const record = status.data?.record;

  const handleConnect = (mode: "managed" | "cdp") => {
    const body: { cdpUrl?: string; port?: number } = {};
    if (mode === "cdp") {
      const trimmed = cdpUrl.trim();
      if (!trimmed) {
        toast.error("Paste a CDP URL first.");
        return;
      }
      body.cdpUrl = trimmed;
    } else if (port.trim().length > 0) {
      const parsed = Number(port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        toast.error("Port must be an integer between 1 and 65535.");
        return;
      }
      body.port = parsed;
    }
    connect.mutate(body, {
      onSuccess: () => {
        toast.success(mode === "cdp" ? "Attached to Chrome via CDP." : "Chrome connected.");
        setCdpUrl("");
        setPort("");
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
      <PageHeader
        title="Browser"
        description="Attach a real Chrome window so the agent inherits your signed-in state"
      />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-sm">Connection</CardTitle>
                <CardDescription>
                  {connected
                    ? "A Chrome window is attached. Browser tools will see what you see."
                    : "No browser attached. The agent uses an isolated headless Chromium."}
                </CardDescription>
              </div>
              <StatusPill value={connected ? "active" : "disabled"} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {record ? (
              <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <Detail label="Mode" value={record.mode} />
                <Detail label="Started" value={new Date(record.startedAt).toLocaleString()} />
                {record.pid !== null ? <Detail label="PID" value={String(record.pid)} mono /> : null}
                {record.chromePath ? <Detail label="Binary" value={record.chromePath} mono wrap /> : null}
                {record.dataDir ? <Detail label="Profile" value={record.dataDir} mono wrap /> : null}
                <Detail label="CDP URL" value={record.cdpUrl} mono wrap />
              </dl>
            ) : (
              <p className="text-xs text-muted-foreground">
                Click Connect to launch a fresh Chrome with a dedicated profile under{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  ~/.gini/instances/&lt;instance&gt;/chrome-profile
                </code>
                . Sign into whatever you need; the agent inherits those cookies.
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
                  <Label htmlFor="port" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Debugging port (managed mode)
                  </Label>
                  <Input
                    id="port"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder="9222"
                    inputMode="numeric"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Optional. Leave blank to use the runtime default.
                  </p>
                </div>
                <div>
                  <Label htmlFor="cdp" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Attach to existing Chrome (CDP URL)
                  </Label>
                  <Input
                    id="cdp"
                    value={cdpUrl}
                    onChange={(event) => setCdpUrl(event.target.value)}
                    placeholder="ws://127.0.0.1:9222/devtools/browser/abc"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Start Chrome with{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                      --remote-debugging-port=9222
                    </code>{" "}
                    yourself, then paste its websocket debugger URL here. The runtime never touches your Chrome process in this mode.
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

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">How this works</CardTitle>
            <CardDescription>What happens when you click Connect</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>
              The runtime probes the standard install locations (Chrome, Chromium, Microsoft Edge) or
              honors{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                GINI_CHROME_PATH
              </code>
              , spawns Chrome with{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                --remote-debugging-port
              </code>{" "}
              and a dedicated{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                --user-data-dir
              </code>
              , and waits up to 15 seconds for the CDP endpoint to come up.
            </p>
            <p>
              Once connected, browser_* tool calls switch from a fresh headless context to your real
              Chrome session. Disconnect kills the spawned Chrome (the agent never closes your
              own browser windows in advanced/CDP mode) but the profile directory stays on disk so
              your sign-ins persist across reconnects.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect browser?</DialogTitle>
            <DialogDescription>
              {record?.mode === "managed"
                ? "The runtime will send SIGTERM to the Chrome process it launched."
                : "The runtime will drop its CDP attachment but never touch the Chrome process you started."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Your profile directory{" "}
            {record?.dataDir ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                {record.dataDir}
              </code>
            ) : (
              <span>(if any)</span>
            )}{" "}
            stays on disk, so signed-in cookies and saved logins are preserved for the next connect.
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
