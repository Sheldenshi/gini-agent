"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LaneCard({
  lane,
  activeProfileId
}: {
  lane: string | undefined;
  activeProfileId: string | undefined;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Lane</CardTitle></CardHeader>
      <CardContent>
        <p className="font-mono text-sm">{lane ?? "…"}</p>
        <p className="font-mono text-[11px] text-muted-foreground">active profile: {activeProfileId ?? "—"}</p>
      </CardContent>
    </Card>
  );
}
