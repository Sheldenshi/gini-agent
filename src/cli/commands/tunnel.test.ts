// Unit tests for the `gini tunnel` CLI command. The command is a thin shim
// over the gateway's /api/tunnel routes; every route returns the full
// TunnelState, so each sub-command just prints what the gateway returns.
// The real network call is mocked at globalThis.fetch — the contract pinned
// is the URL, method, body, and that `select` without a provider rejects
// BEFORE any fetch fires. Stdout is captured to assert print() renders the
// gateway's response.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { tunnel } from "./tunnel";

interface CapturedRequest {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

describe("tunnel CLI", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalConsoleLog: typeof console.log;
  let captured: CapturedRequest[];
  let logChunks: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConsoleLog = console.log;
    captured = [];
    logChunks = [];
    console.log = (...args: unknown[]) => {
      logChunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  });

  function mockFetch(responder: () => { status: number; body: unknown }): void {
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      const rawHeaders = init.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => { headers[key] = value; });
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) headers[key] = value;
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) headers[key] = String(value);
      }
      captured.push({
        url: String(input),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? init.body : undefined,
        headers
      });
      const { status, body } = responder();
      return Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      }));
    }) as typeof fetch;
  }

  function stdout(): string {
    return logChunks.join("\n");
  }

  const STATE = { providers: [], selectedProvider: "gini-relay", status: "idle" };

  // `gini tunnel` (no sub-verb) → GET /api/tunnel.
  test("`gini tunnel` GETs /api/tunnel and prints the state", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel");
    expect(captured[0]?.method).toBe("GET");
    expect(captured[0]?.body).toBeUndefined();
    expect(captured[0]?.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(stdout())).toEqual(STATE);
  });

  // `gini tunnel select <provider>` → POST { provider }.
  test("`select gini-relay` POSTs { provider } to /api/tunnel/select", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel", "select", "gini-relay"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel/select");
    expect(captured[0]?.method).toBe("POST");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({ provider: "gini-relay" });
    expect(JSON.parse(stdout())).toEqual(STATE);
  });

  // `select` without a provider → usage error, no fetch.
  test("`select` (no provider) throws a usage hint without firing fetch", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    await expect(tunnel(makeCtx(["tunnel", "select"]))).rejects.toThrow(
      "Usage: gini tunnel select <provider>"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // `connect` with a provider → POST { provider }.
  test("`connect gini-relay` POSTs { provider } to /api/tunnel/connect", async () => {
    const connected = { ...STATE, status: "connected", url: "https://abc123.gini-relay.lilaclabs.ai" };
    mockFetch(() => ({ status: 200, body: connected }));
    await tunnel(makeCtx(["tunnel", "connect", "gini-relay"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel/connect");
    expect(captured[0]?.method).toBe("POST");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({ provider: "gini-relay" });
    expect(JSON.parse(stdout())).toEqual(connected);
  });

  // `connect` with no provider → POST {} (uses the saved selection).
  test("`connect` (no provider) POSTs an empty body to /api/tunnel/connect", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel", "connect"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel/connect");
    expect(captured[0]?.method).toBe("POST");
    expect(JSON.parse(captured[0]?.body ?? "null")).toEqual({});
  });

  // `cancel` → POST /api/tunnel/cancel (no body).
  test("`cancel` POSTs /api/tunnel/cancel", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel", "cancel"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel/cancel");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toBeUndefined();
  });

  // `disconnect` → POST /api/tunnel/disconnect (no body).
  test("`disconnect` POSTs /api/tunnel/disconnect", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel", "disconnect"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel/disconnect");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toBeUndefined();
  });

  // An unknown sub-verb is a typo → reject loudly, never silently show status.
  test("an unknown sub-verb throws a usage hint without firing fetch", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    await expect(tunnel(makeCtx(["tunnel", "bogus"]))).rejects.toThrow(
      "Unknown tunnel subcommand: bogus"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // Explicit `gini tunnel status` still GETs /api/tunnel.
  test("`status` GETs /api/tunnel", async () => {
    mockFetch(() => ({ status: 200, body: STATE }));
    await tunnel(makeCtx(["tunnel", "status"]));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/tunnel");
    expect(captured[0]?.method).toBe("GET");
  });

  // A gateway 400 (e.g. disabled provider) surfaces as a thrown error; the
  // api() helper throws before print() runs.
  test("a gateway 400 surfaces as an error and prints nothing", async () => {
    mockFetch(() => ({ status: 400, body: { error: "Tunnel provider ngrok is not available (requires ngrok account)." } }));
    await expect(tunnel(makeCtx(["tunnel", "select", "ngrok"]))).rejects.toThrow("not available");
    expect(captured).toHaveLength(1);
    expect(stdout()).toBe("");
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join("/tmp/gini-tunnel-cli-tests", "test-instance");
  const config: RuntimeConfig = {
    instance: "test-instance",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(stateRoot, "workspace"),
    stateRoot,
    logRoot: join(stateRoot, "logs")
  };
  return {
    config,
    cliArgs,
    command: cliArgs[0] ?? "",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: cliArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
