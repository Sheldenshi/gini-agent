// Minimal Discord Gateway client — presence + push-driven poll wake.
//
// The bridge's source of truth for inbound messages is the REST poll
// loop in `discord-poller.ts`; this file holds a parallel WebSocket
// connection that serves two roles. First, presence: Discord ties
// the bot's "Online" badge to an active Gateway connection, not to
// REST activity, so without this the bot would stay grey-dotted even
// while polling and replying every few seconds. Second, push wake:
// the connection requests `intents: GUILD_MESSAGES | DIRECT_MESSAGES`
// (4608) so Discord pushes a `MESSAGE_CREATE` event the instant a
// message lands, and the gateway invokes the optional
// `onMessageCreate` callback which the poller wires to its wake
// controller — the next REST-poll sleep collapses to ~0ms. The
// `MESSAGE_CONTENT` privileged intent is deliberately NOT requested
// (we don't need content here; REST polling reads it), so Discord
// never asks for a privileged-intent gate in the developer portal.
//
// Lifecycle: the Discord poller calls `connectDiscordGateway` once a
// loop has authenticated its token, and closes the returned handle
// when the loop exits (status flip, disable, SIGTERM). The client
// reconnects on its own when Discord drops the socket — gateway
// drops are routine (~24h forced rotation, plus transient network
// blips) and we don't want a one-shot disconnect to leave the bot
// grey-dotted for the rest of the runtime's lifetime.
//
// Test seam: `webSocketImpl` lets unit tests substitute a stub
// implementation so we exercise the IDENTIFY / heartbeat / reconnect
// shape without opening a real socket to gateway.discord.gg.

import { appendLog } from "../state";
import { sanitizeBridgeStatusMessage } from "./messaging-poller-helpers";
import type { Instance } from "../types";

// Discord requires v=10 today; v=9 is deprecated. encoding=json keeps
// the implementation simple (etf would shave bytes but needs erlang
// term decoding we don't carry).
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Op codes documented at https://discord.com/developers/docs/topics/opcodes-and-status-codes.
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_PRESENCE_UPDATE = 3;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Gateway intents we subscribe to. Combined with the absence of
// MESSAGE_CONTENT (1 << 15), MESSAGE_CREATE events arrive with empty
// `content` strings — exactly what we want: the event is a push
// notification telling the poller "a message landed in channel X",
// and the REST poll that fires in response is what reads the actual
// text. Keeps MESSAGE_CONTENT off the privileged-intent gate in the
// Discord developer portal.
//   GUILD_MESSAGES   = 1 << 9   = 512    (channel messages)
//   DIRECT_MESSAGES  = 1 << 12  = 4096   (DMs to the bot)
const INTENTS_GUILD_MESSAGES = 1 << 9;
const INTENTS_DIRECT_MESSAGES = 1 << 12;
const DEFAULT_INTENTS = INTENTS_GUILD_MESSAGES | INTENTS_DIRECT_MESSAGES;

// Reconnect backoff. We start at 1s and cap at 30s so a flapping
// Gateway can't hammer Discord, and a genuinely-down service still
// gets retried often enough that the bot returns to Online inside a
// minute of recovery.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// Activity type 4 is "Custom" — shows up as the status line under the
// bot name in the member list without prefacing it with "Playing" /
// "Listening to" / etc. Anything more elaborate (rich presence) needs
// an application id and assets we don't ship.
const CUSTOM_ACTIVITY_TYPE = 4;

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface HelloData {
  heartbeat_interval: number;
}

type WebSocketCtor = new (url: string) => WebSocket;

export interface DiscordGatewayOptions {
  // Bot token without the `Bot ` prefix — Gateway IDENTIFY takes the
  // raw token in the payload, not an Authorization header.
  token: string;
  // Instance is only used for `appendLog` namespacing. Optional so
  // unit tests can omit it.
  instance?: Instance;
  // Bridge id stamped onto every log row so an operator with multiple
  // Discord bridges can disambiguate which connection logged what.
  bridgeId?: string;
  // Status text shown next to the bot in Discord's member list.
  // Defaults to a generic "gini agent" string.
  statusText?: string;
  // Override the WebSocket constructor for tests.
  webSocketImpl?: WebSocketCtor;
  // Override the reconnect timer for tests — the default is the
  // RECONNECT_MIN..MAX backoff window applied across attempts.
  reconnectDelayMs?: number;
  // Push hook for MESSAGE_CREATE events. The poller wires this to a
  // wake controller so a Discord-pushed event collapses the next
  // REST-poll sleep down to ~0ms — REST stays the source of truth
  // for content + watermark advancement; the gateway is purely an
  // accelerator that says "go poll now instead of waiting out the
  // 3s interval". `content` is intentionally NOT delivered (we don't
  // request the MESSAGE_CONTENT intent), so the event carries the
  // channelId only.
  onMessageCreate?: (event: { channelId: string }) => void;
}

