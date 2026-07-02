/// <reference lib="dom" />

// ProviderPicker tests: the pure helpers (provider flags, payload builder,
// submit gate) and the rendered surface — the eight-tile grid, the
// per-provider config branches (codex / bedrock / azure / anthropic /
// env-keyed / local), the POST /api/setup/provider on submit, and the
// onSaved / onError / inline-error wiring both /setup and Settings → Add
// provider lean on.
//
// The real DocReference is used (no mock): the test catalog's setupDocUrl is a
// NON-/docs/ URL, so DocReference renders a plain external <a> — no DocSheet
// mount, no fetch, and nothing to leak across files. DocReference and its
// subtree already reach 100% via DocReference.test.tsx, so pulling them into
// the module graph here costs the coverage gate nothing. The Bedrock selects
// are likewise the real components (their import graph is coverage-exempt under
// src/app/**). fetch is stubbed per test and restored in afterEach.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderCatalogItem } from "@/lib/providers";
import {
  buildProviderPayload,
  canSubmitProvider,
  PROVIDER_DESCRIPTION,
  ProviderPicker,
  providerFlags,
  SELECTABLE_PROVIDERS,
  type ProviderFormState
} from "./ProviderPicker";

// --- pure helpers ---

function emptyState(over: Partial<ProviderFormState> = {}): ProviderFormState {
  return {
    providerName: "",
    selectedModel: "",
    apiKey: "",
    baseUrl: "",
    awsRegion: "",
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    apiVersion: "",
    deployment: "",
    authScheme: "api-key",
    ...over
  };
}

describe("providerFlags", () => {
  test("each provider lights exactly its own flag and the api-key requirement follows", () => {
    expect(providerFlags("codex")).toEqual({
      isCodex: true,
      isLocal: false,
      isAnthropic: false,
      isBedrock: false,
      isAzure: false,
      requiresApiKey: false
    });
    expect(providerFlags("local").requiresApiKey).toBe(false);
    expect(providerFlags("bedrock").requiresApiKey).toBe(false);
    expect(providerFlags("openai")).toMatchObject({ isAnthropic: false, requiresApiKey: true });
    expect(providerFlags("anthropic")).toMatchObject({ isAnthropic: true, requiresApiKey: true });
    expect(providerFlags("azure")).toMatchObject({ isAzure: true, requiresApiKey: true });
    // The empty (nothing-selected) state never requires a key.
    expect(providerFlags("").requiresApiKey).toBe(false);
  });
});

describe("buildProviderPayload", () => {
  test("codex posts only the branch trigger — no key, no model", () => {
    expect(buildProviderPayload(emptyState({ providerName: "codex", selectedModel: "gpt-5.5" }))).toEqual({
      provider: "codex"
    });
  });

  test("env-keyed provider sends key, model, and a non-empty base URL", () => {
    expect(
      buildProviderPayload(
        emptyState({ providerName: "openai", apiKey: "  sk-live  ", selectedModel: "gpt-5.4", baseUrl: " https://x " })
      )
    ).toEqual({ provider: "openai", apiKey: "sk-live", model: "gpt-5.4", baseUrl: "https://x" });
  });

  test("env-keyed provider omits an empty base URL, key, and model", () => {
    expect(buildProviderPayload(emptyState({ providerName: "local", baseUrl: "   " }))).toEqual({ provider: "local" });
  });

  test("bedrock carries region + both AWS keys and never a baseUrl", () => {
    expect(
      buildProviderPayload(
        emptyState({
          providerName: "bedrock",
          selectedModel: "us.anthropic.claude-opus-4-8",
          awsRegion: " us-east-1 ",
          awsAccessKeyId: " AKIA ",
          awsSecretAccessKey: " secret ",
          baseUrl: "https://ignored"
        })
      )
    ).toEqual({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-8",
      awsRegion: "us-east-1",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret"
    });
  });

  test("azure always sends the routing trio (trimmed) alongside key, model, endpoint", () => {
    expect(
      buildProviderPayload(
        emptyState({
          providerName: "azure",
          apiKey: "k",
          selectedModel: "gpt-5.5",
          baseUrl: "https://r.openai.azure.com",
          apiVersion: " 2024-10-21 ",
          deployment: " dep ",
          authScheme: "bearer"
        })
      )
    ).toEqual({
      provider: "azure",
      apiKey: "k",
      model: "gpt-5.5",
      baseUrl: "https://r.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "dep",
      authScheme: "bearer"
    });
  });
});

