# Web SSE Connection Exhaustion Starves Polled Queries (e.g. Pair Requests)

Status: Proposed (known issue, fix pending)

## Context

The Next.js control plane keeps itself live two ways at once:

- A single long-lived **Server-Sent Events** stream per browser tab. `RuntimeStreamBridge`
  (`web/src/components/RuntimeStreamBridge.tsx`) opens an `EventSource` to
  `/api/runtime/events/stream` and maps runtime ticks to React Query
  invalidations (e.g. a `pairing` tick invalidates `["pairingRequests","devices"]`).
  It is mounted in `AppShell` (`web/src/components/AppShell.tsx`), so **every route in
  every tab holds one EventSource open for the lifetime of the tab.**
- Per-feature **polling** on top of that. The device-pairing panel uses
  `usePairingRequests()` (`web/src/lib/pairing.ts`) — query key `["pairingRequests"]`,
  `refetchInterval: 3000` — to `GET /api/pairing/requests` (server-filtered to pending
  rows in `src/state/records.ts` `listPendingPairingRequests`).

An `EventSource` over HTTP/1.1 is a normal persistent HTTP connection that is **never
released** while the tab is open. Browsers cap concurrent connections per host on
HTTP/1.1 at **6** (Chrome's default). The gateway's own Bun server
(`http://localhost:7351`) and the inner Next.js dev server are served over
**HTTP/1.1**. The gini-relay front (`https://<sub>.gini-relay.lilaclabs.ai`) is served
by Caddy over **HTTP/2**, which multiplexes many streams over one connection.

## Symptom

With multiple control-plane tabs open against the **localhost** origin, the device-pairing
"Pair requests" panel (tunnel popover, or Settings → Devices → "Pair a device") renders its
empty state — "Waiting for a device to scan…" — even though a device pairing request is
genuinely pending on the gateway. The operator concludes "I can't see the request to
approve," and the device sits waiting until its request expires.

This is silent: there is no error, just an empty panel and stale data.

## Reproduction

1. Create a pending device pairing request (pair a device, or `POST /api/pairing/request`
   from a native client). Confirm it exists: `curl -sS http://localhost:7351/api/pairing/requests`
   returns a `pending` row.
2. Open 7 browser tabs to `http://localhost:7351/` (each mounts `RuntimeStreamBridge` and so
   opens one EventSource). 7 exceeds the HTTP/1.1 cap of 6 connections per host.
3. In a tab opened *after* the pool filled, open the tunnel popover.

Observed in a live run:

- The **1st** tab (opened before the pool saturated) showed the request with Approve/Reject.
- A **later** tab showed the empty "Waiting for a device to scan…" state for the same
  pending request.
- That tab's network log showed the held-open `eventsource` to
  `/api/runtime/events/stream` plus a stack of polls (`/api/runtime/chat`,
  `/api/runtime/pairing/requests`, `/api/runtime/status`, …) stuck **pending**, never
  completing.
- Tabs 1 through 6 loaded; the **7th** tab failed to load the page at all (landed on
  `about:blank`) because its initial document request could not get a connection.

The same flow over the relay URL (HTTP/2) does **not** reproduce — the streams multiplex.

## Root cause

Per-tab persistent SSE multiplied against the HTTP/1.1 limit of 6 connections per host. Six
tabs, each holding one EventSource, fill the pool; every other fetch on that origin —
including the 3-second pairing-requests poll — then queues indefinitely. The pairing query
never resolves, so the panel shows "no pending requests." Nothing is wrong on the gateway:
the request is present and the admin route returns it (verified via loopback and via the BFF
`/api/runtime/pairing/requests`).

It is not specific to pairing — any polled query degrades the same way once the pool is
saturated. Pairing is just where it is most visible and most costly (a real device is left
unapprovable).

## Affected surfaces

- **localhost gateway origin and the inner Next.js dev server**: HTTP/1.1 → vulnerable.
- **gini-relay front**: HTTP/2 (Caddy) → not affected (multiplexed).

## Options (ranked)

1. **Share one SSE per origin across all tabs** via a `SharedWorker` (or a
   `BroadcastChannel` leader election where one tab owns the EventSource and rebroadcasts
   ticks). Collapses N tabs to one connection regardless of tab count. Most robust; removes
   the multiplication at the source. Most implementation effort.
2. **Tear down the SSE when the tab is hidden** (Page Visibility API: close on
   `visibilitychange` → `hidden`, reopen on `visible`) in `RuntimeStreamBridge`. Bounds live
   EventSources to foreground tabs (typically one). Small change, high impact. Trade-off:
   backgrounded tabs stop receiving live ticks and rely on a refetch when refocused — make
   the affected queries refetch on focus so they catch up.
3. **Serve the gateway/web over HTTP/2 (h2c or TLS)** so localhost multiplexes like the
   relay. Removes the per-host cap entirely, but is an infra change to the Bun server and the
   reverse proxy (see `gateway-web-reverse-proxy.md`).
4. **Make the operator never need many tabs** (UX nudge): a single-tab control plane. Not a
   real fix — operators legitimately keep tabs open.

Recommendation: ship Option 2 as the immediate mitigation, pursue Option 1 as the durable
fix. Option 3 helps everything but is heavier.

## Acceptance check

Open 8 tabs against the localhost origin (more than the 6-connection cap), create one pending
pairing request, and confirm **every** tab's Pair-requests panel shows the request within the
poll interval, and that the count of live EventSource connections stays bounded (does not grow
one-per-tab). Re-verify the relay path still works (it already does).

## References

- `web/src/components/RuntimeStreamBridge.tsx` — per-tab EventSource → query invalidation.
- `web/src/components/AppShell.tsx` — mounts the bridge on every route.
- `web/src/lib/pairing.ts` — `usePairingRequests()` poll (`refetchInterval: 3000`).
- `web/src/components/pairing/PairRequestsPanel.tsx` — the panel + its empty "Waiting for a
  device to scan…" state.
- `src/state/records.ts` — `listPendingPairingRequests` (server-side pending filter).
- ADR [gateway-web-reverse-proxy.md](gateway-web-reverse-proxy.md) — single-origin proxy and
  the HTTP/1.1-vs-HTTP/2 distinction between localhost and the relay front.
- ADR [device-pairing-auth.md](device-pairing-auth.md) — the pairing trust model and request
  lifecycle.
