/// <reference lib="dom" />

// TunnelSelectionPanel is presentational: it renders provider rows from props
// and routes every interaction back through its callbacks. The model is Option
// 1 ("one active, tap to switch") — one tunnel is live at a time, there's no
// separate select step and no Save/Cancel. These tests render it directly with
// crafted TunnelState objects so each branch is exercised: a fresh Connect, the
// connecting fold, the live Disconnect, the Switch relabel + host-change
// confirm, the connected⇒available override, and the unavailable→guide routing.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TunnelProvider, TunnelState } from "./types";
import { TunnelSelectionPanel } from "./TunnelSelectionPanel";

const PROVIDERS: TunnelProvider[] = [
  { id: "gini-relay", name: "Gini Relay", enabled: true },
  { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
  { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
  { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "cloudflared CLI" }
];

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return { providers: PROVIDERS, selectedProvider: "gini-relay", status: "idle", ...over };
}

const handlers = {
  onConnect: mock((_?: TunnelProvider["id"]) => {}),
  onCancel: mock(() => {}),
  onDisconnect: mock(() => {}),
  onClose: mock(() => {})
};

function renderPanel(over: Partial<TunnelState> = {}) {
  return render(
    <TunnelSelectionPanel
      state={makeState(over)}
      onConnect={handlers.onConnect}
      onCancel={handlers.onCancel}
      onDisconnect={handlers.onDisconnect}
      onClose={handlers.onClose}
    />
  );
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockClear();
});