describe("canSubmitProvider", () => {
  test("nothing selected, or a pending save, never submits", () => {
    expect(canSubmitProvider(emptyState(), false)).toBe(false);
    expect(canSubmitProvider(emptyState({ providerName: "codex" }), true)).toBe(false);
  });

  test("codex submits on selection alone", () => {
    expect(canSubmitProvider(emptyState({ providerName: "codex" }), false)).toBe(true);
  });

  test("env-keyed needs a model and a key", () => {
    expect(canSubmitProvider(emptyState({ providerName: "openai", selectedModel: "gpt-5.4" }), false)).toBe(false);
    expect(
      canSubmitProvider(emptyState({ providerName: "openai", selectedModel: "gpt-5.4", apiKey: "sk" }), false)
    ).toBe(true);
  });

  test("local needs only a model (no key)", () => {
    expect(canSubmitProvider(emptyState({ providerName: "local", selectedModel: "local/default" }), false)).toBe(true);
  });

  test("azure additionally needs a resource endpoint", () => {
    expect(
      canSubmitProvider(emptyState({ providerName: "azure", selectedModel: "gpt-5.5", apiKey: "k" }), false)
    ).toBe(false);
    expect(
      canSubmitProvider(
        emptyState({ providerName: "azure", selectedModel: "gpt-5.5", apiKey: "k", baseUrl: "https://r" }),
        false
      )
    ).toBe(true);
  });

  test("bedrock needs a model and both AWS keys", () => {
    expect(
      canSubmitProvider(
        emptyState({ providerName: "bedrock", selectedModel: "m", awsAccessKeyId: "AKIA" }),
        false
      )
    ).toBe(false);
    expect(
      canSubmitProvider(
        emptyState({ providerName: "bedrock", selectedModel: "m", awsAccessKeyId: "AKIA", awsSecretAccessKey: "s" }),
        false
      )
    ).toBe(true);
  });
});

describe("static maps", () => {
  test("every selectable provider has a tile description", () => {
    for (const name of SELECTABLE_PROVIDERS) {
      expect(typeof PROVIDER_DESCRIPTION[name]).toBe("string");
    }
  });
});

// --- rendered surface ---

const CATALOG: ProviderCatalogItem[] = [
  { id: "p_codex", name: "codex", displayName: "Codex OAuth", auth: "codex-oauth", models: ["gpt-5.5"] },
  {
    id: "p_openai",
    name: "openai",
    displayName: "OpenAI Compatible",
    auth: "env",
    models: ["gpt-5.4-mini", "gpt-5.4"],
    // A non-/docs/ URL: the real DocReference renders it as a plain external
    // <a> (no DocSheet mount, no fetch), keeping this an isolated render test.
    setupDocUrl: "https://gini.example/providers/openai"
  },
  { id: "p_anthropic", name: "anthropic", displayName: "Anthropic Compatible", auth: "env", models: ["claude-opus-4-8"] },
  {
    id: "p_bedrock",
    name: "bedrock",
    displayName: "Amazon Bedrock",
    auth: "aws",
    models: ["us.anthropic.claude-opus-4-8"]
  },
  { id: "p_openrouter", name: "openrouter", displayName: "OpenRouter Compatible", auth: "env", models: ["openrouter/auto"] },
  { id: "p_deepseek", name: "deepseek", displayName: "DeepSeek", auth: "env", models: ["deepseek-v4-flash"] },
  { id: "p_azure", name: "azure", displayName: "Azure OpenAI", auth: "env", models: ["gpt-5.5"] },
  { id: "p_local", name: "local", displayName: "Local OpenAI-Compatible", auth: "env", models: ["local/default"] }
];

const realFetch = globalThis.fetch;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

// Per-URL fetch stub. `setProvider` produces the POST /setup/provider response;
// override it per test for the failure paths.
let setProvider: () => Promise<Response>;
let catalogResponse: () => Promise<Response>;

function stubFetch() {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup/provider")) return setProvider();
    if (url.includes("/providers/catalog")) return catalogResponse();
    return jsonResponse([]);
  }) as unknown as typeof fetch;
}

function render(ui: Parameters<typeof rtlRender>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  setProvider = async () => jsonResponse({ ok: true, plistRefreshNeeded: false });
  catalogResponse = async () => jsonResponse(CATALOG);
  stubFetch();
  // happy-dom may not implement scrollIntoView; the Select primitives call it.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Click a provider tile by its exact brand label. The label lives in a span
// inside the tile <button>; getByText with an exact string avoids the
// substring collision between "OpenAI" and "Azure OpenAI".
async function selectTile(user: ReturnType<typeof userEvent.setup>, label: string) {
  const tile = (await screen.findByText(label, { exact: true })).closest("button") as HTMLElement;
  await user.click(tile);
}

function lastSetProviderBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
  const call = fetchMock.mock.calls
    .filter(([input]) => String(input).includes("/setup/provider"))
    .at(-1) as [RequestInfo | URL, RequestInit] | undefined;
  return JSON.parse(String(call![1].body)) as Record<string, unknown>;
}

