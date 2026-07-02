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

// The slice of react-query state the panel reads beyond `data`. Defaults to a
// healthy resolved query; error/loading tests flip these per-case so every
// render branch (loading / error / empty / list) is driven through one mocked
// module instance.
type QueryState = {
  isError: boolean;
  error: (Error & { status?: number }) | null;
  isLoading: boolean;
  refetch: ReturnType<typeof mock>;
};
let pairingQuery: QueryState;

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
    usePairingRequests: () => ({ data: requests, ...pairingQuery }),
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
  pairingQuery = { isError: false, error: null, isLoading: false, refetch: mock(() => {}) };
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

  // --- Failure / loading states: a failed admin list must NEVER render as the
  // idle "Waiting…" block (the approve/reject-never-displays bug). ------------

  test("403 with no data: hedged auth error, Disconnected badge, no buttons, no idle copy", () => {
    requests = [];
    pairingQuery = { isError: true, error: Object.assign(new Error("Forbidden"), { status: 403 }), isLoading: false, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/isn’t authorized to manage pairing/)).not.toBeNull();
    expect(screen.queryByText("Disconnected")).not.toBeNull();
    expect(screen.queryByText("Waiting for a device to scan…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("404 with no data: origin-specific error copy, not the idle block", () => {
    requests = [];
    pairingQuery = { isError: true, error: Object.assign(new Error("Not found"), { status: 404 }), isLoading: false, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByText(/isn’t available on this address/)).not.toBeNull();
    expect(screen.queryByText("Waiting for a device to scan…")).toBeNull();
  });

  test("generic error with no data: generic copy, and Try again calls refetch", async () => {
    requests = [];
    const refetch = mock(() => {});
    pairingQuery = { isError: true, error: Object.assign(new Error("boom"), { status: 500 }), isLoading: false, refetch };
    renderPanel();
    expect(screen.queryByText(/Couldn’t load pair requests/)).not.toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("error with an undefined status still renders the generic copy", () => {
    requests = [];
    pairingQuery = { isError: true, error: new Error("network"), isLoading: false, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByText(/Couldn’t load pair requests/)).not.toBeNull();
  });

  test("first load in flight (no data): shows the loading block, never the idle copy", () => {
    requests = [];
    pairingQuery = { isError: false, error: null, isLoading: true, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByText("Loading pair requests…")).not.toBeNull();
    expect(screen.queryByText("Waiting for a device to scan…")).toBeNull();
  });

  test("auth error (403) AFTER a good load keeps the list but flips the badge to Disconnected (no blanking, no alert)", () => {
    requests = [makeRequest()];
    pairingQuery = { isError: true, error: Object.assign(new Error("Forbidden"), { status: 403 }), isLoading: false, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The poll is terminally failing, so the indicator must not claim "Listening…".
    expect(screen.queryByText("Disconnected")).not.toBeNull();
    expect(screen.queryByText("Listening…")).toBeNull();
  });

  test("transient error (no status) AFTER a good load keeps the list AND the live Listening indicator", () => {
    requests = [makeRequest()];
    pairingQuery = { isError: true, error: new Error("network blip"), isLoading: false, refetch: mock(() => {}) };
    renderPanel();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // A transient blip self-heals on the next poll, so the indicator stays live.
    expect(screen.queryByText("Listening…")).not.toBeNull();
    expect(screen.queryByText("Disconnected")).toBeNull();
  });
});
