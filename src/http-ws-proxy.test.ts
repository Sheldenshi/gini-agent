import { describe, expect, test, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import type { Server } from "bun";
import { proxyWebSocketUpgrade, webSocketProxyHandler } from "./http";
import { clearWebTargetCache } from "./web-target";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-ws-proxy-tests";

function cfg(instance: string): RuntimeConfig {
  process.env.GINI_STATE_ROOT = ROOT;
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "t",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`
  } as RuntimeConfig;
}

// Minimal ServerWebSocket double capturing sends and the close call.
function fakeClient(data: Record<string, unknown>) {
  const sent: Array<string | ArrayBuffer> = [];
  let closed: { code?: number; reason?: string } | null = null;
  return {
    data,
    sent,
    closed: () => closed,
    send(m: string | ArrayBuffer) { sent.push(m); },
    close(code?: number, reason?: string) { closed = { code, reason }; }
  };
}

// Minimal upstream WebSocket double capturing sends and the close call.
function fakeUpstream() {
  const sent: Array<string | ArrayBuffer> = [];
  let closed = false;
  return {
    sent,
    wasClosed: () => closed,
    send(m: string | ArrayBuffer) { sent.push(m); },
    close() { closed = true; }
  };
}

describe("proxyWebSocketUpgrade", () => {
  beforeEach(() => clearWebTargetCache());

  test("returns 502 when no web server is resolvable", async () => {
    const config = cfg("ws-down");
    const server = { upgrade: () => true } as unknown as Server<unknown>;
    const res = await proxyWebSocketUpgrade(
      new Request(`http://127.0.0.1:${config.port}/_next/webpack-hmr`),
      server,
      config
    );
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(502);
  });
});

describe("webSocketProxyHandler", () => {
  test("open flushes buffered upstream frames to the client", () => {
    const upstream = fakeUpstream();
    const data = { upstream, toClient: ["a", "b"], toUpstream: [], clientOpen: false, upstreamOpen: false, upstreamClosed: false };
    const ws = fakeClient(data);
    webSocketProxyHandler.open(ws as never);
    expect(ws.sent).toEqual(["a", "b"]);
    expect(data.clientOpen).toBe(true);
    expect((data as { client?: unknown }).client).toBe(ws);
    expect(data.toClient).toEqual([]);
  });

  test("open closes the client immediately if the upstream already died", () => {
    const upstream = fakeUpstream();
    const data = { upstream, toClient: ["x"], toUpstream: [], clientOpen: false, upstreamOpen: false, upstreamClosed: true };
    const ws = fakeClient(data);
    webSocketProxyHandler.open(ws as never);
    expect(ws.closed()).not.toBeNull();
    expect(ws.sent).toEqual([]); // never flushed
  });

  test("message forwards to upstream when open, buffers otherwise", () => {
    const upstream = fakeUpstream();
    const data = { upstream, toClient: [], toUpstream: [] as Array<string | ArrayBuffer>, clientOpen: true, upstreamOpen: false, upstreamClosed: false };
    const ws = fakeClient(data);
    webSocketProxyHandler.message(ws as never, "early");
    expect(data.toUpstream).toEqual(["early"]);
    expect(upstream.sent).toEqual([]);
    data.upstreamOpen = true;
    webSocketProxyHandler.message(ws as never, "live");
    expect(upstream.sent).toEqual(["live"]);
  });

  test("message coerces a binary Buffer frame to an ArrayBuffer", () => {
    const upstream = fakeUpstream();
    const data = { upstream, toClient: [], toUpstream: [], clientOpen: true, upstreamOpen: true, upstreamClosed: false };
    const ws = fakeClient(data);
    webSocketProxyHandler.message(ws as never, Buffer.from([1, 2, 3]));
    expect(upstream.sent.length).toBe(1);
    expect(upstream.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(upstream.sent[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("close tears down the upstream socket", () => {
    const upstream = fakeUpstream();
    const data = { upstream, toClient: [], toUpstream: [], clientOpen: true, upstreamOpen: true, upstreamClosed: false };
    const ws = fakeClient(data);
    webSocketProxyHandler.close(ws as never);
    expect(upstream.wasClosed()).toBe(true);
  });
});
