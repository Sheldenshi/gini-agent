/// <reference lib="dom" />

// PairDeviceDialog is a Radix dialog whose body (useTunnel + the QR-or-hint
// branch + PairRequestsPanel) mounts ONLY while open. We drive the tunnel url
// through the REAL useTunnel by stubbing global fetch (the hook GETs
// /api/runtime/tunnel on mount), and stub ONLY PairRequestsPanel — a leaf no
// other test renders — so the test stays focused on the dialog's own branches:
// closed (body not mounted), opened (body mounts), url present (QR), and no url
// (the connect-the-tunnel hint).
//
// LEAK SAFETY: we mock ONLY ./PairRequestsPanel (not rendered by any other test)
// and revert it in afterAll. We deliberately do NOT mock @/components/tunnel/
// TunnelQR or @/components/tunnel/useTunnel — both are dependencies that OTHER
// rendering tests rely on (TunnelConnectedPopover/TunnelMenu render the real
// TunnelQR; the tunnel tests own useTunnel), so stubbing them leaks and breaks
// those files. The real TunnelQR renders an SVG (titled "Tunnel QR code"); we
// assert on that. The tunnel url is fed via a stubbed fetch, restored in
// afterEach.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TunnelState } from "@/components/tunnel/types";

const realPanel = await import("./PairRequestsPanel");

let tunnelUrl: string | undefined;
const realFetch = globalThis.fetch;

function tunnelState(): TunnelState {
  return {
    providers: [],
    selectedProvider: null,
    status: tunnelUrl ? "connected" : "idle",
    url: tunnelUrl
  };
}

let PairDeviceDialog: typeof import("./PairDeviceDialog").PairDeviceDialog;

beforeAll(async () => {
  mock.module("./PairRequestsPanel", () => ({
    PairRequestsPanel: () => <div data-testid="panel-stub">panel</div>
  }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const dialogPath = "./PairDeviceDialog?dialog-test";
  ({ PairDeviceDialog } = (await import(dialogPath)) as typeof import("./PairDeviceDialog"));
});

afterAll(() => {
  mock.module("./PairRequestsPanel", () => realPanel);
});

beforeEach(() => {
  tunnelUrl = undefined;
  globalThis.fetch = mock(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => tunnelState()
      }) as Response
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("PairDeviceDialog", () => {
  test("closed: only the trigger renders, the body is not mounted", () => {
    render(<PairDeviceDialog />);
    expect(screen.queryByRole("button", { name: /Pair a device/ })).not.toBeNull();
    expect(screen.queryByTestId("panel-stub")).toBeNull();
    // The real TunnelQR (an SVG titled "Tunnel QR code") is absent while closed.
    expect(screen.queryByTitle("Tunnel QR code")).toBeNull();
    expect(
      screen.queryByText("Connect the relay tunnel first, then scan to pair a device.")
    ).toBeNull();
  });

  test("opened with a tunnel url: the QR renders and the panel mounts", async () => {
    tunnelUrl = "https://g31.example";
    render(<PairDeviceDialog />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Pair a device/ }));
    // The panel mounts immediately; useTunnel's mount fetch resolves the url, then
    // the QR branch renders the real TunnelQR SVG.
    expect(await screen.findByTestId("panel-stub")).not.toBeNull();
    const qrTitle = await screen.findByTitle("Tunnel QR code");
    expect(qrTitle).not.toBeNull();
    expect(
      screen.queryByText("Connect the relay tunnel first, then scan to pair a device.")
    ).toBeNull();
  });

  test("opened with no tunnel url: the connect-the-tunnel hint renders instead of the QR", async () => {
    tunnelUrl = undefined;
    render(<PairDeviceDialog />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Pair a device/ }));
    expect(
      await screen.findByText("Connect the relay tunnel first, then scan to pair a device.")
    ).not.toBeNull();
    expect(screen.queryByTitle("Tunnel QR code")).toBeNull();
    expect(screen.queryByTestId("panel-stub")).not.toBeNull();
  });

  test("the optional className is forwarded to the trigger button", () => {
    render(<PairDeviceDialog className="custom-trigger" />);
    const trigger = screen.getByRole("button", { name: /Pair a device/ });
    expect(trigger.className).toContain("custom-trigger");
  });
});
