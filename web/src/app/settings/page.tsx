"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { ProviderCard } from "./_components/ProviderCard";
import type { ProviderCatalogItem } from "@/lib/providers";
import { ToolsetsCard, type ToolsetRow } from "./_components/ToolsetsCard";
import { McpCard, type McpRow } from "./_components/McpCard";
import { MessagingCard, type MessagingRow } from "./_components/MessagingCard";
import { DevicesCard, type DeviceRow } from "./_components/DevicesCard";
import { BrowserSettingsCard } from "./_components/BrowserSettingsCard";

export default function SettingsPage() {
  const invalidate = useInvalidate();
  const status = useStatus();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
    refetchInterval: 60_000
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

  const messagingRemove = useMutation({
    mutationFn: (id: string) => api(`/messaging/${encodeURIComponent(id)}/remove`, { method: "POST" }),
    onSuccess: () => { toast.success("Bridge removed"); invalidate(["messaging", "state", "events"]); },
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

  // Settings card lists every provider in the catalog and marks the
  // instance's active one. Read the instance-level provider (not the
  // per-agent resolvedProvider) because the Settings UI controls the
  // instance default, and showing an agent's pin here would mislead the
  // user about which entry their "Set active" click changes.
  const activeProviderName = status.data?.provider?.provider?.name;
  const activeProviderModel = status.data?.provider?.provider?.model;
  const activeProviderAwsRegion = status.data?.provider?.provider?.awsRegion;
  // The full persisted config for the active provider — carries the transport
  // fields (baseUrl + Azure routing) the static catalog doesn't, so the Edit
  // dialog can prefill them.
  const activeProvider = status.data?.provider?.provider;

  return (
    <>
      <PageHeader title="Settings" description="Providers, browser, toolsets, integrations, devices" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <ProviderCard
          catalog={catalog.data ?? []}
          activeProviderName={activeProviderName}
          activeProviderModel={activeProviderModel}
          activeProviderAwsRegion={activeProviderAwsRegion}
          activeProvider={activeProvider}
        />

        <BrowserSettingsCard />

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
          removePending={messagingRemove.isPending}
          onHealth={(id) => messagingHealth.mutate(id)}
          onRemove={(id) => messagingRemove.mutate(id)}
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
