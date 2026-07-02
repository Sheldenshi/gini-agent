/// <reference lib="dom" />

// ProviderFallbackBanner tests. The banner reads /status via useStatus and
// renders the amber "finish setup" pill only when status.providerFallback is
// set. We drive it through a real QueryClientProvider with a stubbed global
// fetch (no module mocks — the same leak-safe pattern UpdateGate.test uses):
// stub /status, render, and assert on the rendered pill.

import { afterEach, describe, expect, test } from "bun:test";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ProviderFallbackBanner } from "./ProviderFallbackBanner";
import type { RuntimeStatus } from "@runtime/types";

// Deliver react-query observer notifications synchronously so the banner
// re-renders predictably once the stubbed /status resolves.
notifyManager.setScheduler((cb) => cb());

const realFetch = globalThis.fetch;

function stubStatus(status: Partial<RuntimeStatus>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/status")) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderFallbackBanner />
    </QueryClientProvider>
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ProviderFallbackBanner", () => {
  test("renders nothing when no fallback is in effect", async () => {
    stubStatus({ ok: true } as Partial<RuntimeStatus>);
    await act(async () => {
      renderBanner();
    });
    // Give the status query a tick to resolve; the banner must stay absent.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("shows the amber pill with brand labels when a fallback is set", async () => {
    stubStatus({ ok: true, providerFallback: { selected: "bedrock", using: "deepseek" } } as Partial<RuntimeStatus>);
    await act(async () => {
      renderBanner();
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeNull();
    });
    const pill = screen.getByRole("status");
    // Brand labels (not the raw provider names) and the setup CTA.
    expect(pill.textContent).toContain("Amazon Bedrock");
    expect(pill.textContent).toContain("DeepSeek");
    expect(pill.textContent).toContain("Finish setup in Settings");
    expect(pill.getAttribute("aria-live")).toBe("polite");
  });

  test("falls back to the raw provider name for an unknown value", async () => {
    stubStatus({ ok: true, providerFallback: { selected: "acme" as never, using: "deepseek" } } as Partial<RuntimeStatus>);
    await act(async () => {
      renderBanner();
    });
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeNull();
    });
    expect(screen.getByRole("status").textContent).toContain("acme");
  });
});
