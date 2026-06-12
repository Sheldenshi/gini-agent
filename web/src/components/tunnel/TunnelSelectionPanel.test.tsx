/// <reference lib="dom" />

// TunnelSelectionPanel is presentational: it renders provider rows from props
// and routes every interaction (select by click/keyboard, connect, cancel,
// close) straight back through its callbacks. These tests render it directly
// with crafted TunnelState objects so each render branch and handler is
// exercised — idle selection, the connecting fold, the disabled
// non-selected rows, the error message, and the header/footer controls.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import type { TunnelProvider, TunnelState } from "./types";
import { TunnelSelectionPanel } from "./TunnelSelectionPanel";

const PROVIDERS: TunnelProvider[] = [
  { id: "gini-relay", name: "Gini Relay", enabled: true },
  {
    id: "tailscale",
    name: "Tailscale",
    enabled: false,
    requires: "Tailscale network",
    setup: ["Install Tailscale", "tailscale up"]
  },
  { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account", setup: ["Install ngrok", "Add your authtoken"] },
  { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "Cloudflare account", setup: ["Install cloudflared"] }
];

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return { providers: PROVIDERS, selectedProvider: "gini-relay", status: "idle", ...over };
}

const handlers = {
  onSelect: mock((_: TunnelProvider["id"]) => {}),
  onConnect: mock((_?: TunnelProvider["id"]) => {}),
  onCancel: mock(() => {}),
  onDisconnect: mock(() => {}),
  onClose: mock(() => {})
};

function renderPanel(over: Partial<TunnelState> = {}) {
  return render(
    <TunnelSelectionPanel
      state={makeState(over)}
      onSelect={handlers.onSelect}
      onConnect={handlers.onConnect}
      onCancel={handlers.onCancel}
      onDisconnect={handlers.onDisconnect}
      onClose={handlers.onClose}
    />
  );
}

// Find a provider row by its accessible name (the row is role="radio").
function row(name: string): HTMLElement {
  return screen.getByRole("radio", { name: new RegExp(name) });
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockClear();
});

