"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { api } from "@/lib/api";
import Link from "next/link";
import { useConnectors, useInvalidate, useProviders, useSkills, type ProviderDescriptor } from "@/lib/queries";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";

type ReloadReport = {
  added: Array<{ id: string; name: string }>;
  updated: Array<{ id: string; name: string }>;
  skipped: Array<{ path: string; reason: string }>;
};

export default function SkillsPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const skills = useSkills(debounced);
  const connectors = useConnectors();
  const providers = useProviders();
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

  const reload = useMutation({
    mutationFn: () => api<ReloadReport>("/skills/reload", { method: "POST" }),
    onSuccess: (result) => {
      const added = result.added.length;
      const updated = result.updated.length;
      const skipped = result.skipped.length;
      toast.success(`Reload: +${added} new · ~${updated} updated${skipped ? ` · ${skipped} skipped` : ""}`);
      invalidate(["skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const filtered = skills.data ?? [];
  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);
  const detail = filtered.find((s) => s.id === selected) ?? filtered[0];
  const connectorsByProv = useMemo(
    () => connectorsByProvider(connectors.data ?? []),
    [connectors.data]
  );
  const providersById = useMemo(
    () => providersByIdMap(providers.data ?? []),
    [providers.data]
  );

  return (
    <>
      <PageHeader
        title="Skills"
        description="Procedures the agent can use"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>
              {reload.isPending ? "Reloading…" : "Reload from disk"}
            </Button>
            <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
              {validate.isPending ? "Validating…" : "Validate all"}
            </Button>
          </>
        }
      />
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-80 flex-col gap-3 overflow-hidden">
          <Input placeholder="Search skills…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="text-[11px] text-muted-foreground">
            {skills.isLoading ? "Loading…" : `${filtered.length} skill${filtered.length === 1 ? "" : "s"}`}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={debounced ? "No matches" : "No skills loaded"}
              description={debounced ? undefined : "Drop a SKILL.md under skills/ and click Reload from disk."}
            />
          ) : (
            <div className="flex-1 space-y-4 overflow-auto pr-1">
              {grouped.map(({ category, items }) => (
                <div key={category} className="space-y-2">
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {category}
                  </div>
                  <ul className="space-y-2">
                    {items.map((skill) => (
                      <li key={skill.id}>
                        <button
                          onClick={() => setSelected(skill.id)}
                          className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                            detail?.id === skill.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="line-clamp-1 text-sm font-medium">{skill.name}</span>
                            <ActivationPill
                              activation={deriveActivation(skill, connectorsByProv, providersById)}
                            />
                          </div>
                          {skill.description ? (
                            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{skill.description}</p>
                          ) : null}
                          <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                            v{skill.version} · {skill.source ?? "user"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!detail ? (
            <EmptyState title="No skill selected" />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{detail.name}</CardTitle>
                    <CardDescription className="font-mono text-[11px]">
                      v{detail.version}
                      {detail.trigger ? ` · trigger “${detail.trigger}”` : ""}
                    </CardDescription>
                  </div>
                  <ActivationPill
                    activation={deriveActivation(detail, connectorsByProv, providersById)}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {detail.source ? (
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">
                      {detail.source}
                    </Badge>
                  ) : null}
                  {detail.category ? (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {detail.category}
                    </Badge>
                  ) : null}
                  {(detail.platforms ?? []).map((platform) => (
                    <Badge key={platform} variant="outline" className="font-mono text-[10px]">
                      {platform}
                    </Badge>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {detail.description ? (
                  <p className="text-sm text-muted-foreground">{detail.description}</p>
                ) : null}
                {detail.compatibility ? (
                  <p className="text-xs text-muted-foreground">{detail.compatibility}</p>
                ) : null}
                <ActivationRow
                  skill={detail}
                  connectorsByProv={connectorsByProv}
                  providersById={providersById}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "test" })}>Test</Button>
                  {/*
                    Trust toggle. Bundled skills (source === "bundled") are
                    auto-trusted and the buttons are read-only. ADR connector-provider-spec-compliance.md §UI.
                  */}
                  <Button size="sm" variant="outline" disabled={action.isPending || detail.source === "bundled"} onClick={() => action.mutate({ id: detail.id, op: "trust" })}>Trust</Button>
                  <Button size="sm" variant="outline" disabled={action.isPending || detail.source === "bundled"} onClick={() => action.mutate({ id: detail.id, op: "disable" })}>Disable</Button>
                  <Button size="sm" variant="outline" disabled={action.isPending || detail.previousVersions.length === 0} onClick={() => action.mutate({ id: detail.id, op: "rollback" })}>
                    Rollback
                  </Button>
                </div>
                {detail.allowedTools ? (
                  <Section title="Allowed tools (from SKILL.md frontmatter)">
                    <p className="font-mono text-[11px] text-muted-foreground">{detail.allowedTools}</p>
                  </Section>
                ) : null}
                {(detail.requiredConnectors ?? []).length > 0 ? (
                  <Section title="Required connectors">
                    <ul className="space-y-1">
                      {(detail.requiredConnectors ?? []).map((req) => {
                        const matches = (connectors.data ?? []).filter((c) => c.provider === req.provider);
                        const provider = providersById.get(req.provider);
                        const hasProbe = Boolean(provider?.hasProbe);
                        // Mirror the runtime gate: a connector counts as
                        // satisfying the requirement when it is healthy, OR
                        // when its provider has no probe and the record is
                        // configured (we have no failing signal). See
                        // src/integrations/connectors/index.ts isSkillActive.
                        const satisfying = matches.find(
                          (c) => c.health === "healthy" || (!hasProbe && c.health === "unknown" && c.status === "configured")
                        );
                        return (
                          <li key={req.provider} className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-mono">{req.provider}{req.scopes?.length ? ` (${req.scopes.join(", ")})` : ""}</span>
                            {satisfying ? (
                              <Badge variant="outline" className="text-[10px] text-emerald-600">
                                {satisfying.health === "healthy" ? "healthy" : "configured"} ({satisfying.name})
                              </Badge>
                            ) : !provider ? (
                              // Provider isn't in the registry, so the
                              // Connections page dropdown won't list it.
                              // Avoid linking to a dead-end and steer the
                              // user toward the documented escape hatch.
                              <span className="text-[10px] text-muted-foreground">
                                Not supported — use the <span className="font-mono">generic</span> provider or request native support.
                              </span>
                            ) : (
                              <Link
                                href={`/connections?provider=${encodeURIComponent(req.provider)}`}
                                className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-accent"
                              >
                                Connect →
                              </Link>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Section>
                ) : null}

                <Tabs defaultValue={detail.body ? "content" : "overview"}>
                  <TabsList>
                    <TabsTrigger value="content">Content</TabsTrigger>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                  </TabsList>

                  <TabsContent value="content">
                    {detail.body ? (
                      <div className="rounded-md border border-border bg-card/50 p-4">
                        <MarkdownContent text={detail.body} />
                      </div>
                    ) : (
                      <EmptyState
                        title="No body content"
                        description="This skill was created via the API and has no markdown body."
                      />
                    )}
                  </TabsContent>

                  <TabsContent value="overview" className="space-y-4">
                    {detail.steps.length > 0 ? (
                      <Section title="Steps">
                        <ol className="list-decimal space-y-1 pl-5 text-sm">
                          {detail.steps.map((step, index) => <li key={index}>{step}</li>)}
                        </ol>
                      </Section>
                    ) : null}

                    {detail.tests.length > 0 ? (
                      <Section title="Tests">
                        <ul className="list-disc space-y-1 pl-5 text-sm">
                          {detail.tests.map((test, index) => <li key={index}>{test}</li>)}
                        </ul>
                      </Section>
                    ) : null}

                    {detail.requiredTools.length > 0 ? (
                      <Section title="Required tools">
                        <div className="flex flex-wrap gap-1.5">
                          {detail.requiredTools.map((tool) => (
                            <Badge key={tool} variant="outline" className="font-mono text-[10px]">
                              {tool}
                            </Badge>
                          ))}
                        </div>
                      </Section>
                    ) : null}

                    {detail.requiredPermissions.length > 0 ? (
                      <Section title="Required permissions">
                        <div className="flex flex-wrap gap-1.5">
                          {detail.requiredPermissions.map((perm) => (
                            <Badge key={perm} variant="outline" className="font-mono text-[10px]">
                              {perm}
                            </Badge>
                          ))}
                        </div>
                      </Section>
                    ) : null}

                    {detail.prerequisites && (
                      (detail.prerequisites.commands?.length || detail.prerequisites.env?.length)
                    ) ? (
                      <Section title="Prerequisites">
                        {detail.prerequisites.commands?.length ? (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Commands</div>
                            <div className="flex flex-wrap gap-1.5">
                              {detail.prerequisites.commands.map((cmd) => (
                                <Badge key={cmd} variant="outline" className="font-mono text-[10px]">
                                  {cmd}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {detail.prerequisites.env?.length ? (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Env</div>
                            <div className="flex flex-wrap gap-1.5">
                              {detail.prerequisites.env.map((env) => (
                                <Badge key={env} variant="outline" className="font-mono text-[10px]">
                                  {env}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </Section>
                    ) : null}

                    <Section title="Stats">
                      <p className="font-mono text-[11px] text-muted-foreground">
                        ✓ {detail.successCount} · ✕ {detail.failureCount}
                        {detail.lastUsedAt ? ` · last used ${new Date(detail.lastUsedAt).toLocaleString()}` : ""}
                        {detail.sourceTaskId ? ` · source task ${detail.sourceTaskId}` : ""}
                      </p>
                    </Section>

                    {detail.manifestPath ? (
                      <Section title="Manifest path">
                        <p className="break-all font-mono text-[11px] text-muted-foreground">{detail.manifestPath}</p>
                      </Section>
                    ) : null}

                    {detail.previousVersions.length > 0 ? (
                      <Section title="History">
                        <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
                          {JSON.stringify(detail.previousVersions, null, 2)}
                        </pre>
                      </Section>
                    ) : null}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

type Activation = {
  label: "active" | "needs setup" | "untrusted" | "unsupported";
  tone: "ok" | "warn" | "neutral" | "danger";
};

// Compute the effective activation status for the Skills page. The runtime
// is the source of truth for "is this skill in the agent's set"; we replay
// the same dependency check here so users see the badge that matches what
// the agent loop sees. Mirrors src/integrations/connectors/index.ts
// isSkillActive: a connector satisfies a requirement when healthy OR when
// its provider has no probe and the record is configured (unknown health
// is acceptable when there's no remote signal to refute it). Without the
// provider info we'd diverge from the runtime gate for demo / generic
// providers, which always sit at health: "unknown" at rest.
function deriveActivation(
  skill: SkillRecord,
  connectorsByProv: Map<string, ConnectorRecord[]>,
  providersById: Map<string, ProviderDescriptor>
): Activation {
  if (skill.validationStatus === "unsupported") return { label: "unsupported", tone: "danger" };
  if (skill.status === "draft" || skill.status === "disabled") return { label: "untrusted", tone: "neutral" };
  const required = skill.requiredConnectors ?? [];
  if (required.length === 0) return { label: "active", tone: "ok" };
  for (const req of required) {
    const matches = connectorsByProv.get(req.provider) ?? [];
    const hasProbe = Boolean(providersById.get(req.provider)?.hasProbe);
    const satisfied = matches.some((c) => {
      if (c.health === "healthy") return true;
      if (!hasProbe && c.health === "unknown" && c.status === "configured") return true;
      return false;
    });
    if (!satisfied) return { label: "needs setup", tone: "warn" };
  }
  return { label: "active", tone: "ok" };
}

function ActivationPill({ activation }: { activation: Activation }) {
  const tone = activation.tone === "ok"
    ? "bg-emerald-500/10 text-emerald-600"
    : activation.tone === "warn"
    ? "bg-amber-500/10 text-amber-600"
    : activation.tone === "danger"
    ? "bg-red-500/10 text-red-600"
    : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${tone}`}>{activation.label}</span>
  );
}

function ActivationRow({
  skill,
  connectorsByProv,
  providersById
}: {
  skill: SkillRecord;
  connectorsByProv: Map<string, ConnectorRecord[]>;
  providersById: Map<string, ProviderDescriptor>;
}) {
  const activation = deriveActivation(skill, connectorsByProv, providersById);
  return (
    <div className="flex items-center gap-2 text-xs">
      <ActivationPill activation={activation} />
      {skill.validationStatus === "unsupported" && skill.validationMessage ? (
        <span className="text-[11px] text-muted-foreground">{skill.validationMessage}</span>
      ) : null}
    </div>
  );
}

function connectorsByProvider(connectors: ConnectorRecord[]): Map<string, ConnectorRecord[]> {
  const map = new Map<string, ConnectorRecord[]>();
  for (const c of connectors) {
    const list = map.get(c.provider) ?? [];
    list.push(c);
    map.set(c.provider, list);
  }
  return map;
}

function providersByIdMap(providers: ProviderDescriptor[]): Map<string, ProviderDescriptor> {
  const map = new Map<string, ProviderDescriptor>();
  for (const p of providers) map.set(p.id, p);
  return map;
}

function groupByCategory(skills: SkillRecord[]): Array<{ category: string; items: SkillRecord[] }> {
  const buckets = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const key = skill.category ?? "uncategorized";
    const bucket = buckets.get(key) ?? [];
    bucket.push(skill);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([category, items]) => ({
      category,
      items: items.slice().sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}
