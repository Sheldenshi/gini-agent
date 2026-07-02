import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "./types";
import { webPortPath } from "./paths";

// Runtime-safe read of the port THIS instance recorded for its Next.js web
// server. Deliberately NOT imported from src/cli/process: that module binds a
// loopback socket and spawns subprocesses at import time, which the always-on
// gateway must not pull in. This is a pure file read of the per-instance
// web.port file (written by the CLI when it launches the web server). The read
// is fault-tolerant: a missing file (web down) OR a file deleted between a
// stat and the read (a concurrent `gini stop`/restart) both yield null rather
// than throwing past the caller's fallback.
export function recordedWebPort(config: RuntimeConfig): number | null {
  let raw: string;
  try {
    raw = readFileSync(webPortPath(config.instance), "utf8");
  } catch {
    return null;
  }
  const value = Number(raw.trim());
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

// Per-instance generation counter, bumped on every invalidation. A validation
// that started before an invalidation must NOT repopulate the cache afterward
// (an in-flight probe resolving late could otherwise resurrect a port a fresh
// failure just dropped). resolveWebPort captures the generation before its
// async probe and only writes the cache if it hasn't changed.
const generation = new Map<string, number>();

// Drop a cached validation. Exposed for tests.
export function clearWebTargetCache(instance?: string): void {
  if (instance === undefined) {
    validationCache.clear();
    generation.clear();
  } else {
    validationCache.delete(instance);
    generation.set(instance, (generation.get(instance) ?? 0) + 1);
  }
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
  // Never proxy to our own listener. A stale/corrupt web.port equal to the
  // gateway port would otherwise make the healthz probe (and every proxied
  // request) loop back through the /api/runtime carve-out into this process.
  if (port === config.port) return null;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5000;
  const cached = validationCache.get(config.instance);
  if (cached && cached.port === port && cached.validUntil > now()) return port;
  const gen = generation.get(config.instance) ?? 0;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/runtime/__healthz`, {
      signal: AbortSignal.timeout(2000),
      // Never follow redirects: a foreign listener squatting on a reused port
      // could 3xx the probe to the real gini-web healthz and pass validation
      // while still serving proxied traffic itself. A 3xx is not `ok`, so the
      // check below rejects it.
      redirect: "manual"
    });
    if (!res.ok) {
      validationCache.delete(config.instance);
      return null;
    }
    const body = (await res.json()) as { service?: unknown; instance?: unknown };
    if (body.service === "gini-web" && body.instance === config.instance) {
      // Only cache if no invalidation raced this probe. Either way the port is
      // valid as of this just-completed healthz, so still return it.
      if ((generation.get(config.instance) ?? 0) === gen) {
        validationCache.set(config.instance, { port, validUntil: now() + ttlMs });
      }
      return port;
    }
  } catch {
    // Unreachable, timeout, or non-JSON: treat as no usable web target.
  }
  validationCache.delete(config.instance);
  return null;
}
