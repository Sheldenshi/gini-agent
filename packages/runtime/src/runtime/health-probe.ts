// Identity probe for the supervised Next.js web child: confirms the
// process answering on a given port is genuinely gini-web for this
// instance (service + instance match on /api/runtime/__healthz) rather
// than a stale port file or a port-squatting process. Used by the
// watchdog to decide whether the web service is actually alive before
// reviving it.

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
