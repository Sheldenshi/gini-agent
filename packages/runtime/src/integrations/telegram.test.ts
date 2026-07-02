import { describe, expect, test } from "bun:test";
import { createTelegramClient, extractIncomingPayload, extractIncomingText, type TelegramFetch } from "./telegram";

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

  test("sendChatAction posts chat_id and action and returns true", async () => {
    let payload: Record<string, unknown> = {};
    let observedUrl = "";
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((url, init) => {
        observedUrl = url;
        payload = JSON.parse(String(init.body));
        return { ok: true, result: true };
      })
    });
    const ok = await client.sendChatAction(7, "typing");
    expect(observedUrl.endsWith("/botTOK/sendChatAction")).toBe(true);
    expect(payload).toEqual({ chat_id: 7, action: "typing" });
    expect(ok).toBe(true);
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

  test("sendPhoto with a URL goes out as JSON with chat_id, photo, and caption", async () => {
    let payload: Record<string, unknown> = {};
    let observedContentType = "";
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedContentType = ((init.headers ?? {}) as Record<string, string>)["content-type"] ?? "";
        payload = JSON.parse(String(init.body));
        return {
          ok: true,
          result: { message_id: 9, date: 0, chat: { id: payload.chat_id, type: "private" } }
        };
      })
    });
    await client.sendPhoto(42, { kind: "url", url: "https://x.test/p.png" }, {
      caption: "cap",
      parseMode: "MarkdownV2"
    });
    expect(observedContentType).toContain("application/json");
    expect(payload).toEqual({
      chat_id: 42,
      photo: "https://x.test/p.png",
      caption: "cap",
      parse_mode: "MarkdownV2"
    });
  });

  test("sendPhoto with a fileId reuses the id without re-uploading", async () => {
    let payload: Record<string, unknown> = {};
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        payload = JSON.parse(String(init.body));
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } };
      })
    });
    await client.sendPhoto(1, { kind: "fileId", fileId: "ABC123" });
    expect(payload).toEqual({ chat_id: 1, photo: "ABC123" });
  });

  test("sendPhoto with bytes posts multipart/form-data and never sets its own content-type", async () => {
    let observedHeaders: Record<string, string> = {};
    let observedBody: unknown = undefined;
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedHeaders = (init.headers ?? {}) as Record<string, string>;
        observedBody = init.body;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } };
      })
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await client.sendPhoto(1, { kind: "bytes", bytes, filename: "x.png", contentType: "image/png" }, {
      caption: "hi"
    });
    // FormData lets fetch set the content-type automatically with the
    // boundary; if we ever hand-roll the header the boundary is wrong.
    expect(observedHeaders["content-type"]).toBeUndefined();
    expect(observedBody).toBeInstanceOf(FormData);
    const form = observedBody as FormData;
    expect(form.get("chat_id")).toBe("1");
    expect(form.get("caption")).toBe("hi");
    expect(form.get("photo")).toBeInstanceOf(Blob);
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

  test("sendMessage threads the caller's AbortSignal into fetch", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedSignal = init.signal as AbortSignal | undefined;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "hi" } };
      })
    });
    const controller = new AbortController();
    await client.sendMessage(1, "hi", { signal: controller.signal });
    expect(observedSignal).toBe(controller.signal);
  });

  test("sendMessage cancels in-flight fetch when the AbortSignal fires", async () => {
    // Mock a slow Telegram POST that respects the signal: when aborted
    // the underlying fetch rejects with AbortError, the client should
    // surface the abort up to the caller (the messaging layer marks
    // the outbound row failed).
    const client = createTelegramClient("TOK", {
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as TelegramFetch
    });
    const controller = new AbortController();
    const pending = client.sendMessage(1, "hi", { signal: controller.signal });
    // Fire abort while the fetch is parked.
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toThrow(/abort/i);
  });

  test("sendPhoto threads the AbortSignal through the JSON variant", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedSignal = init.signal as AbortSignal | undefined;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } };
      })
    });
    const controller = new AbortController();
    await client.sendPhoto(
      1,
      { kind: "url", url: "https://x.test/p.png" },
      { signal: controller.signal }
    );
    expect(observedSignal).toBe(controller.signal);
  });

  test("sendPhoto threads the AbortSignal through the multipart variant", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        observedSignal = init.signal as AbortSignal | undefined;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } };
      })
    });
    const controller = new AbortController();
    const bytes = new Uint8Array([1, 2, 3]);
    await client.sendPhoto(
      1,
      { kind: "bytes", bytes, filename: "x.png", contentType: "image/png" },
      { signal: controller.signal }
    );
    expect(observedSignal).toBe(controller.signal);
  });
});

