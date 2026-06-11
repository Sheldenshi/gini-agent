/// <reference lib="dom" />

// ProviderCard rows: the persistent needs-reauth state (issue #233) and the
// credential-management affordances around it. A catalog row carrying
// authStatus "needs_reauth" swaps the green "Connected" for the amber
// "Needs re-authentication", shows the redacted failure detail, and routes
// the CTA by reauthKind the same way the chat re-auth note does: "docs"
// wraps the CTA in the DocReference slide-over trigger, "settings" opens the
// row's own key-edit dialog, "aws" renders credentials guidance with no key
// form. A payload missing the routing fields falls back to the settings CTA
// so it never renders broken. Around that: codex hides Edit/Remove in every
// auth state, rows render in the fixed display order, the trash is gated off
// the instance/default-model provider, and the remove confirmation drives
// the /setup/provider/remove mutation through its success and error paths.
//
// LEAK SAFETY: mock.module is process-wide in `bun test`, so the overrides
// are scoped deliberately. DocReference is fully replaced WITHOUT importing
// the real src file — importing it would register DocReference (and its
// MarkdownContent subtree) for the 100% coverage gate without covering it;
// no other test imports it, so no revert is needed. sonner spreads the
// captured real namespace with only `toast` replaced and is reverted in
// afterAll. fetch is stubbed per test and restored in afterEach. The real
// EditProviderDialog is mounted (its import graph is coverage-exempt), so
// the settings CTA assertion exercises the actual key-edit dialog.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderCatalogItem } from "@/lib/providers";

const realSonner = await import("sonner");

const toastSuccess = mock(() => {});
const toastError = mock(() => {});

let ProviderCard: typeof import("./ProviderCard").ProviderCard;

