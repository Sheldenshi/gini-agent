/// <reference lib="dom" />

// DocSheet is the controlled doc slide-over: programmatic opens (no Radix
// trigger interaction) must still fetch on the open edge, the optional `lead`
// renders above the body, a failed fetch retries on the next open, and a
// non-/docs/ URL renders nothing (callers with visible triggers degrade to a
// plain link before reaching it).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocSheet } from "./DocSheet";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchImpl: () => Response;

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = () =>
    new Response(
      JSON.stringify({ path: "remote-access/ngrok", title: "ngrok", markdown: "Install **ngrok** and add your authtoken." }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve(fetchImpl());
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("DocSheet", () => {
  test("a programmatic open fetches the doc and renders title, lead, and body", async () => {
    render(
      <DocSheet
        url="https://gini.lilaclabs.ai/docs/remote-access/ngrok"
        open
        onOpenChange={() => {}}
        lead={<p>This provider needs setup first.</p>}
      />
    );
    await waitFor(() => expect(screen.queryByText(/add your authtoken/)).not.toBeNull());
    expect(fetchCalls).toEqual(["/api/runtime/docs/remote-access/ngrok"]);
    expect(screen.queryByText("This provider needs setup first.")).not.toBeNull();
    expect(screen.queryByText("ngrok", { selector: "[data-slot=sheet-title], h2" })).not.toBeNull();
    // The escape hatch keeps the original hosted URL.
    const full = screen.getAllByText("Open full docs")[0].closest("a");
    expect(full?.getAttribute("href")).toBe("https://gini.lilaclabs.ai/docs/remote-access/ngrok");
  });

  test("a failed fetch shows the error fold and the next open retries", async () => {
    fetchImpl = () => new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    const { rerender } = render(
      <DocSheet url="https://gini.lilaclabs.ai/docs/remote-access/ngrok" open onOpenChange={() => {}} />
    );
    await waitFor(() => expect(screen.queryByText("Could not load this doc.")).not.toBeNull());
    expect(fetchCalls.length).toBe(1);
    // Close, fix the backend, reopen: the open edge retries the fetch.
    fetchImpl = () =>
      new Response(JSON.stringify({ path: "remote-access/ngrok", title: "ngrok", markdown: "now it loads" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/remote-access/ngrok" open={false} onOpenChange={() => {}} />);
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/remote-access/ngrok" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByText("now it loads")).not.toBeNull());
    expect(fetchCalls.length).toBe(2);
  });

  test("swapping the url in place drops the cached doc and fetches the new one", async () => {
    // Callers may swap `url` without a key remount (AddConnectorDialog
    // switches provider templates on one DocReference) — the sheet must
    // never serve the previous url's doc under the new link.
    fetchImpl = () =>
      new Response(JSON.stringify({ path: "search/brave", title: "Brave", markdown: "Brave doc body" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const { rerender } = render(
      <DocSheet url="https://gini.lilaclabs.ai/docs/search/brave" open onOpenChange={() => {}} />
    );
    await waitFor(() => expect(screen.queryByText("Brave doc body")).not.toBeNull());
    fetchImpl = () =>
      new Response(JSON.stringify({ path: "search/exa", title: "Exa", markdown: "Exa doc body" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    // Swap while OPEN: the cached Brave doc drops and Exa fetches immediately.
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/search/exa" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Exa doc body")).not.toBeNull());
    expect(screen.queryByText("Brave doc body")).toBeNull();
    expect(fetchCalls).toEqual(["/api/runtime/docs/search/brave", "/api/runtime/docs/search/exa"]);
    // Swap while CLOSED: no eager fetch; the next open edge fetches.
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/search/exa" open={false} onOpenChange={() => {}} />);
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/search/brave" open={false} onOpenChange={() => {}} />);
    expect(fetchCalls.length).toBe(2);
    fetchImpl = () =>
      new Response(JSON.stringify({ path: "search/brave", title: "Brave", markdown: "Brave doc body" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/search/brave" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Brave doc body")).not.toBeNull());
    expect(fetchCalls).toEqual([
      "/api/runtime/docs/search/brave",
      "/api/runtime/docs/search/exa",
      "/api/runtime/docs/search/brave"
    ]);
  });

  test("an in-flight fetch for a previous url never commits after a swap", async () => {
    // Resolve fetches manually so the OLD url's response can land AFTER the
    // NEW url's — the stale result must be discarded, not displayed (the
    // per-url cache would otherwise pin the wrong doc for the mount).
    const pending = new Map<string, (r: Response) => void>();
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      const { promise, resolve } = Promise.withResolvers<Response>();
      pending.set(url, resolve);
      return promise;
    }) as typeof fetch;
    const doc = (path: string, title: string, markdown: string) =>
      new Response(JSON.stringify({ path, title, markdown }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const { rerender } = render(
      <DocSheet url="https://gini.lilaclabs.ai/docs/search/brave" open onOpenChange={() => {}} />
    );
    await waitFor(() => expect(pending.has("/api/runtime/docs/search/brave")).toBe(true));
    // Swap while brave's fetch is still in flight.
    rerender(<DocSheet url="https://gini.lilaclabs.ai/docs/search/exa" open onOpenChange={() => {}} />);
    await waitFor(() => expect(pending.has("/api/runtime/docs/search/exa")).toBe(true));
    // Resolve the NEW url first…
    pending.get("/api/runtime/docs/search/exa")!(doc("search/exa", "Exa", "Exa doc body"));
    await waitFor(() => expect(screen.queryByText("Exa doc body")).not.toBeNull());
    // …then the stale one: it must not replace the displayed doc.
    pending.get("/api/runtime/docs/search/brave")!(doc("search/brave", "Brave", "Brave doc body"));
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, 50);
    await settle.promise;
    expect(screen.queryByText("Exa doc body")).not.toBeNull();
    expect(screen.queryByText("Brave doc body")).toBeNull();
  });

  test("closing via the sheet reports through onOpenChange", async () => {
    const user = userEvent.setup();
    let openState = true;
    render(
      <DocSheet
        url="https://gini.lilaclabs.ai/docs/remote-access/ngrok"
        open
        onOpenChange={(next) => {
          openState = next;
        }}
      />
    );
    await waitFor(() => expect(screen.queryByText(/add your authtoken/)).not.toBeNull());
    await user.keyboard("{Escape}");
    expect(openState).toBe(false);
  });

  test("a non-/docs/ URL renders nothing", () => {
    const { container } = render(
      <DocSheet url="https://example.com/changelog" open onOpenChange={() => {}} />
    );
    expect(container.innerHTML).toBe("");
    expect(fetchCalls.length).toBe(0);
  });
});