describe("getFile / downloadFile", () => {
  test("getFile returns the file_path the Bot API hands back", async () => {
    let payload: Record<string, unknown> = {};
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((_url, init) => {
        payload = JSON.parse(String(init.body));
        return {
          ok: true,
          result: { file_id: "FID", file_unique_id: "FID", file_path: "photos/FID.jpg" }
        };
      })
    });
    const file = await client.getFile("FID");
    expect(payload).toEqual({ file_id: "FID" });
    expect(file.file_path).toBe("photos/FID.jpg");
  });

  test("downloadFile hits the /file/bot<token>/<path> base and returns raw bytes", async () => {
    let observedUrl = "";
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch((url) => {
        observedUrl = url;
        const bytes = new Uint8Array([7, 8, 9]);
        return new Response(bytes, { status: 200 });
      })
    });
    const buf = await client.downloadFile("photos/x.jpg");
    expect(observedUrl).toContain("/file/botTOK/photos/x.jpg");
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([7, 8, 9]));
  });

  test("downloadFile raises on non-2xx responses", async () => {
    const client = createTelegramClient("TOK", {
      fetchImpl: stubFetch(() => new Response("nope", { status: 404 }))
    });
    await expect(client.downloadFile("missing")).rejects.toThrow(/HTTP 404/);
  });
});

describe("extractIncomingPayload", () => {
  test("returns text-only payloads with chatType + messageId", () => {
    const out = extractIncomingPayload({
      update_id: 1,
      message: {
        message_id: 17,
        date: 0,
        chat: { id: 9, type: "private" },
        text: "hi",
        from: { id: 1, is_bot: false, first_name: "Shelden", username: "shelden" }
      }
    });
    expect(out).toEqual({
      chatId: 9,
      chatType: "private",
      messageId: 17,
      text: "hi",
      photo: undefined,
      senderHandle: "@shelden"
    });
  });

  test("picks the largest PhotoSize for photo updates", () => {
    const photo = [
      { file_id: "s", file_unique_id: "s", width: 90, height: 60 },
      { file_id: "m", file_unique_id: "m", width: 320, height: 240 },
      { file_id: "l", file_unique_id: "l", width: 1280, height: 960 }
    ];
    const out = extractIncomingPayload({
      update_id: 2,
      message: { message_id: 2, date: 0, chat: { id: 1, type: "private" }, photo, caption: "look" }
    });
    expect(out?.photo?.file_id).toBe("l");
    expect(out?.text).toBe("look");
    expect(out?.chatType).toBe("private");
  });

  test("returns undefined for empty updates", () => {
    expect(extractIncomingPayload({ update_id: 3 })).toBeUndefined();
  });

  test("strips a leading bot mention so the agent sees clean text", () => {
    const out = extractIncomingPayload(
      {
        update_id: 4,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: -1, type: "supergroup", title: "team" },
          text: "@gini_agent_bot what's the weather?"
        }
      },
      { botUsername: "gini_agent_bot" }
    );
    expect(out?.text).toBe("what's the weather?");
    expect(out?.chatType).toBe("supergroup");
  });

  test("strips the /cmd@botname suffix common in group chats", () => {
    const out = extractIncomingPayload(
      {
        update_id: 5,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: -1, type: "group" },
          text: "/start@gini_agent_bot please"
        }
      },
      { botUsername: "gini_agent_bot" }
    );
    expect(out?.text).toBe("/start please");
  });

  test("leaves other users' mentions intact — only the bot's handle is stripped", () => {
    const out = extractIncomingPayload(
      {
        update_id: 6,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: -1, type: "supergroup" },
          text: "@gini_agent_bot ping @alice about the deploy"
        }
      },
      { botUsername: "gini_agent_bot" }
    );
    expect(out?.text).toBe("ping @alice about the deploy");
  });

  test("falls back to first_name when sender has no @username", () => {
    const out = extractIncomingPayload({
      update_id: 7,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: -1, type: "group" },
        text: "hello",
        from: { id: 2, is_bot: false, first_name: "Alex" }
      }
    });
    expect(out?.senderHandle).toBe("Alex");
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
