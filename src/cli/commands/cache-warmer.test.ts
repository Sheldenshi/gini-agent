// Unit tests for the `gini cache-warmer` CLI command. The command is a
// thin shim around the gateway's /api/settings/cache-warmer endpoint:
//   `gini cache-warmer`            → GET, prints { minutes }
//   `gini cache-warmer set <n>`    → POST { minutes: n }, prints result
//
// The real network call is mocked at globalThis.fetch — the contract we
// pin is the URL, method, body, and that input validation rejects bad
// `<n>` BEFORE any fetch fires. Stdout is captured to assert print()
// renders the parsed JSON body the gateway returned.
//
// Validation lives both client-side (integer-only guard in the CLI to
// give a fast local error) and server-side (range + persistence in
// setCacheWarmer). The CLI integer guard is tested here; range
// enforcement is delegated to the gateway, so the upper-edge test
// confirms the CLI forwards an out-of-range integer and surfaces the
// gateway's 400 response.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { cacheWarmer } from "./cache-warmer";

interface CapturedRequest {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

describe("cache-warmer CLI", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalConsoleLog: typeof console.log;
  let captured: CapturedRequest[];
  let logChunks: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConsoleLog = console.log;
    captured = [];
    logChunks = [];
    // print() in src/cli/output.ts writes via console.log, so capture
    // there. process.stdout.write is bypassed by console.log's internal
    // formatter and would miss the output entirely.
    console.log = (...args: unknown[]) => {
      logChunks.push(args.map(a => typeof a === "string" ? a : String(a)).join(" "));
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
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key] = String(value);
        }
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

  // gini cache-warmer (no sub-verb) → GET /api/settings/cache-warmer.
  // The result body is what the gateway returns, and the CLI just
  // pretty-prints it via print(). We pin both the request shape and
  // that the printed JSON contains the gateway's `minutes` value.
  test("`gini cache-warmer` GETs /api/settings/cache-warmer and prints { minutes }", async () => {
    mockFetch(() => ({ status: 200, body: { minutes: 45 } }));
    const ctx = makeCtx(["cache-warmer"]);
    await cacheWarmer(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/settings/cache-warmer");
    expect(captured[0]?.method).toBe("GET");
    expect(captured[0]?.body).toBeUndefined();
    expect(captured[0]?.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(stdout())).toEqual({ minutes: 45 });
  });

  // gini cache-warmer set <n> → POST with JSON body { minutes: <n> }.
  // The CLI's only client-side check is integer-ness; valid integers
  // are forwarded as-is. The printed payload is whatever the gateway
  // returns — typically { ok: true, minutes }.
  test("`set 30` POSTs { minutes: 30 } and prints the gateway result", async () => {
    mockFetch(() => ({ status: 200, body: { ok: true, minutes: 30 } }));
    const ctx = makeCtx(["cache-warmer", "set", "30"]);
    await cacheWarmer(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://127.0.0.1:7337/api/settings/cache-warmer");
    expect(captured[0]?.method).toBe("POST");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({ minutes: 30 });
    expect(captured[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(stdout())).toEqual({ ok: true, minutes: 30 });
  });

  // `set 0` is the canonical "off" — there is no string alias on
  // purpose. The CLI must still pass 0 as a numeric literal (not "0").
  test("`set 0` POSTs { minutes: 0 } (the canonical off switch)", async () => {
    mockFetch(() => ({ status: 200, body: { ok: true, minutes: 0 } }));
    const ctx = makeCtx(["cache-warmer", "set", "0"]);
    await cacheWarmer(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    const sent = JSON.parse(captured[0]?.body ?? "{}");
    expect(sent).toEqual({ minutes: 0 });
    expect(sent.minutes).toBe(0);
    expect(typeof sent.minutes).toBe("number");
    expect(JSON.parse(stdout())).toEqual({ ok: true, minutes: 0 });
  });

  // Non-numeric input must be caught client-side before any fetch.
  // The error message is the one downstream consumers (web UI, scripts)
  // rely on for their assertions, so it's pinned verbatim.
  test("`set abc` rejects locally with 'integer between 0 and 1440' BEFORE fetch", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    const ctx = makeCtx(["cache-warmer", "set", "abc"]);
    await expect(cacheWarmer(ctx)).rejects.toThrow(
      "minutes must be an integer between 0 and 1440"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // Fractional input is rejected for the same reason as non-numeric:
  // Number("12.5") parses, but Number.isInteger() rejects it. No fetch.
  test("`set 12.5` rejects locally on the integer guard (no fetch fires)", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    const ctx = makeCtx(["cache-warmer", "set", "12.5"]);
    await expect(cacheWarmer(ctx)).rejects.toThrow(
      "minutes must be an integer between 0 and 1440"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // `set` with no value → usage error. The CLI must NOT consume any
  // following positional from cliArgs (there isn't one anyway) and
  // must NOT fall through to the integer check on `undefined`.
  test("`set` (no value) throws a usage hint without firing fetch", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    const ctx = makeCtx(["cache-warmer", "set"]);
    await expect(cacheWarmer(ctx)).rejects.toThrow(
      "Usage: gini cache-warmer set <minutes>"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // Unknown sub-verb is rejected with the top-level usage. Note: the
  // command's implementation defaults to "show" when cliArgs[1] is
  // missing, so an empty sub doesn't trigger this path — only a
  // present-but-unknown sub does.
  test("`cache-warmer foobar` throws the top-level usage hint", async () => {
    mockFetch(() => { throw new Error("fetch should not be called"); });
    const ctx = makeCtx(["cache-warmer", "foobar"]);
    await expect(cacheWarmer(ctx)).rejects.toThrow(
      "Usage: gini cache-warmer [set <minutes>]"
    );
    expect(captured).toHaveLength(0);
    expect(stdout()).toBe("");
  });

  // The CLI guard is integer-only, NOT range. 1441 is a valid integer
  // and gets forwarded to the gateway, which is the authority on the
  // [0, 1440] range. The CLI surfaces the gateway's 400 response.
  test("`set 1441` forwards to gateway (CLI accepts integer); gateway 400 surfaces as error", async () => {
    mockFetch(() => ({ status: 400, body: { error: "minutes must be in [0, 1440]" } }));
    const ctx = makeCtx(["cache-warmer", "set", "1441"]);
    await expect(cacheWarmer(ctx)).rejects.toThrow("minutes must be in [0, 1440]");
    // The CLI must have actually sent the request — that's the whole
    // point of this test (the integer guard is local-only, range is
    // server-side).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({ minutes: 1441 });
    // No print() because the api() helper throws before print() runs.
    expect(stdout()).toBe("");
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join("/tmp/gini-cache-warmer-cli-tests", "test-instance");
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
