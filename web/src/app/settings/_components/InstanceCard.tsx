"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function InstanceCard({
  instance,
  activeProfileId
}: {
  instance: string | undefined;
  activeProfileId: string | undefined;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Instance</CardTitle></CardHeader>
      <CardContent>
        <p className="font-mono text-sm">{instance ?? "…"}</p>
        <p className="font-mono text-[11px] text-muted-foreground">active profile: {activeProfileId ?? "—"}</p>
      </CardContent>
    </Card>
  );
}
