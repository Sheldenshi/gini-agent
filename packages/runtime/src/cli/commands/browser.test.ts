// Unit tests for the `gini browser` subcommands — dispatch + the path/method
// each subcommand sends. The default transport is the spawned per-instance
// Chrome, so a bare `connect` posts an empty body; `connect --url <ws>` attaches
// to the user's own external Chrome over CDP (issue #420 kept cdp, removed the
// managed/visible-window mode). The command talks to the local gateway over
// HTTP, so we stub globalThis.fetch (same pattern as the connector CLI tests).

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { browser } from "./browser";

interface CapturedCall {
  url: string;
  method: string;
  body: string | undefined;
}

describe("browser CLI", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(): CapturedCall[] {
    const calls: CapturedCall[] = [];
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined
      });
      return Promise.resolve(
        new Response(JSON.stringify({ connected: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }) as unknown as typeof fetch;
    return calls;
  }

  test("default action GETs the browser status", async () => {
    const calls = stubFetch();
    await browser(makeCtx(["browser"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/api/browser");
  });

  test("status GETs the browser status", async () => {
    const calls = stubFetch();
    await browser(makeCtx(["browser", "status"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/api/browser");
  });

  test("bare connect POSTs an empty body (default spawned transport)", async () => {
    const calls = stubFetch();
    await browser(makeCtx(["browser", "connect"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/browser/connect");
    expect(JSON.parse(calls[0].body!)).toEqual({});
  });

  test("connect --url POSTs the cdpUrl for an external-Chrome attach", async () => {
    const calls = stubFetch();
    await browser(makeCtx(["browser", "connect", "--url", "ws://127.0.0.1:9222/devtools/browser/abc"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/browser/connect");
    expect(JSON.parse(calls[0].body!)).toEqual({ cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
  });

  test("disconnect POSTs to the disconnect route", async () => {
    const calls = stubFetch();
    await browser(makeCtx(["browser", "disconnect"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/browser/disconnect");
  });

  test("an unknown subcommand rejects with usage", async () => {
    stubFetch();
    await expect(browser(makeCtx(["browser", "bogus"]))).rejects.toThrow(
      /Usage: gini browser status \| connect \[--url WSURL\] \| disconnect/
    );
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join("/tmp/gini-browser-cli-tests", `${process.pid}`, "instances", "test-instance");
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
