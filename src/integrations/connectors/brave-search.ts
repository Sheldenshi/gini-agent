// Brave Search provider module. Free-tier API at https://brave.com/search/api/
// (2k queries/month). The token is sent as `X-Subscription-Token: <key>` —
// Brave does NOT accept Bearer auth.
//
// Probe runs a 1-result query for "ping" against the web-search endpoint
// (cheapest authenticated call). Any non-2xx response counts as failure.

import type { ProviderModule } from "./types";

export interface BraveProbeOk {
  ok: true;
}

export interface BraveProbeFail {
  ok: false;
  error: string;
}

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 10_000;

export async function probeBrave(token: string): Promise<BraveProbeOk | BraveProbeFail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", "ping");
    url.searchParams.set("count", "1");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": token
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: `Brave Search API returned HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Brave probe timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export const braveSearchProvider: ProviderModule = {
  id: "brave-search",
  label: "Brave Search",
  description: "Web search via Brave's Data-for-Search API. Free tier: 2k queries/month at https://brave.com/search/api/.",
  docsUrl: "https://gini.lilaclabs.ai/docs/search/brave",
  fields: [
    {
      name: "token",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "BSA…"
    }
  ],
  secrets: {
    purposes: ["token"],
    envBindings: { BRAVE_SEARCH_API_KEY: "token" }
  },
  async probe(ctx) {
    const token = await ctx.resolveSecret("token");
    if (!token) return { ok: false, message: "Missing token secret." };
    const result = await probeBrave(token);
    return result.ok ? { ok: true, message: "Brave Search API reachable." } : { ok: false, message: result.error };
  }
};
