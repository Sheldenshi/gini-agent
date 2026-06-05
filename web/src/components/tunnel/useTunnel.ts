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
  const data = (await res.json()) as TunnelState & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export type TunnelController = {
  state: TunnelState;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  select: (provider: TunnelProviderId) => void;
  connect: (provider?: TunnelProviderId) => void;
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

  const get = useCallback(async () => {
    const seq = (getSeq.current += 1);
    try {
      const next = await readState(await fetch(BASE, { headers: { accept: "application/json" } }));
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

  const post = useCallback(async (path: string, body?: Record<string, unknown>) => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const select = useCallback((provider: TunnelProviderId) => void post("/select", { provider }), [post]);
  const connect = useCallback(
    (provider?: TunnelProviderId) => void post("/connect", provider ? { provider } : undefined),
    [post]
  );
  const cancel = useCallback(() => void post("/cancel"), [post]);
  const disconnect = useCallback(() => void post("/disconnect"), [post]);

  return { state, loading, error, refresh: () => void get(), select, connect, cancel, disconnect };
}
