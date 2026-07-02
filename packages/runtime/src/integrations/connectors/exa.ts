// Exa provider module. Neural web search + content extraction via
// https://exa.ai. Uses the REST API directly (no SDK) so the runtime
// doesn't pull a fresh dependency just for one provider.
//
// Probe runs a 1-result search for "ping". Any non-2xx counts as failure.

import type { ProviderModule } from "./types";

export interface ExaProbeOk {
  ok: true;
}

export interface ExaProbeFail {
  ok: false;
  error: string;
}

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const TIMEOUT_MS = 10_000;

export async function probeExa(token: string): Promise<ExaProbeOk | ExaProbeFail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token
      },
      body: JSON.stringify({ query: "ping", numResults: 1 }),
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: `Exa API returned HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Exa probe timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export const exaProvider: ProviderModule = {
  id: "exa",
  label: "Exa",
  description: "Neural web search + content extraction via Exa (https://exa.ai). Paid; free trial credits available.",
  docsUrl: "https://gini.lilaclabs.ai/docs/search/exa",
  fields: [
    {
      name: "token",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "exa_…"
    }
  ],
  secrets: {
    purposes: ["token"],
    envBindings: { EXA_API_KEY: "token" }
  },
  async probe(ctx) {
    const token = await ctx.resolveSecret("token");
    if (!token) return { ok: false, message: "Missing token secret." };
    const result = await probeExa(token);
    return result.ok ? { ok: true, message: "Exa API reachable." } : { ok: false, message: result.error };
  }
};
