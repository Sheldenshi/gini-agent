/// <reference lib="dom" />

// DocReference renders an app-referenced hosted-docs URL inline: the trigger
// opens a sheet, the doc (or #anchor section) is fetched once through the BFF,
// and non-/docs/ URLs degrade to a plain external link. These tests stub
// global fetch and exercise every branch: inline success (with and without an
// anchor), the fetch-error fold, the single-fetch guard across reopen, and the
// plain-link fallback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocReference } from "./DocReference";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
const successFetchImpl = () =>
  new Response(JSON.stringify({ path: "remote-access", title: "Remote Access", markdown: "Front the **gateway port**." }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
let fetchImpl: (url: string) => Response = successFetchImpl;

beforeEach(() => {
  fetchCalls = [];
  // fetchImpl is per-test mutable state — restore the success default so a
  // test that swaps in a failure response can't leak it into later tests.
  fetchImpl = successFetchImpl;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    return Promise.resolve(fetchImpl(url));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("DocReference", () => {
  test("a non-/docs/ URL falls back to a plain external link", () => {
    render(
      <DocReference url="https://example.com/changelog">
        <span>changelog</span>
      </DocReference>
    );
    const link = screen.getByText("changelog").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/changelog");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(fetchCalls.length).toBe(0);
  });

  test("opening the sheet fetches the doc and renders title + markdown", async () => {
    const user = userEvent.setup();
    render(
      <DocReference url="https://gini.lilaclabs.ai/docs/remote-access">
        <button type="button">Remote Access</button>
      </DocReference>
    );
    await user.click(screen.getByRole("button", { name: "Remote Access" }));
    // toBeTruthy, not toBeNull: the fallback `queryAllByText(...)[1]` yields
    // undefined when absent, and `undefined` passes a not-null check.
    await waitFor(() =>
      expect(
        screen.queryByText("Remote Access", { selector: "h2, [data-slot=sheet-title]" }) ??
          screen.queryAllByText("Remote Access")[1]
      ).toBeTruthy()
    );
    expect(fetchCalls).toEqual(["/api/runtime/docs/remote-access"]);
    await waitFor(() => expect(screen.queryByText(/gateway port/)).not.toBeNull());
    // The escape hatch keeps the original hosted URL.
    const full = screen.getByText("Open full docs").closest("a");
    expect(full?.getAttribute("href")).toBe("https://gini.lilaclabs.ai/docs/remote-access");
  });

  test("an #anchor on the URL narrows the fetch to that section", async () => {
    const user = userEvent.setup();
    render(
      <DocReference url="https://gini.lilaclabs.ai/docs/remote-access#manual-tunnels">
        <button type="button">manual tunnels</button>
      </DocReference>
    );
    await user.click(screen.getByRole("button", { name: "manual tunnels" }));
    await waitFor(() => expect(fetchCalls).toEqual(["/api/runtime/docs/remote-access?section=manual-tunnels"]));
  });

  test("reopening does not refetch once the doc is loaded", async () => {
    const user = userEvent.setup();
    render(
      <DocReference url="https://gini.lilaclabs.ai/docs/remote-access">
        <button type="button">open</button>
      </DocReference>
    );
    await user.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(screen.queryByText(/gateway port/)).not.toBeNull());
    expect(fetchCalls.length).toBe(1);
  });

  test("a failed fetch shows the error fold with the external escape hatch", async () => {
    fetchImpl = () => new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    const user = userEvent.setup();
    render(
      <DocReference url="https://gini.lilaclabs.ai/docs/missing-doc">
        <button type="button">open missing</button>
      </DocReference>
    );
    await user.click(screen.getByRole("button", { name: "open missing" }));
    await waitFor(() => expect(screen.queryByText("Could not load this doc.")).not.toBeNull());
  });

  test("a non-Error rejection is stringified into the error fold", async () => {
    globalThis.fetch = (() => Promise.reject("boom")) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(
      <DocReference url="https://gini.lilaclabs.ai/docs/remote-access">
        <button type="button">open</button>
      </DocReference>
    );
    await user.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(screen.queryByText("Could not load this doc.")).not.toBeNull());
  });
});
