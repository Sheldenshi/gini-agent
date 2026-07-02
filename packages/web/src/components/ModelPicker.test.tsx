/// <reference lib="dom" />

// ModelPicker tests: the pure helpers (filter/selection/trigger-label) and
// the rendered picker — open/search/select, the multi-route flyout via
// hover, chevron (touch), and keyboard, and the escape/scroll/mouse-leave
// dismissal paths. fetch is stubbed per-URL so the /providers/models and
// /providers/catalog queries resolve without a gateway.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  filterModelEntries,
  findSelectedRoute,
  ModelPicker,
  modelTriggerLabel,
  shouldCloseFlyoutOnLeave
} from "./ModelPicker";
import type { ModelCatalogEntry } from "@/lib/providers";

const ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gpt-5.5",
    routes: [{ provider: "codex", providerModelId: "gpt-5.5", label: "Codex", default: true }]
  },
  {
    id: "claude-sonnet-4-6",
    routes: [
      { provider: "anthropic", providerModelId: "claude-sonnet-4-6", label: "Anthropic", default: true },
      { provider: "bedrock", providerModelId: "us.anthropic.claude-sonnet-4-6", label: "Amazon Bedrock · us", default: false },
      { provider: "bedrock", providerModelId: "eu.anthropic.claude-sonnet-4-6", label: "Amazon Bedrock · eu", default: false }
    ]
  },
  {
    id: "local/default",
    routes: [{ provider: "local", providerModelId: "local/default", label: "Local", default: true }]
  }
];

const CATALOG = [
  { id: "local", name: "local", displayName: "Local OpenAI-Compatible", auth: "env", models: ["local/default"], configured: true }
];

const rawLabel = (provider: string) => provider;

describe("filterModelEntries", () => {
  test("returns everything for a blank query", () => {
    expect(filterModelEntries(ENTRIES, "")).toEqual(ENTRIES);
    expect(filterModelEntries(ENTRIES, "   ")).toEqual(ENTRIES);
  });

  test("matches the canonical model name case-insensitively", () => {
    expect(filterModelEntries(ENTRIES, "CLAUDE").map((e) => e.id)).toEqual(["claude-sonnet-4-6"]);
  });

  test("matches route labels so a provider search finds its models", () => {
    expect(filterModelEntries(ENTRIES, "bedrock").map((e) => e.id)).toEqual(["claude-sonnet-4-6"]);
  });

  test("no match yields an empty list", () => {
    expect(filterModelEntries(ENTRIES, "nope")).toEqual([]);
  });
});

describe("findSelectedRoute", () => {
  test("resolves a pair to its entry and route", () => {
    const match = findSelectedRoute(ENTRIES, {
      provider: "bedrock",
      model: "eu.anthropic.claude-sonnet-4-6"
    });
    expect(match?.entry.id).toBe("claude-sonnet-4-6");
    expect(match?.route.label).toBe("Amazon Bedrock · eu");
  });

  test("returns null for a missing value or an off-catalog pair", () => {
    expect(findSelectedRoute(ENTRIES, null)).toBeNull();
    expect(findSelectedRoute(ENTRIES, undefined)).toBeNull();
    // Same model id through a provider that doesn't serve it.
    expect(findSelectedRoute(ENTRIES, { provider: "openai", model: "gpt-5.5" })).toBeNull();
  });
});

describe("modelTriggerLabel", () => {
  test("always names the serving route — default routes included", () => {
    expect(modelTriggerLabel(ENTRIES, { provider: "anthropic", model: "claude-sonnet-4-6" }, rawLabel)).toEqual({
      model: "claude-sonnet-4-6",
      route: "Anthropic"
    });
    expect(
      modelTriggerLabel(ENTRIES, { provider: "bedrock", model: "us.anthropic.claude-sonnet-4-6" }, rawLabel)
    ).toEqual({ model: "claude-sonnet-4-6", route: "Amazon Bedrock · us" });
  });

  test("an off-catalog pair shows its raw model id with the provider fallback label", () => {
    expect(modelTriggerLabel(ENTRIES, { provider: "local", model: "qwen3:32b" }, rawLabel)).toEqual({
      model: "qwen3:32b",
      route: "local"
    });
  });

  test("placeholder when nothing is selected", () => {
    expect(modelTriggerLabel(ENTRIES, null, rawLabel)).toEqual({ model: "Select model" });
    expect(modelTriggerLabel(ENTRIES, { provider: "codex", model: "" }, rawLabel)).toEqual({
      model: "Select model"
    });
  });
});

describe("shouldCloseFlyoutOnLeave", () => {
  test("closes only on a genuine departure to a node outside the content", () => {
    const content = document.createElement("div");
    const inside = document.createElement("div");
    content.append(inside);
    const outside = document.createElement("div");
    document.body.append(content, outside);
    expect(shouldCloseFlyoutOnLeave(content, outside)).toBe(true);
    expect(shouldCloseFlyoutOnLeave(content, inside)).toBe(false);
    // Pointer left the window (no relatedTarget) or the ref is gone.
    expect(shouldCloseFlyoutOnLeave(content, null)).toBe(false);
    expect(shouldCloseFlyoutOnLeave(content, undefined)).toBe(false);
    expect(shouldCloseFlyoutOnLeave(null, outside)).toBe(true);
    content.remove();
    outside.remove();
  });
});

