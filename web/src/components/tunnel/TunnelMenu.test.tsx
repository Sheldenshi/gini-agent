/// <reference lib="dom" />

// TunnelMenu owns the open/edit view-derivation: it picks the connected popover
// vs the selection panel and resets the `editing` override on close. useTunnel is
// mocked so these tests drive view state directly without the network; the child
// panels render for real so the wiring (Edit/Disconnect/Connect/Close) is exercised.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TunnelProvider, TunnelState } from "./types";
import type { TunnelController } from "./useTunnel";

// The connected popover embeds the real PairRequestsPanel (useQuery), so renders
// need a QueryClient; stub fetch so its list query resolves empty with no real
// network. (This file previously passed only because a sibling test leaked a
// PairRequestsPanel stub — wrapping renders here removes that order-dependence.)
const realFetch = globalThis.fetch;
function render(ui: Parameters<typeof rtlRender>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const PROVIDERS: TunnelProvider[] = [
  { id: "gini-relay", name: "Gini Relay", enabled: true },
  { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
  { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
  { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "cloudflared CLI" }
];

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return { providers: PROVIDERS, selectedProvider: "gini-relay", status: "idle", ...over };
}

const actions = {
  connect: mock(async (): Promise<{ ok: true } | { ok: false; message: string; code?: string }> => ({ ok: true })),
  cancel: mock(() => {}),
  disconnect: mock(() => {}),
  refresh: mock(() => {})
};

let controller: TunnelController;

// mock.module is process-wide, so capture the real module up front and restore it
// in afterAll — otherwise this stub leaks into sibling files that render the real
// useTunnel (e.g. PairDeviceDialog.test). The suite also runs with --isolate as
// the structural backstop, but a self-contained restore keeps this file honest.
const realUseTunnel = await import("./useTunnel");
mock.module("./useTunnel", () => ({ useTunnel: (): TunnelController => controller }));

const { TunnelMenu } = await import("./TunnelMenu");

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  actions.connect.mockImplementation(async () => ({ ok: true }));
  controller = { state: makeState(), loading: false, error: null, ...actions };
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ requests: [] }), { headers: { "content-type": "application/json" } })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.module("./useTunnel", () => realUseTunnel);
});

const open = (user: ReturnType<typeof userEvent.setup>, name: "Open tunnel" | "Tunnel connected") =>
  user.click(screen.getByRole("button", { name }));