describe("ProviderPicker rendering", () => {
  test("renders one tile per selectable provider once the catalog loads", async () => {
    render(<ProviderPicker onSaved={mock(() => {})} />);
    // All eight catalog tiles render their brand label.
    for (const label of ["Codex", "OpenAI", "Anthropic", "Amazon Bedrock", "OpenRouter", "DeepSeek", "Azure OpenAI", "Local"]) {
      expect(await screen.findByText(label, { exact: true })).not.toBeNull();
    }
  });

  test("shows the loading hint before the catalog arrives", () => {
    catalogResponse = () => new Promise<Response>(() => {});
    render(<ProviderPicker onSaved={mock(() => {})} />);
    expect(screen.getByText("Loading providers…")).not.toBeNull();
  });

  test("surfaces a terminal error (not a stuck spinner) when the catalog fetch fails", async () => {
    catalogResponse = async () => new Response(JSON.stringify({ error: "down" }), { status: 503 });
    render(<ProviderPicker onSaved={mock(() => {})} />);
    expect(await screen.findByText(/Couldn't load providers/)).not.toBeNull();
    expect(screen.queryByText("Loading providers…")).toBeNull();
    // No config form renders without a selectable provider.
    expect(screen.queryByText(/^Configure /)).toBeNull();
  });

  test("seeds the first tile (codex) by default and shows its instructions", async () => {
    render(<ProviderPicker onSaved={mock(() => {})} />);
    // "codex login" appears in both a <pre> and an inline <code>; assert the
    // submit affordance, which is unique to the codex branch.
    expect(await screen.findByRole("button", { name: "Verify Codex auth" })).not.toBeNull();
    expect(screen.getAllByText("codex login").length).toBeGreaterThan(0);
  });

  test("preselect seeds a specific tile and its setup-guide link", async () => {
    render(<ProviderPicker preselect="openai" onSaved={mock(() => {})} />);
    const guide = await screen.findByText("Read the OpenAI setup guide");
    // A non-/docs/ URL degrades to a plain external link carrying the href.
    expect(guide.closest("a")?.getAttribute("href")).toBe("https://gini.example/providers/openai");
    expect(screen.getByLabelText("API key")).not.toBeNull();
  });
});

describe("ProviderPicker submit", () => {
  test("codex verifies with the minimal payload and reports the summary to onSaved", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await user.click(await screen.findByRole("button", { name: "Verify Codex auth" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ provider: "codex", model: "gpt-5.5", isCodex: true }));
    expect(lastSetProviderBody()).toEqual({ provider: "codex" });
  });

  test("an env-keyed provider posts key + model and uses the custom submit label", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker submitLabel="Save and continue" onSaved={onSaved} />);
    await selectTile(user, "OpenAI");
    await user.type(screen.getByLabelText("API key"), "sk-test");
    const submit = screen.getByRole("button", { name: "Save and continue" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ provider: "openai", model: "gpt-5.4-mini", isCodex: false })
    );
    expect(lastSetProviderBody()).toEqual({ provider: "openai", apiKey: "sk-test", model: "gpt-5.4-mini" });
  });

  test("bedrock posts both AWS keys after they are entered", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "Amazon Bedrock");
    await user.type(screen.getByLabelText("AWS Access Key ID"), "AKIA123");
    await user.type(screen.getByLabelText("AWS Secret Access Key"), "secret123");
    const submit = screen.getByRole("button", { name: "Save provider" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastSetProviderBody()).toEqual({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-8",
      awsAccessKeyId: "AKIA123",
      awsSecretAccessKey: "secret123"
    });
  });

  test("azure requires the resource endpoint, then posts the full routing trio", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "Azure OpenAI");
    await user.type(screen.getByLabelText("API key"), "azkey");
    const submit = screen.getByRole("button", { name: "Save provider" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Resource endpoint"), "https://r.openai.azure.com");
    await user.type(screen.getByLabelText("API version"), "2024-10-21");
    await user.type(screen.getByLabelText("Deployment"), "my-dep");
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastSetProviderBody()).toEqual({
      provider: "azure",
      apiKey: "azkey",
      model: "gpt-5.5",
      baseUrl: "https://r.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "my-dep",
      authScheme: "api-key"
    });
  });

  test("anthropic accepts an optional base URL and posts it", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "Anthropic");
    await user.type(screen.getByLabelText("API key"), "ant-key");
    await user.type(screen.getByPlaceholderText("https://api.anthropic.com"), "https://proxy.example");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastSetProviderBody()).toEqual({
      provider: "anthropic",
      apiKey: "ant-key",
      model: "claude-opus-4-8",
      baseUrl: "https://proxy.example"
    });
  });

  test("a generic OpenAI-compatible provider posts an overridden base URL", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "OpenRouter");
    await user.type(screen.getByLabelText("API key"), "or-key");
    await user.type(screen.getByPlaceholderText("Override the default endpoint"), "https://or.example/v1");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastSetProviderBody()).toEqual({
      provider: "openrouter",
      apiKey: "or-key",
      model: "openrouter/auto",
      baseUrl: "https://or.example/v1"
    });
  });

  test("while a non-codex save is pending the button shows the custom pending label", async () => {
    setProvider = () => new Promise<Response>(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker submitLabel="Save and continue" pendingLabel="Saving…" onSaved={mock(() => {})} />);
    await selectTile(user, "Local");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).not.toBeNull();
  });

  test("while a codex verify is pending the button shows Verifying…", async () => {
    setProvider = () => new Promise<Response>(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} />);
    await user.click(await screen.findByRole("button", { name: "Verify Codex auth" }));
    expect(await screen.findByRole("button", { name: "Verifying…" })).not.toBeNull();
  });

  test("the tiles lock while a save is pending, so the summary can't drift to a switched provider", async () => {
    const onSaved = mock(() => {});
    // Resolve the POST only once the test releases it, so the save stays
    // pending while we attempt to switch tiles.
    let release!: (r: Response) => void;
    setProvider = () => new Promise<Response>((resolve) => { release = resolve; });
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "OpenAI");
    await user.type(screen.getByLabelText("API key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    // The Local tile is now disabled — clicking it must NOT change the selection.
    const localTile = (await screen.findByText("Local", { exact: true })).closest("button") as HTMLButtonElement;
    expect(localTile.disabled).toBe(true);
    await user.click(localTile);
    release(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    // The summary reports the SUBMITTED provider (openai), never the click target.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ provider: "openai", model: "gpt-5.4-mini", isCodex: false })
    );
  });

  test("local needs no API key field and submits on model alone", async () => {
    const onSaved = mock(() => {});
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={onSaved} />);
    await selectTile(user, "Local");
    expect(screen.queryByLabelText("API key")).toBeNull();
    const submit = screen.getByRole("button", { name: "Save provider" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    await user.click(submit);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ provider: "local", model: "local/default", isCodex: false }));
  });
});