export interface DiscordGatewayHandle {
  // Resolves when the gateway is fully closed (either via `close()`
  // or because reconnect was disabled and the socket dropped). The
  // poller doesn't need this for the happy path but it's useful in
  // tests and for the supervisor's drain.
  done: Promise<void>;
  // Idempotent. Triggers a clean disconnect and stops the reconnect
  // loop. After calling this `done` resolves.
  close: () => void;
}

export function connectDiscordGateway(options: DiscordGatewayOptions): DiscordGatewayHandle {
  const {
    token,
    instance,
    bridgeId,
    statusText = "gini agent",
    webSocketImpl,
    reconnectDelayMs,
    onMessageCreate
  } = options;
  const WS = webSocketImpl ?? globalThis.WebSocket;
  if (!WS) {
    throw new Error("WebSocket is not available in this runtime; pass webSocketImpl.");
  }

  const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<void>();
  let socket: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeq: number | null = null;
  let closed = false;
  let attempt = 0;

  // Scrub the bot token (and any other Discord/Telegram credential
  // shapes) out of every gateway log payload. The token never travels
  // in a URL or Authorization header here (it goes in the IDENTIFY
  // JSON), but a peer-supplied close `reason` or a fetch error
  // message could in principle echo it; the linear-scan sanitizer
  // costs nothing on healthy logs and is the only line of defense
  // for fields we don't own.
  function scrubLogData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!data) return data;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        const sanitized = sanitizeBridgeStatusMessage(value);
        // The shared sanitizer scrubs `Bot <token>`-shaped strings and
        // `/bot<token>/` URL paths; the gateway also holds the raw
        // token in this closure, so explicitly redact a direct echo
        // even though that should never happen organically.
        out[key] = sanitized.split(token).join("<redacted>");
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  function logRow(message: string, data?: Record<string, unknown>): void {
    if (!instance) return;
    appendLog(instance, message, {
      ...(bridgeId ? { bridgeId } : {}),
      ...(scrubLogData(data) ?? {})
    });
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function safeClose(code = 1000, reason = "client closing"): void {
    try {
      socket?.close(code, reason);
    } catch {
      // Some WebSocket implementations throw on close-after-close; the
      // outer `closed` flag is the source of truth for the lifecycle
      // so we swallow the throw and let the close event drive the
      // rest of the state machine.
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    attempt += 1;
    // Exponential backoff with jitter. Floor at RECONNECT_MIN_MS,
    // ceiling at RECONNECT_MAX_MS. Tests pass reconnectDelayMs to
    // pin the delay deterministically.
    const base =
      reconnectDelayMs !== undefined
        ? reconnectDelayMs
        : Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, base);
  }

  function openSocket(): void {
    if (closed) return;
    let next: WebSocket;
    try {
      next = new WS(GATEWAY_URL);
    } catch (error) {
      logRow("messaging.discord.gateway_open_error", {
        error: error instanceof Error ? error.message : String(error)
      });
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      // Reset the backoff counter once we have a live socket. If
      // IDENTIFY succeeds Discord sends HELLO; we IDENTIFY inside
      // the HELLO handler below.
      attempt = 0;
      logRow("messaging.discord.gateway_open");
    });

    next.addEventListener("message", (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String((event as MessageEvent).data)) as GatewayPayload;
      } catch (error) {
        logRow("messaging.discord.gateway_parse_error", {
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (typeof payload.s === "number") lastSeq = payload.s;
      handleFrame(payload);
    });

    next.addEventListener("close", (event) => {
      stopHeartbeat();
      socket = null;
      const ce = event as CloseEvent;
      logRow("messaging.discord.gateway_close", {
        code: ce.code,
        reason: typeof ce.reason === "string" ? ce.reason : ""
      });
      if (closed) {
        resolveDone();
        return;
      }
      // Non-recoverable close codes: reconnecting would just produce
      // the same close. Per Discord's Gateway docs:
      //   4004 Authentication failed (bad token)
      //   4010 Invalid shard
      //   4011 Sharding required
      //   4012 Invalid API version
      //   4013 Invalid intent(s)
      //   4014 Disallowed intent(s) — privileged intent not enabled
      // Tear the handle down instead of looping. The operator has to
      // recreate the bridge (and fix the underlying setup) for the
      // gateway to come back up. logRow above captured the close
      // code/reason so the failure is diagnosable.
      const NON_RECONNECTABLE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
      if (NON_RECONNECTABLE.has(ce.code)) {
        logRow("messaging.discord.gateway_giveup", { code: ce.code });
        closed = true;
        resolveDone();
        return;
      }
      scheduleReconnect();
    });

    // `error` events on WebSocket carry no detail by spec; treat them
    // as soft and rely on the matching `close` event for the actual
    // teardown + reconnect path.
    next.addEventListener("error", () => {
      logRow("messaging.discord.gateway_socket_error");
    });
  }

  function handleFrame(payload: GatewayPayload): void {
    switch (payload.op) {
      case OP_HELLO: {
        const interval = (payload.d as HelloData | undefined)?.heartbeat_interval ?? 41_250;
        stopHeartbeat();
        // First heartbeat fires immediately so we don't sit silent
        // for the full interval after IDENTIFY — Discord won't drop
        // us for that but the heartbeat acks are how we know the
        // session is healthy.
        sendFrame({ op: OP_HEARTBEAT, d: lastSeq });
        heartbeatTimer = setInterval(() => {
          sendFrame({ op: OP_HEARTBEAT, d: lastSeq });
        }, interval);
        // IDENTIFY with GUILD_MESSAGES | DIRECT_MESSAGES so Discord
        // pushes a MESSAGE_CREATE event the instant a message lands
        // in any channel/DM the bot can see. The handler below pokes
        // the poller's wake controller; REST polling still owns
        // content + watermark + dedupe so the gateway path is a
        // pure-latency optimization, not a correctness one. The
        // MESSAGE_CONTENT intent is intentionally NOT requested —
        // we don't need content from the event and skipping it
        // keeps the bot off Discord's privileged-intent gate.
        sendFrame({
          op: OP_IDENTIFY,
          d: {
            token,
            intents: DEFAULT_INTENTS,
            properties: {
              os: process.platform,
              browser: "gini-agent",
              device: "gini-agent"
            },
            presence: {
              activities: [{ name: statusText, type: CUSTOM_ACTIVITY_TYPE }],
              status: "online",
              afk: false
            }
          }
        });
        break;
      }
      case OP_HEARTBEAT: {
        // Discord can ask for an immediate heartbeat outside the
        // interval (e.g. after a resume); answer right away.
        sendFrame({ op: OP_HEARTBEAT, d: lastSeq });
        break;
      }
      case OP_HEARTBEAT_ACK: {
        // Healthy round-trip — nothing to do. Could track here for a
        // "missing ack ⇒ zombie connection" detector but Discord's
        // own close codes already cover that.
        break;
      }
      case OP_RECONNECT: {
        // Discord asked us to reconnect (op 7). Close with 4000 so
        // the close handler schedules a reconnect.
        logRow("messaging.discord.gateway_reconnect_requested");
        safeClose(4000, "reconnect requested");
        break;
      }
      case OP_INVALID_SESSION: {
        // Op 9 — session invalidated. We do a clean disconnect; the
        // reconnect loop establishes a fresh session.
        logRow("messaging.discord.gateway_invalid_session");
        safeClose(4000, "invalid session");
        break;
      }
      case OP_DISPATCH: {
        if (payload.t === "READY") {
          logRow("messaging.discord.gateway_ready");
        } else if (payload.t === "MESSAGE_CREATE" && onMessageCreate) {
          // Push notification: collapse the next REST-poll sleep so
          // the message is processed on the order of network latency
          // instead of waiting out POLL_INTERVAL_MS. The callback is
          // best-effort — if it throws (e.g. a stale poller wake
          // controller) we swallow so a bad consumer can't tear
          // down the Gateway socket. The REST poll's watermark + the
          // event being delivered repeatedly to multiple clients all
          // mean a missed wake just degrades to the 3s baseline.
          const data = payload.d as { channel_id?: unknown } | undefined;
          const channelId = typeof data?.channel_id === "string" ? data.channel_id : undefined;
          if (channelId) {
            try {
              onMessageCreate({ channelId });
            } catch {
              // Intentional swallow — see comment above.
            }
          }
        }
        break;
      }
      default:
        // Future op codes we don't recognise — log and ignore so the
        // connection stays up. Discord guarantees forward compat
        // here: unknown ops are safe to drop.
        logRow("messaging.discord.gateway_unhandled_op", { op: payload.op });
    }
  }

  function sendFrame(frame: { op: number; d: unknown }): void {
    if (!socket || socket.readyState !== (globalThis.WebSocket?.OPEN ?? 1)) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      logRow("messaging.discord.gateway_send_error", {
        op: frame.op,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Allow callers to nudge the presence text after connect without
  // tearing down the socket. Optional today — the supervisor doesn't
  // call it — but cheap to expose now so a future "bot is busy on
  // task N" status doesn't require another wave of refactors.
  function setPresence(): void {
    sendFrame({
      op: OP_PRESENCE_UPDATE,
      d: {
        since: null,
        activities: [{ name: statusText, type: CUSTOM_ACTIVITY_TYPE }],
        status: "online",
        afk: false
      }
    });
  }
  void setPresence;

  openSocket();

  return {
    done: donePromise,
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopHeartbeat();
      if (socket) {
        safeClose(1000, "client closing");
      } else {
        // No live socket and no pending reconnect — resolve done
        // immediately so the caller's drain doesn't hang waiting on
        // a close event that will never come.
        resolveDone();
      }
    }
  };
}
