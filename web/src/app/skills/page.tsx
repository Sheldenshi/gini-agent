"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useSkills } from "@/lib/queries";
import type { SkillRecord } from "@/lib/types";

export default function SkillsPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const skills = useSkills(debounced);
  const invalidate = useInvalidate();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "test" | "trust" | "disable" | "rollback" }) =>
      api<SkillRecord>(`/skills/${encodeURIComponent(id)}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["skills", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const validate = useMutation({
    mutationFn: () => api<{ ok: boolean; results: Array<{ id: string; name: string; ok: boolean; issues: string[] }> }>("/skills/validate"),
    onSuccess: (result) => {
      const failing = result.results.filter((r) => !r.ok).length;
      toast.success(failing === 0 ? `All ${result.results.length} skills validated.` : `${failing} of ${result.results.length} skills have issues.`);
      invalidate(["skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const filtered = skills.data ?? [];
  const detail = filtered.find((s) => s.id === selected) ?? filtered[0];

  return (
    <>
      <PageHeader
        title="Skills"
        description="Procedures the agent can use"
        actions={
          <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
            {validate.isPending ? "Validating…" : "Validate all"}
          </Button>
        }
      />
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-80 flex-col gap-3">
          <Input placeholder="Search skills…" value={search} onChange={(event) => setSearch(event.target.value)} />
          {filtered.length === 0 ? (
            <EmptyState title="No skills" />
          ) : (
            <ul className="space-y-2 overflow-auto">
              {filtered.map((skill) => (
                <li key={skill.id}>
                  <button
                    onClick={() => setSelected(skill.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      detail?.id === skill.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-sm font-medium">{skill.name}</span>
                      <StatusPill value={skill.status} />
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">v{skill.version} · {skill.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!detail ? (
            <EmptyState title="No skill selected" />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{detail.name}</CardTitle>
                    <CardDescription className="font-mono text-[11px]">v{detail.version} · trigger “{detail.trigger}”</CardDescription>
                  </div>
                  <StatusPill value={detail.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{detail.description || "No description"}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "test" })}>Test</Button>
                  <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "trust" })}>Trust</Button>
                  <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "disable" })}>Disable</Button>
                  <Button size="sm" variant="outline" disabled={action.isPending || detail.previousVersions.length === 0} onClick={() => action.mutate({ id: detail.id, op: "rollback" })}>
                    Rollback
                  </Button>
                </div>
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps</h4>
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    {detail.steps.map((step, index) => <li key={index}>{step}</li>)}
                  </ol>
                </div>
                {detail.tests.length > 0 ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tests</h4>
                    <ul className="list-disc space-y-1 pl-5 text-sm">
                      {detail.tests.map((test, index) => <li key={index}>{test}</li>)}
                    </ul>
                  </div>
                ) : null}
                <p className="font-mono text-[10px] text-muted-foreground">
                  ✓ {detail.successCount} · ✕ {detail.failureCount}
                  {detail.lastUsedAt ? ` · last used ${new Date(detail.lastUsedAt).toLocaleString()}` : ""}
                  {detail.sourceTaskId ? ` · source task ${detail.sourceTaskId}` : ""}
                </p>
                {detail.previousVersions.length > 0 ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h4>
                    <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
                      {JSON.stringify(detail.previousVersions, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
