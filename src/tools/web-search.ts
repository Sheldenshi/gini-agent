// Web-search backends for the `web_search` tool. Two providers today —
// Brave Search and Exa — selected per call by their connector provider id
// ("brave-search" | "exa"). Each function takes the resolved API token and
// returns a normalized result list the dispatcher formats into the tool
// result string.

import { BRAVE_SEARCH_ENDPOINT } from "../integrations/connectors/brave-search";
import { EXA_SEARCH_ENDPOINT } from "../integrations/connectors/exa";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 15_000;

export async function braveWebSearch(token: string, query: string, count: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": token
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Brave Search API returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = payload.web?.results ?? [];
    return results.slice(0, count).map((entry) => ({
      title: stripTags(entry.title ?? ""),
      url: entry.url ?? "",
      snippet: stripTags(entry.description ?? "")
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function exaWebSearch(token: string, query: string, count: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": token
      },
      body: JSON.stringify({
        query,
        numResults: count,
        contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Exa API returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        highlights?: string[];
      }>;
    };
    const results = payload.results ?? [];
    return results.slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: pickSnippet(entry.highlights, entry.text)
    }));
  } finally {
    clearTimeout(timer);
  }
}

export function formatWebSearchResults(provider: string, query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return `No results from ${provider} for "${query}".`;
  }
  const lines = results.map((r, i) => {
    const head = `[${i + 1}] ${r.title || "(untitled)"} — ${r.url}`;
    const body = r.snippet ? `\n    ${truncate(r.snippet, 280)}` : "";
    return head + body;
  });
  return `Results from ${provider} for "${query}":\n${lines.join("\n")}`;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function pickSnippet(highlights: string[] | undefined, text: string | undefined): string {
  if (Array.isArray(highlights) && highlights.length > 0) {
    return highlights.join(" … ").trim();
  }
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}
