// Identity probe shared between the runtime API's PATCH /api/tunnel
// handler and the TunnelManager's swapCloudflared(). The handler probes
// before entering the manager's apply chain so it can fail fast with a
// 409; the manager re-probes inside the chain to close the race window
// where the supervised Next.js child dies between the handler's probe
// and the manager's spawn, and an opportunistic local process binds
// the freed port before cloudflared launches against it.

export async function isSupervisedWebChild(instance: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runtime/__healthz`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: unknown; instance?: unknown };
    return body.service === "gini-web" && body.instance === instance;
  } catch {
    return false;
  }
}