// --- Rendered picker ---

const realFetch = globalThis.fetch;

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function stubFetch(models: unknown = ENTRIES) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/providers/models")) return jsonResponse(models);
    if (url.includes("/providers/catalog")) return jsonResponse(CATALOG);
    return jsonResponse([]);
  }) as unknown as typeof fetch;
}

function render(ui: Parameters<typeof rtlRender>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  stubFetch();
  // happy-dom elements may not implement scrollIntoView; the keyboard path
  // calls it for visibility only.
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const popoverContent = () =>
  screen.getByPlaceholderText("Search models…").closest('[data-slot="popover-content"]') as HTMLElement;

describe("ModelPicker", () => {
  test("trigger shows the placeholder without a value, the model name on a default route, and opens the searchable list", async () => {
    const onSelect = mock(() => {});
    render(<ModelPicker value={null} onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Select model" });
    expect(trigger.textContent).toContain("Select model");

    const user = userEvent.setup();
    await user.click(trigger);
    expect(await screen.findByRole("option", { name: /gpt-5\.5/ })).not.toBeNull();
    // Every row names its serving route; only multi-route rows carry the
    // route-chooser chevron button.
    const multi = screen.getByRole("option", { name: /claude-sonnet-4-6/ });
    expect(multi.textContent).toContain("Anthropic");
    expect(within(multi).getByRole("button")).not.toBeNull();
    const single = screen.getByRole("option", { name: /gpt-5\.5/ });
    expect(single.textContent).toContain("Codex");
    expect(within(single).queryByRole("button")).toBeNull();
  });

  test("trigger names the serving route even on the default route", async () => {
    render(<ModelPicker value={{ provider: "codex", model: "gpt-5.5" }} onSelect={mock(() => {})} />);
    const trigger = await screen.findByRole("button", { name: "Select model" });
    await screen.findByText(/· Codex/);
    expect(trigger.textContent).toContain("gpt-5.5");
    expect(trigger.textContent).toContain("· Codex");
  });

  test("trigger appends the route label for a non-default route", async () => {
    render(
      <ModelPicker
        value={{ provider: "bedrock", model: "eu.anthropic.claude-sonnet-4-6" }}
        onSelect={mock(() => {})}
      />
    );
    const trigger = screen.getByRole("button", { name: "Select model" });
    await screen.findByText(/Amazon Bedrock · eu/);
    expect(trigger.textContent).toContain("claude-sonnet-4-6");
    expect(trigger.textContent).toContain("· Amazon Bedrock · eu");
  });

  test("an off-catalog pair shows its raw id with the provider label resolved from the catalog", async () => {
    render(<ModelPicker value={{ provider: "local", model: "qwen3:32b" }} onSelect={mock(() => {})} />);
    const trigger = screen.getByRole("button", { name: "Select model" });
    await screen.findByText(/· Local/);
    expect(trigger.textContent).toContain("qwen3:32b");
    // displayProviderName maps the catalog row to the short brand label.
    expect(trigger.textContent).toContain("· Local");
  });

  test("an off-catalog pair from an unknown provider falls back to the raw provider name", async () => {
    render(<ModelPicker value={{ provider: "acme", model: "frontier-1" }} onSelect={mock(() => {})} />);
    const trigger = screen.getByRole("button", { name: "Select model" });
    await screen.findByText(/· acme/);
    expect(trigger.textContent).toContain("frontier-1");
  });

  test("clicking a model name selects its default route and closes", async () => {
    const onSelect = mock(() => {});
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await user.click(await screen.findByRole("option", { name: /claude-sonnet-4-6/ }));
    expect(onSelect).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(screen.queryByPlaceholderText("Search models…")).toBeNull();
  });

  test("search filters the list and surfaces a no-match message", async () => {
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await screen.findByRole("option", { name: /gpt-5\.5/ });
    await user.type(screen.getByPlaceholderText("Search models…"), "claude");
    expect(screen.queryByRole("option", { name: /gpt-5\.5/ })).toBeNull();
    expect(screen.getByRole("option", { name: /claude-sonnet-4-6/ })).not.toBeNull();
    await user.clear(screen.getByPlaceholderText("Search models…"));
    await user.type(screen.getByPlaceholderText("Search models…"), "zzz");
    expect(screen.getByText("No models match.")).not.toBeNull();
  });

  test("hovering a multi-route row opens the flyout; clicking a route selects that exact pair", async () => {
    const onSelect = mock(() => {});
    const user = userEvent.setup();
    render(<ModelPicker value={{ provider: "anthropic", model: "claude-sonnet-4-6" }} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await user.hover(await screen.findByRole("option", { name: /claude-sonnet-4-6/ }));
    const flyout = await screen.findByRole("listbox", { name: "Routes for claude-sonnet-4-6" });
    expect(within(flyout).getByText("default")).not.toBeNull();
    expect(within(flyout).getAllByRole("option")).toHaveLength(3);
    await user.click(within(flyout).getByRole("option", { name: /Amazon Bedrock · eu/ }));
    expect(onSelect).toHaveBeenCalledWith({ provider: "bedrock", model: "eu.anthropic.claude-sonnet-4-6" });
  });

  test("hovering a single-route row closes an open flyout; so do scroll and leaving the popover", async () => {
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    const multi = await screen.findByRole("option", { name: /claude-sonnet-4-6/ });

    await user.hover(multi);
    expect(screen.getByRole("listbox", { name: /Routes for/ })).not.toBeNull();
    await user.hover(screen.getByRole("option", { name: /gpt-5\.5/ }));
    expect(screen.queryByRole("listbox", { name: /Routes for/ })).toBeNull();

    await user.hover(multi);
    fireEvent.scroll(screen.getByRole("listbox", { name: "Models" }));
    expect(screen.queryByRole("listbox", { name: /Routes for/ })).toBeNull();

    // Park the pointer elsewhere first — a hover on the row it's already
    // over is a no-op and would leave the flyout closed.
    await user.hover(screen.getByRole("option", { name: /gpt-5\.5/ }));
    await user.hover(multi);
    // A missing relatedTarget (pointer left the window) keeps the flyout
    // open; the genuine-departure decision is covered by the
    // shouldCloseFlyoutOnLeave unit tests below.
    fireEvent.mouseLeave(popoverContent());
    expect(screen.getByRole("listbox", { name: /Routes for/ })).not.toBeNull();
  });

  test("the chevron is a touch/click fallback that opens the flyout", async () => {
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await screen.findByRole("option", { name: /claude-sonnet-4-6/ });
    await user.click(screen.getByRole("button", { name: "Choose a route for claude-sonnet-4-6" }));
    expect(screen.getByRole("listbox", { name: "Routes for claude-sonnet-4-6" })).not.toBeNull();
  });

  test("keyboard: arrows navigate, ArrowRight opens the flyout, Enter selects the highlighted route", async () => {
    const onSelect = mock(() => {});
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await screen.findByRole("option", { name: /gpt-5\.5/ });

    // ArrowUp clamps at the top; ArrowDown walks to the multi-route entry.
    await user.keyboard("{ArrowUp}{ArrowDown}");
    const input = screen.getByPlaceholderText("Search models…");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /claude-sonnet-4-6/ }).id
    );

    // Into the flyout, down one route (us), and select it.
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ provider: "bedrock", model: "us.anthropic.claude-sonnet-4-6" });
  });

  test("keyboard: Enter without a flyout selects the highlighted model's default route", async () => {
    const onSelect = mock(() => {});
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await screen.findByRole("option", { name: /gpt-5\.5/ });
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ provider: "codex", model: "gpt-5.5" });
  });

  test("keyboard: ArrowLeft closes the flyout; Escape closes flyout first, popover second", async () => {
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await screen.findByRole("option", { name: /claude-sonnet-4-6/ });

    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("listbox", { name: /Routes for/ })).not.toBeNull();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("listbox", { name: /Routes for/ })).toBeNull();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("listbox", { name: /Routes for/ })).not.toBeNull();
    await user.keyboard("{Escape}");
    // Flyout gone, popover still open.
    expect(screen.queryByRole("listbox", { name: /Routes for/ })).toBeNull();
    expect(screen.getByPlaceholderText("Search models…")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Search models…")).toBeNull();
  });

  test("opening with a selection highlights it and marks the row", async () => {
    const user = userEvent.setup();
    render(<ModelPicker value={{ provider: "codex", model: "gpt-5.5" }} onSelect={mock(() => {})} />);
    await screen.findByText("gpt-5.5");
    await user.click(screen.getByRole("button", { name: "Select model" }));
    const row = await screen.findByRole("option", { name: /gpt-5\.5/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
    const input = screen.getByPlaceholderText("Search models…");
    expect(input.getAttribute("aria-activedescendant")).toBe(row.id);
  });

  test("shows the loading state while routes are in flight", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/providers/models")) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse(CATALOG));
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    expect(await screen.findByText("Loading models…")).not.toBeNull();
  });

  test("shows the empty state when no providers are connected", async () => {
    stubFetch([]);
    const user = userEvent.setup();
    render(<ModelPicker value={null} onSelect={mock(() => {})} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    expect(await screen.findByText("No providers connected.")).not.toBeNull();
  });

  test("respects the disabled flag", async () => {
    render(<ModelPicker value={null} onSelect={mock(() => {})} disabled ariaLabel="Default model" />);
    const trigger = screen.getByRole("button", { name: "Default model" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});