beforeAll(async () => {
  // The stub keeps the docs CTA observable — the wrapped trigger and the url
  // it would open — without mounting the slide-over machinery.
  mock.module("@/components/DocReference", () => ({
    DocReference: ({ url, children }: { url: string; children: React.ReactNode }) => (
      <div data-testid="doc-reference" data-url={url}>
        {children}
      </div>
    )
  }));
  mock.module("sonner", () => ({ ...realSonner, toast: { success: toastSuccess, error: toastError } }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const cardPath = "./ProviderCard?provider-card-test";
  ({ ProviderCard } = (await import(cardPath)) as typeof import("./ProviderCard"));
});

afterAll(() => {
  mock.module("sonner", () => realSonner);
});

const DISPLAY: Record<string, string> = {
  codex: "Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  azure: "Azure OpenAI",
  local: "Local OpenAI-Compatible"
};

function row(name: string, over: Partial<ProviderCatalogItem> = {}): ProviderCatalogItem {
  return {
    id: `prov_${name}`,
    name,
    displayName: DISPLAY[name] ?? name,
    auth: name === "codex" ? "codex-oauth" : name === "bedrock" ? "aws" : "env",
    models: [`${name}-model-a`, `${name}-model-b`],
    configured: true,
    ...over
  };
}

const REAUTH_DETAIL = "401 Unauthorized: OAuth token expired";
const REAUTH_AT = "2026-06-01T00:00:00.000Z";

const realFetch = globalThis.fetch;
let removeResponse: () => Promise<Response>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  removeResponse = async () => jsonResponse({ ok: true });
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup/provider/remove")) return removeResponse();
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type CardProps = Parameters<typeof ProviderCard>[0];

function renderCard(catalog: ProviderCatalogItem[], props: Omit<Partial<CardProps>, "catalog"> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <ProviderCard catalog={catalog} {...props} />
    </QueryClientProvider>
  );
}

// The display-name span is the only element whose exact text is the brand
// label, so it anchors the row's <li>.
function rowItem(label: string): HTMLElement {
  return screen.getByText(label).closest("li") as HTMLElement;
}

describe("ProviderCard needs-reauth state", () => {
  test("docs kind: amber status, redacted detail, and a DocReference-wrapped CTA; codex still hides Edit/Remove", () => {
    renderCard([
      row("codex", {
        authStatus: "needs_reauth",
        reauth: {
          detail: REAUTH_DETAIL,
          at: REAUTH_AT,
          reauthKind: "docs",
          reauthUrl: "https://docs.gini.example/docs/providers#codex-re-auth"
        }
      }),
      row("openai", { authStatus: "ok" })
    ]);

    const codex = rowItem("Codex");
    expect(within(codex).getByText("Needs re-authentication")).not.toBeNull();
    expect(within(codex).queryByText("Connected")).toBeNull();
    expect(codex.className).toContain("border-amber-500/30");
    expect(within(codex).getByText(REAUTH_DETAIL)).not.toBeNull();

    const docRef = within(codex).getByTestId("doc-reference");
    expect(docRef.getAttribute("data-url")).toBe("https://docs.gini.example/docs/providers#codex-re-auth");
    expect(within(docRef).getByRole("button", { name: "How to re-authenticate Codex" })).not.toBeNull();

    // Codex's only affordance is the docs CTA — no Edit pencil, no trash.
    expect(within(codex).queryByRole("button", { name: "Edit Codex" })).toBeNull();
    expect(within(codex).queryByRole("button", { name: "Remove Codex" })).toBeNull();

    // The healthy sibling keeps its green Connected and gets no reauth UI.
    const openai = rowItem("OpenAI");
    expect(within(openai).getByText("Connected")).not.toBeNull();
    expect(within(openai).queryByText("Needs re-authentication")).toBeNull();
    expect(openai.className).toContain("border-border");
  });

  test("settings kind: the CTA opens the row's key-edit dialog; closing it clears the editing row", async () => {
    renderCard([
      row("openai", {
        authStatus: "needs_reauth",
        reauth: { detail: REAUTH_DETAIL, at: REAUTH_AT, reauthKind: "settings", reauthUrl: "/settings" }
      })
    ]);

    expect(screen.getByText("Needs re-authentication")).not.toBeNull();
    expect(screen.queryByTestId("doc-reference")).toBeNull();
    expect(screen.queryByText("Edit provider")).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Update OpenAI key" }));
    expect(await screen.findByText("Edit provider")).not.toBeNull();
    expect(screen.getByText("OpenAI · API key")).not.toBeNull();
    expect(screen.getByLabelText("API key")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Edit provider")).toBeNull());
  });

  test("aws kind: credentials guidance instead of a key CTA, and no key form opens", () => {
    renderCard([
      row("bedrock", {
        authStatus: "needs_reauth",
        reauth: { detail: "credential chain exhausted", at: REAUTH_AT, reauthKind: "aws", reauthUrl: "/settings" }
      })
    ]);

    expect(screen.getByText("Needs re-authentication")).not.toBeNull();
    expect(screen.getByText("credential chain exhausted")).not.toBeNull();
    expect(screen.getByText(/Check your AWS credentials/)).not.toBeNull();
    expect(screen.queryByTestId("doc-reference")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update Amazon Bedrock key" })).toBeNull();
    expect(screen.queryByText("Edit provider")).toBeNull();
    // Bedrock keeps its Edit pencil but is never removable from this UI.
    expect(screen.getByRole("button", { name: "Edit Amazon Bedrock" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Amazon Bedrock" })).toBeNull();
  });

  test("a payload missing the routing fields falls back to the settings CTA with no detail line", () => {
    renderCard([row("deepseek", { authStatus: "needs_reauth" })]);

    expect(screen.getByText("Needs re-authentication")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Update DeepSeek key" })).not.toBeNull();
    expect(screen.queryByText(REAUTH_DETAIL)).toBeNull();
    expect(screen.queryByTestId("doc-reference")).toBeNull();
  });

  test("authStatus ok or absent renders the green Connected with none of the reauth UI", () => {
    renderCard([row("codex", { authStatus: "ok" }), row("openai")]);

    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.queryByText("Needs re-authentication")).toBeNull();
    expect(screen.queryByTestId("doc-reference")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update OpenAI key" })).toBeNull();
    expect(screen.queryByText(/Check your AWS credentials/)).toBeNull();
    expect(rowItem("Codex").className).toContain("border-border");

    // Codex hides Edit/Remove while connected too; the openai row keeps both.
    expect(screen.queryByRole("button", { name: "Edit Codex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Codex" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit OpenAI" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove OpenAI" })).not.toBeNull();
  });
});

describe("ProviderCard rows", () => {
  test("renders configured catalog rows in the fixed display order; unconfigured and unknown names drop", () => {
    renderCard([
      row("openrouter"),
      row("openai"),
      row("echo"),
      row("anthropic", { configured: false }),
      row("deepseek", { configured: undefined })
    ]);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("OpenAI");
    expect(items[1]!.textContent).toContain("OpenRouter");
  });

  test("an empty catalog renders the no-providers panel", () => {
    renderCard([]);
    expect(screen.getByText("No providers connected yet")).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  test("the instance row shows the active model; other rows show their first catalog model", () => {
    renderCard([row("openai"), row("anthropic")], {
      activeProviderName: "openai",
      activeProviderModel: "gpt-5.5-pro"
    });
    expect(within(rowItem("OpenAI")).getByText("gpt-5.5-pro")).not.toBeNull();
    expect(within(rowItem("Anthropic")).getByText("anthropic-model-a")).not.toBeNull();
  });

  test("an instance row without an active model falls back to its first catalog model", () => {
    renderCard([row("openai")], { activeProviderName: "openai" });
    expect(within(rowItem("OpenAI")).getByText("openai-model-a")).not.toBeNull();
  });

  test("the Edit pencil opens the key-edit dialog for that row", async () => {
    renderCard([row("openai")], {
      activeProviderName: "openai",
      activeProviderModel: "gpt-5.5-pro",
      activeProvider: { name: "openai", model: "gpt-5.5-pro", baseUrl: "https://example.test/v1" }
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit OpenAI" }));
    expect(await screen.findByText("Edit provider")).not.toBeNull();
    expect(screen.getByText("OpenAI · API key")).not.toBeNull();
  });

  test("the trash is disabled for the instance provider and the default model's provider", () => {
    renderCard([row("openai"), row("anthropic"), row("deepseek")], {
      activeProviderName: "openai",
      defaultModelProviderName: "anthropic"
    });

    const gate = "Switch the default model off this provider before removing it.";
    const openaiRemove = screen.getByRole("button", { name: "Remove OpenAI" }) as HTMLButtonElement;
    expect(openaiRemove.disabled).toBe(true);
    expect(openaiRemove.getAttribute("title")).toBe(gate);

    const anthropicRemove = screen.getByRole("button", { name: "Remove Anthropic" }) as HTMLButtonElement;
    expect(anthropicRemove.disabled).toBe(true);
    expect(anthropicRemove.getAttribute("title")).toBe(gate);

    const deepseekRemove = screen.getByRole("button", { name: "Remove DeepSeek" }) as HTMLButtonElement;
    expect(deepseekRemove.disabled).toBe(false);
    expect(deepseekRemove.getAttribute("title")).toBeNull();
  });
});

describe("ProviderCard removal", () => {
  test("confirming POSTs /setup/provider/remove and the success path closes the dialog", async () => {
    renderCard([row("openai"), row("anthropic")], { activeProviderName: "anthropic" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    expect(await screen.findByText("Remove OpenAI?")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("openai disconnected."));
    await waitFor(() => expect(screen.queryByText("Remove OpenAI?")).toBeNull());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const removeCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/setup/provider/remove")) as
      | [RequestInfo | URL, RequestInit]
      | undefined;
    expect(removeCall).not.toBeUndefined();
    expect(String(removeCall![0])).toBe("/api/runtime/setup/provider/remove");
    expect(removeCall![1].method).toBe("POST");
    expect(JSON.parse(String(removeCall![1].body))).toEqual({ provider: "openai" });
    expect(toastError).not.toHaveBeenCalled();
  });

  test("a structured { ok: false } result keeps the dialog open and surfaces the error toast", async () => {
    removeResponse = async () => jsonResponse({ ok: false, error: "remove failed" });
    renderCard([row("openai")]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    await screen.findByText("Remove OpenAI?");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("remove failed"));
    expect(screen.getByText("Remove OpenAI?")).not.toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test("a non-2xx response surfaces the gateway error through onError and keeps the dialog open", async () => {
    removeResponse = async () => jsonResponse({ error: "gateway exploded" }, 500);
    renderCard([row("openai")]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    await screen.findByText("Remove OpenAI?");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("gateway exploded"));
    expect(screen.getByText("Remove OpenAI?")).not.toBeNull();
  });

  test("the confirmation dismisses via Cancel and via the dialog's own close request", async () => {
    renderCard([row("openai")]);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    await screen.findByText("Remove OpenAI?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Remove OpenAI?")).toBeNull());

    // Reopen and dismiss through the Dialog's onOpenChange (Escape).
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    await screen.findByText("Remove OpenAI?");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Remove OpenAI?")).toBeNull());
  });

  test("while the remove is pending the dialog locks: Removing… label, disabled buttons, Escape held", async () => {
    // A never-settling response pins the isPending state.
    removeResponse = () => new Promise<Response>(() => {});
    renderCard([row("openai")]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    await screen.findByText("Remove OpenAI?");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Removing…")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Removing…" }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.getByText("Remove OpenAI?")).not.toBeNull();
  });
});
