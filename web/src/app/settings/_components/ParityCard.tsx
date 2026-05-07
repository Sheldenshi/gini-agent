"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";

export interface ChecksResult {
  ok: boolean;
  checks: Array<{ id: string; label: string; status: string; evidence: string[] }>;
}

export function ParityCard({ title, result }: { title: string; result: ChecksResult | undefined }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {result ? <StatusPill value={result.ok ? "pass" : "partial"} /> : null}
        </div>
      </CardHeader>
      <CardContent>
        {!result ? (
          <EmptyState title="Loading…" />
        ) : (
          <ul className="divide-y divide-border">
            {result.checks.map((check) => (
              <li key={check.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-xs">{check.label}</span>
                <StatusPill value={check.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
