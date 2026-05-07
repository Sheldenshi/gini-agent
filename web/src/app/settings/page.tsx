"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useInvalidate, useParity, useReadiness, useState_ } from "@/lib/queries";
import { LaneCard } from "./_components/LaneCard";
import { ProviderCard, type ProviderCatalogItem } from "./_components/ProviderCard";
import { ProfileCard, type ProfileRow } from "./_components/ProfileCard";
import { ToolsetsCard, type ToolsetRow } from "./_components/ToolsetsCard";
import { McpCard, MessagingCard, type McpRow, type MessagingRow } from "./_components/McpCard";
import { DevicesCard, PromotionsCard, type DeviceRow, type PromotionRow } from "./_components/DevicesCard";
import { SnapshotsCard, type SnapshotRow } from "./_components/SnapshotsCard";
import { ParityCard } from "./_components/ParityCard";

export default function SettingsPage() {
  const state = useState_();
  const parity = useParity();
  const readiness = useReadiness();
  const invalidate = useInvalidate();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
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
  // Snapshots are exposed via /api/state but not via a dedicated /snapshots
  // route, so we read from the state snapshot. (See src/state.ts:readState.)
  const snapshots = ((state.data?.snapshots ?? []) as SnapshotRow[]).slice().reverse();

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

  const activeProfileId = profiles.data?.activeProfileId ?? state.data?.activeProfileId;

  return (
    <>
      <PageHeader title="Settings" description="Lane, providers, profiles, integrations, devices, parity & readiness" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="grid gap-3 lg:grid-cols-2">
          <LaneCard lane={state.data?.lane} activeProfileId={activeProfileId} />
          <ProviderCard catalog={catalog.data} />
        </div>

        <ProfileCard
          profiles={profiles.data?.profiles ?? []}
          activeProfileId={activeProfileId}
          pending={useProfile.isPending}
          onUse={(id) => useProfile.mutate(id)}
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

        <PromotionsCard promotions={promotions.data ?? []} />

        <SnapshotsCard snapshots={snapshots} />

        <div className="grid gap-3 lg:grid-cols-2">
          <ParityCard title="Hermes parity" result={parity.data} />
          <ParityCard title="V1 readiness" result={readiness.data} />
        </div>
      </div>
    </>
  );
}
