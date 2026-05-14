"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface DeviceRow { id: string; name: string; status: string }

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
            <CardTitle className="text-sm">Paired devices</CardTitle>
            <CardDescription>{devices.length} known</CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={createPending} onClick={onCreatePairing}>
            {createPending ? "Creating…" : "Create pairing code"}
          </Button>
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
                  <p className="font-mono text-[10px] text-muted-foreground">{item.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill value={item.status} />
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

