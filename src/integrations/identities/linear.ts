// Linear personal API key probe. Personal API keys authenticate with
// `Authorization: <token>` — Linear does NOT accept `Bearer <token>`
// for personal keys (only OAuth tokens use Bearer).
//
// We hit the viewer query which is the cheapest authenticated GraphQL
// call. Any 401/403, network error, or GraphQL error counts as a failed
// probe.

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
