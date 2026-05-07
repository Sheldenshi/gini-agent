"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useInvalidate, useParity, useReadiness, useState_ } from "@/lib/queries";

interface ProfileRow { id: string; name: string; status: string }
interface ToolsetRow { id: string; name: string; status: string; description: string }
interface McpRow { id: string; name: string; status: string; command: string; lastHealthAt?: string }
interface MessagingRow { id: string; name: string; status: string; kind: string }
interface DeviceRow { id: string; name: string; status: string }
interface PromotionRow { id: string; status: string; candidateRef: string; summary: string }

export default function SettingsPage() {
  const state = useState_();
  const parity = useParity();
  const readiness = useReadiness();
  const invalidate = useInvalidate();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<unknown[]>("/providers/catalog"),
    refetchInterval: 60_000
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<{ profiles: ProfileRow[]; activeProfileId?: string }>("/profiles")
  });
  const toolsets = useQuery({
    queryKey: ["toolsets"],
    queryFn: () => api<{ toolsets: ToolsetRow[] }>("/toolsets")
  });
  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: () => api<McpRow[]>("/mcp")
  });
  const messaging = useQuery({
    queryKey: ["messaging"],
    queryFn: () => api<MessagingRow[]>("/messaging")
  });
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<DeviceRow[]>("/devices")
  });
  const promotions = useQuery({
    queryKey: ["promotions"],
    queryFn: () => api<PromotionRow[]>("/promotions")
  });

  const useProfile = useMutation({
    mutationFn: (id: string) => api(`/profiles/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => { toast.success("Profile activated"); invalidate(["profiles", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const toolsetToggle = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "enable" | "disable" }) =>
      api(`/toolsets/${encodeURIComponent(id)}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => { toast.success(`Toolset ${vars.op}d`); invalidate(["toolsets", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const mcpHealth = useMutation({
    mutationFn: (id: string) => api(`/mcp/${encodeURIComponent(id)}/health`, { method: "POST" }),
    onSuccess: () => { toast.success("MCP server checked"); invalidate(["mcp", "events"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const mcpDisable = useMutation({
    mutationFn: (id: string) => api(`/mcp/${encodeURIComponent(id)}/disable`, { method: "POST" }),
    onSuccess: () => { toast.success("MCP server disabled"); invalidate(["mcp", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const messagingHealth = useMutation({
    mutationFn: (id: string) => api(`/messaging/${encodeURIComponent(id)}/health`, { method: "POST" }),
    onSuccess: () => { toast.success("Bridge checked"); invalidate(["messaging", "events"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const messagingDisable = useMutation({
    mutationFn: (id: string) => api(`/messaging/${encodeURIComponent(id)}/disable`, { method: "POST" }),
    onSuccess: () => { toast.success("Bridge disabled"); invalidate(["messaging", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const deviceRevoke = useMutation({
    mutationFn: (id: string) => api(`/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSuccess: () => { toast.success("Device revoked"); invalidate(["devices", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const createPairing = useMutation({
    mutationFn: () => api<{ code: string; expiresAt: string }>("/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 600 }) }),
    onSuccess: (result) => toast.success(`Pairing code: ${result.code} (expires ${new Date(result.expiresAt).toLocaleTimeString()})`),
    onError: (error: Error) => toast.error(error.message)
  });

  const activeProfileId = profiles.data?.activeProfileId;

  return (
    <>
      <PageHeader title="Settings" description="Lane, providers, profiles, integrations, devices, parity & readiness" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">Lane</CardTitle></CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{state.data?.lane ?? "…"}</p>
              <p className="font-mono text-[11px] text-muted-foreground">active profile: {activeProfileId ?? state.data?.activeProfileId ?? "—"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Provider catalog</CardTitle></CardHeader>
            <CardContent>
              {catalog.data && Array.isArray(catalog.data) && catalog.data.length > 0 ? (
                <ul className="divide-y divide-border text-xs">
                  {(catalog.data as Array<{ id: string; displayName: string; auth: string; models: string[] }>).map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="truncate">{item.displayName}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {item.auth} · {item.models.length.toString().padStart(2, " ")} models
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No catalog" />
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Profiles</CardTitle>
            <CardDescription>{profiles.data?.profiles.length ?? 0} configured · click to activate</CardDescription>
          </CardHeader>
          <CardContent>
            {(profiles.data?.profiles ?? []).length === 0 ? (
              <EmptyState title="No profiles" description="Create one with `gini profile create <name>`." />
            ) : (
              <ul className="divide-y divide-border">
                {(profiles.data?.profiles ?? []).map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm">{item.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{item.id}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={item.id === activeProfileId ? "active" : item.status} />
                      <Button
                        size="sm"
                        variant={item.id === activeProfileId ? "secondary" : "outline"}
                        disabled={item.id === activeProfileId || useProfile.isPending}
                        onClick={() => useProfile.mutate(item.id)}
                      >
                        {item.id === activeProfileId ? "Active" : "Use"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Toolsets</CardTitle>
            <CardDescription>{toolsets.data?.toolsets.length ?? 0} configured</CardDescription>
          </CardHeader>
          <CardContent>
            {(toolsets.data?.toolsets ?? []).length === 0 ? (
              <EmptyState title="No toolsets" />
            ) : (
              <ul className="divide-y divide-border">
                {(toolsets.data?.toolsets ?? []).map((item) => {
                  const enabled = item.status === "enabled" || item.status === "active";
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="text-sm">{item.name}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">{item.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill value={item.status} />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={toolsetToggle.isPending}
                          onClick={() => toolsetToggle.mutate({ id: item.id, op: enabled ? "disable" : "enable" })}
                        >
                          {enabled ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">MCP servers</CardTitle>
            <CardDescription>{mcp.data?.length ?? 0} configured</CardDescription>
          </CardHeader>
          <CardContent>
            {(mcp.data ?? []).length === 0 ? (
              <EmptyState title="No MCP servers" />
            ) : (
              <ul className="divide-y divide-border">
                {(mcp.data ?? []).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm">{item.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">{item.command}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={item.status} />
                      <Button size="sm" variant="outline" disabled={mcpHealth.isPending} onClick={() => mcpHealth.mutate(item.id)}>Health</Button>
                      <Button size="sm" variant="outline" disabled={mcpDisable.isPending || item.status === "disabled"} onClick={() => mcpDisable.mutate(item.id)}>Disable</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Messaging bridges</CardTitle>
            <CardDescription>{messaging.data?.length ?? 0} configured</CardDescription>
          </CardHeader>
          <CardContent>
            {(messaging.data ?? []).length === 0 ? (
              <EmptyState title="No bridges" />
            ) : (
              <ul className="divide-y divide-border">
                {(messaging.data ?? []).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm">{item.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{item.kind}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill value={item.status} />
                      <Button size="sm" variant="outline" disabled={messagingHealth.isPending} onClick={() => messagingHealth.mutate(item.id)}>Health</Button>
                      <Button size="sm" variant="outline" disabled={messagingDisable.isPending || item.status === "disabled"} onClick={() => messagingDisable.mutate(item.id)}>Disable</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm">Paired devices</CardTitle>
                <CardDescription>{devices.data?.length ?? 0} known</CardDescription>
              </div>
              <Button size="sm" variant="outline" disabled={createPairing.isPending} onClick={() => createPairing.mutate()}>
                {createPairing.isPending ? "Creating…" : "Create pairing code"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {(devices.data ?? []).length === 0 ? (
              <EmptyState title="No devices" description="Create a pairing code, then claim it from a device." />
            ) : (
              <ul className="divide-y divide-border">
                {(devices.data ?? []).map((item) => (
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
                        disabled={deviceRevoke.isPending || item.status === "revoked"}
                        onClick={() => deviceRevoke.mutate(item.id)}
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

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Promotions</CardTitle>
            <CardDescription>{promotions.data?.length ?? 0} candidates</CardDescription>
          </CardHeader>
          <CardContent>
            {(promotions.data ?? []).length === 0 ? (
              <EmptyState title="No promotions" />
            ) : (
              <ul className="divide-y divide-border">
                {(promotions.data ?? []).map((item) => (
                  <li key={item.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{item.candidateRef}</span>
                      <StatusPill value={item.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-3 lg:grid-cols-2">
          <ChecksCard title="Hermes parity" result={parity.data} />
          <ChecksCard title="V1 readiness" result={readiness.data} />
        </div>
      </div>
    </>
  );
}

function ChecksCard({ title, result }: { title: string; result?: { ok: boolean; checks: Array<{ id: string; label: string; status: string; evidence: string[] }> } }) {
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
