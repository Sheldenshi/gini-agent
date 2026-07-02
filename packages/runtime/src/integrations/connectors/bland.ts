// Bland AI provider module. Outbound AI phone calls via https://bland.ai.
// Uses the REST API directly (no SDK). The key is sent as a raw
// `authorization: <key>` header — Bland does NOT use Bearer auth.
//
// Probe lists 1 call (cheapest authenticated read). Any non-2xx counts as
// failure.

import type { ProviderModule } from "./types";

export interface BlandProbeOk {
  ok: true;
}

export interface BlandProbeFail {
  ok: false;
  error: string;
}

export const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
const TIMEOUT_MS = 10_000;

export async function probeBland(token: string): Promise<BlandProbeOk | BlandProbeFail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(BLAND_CALLS_ENDPOINT);
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: token
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: `Bland API returned HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Bland probe timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export const blandProvider: ProviderModule = {
  id: "bland",
  label: "Bland AI",
  description: "Outbound AI phone calls via Bland AI (https://bland.ai). Pay-per-minute; free trial credits available.",
  docsUrl: "https://gini.lilaclabs.ai/docs/phone/bland",
  fields: [
    {
      name: "token",
      label: "API key",
      secret: true,
      required: true,
      placeholder: "org_…"
    }
  ],
  secrets: {
    purposes: ["token"],
    envBindings: { BLAND_API_KEY: "token" }
  },
  async probe(ctx) {
    const token = await ctx.resolveSecret("token");
    if (!token) return { ok: false, message: "Missing token secret." };
    const result = await probeBland(token);
    return result.ok ? { ok: true, message: "Bland API reachable." } : { ok: false, message: result.error };
  }
};
