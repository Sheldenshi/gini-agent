"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { ProviderCard, type ProviderCatalogItem } from "./_components/ProviderCard";
import { AgentCard, type AgentRow } from "./_components/AgentCard";
import { ToolsetsCard, type ToolsetRow } from "./_components/ToolsetsCard";
import { McpCard, MessagingCard, type McpRow, type MessagingRow } from "./_components/McpCard";
import { DevicesCard, type DeviceRow } from "./_components/DevicesCard";

export default function SettingsPage() {
  const invalidate = useInvalidate();
  const status = useStatus();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
    refetchInterval: 60_000
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
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

  const useAgent = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => { toast.success("Agent activated"); invalidate(["agents", "state"]); },
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

  const activeAgentId = agents.data?.activeAgentId;
  // Prefer activeAgent.resolvedProvider (Phase B) and fall back to
  // provider.provider for safety during rollout — older runtimes that
  // pre-date the activeAgent block still surface the legacy field.
  const effectiveProviderName = status.data?.activeAgent?.resolvedProvider?.name
    ?? status.data?.provider?.provider?.name;
  const effectiveProviderModel = status.data?.activeAgent?.resolvedProvider?.model
    ?? status.data?.provider?.provider?.model;
  const catalogEntry = catalog.data?.find((c) => c.name === effectiveProviderName);
  const displayName = catalogEntry?.displayName ?? effectiveProviderName;
  const agentWarnings = status.data?.activeAgent?.warnings ?? [];

  return (
    <>
      <PageHeader title="Settings" description="Providers, agents, toolsets, integrations, devices" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <ProviderCard displayName={displayName} model={effectiveProviderModel} />

        <AgentCard
          agents={agents.data?.agents ?? []}
          activeAgentId={activeAgentId}
          warnings={agentWarnings}
          pending={useAgent.isPending}
          onUse={(id) => useAgent.mutate(id)}
        />

        <ToolsetsCard
          toolsets={toolsets.data?.toolsets ?? []}
          pending={toolsetToggle.isPending}
          onToggle={(id, op) => toolsetToggle.mutate({ id, op })}
        />

        <McpCard
          servers={mcp.data ?? []}
          healthPending={mcpHealth.isPending}
          disablePending={mcpDisable.isPending}
          onHealth={(id) => mcpHealth.mutate(id)}
          onDisable={(id) => mcpDisable.mutate(id)}
        />

        <MessagingCard
          bridges={messaging.data ?? []}
          healthPending={messagingHealth.isPending}
          disablePending={messagingDisable.isPending}
          onHealth={(id) => messagingHealth.mutate(id)}
          onDisable={(id) => messagingDisable.mutate(id)}
        />

        <DevicesCard
          devices={devices.data ?? []}
          revokePending={deviceRevoke.isPending}
          createPending={createPairing.isPending}
          onRevoke={(id) => deviceRevoke.mutate(id)}
          onCreatePairing={() => createPairing.mutate()}
        />
      </div>
    </>
  );
}
