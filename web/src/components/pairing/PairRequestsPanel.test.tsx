/// <reference lib="dom" />

// PairRequestsPanel renders the admin "Pair requests" list for any paired session
// (loopback or relay — the mirror model; see ADR device-pairing-auth.md). These
// tests mock the @/lib/pairing data hooks and sonner's toast so every branch is
// driven without the network: the idle empty-list block, populated rows with the
// relativeTime variants, the approve/reject mutate -> toast (success + error)
// wiring, and the isPending disabled state. The panel no longer subscribes to the
// runtime stream — RuntimeStreamBridge owns "pairing"-event invalidation app-wide
// — so there is no SSE wiring to exercise here.
//
// LEAK SAFETY: mock.module is process-wide in `bun test` and can outlive the file
// that set it, so every override SPREADS the real module and changes only the
// exports this file needs. That way, if an override is still live when a sibling
// test runs, the other exports it relies on (e.g. sonner's Toaster) are
// preserved. The real namespaces are captured for spreading and for the afterAll
// revert. Neither specifier is itself the SUBJECT of another rendering test, so
// the spread keeps them harmless.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test
} from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PairingRequestView } from "@/lib/pairing";

const realPairing = await import("@/lib/pairing");
const realSonner = await import("sonner");

// --- Controllable mock surface --------------------------------------------
let requests: PairingRequestView[] = [];

type Mutation = {
  mutate: ReturnType<typeof mock>;
  isPending: boolean;
};
let approve: Mutation;
let reject: Mutation;

const toastSuccess = mock((_: string) => {});
const toastError = mock((_: string) => {});

let PairRequestsPanel: typeof import("./PairRequestsPanel").PairRequestsPanel;

beforeAll(async () => {
  mock.module("@/lib/pairing", () => ({
    ...realPairing,
    usePairingRequests: () => ({ data: requests }),
    useApprovePairing: () => approve,
    useRejectPairing: () => reject
  }));
  // Spread the real sonner so non-`toast` exports survive; override only `toast`.
  mock.module("sonner", () => ({
    ...realSonner,
    toast: { success: toastSuccess, error: toastError }
  }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const panelPath = "./PairRequestsPanel?panel-test";
  ({ PairRequestsPanel } = (await import(panelPath)) as typeof import("./PairRequestsPanel"));
});

afterAll(() => {
  mock.module("@/lib/pairing", () => realPairing);
  mock.module("sonner", () => realSonner);
});

function makeRequest(over: Partial<PairingRequestView> = {}): PairingRequestView {
  return {
    id: "req-1",
    code: "428913",
    status: "pending",
    deviceName: "iPhone",
    relayHost: "g31.example",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over
  };
}

function renderPanel() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <PairRequestsPanel />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  requests = [];
  approve = { mutate: mock(() => {}), isPending: false };
  reject = { mutate: mock(() => {}), isPending: false };
  toastSuccess.mockClear();
  toastError.mockClear();
});

// relativeTime assertions freeze the wall clock so the createdAt offset and the
// in-component Date.now() read share one instant (a live clock can tick mid-test
// and flip "30s ago" -> "31s ago"). Reset to the real clock after every test.
afterEach(() => {
  setSystemTime();
});

describe("PairRequestsPanel", () => {
  test("empty list: renders the idle waiting block", () => {
    requests = [];
    renderPanel();
    expect(screen.queryByText("Waiting for a device to scan…")).not.toBeNull();
    expect(
      screen.queryByText("Open the link or scan the code on the device you want to add.")
    ).not.toBeNull();
  });

  test("requests: renders code, device name, warning, and action buttons", () => {
    requests = [makeRequest()];
    renderPanel();
    expect(screen.queryByText("428913")).not.toBeNull();
    expect(screen.queryByText("iPhone")).not.toBeNull();
    expect(
      screen.queryByText("Approve only if this code matches the one shown on that device.")
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeNull();
  });

  test("Approve mutate is called with the id; onSuccess toasts success", async () => {
    requests = [makeRequest({ id: "approve-me" })];
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve.mutate).toHaveBeenCalledTimes(1);
    const [id, opts] = approve.mutate.mock.calls[0] as [
      string,
      { onSuccess: () => void; onError: (e: Error) => void }
    ];
    expect(id).toBe("approve-me");
    act(() => opts.onSuccess());
    expect(toastSuccess).toHaveBeenCalledWith("Device approved");
  });

  test("Approve onError toasts the error message", async () => {
    requests = [makeRequest()];
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const [, opts] = approve.mutate.mock.calls[0] as [
      string,
      { onSuccess: () => void; onError: (e: Error) => void }
    ];
    act(() => opts.onError(new Error("approve boom")));
    expect(toastError).toHaveBeenCalledWith("approve boom");
  });

  test("Reject mutate is called with the id; onSuccess toasts rejected", async () => {
    requests = [makeRequest({ id: "reject-me" })];
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(reject.mutate).toHaveBeenCalledTimes(1);
    const [id, opts] = reject.mutate.mock.calls[0] as [
      string,
      { onSuccess: () => void; onError: (e: Error) => void }
    ];
    expect(id).toBe("reject-me");
    act(() => opts.onSuccess());
    expect(toastSuccess).toHaveBeenCalledWith("Request rejected");
  });

  test("Reject onError toasts the error message", async () => {
    requests = [makeRequest()];
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const [, opts] = reject.mutate.mock.calls[0] as [
      string,
      { onSuccess: () => void; onError: (e: Error) => void }
    ];
    act(() => opts.onError(new Error("reject boom")));
    expect(toastError).toHaveBeenCalledWith("reject boom");
  });

  test("buttons are disabled while their mutation isPending", () => {
    requests = [makeRequest()];
    approve.isPending = true;
    reject.isPending = true;
    renderPanel();
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  test("relativeTime: 'just now' for a fresh request (<5s)", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    requests = [makeRequest({ createdAt: new Date(Date.now() - 1000).toISOString() })];
    renderPanel();
    expect(screen.queryByText(/just now/)).not.toBeNull();
  });

  test("relativeTime: 'Ns ago' for under a minute", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    requests = [makeRequest({ createdAt: new Date(Date.now() - 30_000).toISOString() })];
    renderPanel();
    expect(screen.queryByText(/30s ago/)).not.toBeNull();
  });

  test("relativeTime: 'Nm ago' for a minute or more", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    requests = [makeRequest({ createdAt: new Date(Date.now() - 120_000).toISOString() })];
    renderPanel();
    expect(screen.queryByText(/2m ago/)).not.toBeNull();
  });

  test("relativeTime: empty string for an unparseable timestamp", () => {
    requests = [makeRequest({ createdAt: "not-a-date" })];
    renderPanel();
    expect(screen.queryByText("iPhone")).not.toBeNull();
    expect(screen.queryByText(/ago/)).toBeNull();
  });
});
