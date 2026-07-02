"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PairingRequestStatus } from "@runtime/types";

// Re-export the runtime contract's status union so callers keep importing it from
// here, but the single source of truth stays in @runtime/types (no hand-copied
// duplicate that could drift from the wire).
export type { PairingRequestStatus };

// All pairing calls hit the gateway's NATIVE /api/pairing/* surface SAME-ORIGIN
// (NOT the bearer-injecting /api/runtime BFF). Same-origin matters twice: the
// browser sends a same-origin Origin (so the gateway's CSRF check passes) AND it
// auto-attaches the HttpOnly gini_pair / gini_session cookies the routes need.
//   - DEVICE handshake (request/poll/claim/cancel): public, gini_pair-bound — the
//     UNPAIRED device on /pair runs these with no session.
//   - ADMIN routes (list/approve/reject): handlePairingRoutes accepts loopback OR
//     a valid gini_session, so a PAIRED relay session is admin exactly like
//     127.0.0.1 (the mirror model; the only relay-specific gate is the initial
//     pairing handshake). See ADR device-pairing-auth.md.

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

// --- Admin side (the approval panel — any paired session, loopback or relay) ---
// Native same-origin /api/pairing/* so the request carries both the relay Origin
// (for the gateway's CSRF check) AND the gini_session cookie that
// handlePairingRoutes validates (loopback OR a valid session passes). An unpaired
// relay visitor has no session and is refused. See ADR device-pairing-auth.md.
export function listPairingRequests(): Promise<{ requests: PairingRequestView[] }> {
  return pairingFetch("/requests");
}
export function approvePairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return pairingFetch(`/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" });
}
export function rejectPairingRequest(id: string): Promise<{ request: PairingRequestView }> {
  return pairingFetch(`/requests/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
}

// Live list of pending pairing requests for the admin approval panel. Polls
// every 3s as a durability backstop; the SSE "pairing" tick also invalidates
// ["pairingRequests"] for instant updates. The panel mounts only inside the
// (open-gated) Pair-device dialog, so this query is active only while shown —
// on loopback OR any paired relay session (both are admins).
export function usePairingRequests() {
  return useQuery({
    queryKey: ["pairingRequests"],
    queryFn: async () => (await listPairingRequests()).requests,
    refetchInterval: 3000,
    // retry: false turns off react-query's per-attempt retries for EVERY error,
    // not only the terminal ones. A 403 (missing/expired session, wrong origin)
    // or 404 (not served on this origin) won't self-heal by retrying, and a
    // transient blip recovers on the next refetchInterval poll anyway — so
    // retries only delay surfacing the failure behind the loading state, where
    // the panel would otherwise show the idle "waiting" copy and hide that
    // approve/reject is unreachable. The panel keeps the last good list and
    // offers "Try again" while an error is showing.
    retry: false
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
