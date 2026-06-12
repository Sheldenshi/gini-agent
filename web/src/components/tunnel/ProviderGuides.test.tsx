/// <reference lib="dom" />

// The sidebar's per-provider guide picker: one entry per tunnel provider,
// each opening ONLY that provider's guide inline (no aggregate guide exists).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderGuides } from "./ProviderGuides";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve(
      new Response(
        JSON.stringify({ path: "remote-access/tailscale", title: "Tailscale", markdown: "Tailnet-private access." }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ProviderGuides", () => {
  test("renders one guide entry per provider", () => {
    render(<ProviderGuides />);
    for (const name of ["Gini Relay", "Tailscale", "ngrok", "Cloudflare"]) {
      expect(screen.queryByRole("button", { name: `${name} remote access guide` })).not.toBeNull();
    }
    expect(screen.queryByText("Remote access")).not.toBeNull();
  });

  test("an entry opens that provider's guide (provider-scoped fetch)", async () => {
    const user = userEvent.setup();
    render(<ProviderGuides />);
    await user.click(screen.getByRole("button", { name: "Tailscale remote access guide" }));
    await waitFor(() => expect(screen.queryByText("Tailnet-private access.")).not.toBeNull());
    expect(fetchCalls).toEqual(["/api/runtime/docs/remote-access/tailscale"]);
  });
});
