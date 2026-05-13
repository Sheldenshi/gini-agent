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
  useDisconnectBrowser,
  useWipeBrowserProfile
} from "@/lib/queries";

// The /browser page is the user-facing surface for the persistent profile
// the agent always drives. Sign-ins live in a dedicated profile dir
// (~/.gini/instances/<inst>/chrome-profile/) that the agent uses headless
// by default. Connect just OPENS A WINDOW into the same profile so the
// user can sign in; Disconnect closes the window, but the agent still
// has access to the same cookies on its next call. Wipe Profile is the
// only way to actually remove saved sign-ins.
//
// Advanced: paste an existing CDP ws:// URL to attach to a Chrome the
// user already started themselves. Kept for power users; the path is
// known-flaky under the current Bun + Playwright stack.

export default function BrowserPage() {
  const connect = useConnectBrowser();
  const disconnect = useDisconnectBrowser();
  const wipe = useWipeBrowserProfile();
  // Tighten the polling cadence while a mutation is in flight so the user
  // sees the new connection status snap into place; idle pages can fall
  // back to the slower 5s cadence to avoid hammering the runtime.
  const status = useBrowserConnection({
    isActive: connect.isPending || disconnect.isPending || wipe.isPending
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

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

  const handleWipe = () => {
    wipe.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(`Wiped profile at ${result.dataDir}.`);
        setWipeOpen(false);
      },
      onError: (error: Error) => toast.error(error.message)
    });
  };

  return (
    <>
      <PageHeader
        title="Browser"
        description="Toggle a visible Chrome window over the agent's persistent profile"
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
                    : "Headless — your saved sign-ins are still available. Click Connect to open a window."}
                </CardDescription>
              </div>
              <StatusPill value={connected ? "active" : "disabled"} />
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
                The agent always drives a persistent profile at{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  ~/.gini/instances/&lt;instance&gt;/chrome-profile
                </code>
                . Click Connect to open a visible window over that profile so you can sign in;
                disconnect closes the window but the agent keeps access to the cookies on its
                next call.
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

            <div className="border-t pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setWipeOpen(true)}
                  disabled={connected || wipe.isPending}
                  title={
                    connected
                      ? "Disconnect the visible window before wiping the profile."
                      : "Permanently delete all saved sign-ins and cookies."
                  }
                >
                  {wipe.isPending ? "Wiping..." : "Wipe Profile"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Removes all cookies and saved logins from the persistent profile. Use this
                  when you want the agent to start fresh.
                </p>
              </div>
              {wipe.error ? (
                <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  {wipe.error.message}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">How this works</CardTitle>
            <CardDescription>Persistent profile, visibility toggle</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>
              The agent always drives the same per-instance profile at{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                ~/.gini/instances/&lt;instance&gt;/chrome-profile
              </code>
              . By default Chromium runs headless against that profile. When you click Connect,
              the runtime closes the headless context and relaunches the same profile in a
              visible window so you can sign in.
            </p>
            <p>
              Disconnect closes the visible window. The agent keeps using the same profile
              headless — your sign-ins remain accessible on its next tool call. Sign-ins
              survive runtime restarts too; they only go away if you explicitly hit{" "}
              <strong>Wipe Profile</strong>.
            </p>
            <p>
              Advanced: attach to a Chrome you started yourself by pasting its CDP URL. Note
              that this path is known-flaky under the current Playwright + Bun stack; managed
              mode is the recommended option.
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
                ? "Closing the Chrome window. Your saved sign-ins remain accessible to the agent."
                : "The runtime will drop its CDP attachment but never touch the Chrome process you started."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {record?.mode === "managed" ? (
              <>
                The per-instance profile at{" "}
                {record?.dataDir ? (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                    {record.dataDir}
                  </code>
                ) : (
                  <span>your instance profile directory</span>
                )}{" "}
                stays on disk and the agent keeps using it headless. Use{" "}
                <strong>Wipe Profile</strong> if you want to remove your saved sign-ins.
              </>
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

      <Dialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wipe browser profile?</DialogTitle>
            <DialogDescription>
              This permanently deletes all cookies, saved logins, and browsing data in the
              per-instance profile.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Removes{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              ~/.gini/instances/&lt;instance&gt;/chrome-profile
            </code>
            . The agent will see an unauthenticated browser on its next request and you'll
            need to sign back into anything you care about.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleWipe} disabled={wipe.isPending}>
              {wipe.isPending ? "Wiping..." : "Wipe Profile"}
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