describe("ProviderPicker failure handling", () => {
  test("a structured { ok: false } result routes to onError when provided", async () => {
    const onError = mock(() => {});
    setProvider = async () => jsonResponse({ ok: false, error: "Codex credentials not found." });
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} onError={onError} />);
    await user.click(await screen.findByRole("button", { name: "Verify Codex auth" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Codex credentials not found."));
  });

  test("without onError, a failed save renders the message inline", async () => {
    setProvider = async () => jsonResponse({ ok: false, error: "key rejected" });
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} />);
    await selectTile(user, "OpenAI");
    await user.type(screen.getByLabelText("API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(await screen.findByText("key rejected")).not.toBeNull();
  });

  test("an ok:false with no error message falls back to the generic inline text", async () => {
    setProvider = async () => jsonResponse({ ok: false });
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} />);
    await selectTile(user, "Local");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(await screen.findByText("Failed to save provider.")).not.toBeNull();
  });

  test("a thrown (non-2xx) request surfaces the gateway error inline", async () => {
    setProvider = async () => jsonResponse({ error: "gateway exploded" }, 500);
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} />);
    await selectTile(user, "Local");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    expect(await screen.findByText("gateway exploded")).not.toBeNull();
  });

  test("switching tiles after an inline error clears it", async () => {
    setProvider = async () => jsonResponse({ ok: false, error: "key rejected" });
    const user = userEvent.setup();
    render(<ProviderPicker onSaved={mock(() => {})} />);
    await selectTile(user, "OpenAI");
    await user.type(screen.getByLabelText("API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    await screen.findByText("key rejected");
    await selectTile(user, "Local");
    expect(screen.queryByText("key rejected")).toBeNull();
  });
});

describe("ProviderPicker chrome", () => {
  test("renders a provided secondary action node next to submit", async () => {
    render(<ProviderPicker onSaved={mock(() => {})} secondaryAction={<button type="button">Cancel</button>} />);
    // Wait for the catalog to settle and seed the first tile before asserting,
    // so the test doesn't finish (and emit act warnings) mid-fetch. The codex
    // verify button only renders once seeding has run.
    await screen.findByRole("button", { name: "Verify Codex auth" });
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
  });
});
