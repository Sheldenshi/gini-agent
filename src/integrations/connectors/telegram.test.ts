import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { probeTelegram, telegramApiUrl, telegramProvider } from "./telegram";

const ROOT = "/tmp/gini-telegram-connector-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

describe("probeTelegram", () => {
  test("returns ok and bot username on success", async () => {
    mockFetch(async (url) => {
      expect(url).toContain("/getMe");
      return new Response(
        JSON.stringify({ ok: true, result: { id: 42, username: "gini_test_bot", first_name: "Gini Test" } }),
        { status: 200 }
      );
    });
    const result = await probeTelegram("12345:ABCDEF");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bot.username).toBe("gini_test_bot");
      expect(result.bot.id).toBe(42);
    }
  });

  test("HTTP 401 surfaces the rotate-token message", async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const result = await probeTelegram("bad-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("rotate it via connectors");
    }
  });

  test("non-401 HTTP failures bubble the status code", async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: false }), { status: 502 }));
    const result = await probeTelegram("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 502");
    }
  });

  test("missing bot data on a 200 response is treated as failure", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    );
    const result = await probeTelegram("token");
    expect(result.ok).toBe(false);
  });
});

describe("telegramProvider.probe", () => {
  test("returns the @username on success", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ ok: true, result: { id: 99, username: "myhandle" } }), { status: 200 })
    );
    const result = await telegramProvider.probe!({
      config: {} as never,
      connectorId: "id_test",
      resolveSecret: async () => "token",
      metadata: {}
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Authenticated as @myhandle");
  });

  test("returns failure when secret is missing", async () => {
    const result = await telegramProvider.probe!({
      config: {} as never,
      connectorId: "id_test",
      resolveSecret: async () => undefined,
      metadata: {}
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing");
  });
});

describe("telegramApiUrl", () => {
  test("interpolates token into the bot path", () => {
    const url = telegramApiUrl("12345:ABCDEF", "getMe");
    expect(url).toBe("https://api.telegram.org/bot12345:ABCDEF/getMe");
  });
});
