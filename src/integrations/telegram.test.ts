import { describe, expect, test } from "bun:test";
import { createTelegramClient, extractIncomingText, type TelegramFetch } from "./telegram";

function stubFetch(handler: (url: string, init: RequestInit) => unknown): TelegramFetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const result = handler(url, init ?? {});
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as TelegramFetch;
}

describe("telegram client", () => {
  test("getMe hits /bot<token>/getMe and unwraps result", async () => {
    let observed = "";
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((url) => {
        observed = url;
        return { ok: true, result: { id: 99, is_bot: true, username: "ginibot" } };
      })
    });
    const me = await client.getMe();
    expect(observed.endsWith("/botTOK/getMe")).toBe(true);
    expect(me.username).toBe("ginibot");
  });

  test("sendMessage posts chat_id and text and returns the message", async () => {
    let payload: Record<string, unknown> = {};
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        payload = JSON.parse(String(init.body));
        return {
          ok: true,
          result: { message_id: 7, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text }
        };
      })
    });
    const msg = await client.sendMessage(42, "hi");
    expect(payload).toEqual({ chat_id: 42, text: "hi" });
    expect(msg.message_id).toBe(7);
  });

  test("getUpdates forwards offset and timeout, restricts allowed_updates", async () => {
    let payload: Record<string, unknown> = {};
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        payload = JSON.parse(String(init.body));
        return { ok: true, result: [] };
      })
    });
    await client.getUpdates(101, 25);
    expect(payload).toEqual({ offset: 101, timeout: 25, allowed_updates: ["message"] });
  });

  test("getUpdates omits offset when undefined (first poll)", async () => {
    let payload: Record<string, unknown> = {};
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        payload = JSON.parse(String(init.body));
        return { ok: true, result: [] };
      })
    });
    await client.getUpdates(undefined, 1);
    expect(payload).toEqual({ timeout: 1, allowed_updates: ["message"] });
  });

  test("API-level failure (ok:false) raises with the description", async () => {
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch(
        () =>
          new Response(JSON.stringify({ ok: false, description: "Unauthorized", error_code: 401 }), {
            status: 401,
            headers: { "content-type": "application/json" }
          })
      )
    });
    await expect(client.getMe()).rejects.toThrow(/Unauthorized/);
  });

  test("non-JSON body still raises a clear error", async () => {
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch(() => new Response("bad gateway", { status: 502 }))
    });
    await expect(client.getMe()).rejects.toThrow(/non-JSON body/);
  });

  test("empty token is rejected up front", () => {
    expect(() => createTelegramClient("")).toThrow(/required/);
  });
});

describe("extractIncomingText", () => {
  test("returns text from a regular message", () => {
    const got = extractIncomingText({
      update_id: 1,
      message: { message_id: 2, date: 0, chat: { id: 55, type: "private" }, text: "hello" }
    });
    expect(got).toEqual({ chatId: 55, text: "hello" });
  });

  test("falls back to edited_message", () => {
    const got = extractIncomingText({
      update_id: 1,
      edited_message: { message_id: 2, date: 0, chat: { id: 55, type: "private" }, text: "fixed" }
    });
    expect(got).toEqual({ chatId: 55, text: "fixed" });
  });

  test("returns undefined when no text is present", () => {
    expect(extractIncomingText({ update_id: 1 })).toBeUndefined();
    expect(
      extractIncomingText({ update_id: 1, message: { message_id: 2, date: 0, chat: { id: 1, type: "private" } } })
    ).toBeUndefined();
  });
});
