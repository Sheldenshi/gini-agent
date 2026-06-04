"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// The device-pairing API lives on the gateway's NATIVE /api/pairing surface and
// is reached SAME-ORIGIN — NOT through the /api/runtime BFF (so it does NOT use
// the `api()` helper). Same-origin matters: on the loopback front the browser's
// origin is the gateway itself, so these fetches carry the true loopback Host
// the operator-only routes require; over the relay the same fetches reach the
// public device routes. The gini_pair / gini_session cookies are HttpOnly and
// managed entirely by the gateway — the client never reads them.
// See ADR device-pairing-auth.md.

export type PairingRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "claimed"
  | "expired"
  | "cancelled";

export interface PairingRequestView {
  id: string;
  code: string;
  status: PairingRequestStatus;
  deviceName: string;
  relayHost: string;
  createdAt: string;
  expiresAt: string;
}

async function pairingFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/pairing${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    credentials: "same-origin"
  });
  const value = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    // Attach the HTTP status so callers (e.g. the /pair poll loop) can tell a
    // terminal 403/404 from a transient network blip.
    const error = new Error(value.error ?? `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return value as T;
}

// --- Device side (the /pair page over the relay) ---------------------------
export function createPairingRequest(): Promise<{ id: string; code: string }> {
  return pairingFetch("/request", { method: "POST", body: "{}" });
}
export function pollPairingRequest(id: string): Promise<{ status: PairingRequestStatus }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}`);
}
export function claimPairingRequest(id: string): Promise<{ ok: true }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}/claim`, { method: "POST", body: "{}" });
}
export function cancelPairingRequest(id: string): Promise<{ ok: true }> {
  return pairingFetch(`/request/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

// --- Operator side (the loopback approval panel) ---------------------------
export function listPairingRequests(): Promise<{ requests: PairingRequestView[] }> {
  return pairingFetch("/requests");
}
export function approvePairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return pairingFetch(`/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" });
}
export function rejectPairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return pairingFetch(`/requests/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
}

// The operator approval panel + session revoke only function on the loopback
// front (the gateway 403s the operator routes over the relay). Components use
// this to gate rendering the panel to the local browser.
export function isLoopbackFront(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

// Live list of pending pairing requests for the operator panel. Polls every 3s
// as a durability backstop; callers also invalidate ["pairingRequests"] from
// the SSE "pairing" tick for instant updates. Enable only on the loopback front.
export function usePairingRequests(enabled: boolean) {
  return useQuery({
    queryKey: ["pairingRequests"],
    queryFn: async () => (await listPairingRequests()).requests,
    refetchInterval: enabled ? 3000 : false,
    enabled
  });
}

export function useApprovePairing() {
  const qc = useQueryClient();
  return useMutation<PairingRequestView, Error, string>({
    mutationFn: async (id: string) => (await approvePairingRequest(id)).request,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pairingRequests"] });
      qc.invalidateQueries({ queryKey: ["devices"] });
    }
  });
}

export function useRejectPairing() {
  const qc = useQueryClient();
  return useMutation<PairingRequestView, Error, string>({
    mutationFn: async (id: string) => (await rejectPairingRequest(id)).request,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pairingRequests"] })
  });
}
