"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { PairDeviceDialog } from "@/components/pairing/PairDeviceDialog";
import { effectiveStatus } from "./deviceStatus";

export interface DeviceRow { id: string; name: string; status: string; origin?: string; lastSeenAt?: string; expiresAt?: string }

export function humanizeLastSeen(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "active now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function DevicesCard({
  devices,
  revokePending,
  createPending,
  onRevoke,
  onCreatePairing
}: {
  devices: DeviceRow[];
  revokePending: boolean;
  createPending: boolean;
  onRevoke: (id: string) => void;
  onCreatePairing: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Active sessions</CardTitle>
            <CardDescription>{devices.filter((d) => effectiveStatus(d) === "active").length} active</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={createPending} onClick={onCreatePairing}>
              {createPending ? "Creating…" : "Create pairing code"}
            </Button>
            <PairDeviceDialog />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <EmptyState title="No devices" description="Create a pairing code, then claim it from a device." />
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{item.name}</p>
                  <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {!item.origin || item.origin === "loopback" ? (
                      <span>loopback</span>
                    ) : (
                      <span className="truncate font-mono">{item.origin}</span>
                    )}
                    {humanizeLastSeen(item.lastSeenAt) ? (
                      <span className="truncate">· {humanizeLastSeen(item.lastSeenAt)}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={effectiveStatus(item)} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revokePending || item.status === "revoked"}
                    onClick={() => onRevoke(item.id)}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