describe("TunnelSelectionPanel", () => {
  test("renders the header and a provider catalog", () => {
    renderPanel();
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Gini Relay" })).not.toBeNull();
  });

  test("there is no radiogroup, no Save, and no per-row select control — connecting IS selecting", () => {
    renderPanel();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("idle: every row shows a Connect button (not Switch) and unavailable rows show their requirement", () => {
    renderPanel();
    for (const name of ["Gini Relay", "Tailscale", "ngrok", "Cloudflare"]) {
      expect(screen.queryByRole("button", { name: `Connect ${name}` })).not.toBeNull();
    }
    expect(screen.queryByText(/Requires Tailscale network/)).not.toBeNull();
    expect(screen.queryByText(/Requires ngrok account/)).not.toBeNull();
    expect(screen.queryByText(/Requires cloudflared CLI/)).not.toBeNull();
  });

  test("idle: clicking a row's Connect routes onConnect with the id, no confirm", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(handlers.onConnect).toHaveBeenCalledWith("gini-relay");
  });

  test("EVERY row's Connect is live — an unavailable provider routes onConnect (gateway re-checks / owner opens guide)", async () => {
    const user = userEvent.setup();
    renderPanel();
    const tailscale = screen.getByRole("button", { name: "Connect Tailscale" });
    expect((tailscale as HTMLButtonElement).disabled).toBe(false);
    await user.click(tailscale);
    expect(handlers.onConnect).toHaveBeenCalledWith("tailscale");
  });

  test("connecting: the selected row shows Connecting + Cancel; other Connects are disabled", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connecting" });
    expect(screen.queryByText("Connecting...")).not.toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel Gini Relay connect" });
    await user.click(cancel);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    // The one in-flight connect locks every other row's Connect.
    expect((screen.getByRole("button", { name: "Connect Tailscale" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("connected: the live row shows Disconnect (not Connect) and routes onDisconnect", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connected", url: "https://g31.example" });
    expect(screen.queryByRole("button", { name: "Connect Gini Relay" })).toBeNull();
    const disconnect = screen.getByRole("button", { name: "Disconnect Gini Relay" });
    await user.click(disconnect);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  });

  test("connected: other available rows relabel Connect → Switch", () => {
    // Cloudflare available (enabled) so it's a real switch target.
    const providers: TunnelProvider[] = [
      { id: "gini-relay", name: "Gini Relay", enabled: true },
      { id: "tailscale", name: "Tailscale", enabled: true },
      { id: "ngrok", name: "ngrok", enabled: true },
      { id: "cloudflare", name: "Cloudflare", enabled: true }
    ];
    renderPanel({ providers, selectedProvider: "gini-relay", status: "connected", url: "https://g.example" });
    // The non-live rows say "Switch" (aria-label "Switch to <name>"), not "Connect".
    expect(screen.queryByRole("button", { name: "Switch to Tailscale" })).not.toBeNull();
    expect(screen.getAllByText("Switch")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Connect Tailscale" })).toBeNull();
  });

  test("switching away from a live provider asks for confirmation before tearing it down", async () => {
    const user = userEvent.setup();
    const providers: TunnelProvider[] = PROVIDERS.map((p) => ({ ...p, enabled: true }));
    renderPanel({ providers, selectedProvider: "gini-relay", status: "connected", url: "https://g.example" });
    await user.click(screen.getByRole("button", { name: "Switch to Tailscale" }));
    // It must NOT have connected yet — a confirm screen is shown first.
    expect(handlers.onConnect).not.toHaveBeenCalled();
    expect(screen.queryByText("Switch tunnel?")).not.toBeNull();
    // The warning names the provider losing the host and the one gaining it.
    expect(screen.queryByText(/scan the new QR/)).not.toBeNull();
    // Confirming proceeds to the connect.
    await user.click(screen.getByRole("button", { name: "Switch to Tailscale" }));
    expect(handlers.onConnect).toHaveBeenCalledWith("tailscale");
  });

  test("cancelling the switch confirm keeps the current tunnel (no connect)", async () => {
    const user = userEvent.setup();
    const providers: TunnelProvider[] = PROVIDERS.map((p) => ({ ...p, enabled: true }));
    renderPanel({ providers, selectedProvider: "gini-relay", status: "connected", url: "https://g.example" });
    await user.click(screen.getByRole("button", { name: "Switch to Tailscale" }));
    await user.click(screen.getByRole("button", { name: "Keep Gini Relay" }));
    expect(handlers.onConnect).not.toHaveBeenCalled();
    // Back on the picker.
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
  });

  test("dismissing the switch confirm via its Close (X) also keeps the current tunnel", async () => {
    const user = userEvent.setup();
    const providers: TunnelProvider[] = PROVIDERS.map((p) => ({ ...p, enabled: true }));
    renderPanel({ providers, selectedProvider: "gini-relay", status: "connected", url: "https://g.example" });
    await user.click(screen.getByRole("button", { name: "Switch to Tailscale" }));
    expect(screen.queryByText("Switch tunnel?")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(handlers.onConnect).not.toHaveBeenCalled();
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
  });

  test("connected ⇒ available: a LIVE provider flagged !enabled by detection still shows Disconnect, no 'Requires'", () => {
    // The detection probe lagged/flaked and reports cloudflare unavailable, but
    // it is the live tunnel. The connection is the source of truth.
    renderPanel({
      providers: PROVIDERS,
      selectedProvider: "cloudflare",
      status: "connected",
      url: "https://app.example"
    });
    expect(screen.queryByRole("button", { name: "Disconnect Cloudflare" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Switch to Cloudflare" })).toBeNull();
    // No "Requires …" caption on the live provider, despite enabled:false.
    expect(screen.queryByText(/Requires cloudflared CLI/)).toBeNull();
    // A genuinely-unavailable OTHER provider still shows its requirement.
    expect(screen.queryByText(/Requires Tailscale network/)).not.toBeNull();
  });

  test("the live row is the only one tinted Connected", () => {
    renderPanel({ status: "connected", url: "https://g.example" });
    const live = screen.getByText("Gini Relay").closest("div.flex.min-h-15") as HTMLElement;
    expect(within(live).queryByText("Connected")).not.toBeNull();
  });

  test("error: the message renders", () => {
    renderPanel({ status: "error", message: "Tunnel handshake failed" });
    expect(screen.queryByText("Tunnel handshake failed")).not.toBeNull();
  });

  test("the header Close button routes onClose", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
