// Unit tests for the `gini connector accounts` subcommands — focused on
// dispatch + argument parsing for the tagged-Google-account management surface.
//
// The command talks to the local gateway over HTTP, so we stub globalThis.fetch
// (same pattern as the `provider catalog` test) and assert the path/method/body
// each subcommand sends. `add` is the exception: it must NOT call the API (the
// browser OAuth flow only the agent can drive), so we assert fetch is untouched.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { connector } from "./connectors";

interface CapturedCall {
  url: string;
  method: string;
  body: string | undefined;
}

describe("connector accounts CLI", () => {
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
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }) as unknown as typeof fetch;
    return calls;
  }

  test("accounts (default action) GETs the accounts list", async () => {
    const calls = stubFetch();
    await connector(makeCtx(["connector", "accounts"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/api/google/accounts");
  });

  test("accounts retag PATCHes the account with the new tag", async () => {
    const calls = stubFetch();
    await connector(makeCtx(["connector", "accounts", "retag", "gacct_abc", "--tag", "work"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/api/google/accounts/gacct_abc");
    expect(JSON.parse(calls[0].body!)).toEqual({ tag: "work" });
  });

  test("accounts retag without an id rejects with usage", async () => {
    stubFetch();
    await expect(connector(makeCtx(["connector", "accounts", "retag", "--tag", "work"]))).rejects.toThrow(
      /Usage: gini connector accounts retag/
    );
  });

  test("accounts retag without --tag rejects with usage", async () => {
    stubFetch();
    await expect(connector(makeCtx(["connector", "accounts", "retag", "gacct_abc"]))).rejects.toThrow(
      /Usage: gini connector accounts retag/
    );
  });

  test("accounts remove DELETEs the account", async () => {
    const calls = stubFetch();
    await connector(makeCtx(["connector", "accounts", "remove", "gacct_abc"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("/api/google/accounts/gacct_abc");
  });

  test("accounts remove without an id rejects with usage", async () => {
    stubFetch();
    await expect(connector(makeCtx(["connector", "accounts", "remove"]))).rejects.toThrow(
      /Usage: gini connector accounts remove/
    );
  });

  test("accounts add does NOT hit the API and prints chat guidance", async () => {
    const calls = stubFetch();
    await connector(makeCtx(["connector", "accounts", "add"]));
    expect(calls).toHaveLength(0);
  });

  test("accounts with an unknown action rejects with usage", async () => {
    stubFetch();
    await expect(connector(makeCtx(["connector", "accounts", "bogus"]))).rejects.toThrow(
      /Usage: gini connector accounts/
    );
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join("/tmp/gini-connector-cli-tests", `${process.pid}`, "instances", "test-instance");
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
