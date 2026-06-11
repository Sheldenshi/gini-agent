// EventSource with client-managed reopen.
//
// The browser's built-in SSE reconnect only survives transport drops. When a
// reconnect attempt gets an HTTP response that isn't a 200 stream — exactly
// what happens while the gateway restarts and the BFF answers 503 — the spec
// says the browser must fail the connection PERMANENTLY (readyState CLOSED,
// no further retries) — so a gateway blip would kill every live stream until
// a full page reload.
//
// This wrapper watches for that permanent-failure state and reopens a fresh
// EventSource on an exponential backoff, while leaving the built-in
// (CONNECTING-state) retry loop alone. A reopened EventSource carries no
// Last-Event-ID, so the runtime replays its event log from the start — the
// consumers merge by id, which makes the replay self-healing for anything
// missed during the outage.

export interface ResilientEventSourceOptions {
  // Register listeners on a freshly-constructed EventSource. Called once per
  // (re)open so handlers survive reconnection.
  attach: (source: EventSource) => void;
  // Fired on connection-state TRANSITIONS only: true when a stream opens,
  // false when the transport drops (either retry mode).
  onStateChange?: (connected: boolean) => void;
  // Injectables. Tests drive a fake transport and virtual timers; production
  // callers omit all of these. The timer handle is opaque (`unknown`) so the
  // same signature types both real timers and a test's numeric ids.
  eventSourceFactory?: (url: string) => EventSource;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ResilientEventSourceHandle {
  close(): void;
  // The live transport, exposed for tests/diagnostics. Null after close().
  current(): EventSource | null;
}

// readyState constant: avoid EventSource.CLOSED so fakes without statics work.
const CLOSED = 2;

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;

export function openResilientEventSource(
  url: string,
  options: ResilientEventSourceOptions
): ResilientEventSourceHandle {
  const factory = options.eventSourceFactory ?? ((target: string) => new EventSource(target));
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let source: EventSource | null = null;
  let reopenTimer: unknown = null;
  let attempts = 0;
  let closed = false;
  // Transition-only state reporting; null = nothing reported yet.
  let reportedConnected: boolean | null = null;

  const report = (connected: boolean): void => {
    if (reportedConnected === connected) return;
    reportedConnected = connected;
    options.onStateChange?.(connected);
  };

  const open = (): void => {
    if (closed) return;
    const next = factory(url);
    source = next;
    options.attach(next);
    next.onopen = () => {
      attempts = 0;
      report(true);
    };
    next.onerror = () => {
      report(false);
      // CONNECTING means the browser's own retry loop is still alive — leave
      // it be, or we'd double-connect. CLOSED is the permanent-failure state
      // (e.g. the BFF's 503 while the gateway restarts): the browser will
      // never retry again, so reopening is on us.
      if (next.readyState !== CLOSED) return;
      next.close();
      if (source === next) source = null;
      if (reopenTimer !== null || closed) return;
      const delay = Math.min(baseDelayMs * 2 ** attempts, maxDelayMs);
      attempts += 1;
      reopenTimer = setTimeoutFn(() => {
        reopenTimer = null;
        open();
      }, delay);
    };
  };

  open();

  return {
    close(): void {
      closed = true;
      if (reopenTimer !== null) {
        clearTimeoutFn(reopenTimer);
        reopenTimer = null;
      }
      source?.close();
      source = null;
    },
    current(): EventSource | null {
      return source;
    }
  };
}