describe("TunnelSelectionPanel", () => {
  test("renders the header and an enabled, selectable provider row", () => {
    renderPanel();
    expect(screen.queryByText("Tunnel provider")).not.toBeNull();
    expect(screen.queryByText("Choose how Gini is exposed")).not.toBeNull();
    const enabled = row("Gini Relay");
    expect(enabled.getAttribute("aria-disabled")).toBeNull();
    expect(enabled.getAttribute("tabindex")).toBe("0");
    expect(enabled.getAttribute("aria-checked")).toBe("true");
  });

  test("the selected row is marked with a 'Selected' text label", () => {
    renderPanel();
    expect(within(row("Gini Relay")).queryByText("Selected")).not.toBeNull();
  });

  test("disabled rows show their requirement and are aria-disabled and untabbable", () => {
    renderPanel();
    expect(screen.queryByText("Requires Tailscale network")).not.toBeNull();
    expect(screen.queryByText("Requires ngrok account")).not.toBeNull();
    expect(screen.queryByText("Requires Cloudflare account")).not.toBeNull();
    const disabled = row("Tailscale");
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("tabindex")).toBe("-1");
  });

  test("non-selected rows render a disabled Connect button", () => {
    renderPanel();
    const tailscaleConnect = screen.getByRole("button", { name: "Connect Tailscale" });
    expect((tailscaleConnect as HTMLButtonElement).disabled).toBe(true);
  });

  test("clicking an enabled, non-selected row selects it", async () => {
    const user = userEvent.setup();
    // Select cloudflare-as-selected so gini-relay is enabled but NOT selected.
    render(
      <TunnelSelectionPanel
        state={makeState({ selectedProvider: null })}
        onSelect={handlers.onSelect}
        onConnect={handlers.onConnect}
        onCancel={handlers.onCancel}
        onDisconnect={handlers.onDisconnect}
        onClose={handlers.onClose}
      />
    );
    await user.click(row("Gini Relay"));
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("clicking a disabled row does not select it", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(row("Tailscale"));
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("pressing Enter on a focused enabled row selects it", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedProvider: null });
    row("Gini Relay").focus();
    await user.keyboard("{Enter}");
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("pressing Space on a focused enabled row selects it", async () => {
    const user = userEvent.setup();
    renderPanel({ selectedProvider: null });
    row("Gini Relay").focus();
    await user.keyboard(" ");
    expect(handlers.onSelect).toHaveBeenCalledWith("gini-relay");
  });

  test("a non-Enter/Space key on an enabled row does not select", () => {
    renderPanel({ selectedProvider: null });
    fireEvent.keyDown(row("Gini Relay"), { key: "ArrowDown" });
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("keydown on a disabled row returns early without selecting", () => {
    renderPanel();
    fireEvent.keyDown(row("Tailscale"), { key: "Enter" });
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("idle + selected: clicking the row's Connect routes onConnect with the id", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Connect Gini Relay" }));
    expect(handlers.onConnect).toHaveBeenCalledWith("gini-relay");
    // The action cluster sits beside the radio, not inside it — clicking
    // Connect must not also select.
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("connecting: the selected row shows Connecting and a Cancel button", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connecting" });
    expect(screen.queryByText("Connecting...")).not.toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel Gini Relay connect" });
    await user.click(cancel);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("connecting: non-selected rows and Save are disabled", () => {
    renderPanel({ status: "connecting" });
    const tailscale = row("Tailscale");
    expect(tailscale.getAttribute("aria-disabled")).toBe("true");
    expect(tailscale.getAttribute("tabindex")).toBe("-1");
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("connected: the selected row shows Disconnect (not Connect) and routes onDisconnect", async () => {
    const user = userEvent.setup();
    renderPanel({ status: "connected", url: "https://g31.example" });
    expect(screen.queryByRole("button", { name: "Connect Gini Relay" })).toBeNull();
    const disconnect = screen.getByRole("button", { name: "Disconnect Gini Relay" });
    await user.click(disconnect);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
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

  test("the footer Cancel button routes onClose", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("the footer Save button routes onClose when idle", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  test("the footer hint links to the Remote Access doc", () => {
    renderPanel();
    expect(screen.queryByText(/Unavailable providers show an/)).not.toBeNull();
    // The DocReference trigger renders as a link-styled button; clicking it is
    // covered by DocReference's own tests — here we pin that the panel wires it.
    expect(screen.queryByRole("button", { name: "Remote Access" })).not.toBeNull();
  });

  test("a disabled row's (i) opens that provider's details sheet (the trigger stays interactive)", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.queryByText("Set up Tailscale")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Tailscale setup instructions" });
    // The trigger sits in the row's action cluster, NEXT TO Connect, but must
    // NOT live inside the aria-disabled radio — AT and real pointer semantics
    // treat descendants of a disabled widget as inert.
    expect(toggle.closest('[aria-disabled="true"]')).toBeNull();
    expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(toggle);
    // A full slide-over sheet, scoped to this one provider.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Set up Tailscale")).not.toBeNull();
    expect(within(dialog).queryByText(/requires Tailscale network/)).not.toBeNull();
    expect(within(dialog).queryByText("Install Tailscale")).not.toBeNull();
    expect(within(dialog).queryByText("tailscale up")).not.toBeNull();
    expect(within(dialog).queryByText(/availability is re-checked/)).not.toBeNull();
    // Scoped: no other provider's steps leak into the sheet.
    expect(within(dialog).queryByText("Install ngrok")).toBeNull();
    // Opening details must not select the (disabled) row.
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  test("closing the sheet and opening another provider's swaps the details", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Tailscale setup instructions" }));
    expect(screen.queryByText("Set up Tailscale")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Set up Tailscale")).toBeNull();
    await user.click(screen.getByRole("button", { name: "ngrok setup instructions" }));
    expect(screen.queryByText("Set up ngrok")).not.toBeNull();
    expect(screen.queryByText("Set up Tailscale")).toBeNull();
  });

  test("an ENABLED provider's details sheet uses the 'how this works' heading and omits the re-check hint", async () => {
    const user = userEvent.setup();
    render(
      <TunnelSelectionPanel
        state={makeState({
          providers: [
            { id: "gini-relay", name: "Gini Relay", enabled: true },
            { id: "tailscale", name: "Tailscale", enabled: true, setup: ["Install Tailscale", "tailscale up"] },
            { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account", setup: ["Install ngrok"] },
            { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "Cloudflare account", setup: ["Install cloudflared"] }
          ]
        })}
        onSelect={handlers.onSelect}
        onConnect={handlers.onConnect}
        onCancel={handlers.onCancel}
        onDisconnect={handlers.onDisconnect}
        onClose={handlers.onClose}
      />
    );
    await user.click(screen.getByRole("button", { name: "Tailscale setup instructions" }));
    expect(screen.queryByText("Tailscale — how this works")).not.toBeNull();
    expect(screen.queryByText(/availability is re-checked/)).toBeNull();
  });

  test("a provider without setup steps renders no info toggle (gini-relay)", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Gini Relay setup instructions" })).toBeNull();
  });
});
