import { existsSync, readFileSync } from "node:fs";
import type { RuntimeConfig } from "./types";
import { webPortPath } from "./paths";

// Runtime-safe read of the port THIS instance recorded for its Next.js web
// server. Deliberately NOT imported from src/cli/process: that module binds a
// loopback socket and spawns subprocesses at import time, which the always-on
// gateway must not pull in. This is a pure file read of the per-instance
// web.port file (written by the CLI when it launches the web server).
export function recordedWebPort(config: RuntimeConfig): number | null {
  const path = webPortPath(config.instance);
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface WebTargetDeps {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

interface CacheEntry {
  port: number;
  validUntil: number;
}

// Per-instance memo of the last healthz-validated port. Keeps the validation
// round-trip off the hot path while still catching a port that goes stale.
const validationCache = new Map<string, CacheEntry>();

// Drop a cached validation. Exposed for tests.
export function clearWebTargetCache(instance?: string): void {
  if (instance === undefined) validationCache.clear();
  else validationCache.delete(instance);
}

// Resolve the loopback port of THIS instance's Next.js web server, VALIDATED
// against the BFF healthz endpoint. The recorded port file is not cleared when
// the web server dies, so a reused port could otherwise route traffic — and
// the browser's bearer-injecting BFF calls — to a foreign instance's server.
// The healthz response carries `service` and `instance`; we proxy only when
// both match. Result is cached briefly (ttlMs) so the check is amortized.
// Returns null when web is down, unreachable, or not ours — callers fall back
// to the runtime banner / 502.
export async function resolveWebPort(config: RuntimeConfig, deps: WebTargetDeps = {}): Promise<number | null> {
  const port = recordedWebPort(config);
  if (port === null) return null;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5000;
  const cached = validationCache.get(config.instance);
  if (cached && cached.port === port && cached.validUntil > now()) return port;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/runtime/__healthz`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) {
      validationCache.delete(config.instance);
      return null;
    }
    const body = (await res.json()) as { service?: unknown; instance?: unknown };
    if (body.service === "gini-web" && body.instance === config.instance) {
      validationCache.set(config.instance, { port, validUntil: now() + ttlMs });
      return port;
    }
  } catch {
    // Unreachable, timeout, or non-JSON: treat as no usable web target.
  }
  validationCache.delete(config.instance);
  return null;
}
