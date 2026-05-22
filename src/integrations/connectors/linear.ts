// Linear provider module. Personal API keys authenticate with
// `Authorization: <token>` — Linear does NOT accept `Bearer <token>` for
// personal keys (only OAuth tokens use Bearer).
//
// The probe hits the viewer query (cheapest authenticated GraphQL call).
// Any 401/403, network error, or GraphQL error counts as a failed probe.

import type { ProviderModule } from "./types";

export interface LinearProbeOk {
  ok: true;
  viewer: { id: string; name: string; email?: string };
}

export interface LinearProbeFail {
  ok: false;
  error: string;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 10_000;

export async function probeLinear(token: string): Promise<LinearProbeOk | LinearProbeFail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: token
      },
      body: JSON.stringify({ query: "{ viewer { id name email } }" }),
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, error: `Linear API returned HTTP ${response.status}` };
    }
    const payload = (await response.json()) as {
      data?: { viewer?: { id?: string; name?: string; email?: string } };
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors && payload.errors.length > 0) {
      return { ok: false, error: payload.errors.map((e) => e.message ?? "unknown").join("; ") };
    }
    const viewer = payload.data?.viewer;
    if (!viewer?.id || !viewer.name) {
      return { ok: false, error: "Linear viewer query returned no data." };
    }
    return { ok: true, viewer: { id: viewer.id, name: viewer.name, email: viewer.email } };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Linear probe timed out after ${TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export const linearProvider: ProviderModule = {
  id: "linear",
  label: "Linear",
  description: "Query and update Linear issues via the Linear GraphQL API.",
  fields: [
    {
      name: "token",
      label: "Personal API token",
      description: "Get one at https://linear.app/settings/account/security.",
      secret: true,
      required: true,
      placeholder: "lin_api_…"
    }
  ],
  secrets: {
    purposes: ["token"],
    envBindings: { LINEAR_API_KEY: "token" }
  },
  // Auto-register the hosted Linear MCP server when a Linear connector
  // becomes healthy. The `${LINEAR_API_KEY}` placeholder resolves at
  // invoke-time via `resolveMcpHeaders()` against the same connector's
  // env-binding, so the token never lands in state.json.
  mcpServer: {
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    headers: {
      Authorization: "Bearer ${LINEAR_API_KEY}"
    }
  },
  async probe(ctx) {
    const token = await ctx.resolveSecret("token");
    if (!token) return { ok: false, message: "Missing token secret." };
    const result = await probeLinear(token);
    return result.ok
      ? { ok: true, message: `Authenticated as ${result.viewer.name}` }
      : { ok: false, message: result.error };
  }
};
