// Cache warmer: a single integer of state (cacheWarmerMinutes) plus a
// background loop that fires a minimal probe against the active provider
// every `minutes * 0.9` minutes when the value is non-zero. The probe
// reuses generateTaskSummary so the wire prefix (model + system prompt
// from runtime identity files) matches what real chat turns send, which
// is what keeps the provider's prompt cache hot for those turns.
//
// Aggressively flat by design:
//   - One nullable number on RuntimeConfig (`cacheWarmerMinutes`).
//   - One setter that validates 0..1440 and persists.
//   - One getter that returns the persisted value.
//   - One probe that calls the existing model dispatch path.
//   - The loop itself lives in src/server.ts next to the other gateway
//     loops (scheduler, reprobe, telegram, discord).
//
// Not handled here on purpose: per-agent / per-chat prefix tracking, or
// any retry policy. A failed probe logs and the next interval tries
// again. The `in_memory` retention tier itself is pinned on every
// OpenAI-compatible request body in src/provider.ts; the warmer's job
// is just to keep the implicit prefix cache fresh by re-firing.

import { writeFileSync } from "node:fs";
import { configPath } from "../paths";
import { generateTaskSummary } from "../provider";
import { appendLog } from "../state/trace";
import type { RuntimeConfig } from "../types";

export const CACHE_WARMER_MAX_MINUTES = 1440; // 24 hours

export interface CacheWarmerState {
  minutes: number;
}

export interface SetCacheWarmerResult {
  ok: boolean;
  minutes: number;
  error?: string;
}

// Read the persisted interval. 0 means disabled.
export function getCacheWarmer(config: RuntimeConfig): CacheWarmerState {
  return { minutes: config.cacheWarmerMinutes ?? 0 };
}

// Persist a new interval. Accepts integer minutes in [0, 1440]. 0 stores
// undefined on the config so disabled state doesn't leave a noisy `0` in
// config.json.
export function setCacheWarmer(config: RuntimeConfig, payload: unknown): SetCacheWarmerResult {
  const minutes = readMinutes(payload);
  if (minutes === null) {
    return {
      ok: false,
      minutes: config.cacheWarmerMinutes ?? 0,
      error: `minutes must be an integer between 0 and ${CACHE_WARMER_MAX_MINUTES}`
    };
  }
  config.cacheWarmerMinutes = minutes === 0 ? undefined : minutes;
  writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
  appendLog(config.instance, "cache_warmer.updated", { minutes });
  return { ok: true, minutes };
}

// Fire a single probe. Caller (the gateway loop) is responsible for
// timing. Errors propagate so the loop can log them; we don't swallow
// here because that would mask provider auth/transport failures.
export async function fireCacheWarmerProbe(config: RuntimeConfig): Promise<void> {
  const provider = config.provider;
  if (!provider || provider.name === "echo") return;
  // " " is the smallest non-empty user message; the system prefix that
  // generateTaskSummary builds is what actually warms the cache.
  await generateTaskSummary(config, " ");
}

function readMinutes(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { minutes?: unknown }).minutes;
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 0 || raw > CACHE_WARMER_MAX_MINUTES) return null;
  return raw;
}