describe("TunnelMenu", () => {
  test("idle: the trigger opens the selection panel and refreshes on open", async () => {
    const user = userEvent.setup();
    render(<TunnelMenu />);
    expect(screen.queryByText("Tunnel provider")).toBeNull();
    await open(user, "Open tunnel");
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    expect(actions.refresh).toHaveBeenCalledTimes(1);
  });

  test("connected: the trigger opens the connected popover", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal QR" })).not.toBeNull();
  });

  test("the trigger pill names the CONNECTED provider (any provider, not just the relay)", () => {
    controller.state = makeState({ status: "connected", url: "https://m.ts.example", selectedProvider: "tailscale" });
    render(<TunnelMenu />);
    expect(screen.queryByText("Live")).not.toBeNull();
    expect(screen.queryByText("tailscale")).not.toBeNull();
  });

  test("the trigger pill falls back to 'tunnel' when connected with no recorded selection, and 'no tunnel' when idle", () => {
    controller.state = makeState({ status: "connected", url: "https://x.example", selectedProvider: null });
    const first = render(<TunnelMenu />);
    expect(screen.queryByText("tunnel")).not.toBeNull();
    first.unmount();
    controller.state = makeState({ status: "idle" });
    render(<TunnelMenu />);
    expect(screen.queryByText("Off")).not.toBeNull();
    expect(screen.queryByText("no tunnel")).not.toBeNull();
  });

  test("connected: Edit shows the selection panel with a Disconnect button, without disconnecting", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    await user.click(screen.getByRole("button", { name: "Edit selection" }));
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    // The selected provider's row shows Disconnect (not Connect) while connected.
    expect(screen.queryByRole("button", { name: "Disconnect Gini Relay" })).not.toBeNull();
    expect(actions.disconnect).not.toHaveBeenCalled();
  });

  test("connected: clicking Disconnect in the edit panel tears the tunnel down", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    await user.click(screen.getByRole("button", { name: "Edit selection" }));
    await user.click(screen.getByRole("button", { name: "Disconnect Gini Relay" }));
    expect(actions.disconnect).toHaveBeenCalledTimes(1);
  });

  test("connected: Close from the edit panel returns to the connected view (does not close the popover)", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    await user.click(screen.getByRole("button", { name: "Edit selection" }));
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    // The panel's header Close (X) is the only dismiss control now (no Save/Cancel
    // footer). When reached via Edit, it returns to the connected (QR) view rather
    // than closing the whole popover.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Choose how Gini is exposed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal QR" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Edit selection" })).not.toBeNull();
  });

  test("closing the edit panel via Escape resets editing; reopening shows the connected view", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    await user.click(screen.getByRole("button", { name: "Edit selection" }));
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Choose how Gini is exposed")).toBeNull();
    await open(user, "Tunnel connected");
    expect(screen.queryByRole("button", { name: "Reveal QR" })).not.toBeNull();
    expect(screen.queryByText("Choose how Gini is exposed")).toBeNull();
  });

  test("connected: Disconnect routes to the controller action", async () => {
    const user = userEvent.setup();
    controller.state = makeState({ status: "connected", url: "https://g31.example" });
    render(<TunnelMenu />);
    await open(user, "Tunnel connected");
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(actions.disconnect).toHaveBeenCalledTimes(1);
  });

  test("idle: clicking a provider's Connect routes to the controller (connect IS the selection)", async () => {
    const user = userEvent.setup();
    render(<TunnelMenu />);
    await open(user, "Open tunnel");
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(actions.connect).toHaveBeenCalledWith("gini-relay");
  });

  test("the selection panel's Close button dismisses the popover", async () => {
    const user = userEvent.setup();
    render(<TunnelMenu />);
    await open(user, "Open tunnel");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Tunnel provider")).toBeNull();
  });

  test("a hook request error is surfaced in the popover", async () => {
    const user = userEvent.setup();
    controller.error = "Tunnel connect failed";
    render(<TunnelMenu />);
    expect(screen.queryByRole("alert")).toBeNull();
    await open(user, "Open tunnel");
    const alert = screen.queryByRole("alert");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Tunnel connect failed");
  });

  test("Connect on an unavailable provider opens THAT provider's setup guide sheet", async () => {
    const user = userEvent.setup();
    // The doc fetch must resolve a DocSection; everything else (pair-request
    // polling) keeps the empty default.
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/docs/")) {
        return new Response(
          JSON.stringify({ path: "remote-access/tailscale", title: "Tailscale", markdown: "Install **Tailscale** and join your tailnet." }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ requests: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    actions.connect.mockImplementation(async () => ({
      ok: false,
      message: "Tunnel provider Tailscale is not available (requires Tailscale network).",
      code: "provider_unavailable"
    }));
    render(<TunnelMenu />);
    await open(user, "Open tunnel");
    // The unavailable row's Connect is LIVE — tapping it attempts the connect
    // (fresh server-side prerequisite check) and the rejection opens the guide.
    await user.click(screen.getByRole("button", { name: "Connect Tailscale" }));
    expect(actions.connect).toHaveBeenCalledWith("tailscale");
    // The guide sheet carries the dynamic availability lead + the doc body.
    await screen.findByText(/isn't ready on this machine yet/);
    expect(screen.queryByText(/requires Tailscale network/)).not.toBeNull();
    await screen.findByText(/join your tailnet/);
    // Provider-scoped: the guide fetched is tailscale's page.
    const fetched = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.endsWith("/docs/remote-access/tailscale"))).toBe(true);
    // Dismissing the guide clears it; the popover (with the panel) remains.
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/isn't ready on this machine yet/)).toBeNull();
  });

  test("Connect failing for any OTHER reason shows the banner without opening a guide", async () => {
    const user = userEvent.setup();
    actions.connect.mockImplementation(async () => ({ ok: false, message: "relay handshake failed" }));
    render(<TunnelMenu />);
    await open(user, "Open tunnel");
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(actions.connect).toHaveBeenCalledWith("gini-relay");
    expect(screen.queryByText(/isn't ready on this machine yet/)).toBeNull();
  });
});
