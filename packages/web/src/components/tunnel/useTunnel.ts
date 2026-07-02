"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TunnelProviderId, TunnelState } from "./types";

/**
 * Live tunnel state, wired to the gateway through the BFF proxy
 * (`/api/runtime/tunnel*` -> gateway `/api/tunnel*`, token injected
 * server-side). GET reads state; the POST actions return the full updated
 * state. While `status === "connecting"` we poll GET until the background
 * relay handshake flips it to `connected` (or `error`).
 */

const BASE = "/api/runtime/tunnel";
const POLL_MS = 1500;

const EMPTY: TunnelState = { providers: [], selectedProvider: null, status: "idle" };

async function readState(res: Response): Promise<TunnelState> {
  const data = (await res.json()) as TunnelState & { error?: string; code?: string };
  if (!res.ok) {
    // Carry the gateway's machine-readable failure code (e.g.
    // "provider_unavailable") so callers can branch on the failure kind.
    const error = new Error(data.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    if (typeof data.code === "string") error.code = data.code;
    throw error;
  }
  return data;
}

// Outcome of a tunnel action. `code` is the gateway's machine-readable
// failure kind when it sent one — the menu opens a provider's setup guide on
// "provider_unavailable" instead of leaving just the error banner.
export type TunnelActionResult = { ok: true } | { ok: false; message: string; code?: string };

// No `select`: the web UI is single-tunnel "tap to switch" (connecting a
// provider IS the selection), so it never calls /api/tunnel/select. That route
// stays on the gateway for the CLI (`gini tunnel select <provider>`).
export type TunnelController = {
  state: TunnelState;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  connect: (provider?: TunnelProviderId) => Promise<TunnelActionResult>;
  cancel: () => void;
  disconnect: () => void;
};

export function useTunnel(): TunnelController {
  const [state, setState] = useState<TunnelState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic id so only the latest get() may commit. The poll loop and the
  // open-time refresh can run GETs concurrently, and fetch makes no ordering
  // guarantee — without this a slow earlier read could resolve last and clobber
  // a newer state.
  const getSeq = useRef(0);

  // `detect` re-probes the manual driver prerequisites gateway-side; used by
  // the panel-open refresh so a freshly-installed tailscale/ngrok/cloudflared
  // flips its row enabled without a runtime restart. Mount + poll reads stay
  // plain so they never spawn detection subprocesses.
  const get = useCallback(async (detect = false) => {
    const seq = (getSeq.current += 1);
    try {
      const next = await readState(
        await fetch(detect ? `${BASE}?detect=1` : BASE, { headers: { accept: "application/json" } })
      );
      if (seq !== getSeq.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (seq !== getSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === getSeq.current) setLoading(false);
    }
  }, []);

  const post = useCallback(async (path: string, body?: Record<string, unknown>): Promise<TunnelActionResult> => {
    setError(null);
    try {
      const next = await readState(
        await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: body ? JSON.stringify(body) : undefined
        })
      );
      // Supersede any GET already in flight so a stale read can't overwrite this
      // POST's committed state (get() checks getSeq before it commits).
      getSeq.current += 1;
      setState(next);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      return { ok: false, message, code };
    }
  }, []);

  // Initial read on mount (the trigger is always mounted, so the status pill
  // reflects the real connection immediately).
  useEffect(() => {
    void get();
  }, [get]);

  // Poll while a connect is in flight so the UI sees connecting -> connected
  // (or error) without a manual refresh.
  const polling = state.status === "connecting";
  const getRef = useRef(get);
  getRef.current = get;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => void getRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [polling]);

  const connect = useCallback(
    (provider?: TunnelProviderId) => post("/connect", provider ? { provider } : undefined),
    [post]
  );
  const cancel = useCallback(() => void post("/cancel"), [post]);
  const disconnect = useCallback(() => void post("/disconnect"), [post]);

  return { state, loading, error, refresh: () => void get(true), connect, cancel, disconnect };
}
