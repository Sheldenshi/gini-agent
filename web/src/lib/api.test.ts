// Tests for the api() fetch helper's body parsing and error tagging. The
// global fetch is stubbed per test; the contract under test is that NO
// response shape — empty body, truncated JSON, HTML error page — ever
// escapes as a raw SyntaxError ("Unexpected end of JSON input"), and that
// the BFF's gateway-down 503 envelope is tagged `unreachable` so callers can
// render it as a transient reconnect instead of a hard failure.

import { afterEach, describe, expect, test } from "bun:test";
import {
  api,
  fetchWorkspaceFile,
  fileInlineUrl,
  fileRawUrl,
  streamUrl,
  uploadImage,
  uploadUrl,
  type ApiError
} from "./api";
import { GATEWAY_RESTARTING_MESSAGE, GATEWAY_UNREACHABLE_CODE } from "./gateway-codes";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

function stubFetch(body: string, init: ResponseInit = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ input: String(input), init: requestInit });
    return new Response(body, init);
  }) as typeof fetch;
  return calls;
}

async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error("expected the api() call to reject");
}

describe("api — success shapes", () => {
  test("2xx JSON body parses and returns", async () => {
    const calls = stubFetch(JSON.stringify({ ok: true, items: [1, 2] }), { status: 200 });
    const value = await api<{ ok: boolean; items: number[] }>("/jobs");
    expect(value.items).toEqual([1, 2]);
    expect(calls[0]!.input).toBe("/api/runtime/jobs");
    // The helper pins JSON content-type and preserves caller headers.
    expect((calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("caller headers are merged over the content-type default", async () => {
    const calls = stubFetch("{}", { status: 200 });
    await api("/jobs", { headers: { "x-extra": "1" } });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-extra"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("2xx empty body returns null instead of throwing a parse error", async () => {
    stubFetch("", { status: 200 });
    await expect(api("/jobs")).resolves.toBeNull();
  });

  test("2xx non-JSON body throws a tagged transport error, not a SyntaxError", async () => {
    stubFetch("<!doctype html>nope", { status: 200 });
    const error = await captureApiError(api("/jobs"));
    expect(error.message).toContain("unreadable response");
    expect(error.status).toBe(200);
    expect(error.unreachable).toBeUndefined();
  });
});

describe("api — gateway error envelopes", () => {
  test("non-2xx {error} surfaces the message with the status tagged", async () => {
    stubFetch(JSON.stringify({ error: "No such session." }), { status: 404 });
    const error = await captureApiError(api("/chat/nope/blocks"));
    expect(error.message).toBe("No such session.");
    expect(error.status).toBe(404);
    expect(error.unreachable).toBeUndefined();
  });

  test("non-2xx {ok:false, message} (runtime-action envelope) surfaces the message", async () => {
    stubFetch(JSON.stringify({ ok: false, message: "Set the secret first." }), { status: 400 });
    const error = await captureApiError(api("/connectors/x/fill"));
    expect(error.message).toBe("Set the secret first.");
    expect(error.status).toBe(400);
  });

  test("4xx with an empty body falls back to HTTP <status> and is NOT unreachable", async () => {
    stubFetch("", { status: 400 });
    const error = await captureApiError(api("/jobs"));
    expect(error.message).toBe("HTTP 400");
    expect(error.unreachable).toBeUndefined();
  });
});

describe("api — gateway-down shapes", () => {
  test("the BFF's 503 gateway_unreachable envelope is tagged unreachable", async () => {
    // Built from the SAME constants the BFF envelope uses (gateway-codes.ts),
    // so a drift in either side breaks this test instead of silently
    // regressing the client's unreachable detection.
    stubFetch(JSON.stringify({ error: GATEWAY_RESTARTING_MESSAGE, code: GATEWAY_UNREACHABLE_CODE }), {
      status: 503
    });
    const error = await captureApiError(api("/status"));
    expect(error.unreachable).toBe(true);
    expect(error.status).toBe(503);
    expect(error.message).toBe(GATEWAY_RESTARTING_MESSAGE);
  });

  test("a 5xx with an EMPTY body is treated as unreachable with a friendly message", async () => {
    stubFetch("", { status: 500 });
    const error = await captureApiError(api("/status"));
    expect(error.unreachable).toBe(true);
    expect(error.message).toBe(GATEWAY_RESTARTING_MESSAGE);
  });

  test("a 5xx with a non-JSON body (proxy error page) is treated as unreachable", async () => {
    stubFetch("<html>Bad Gateway</html>", { status: 502 });
    const error = await captureApiError(api("/status"));
    expect(error.unreachable).toBe(true);
    expect(error.status).toBe(502);
  });

  test("a 5xx with a STRUCTURED gateway error body stays a normal tagged error", async () => {
    stubFetch(JSON.stringify({ error: "Provider exploded." }), { status: 500 });
    const error = await captureApiError(api("/status"));
    expect(error.message).toBe("Provider exploded.");
    expect(error.unreachable).toBeUndefined();
  });
});

describe("uploadImage", () => {
  const file = new File(["pixels"], "x.png", { type: "image/png" });

  test("posts multipart and returns the upload ref", async () => {
    const calls = stubFetch(JSON.stringify({ id: "up_1", mimeType: "image/png", size: 6 }), { status: 200 });
    const ref = await uploadImage(file);
    expect(ref.id).toBe("up_1");
    expect(calls[0]!.input).toBe("/api/runtime/uploads");
    expect(calls[0]!.init!.body).toBeInstanceOf(FormData);
  });

  test("non-2xx {error} surfaces the message", async () => {
    stubFetch(JSON.stringify({ error: "Upload too large." }), { status: 413 });
    await expect(uploadImage(file)).rejects.toThrow("Upload too large.");
  });

  test("non-2xx unparseable body falls back to HTTP <status>", async () => {
    stubFetch("", { status: 503 });
    await expect(uploadImage(file)).rejects.toThrow("HTTP 503");
  });
});

describe("URL helpers", () => {
  test("streamUrl / uploadUrl / fileRawUrl / fileInlineUrl build BFF paths", () => {
    expect(streamUrl("/events/stream")).toBe("/api/runtime/events/stream");
    expect(uploadUrl("a b")).toBe("/api/runtime/uploads/a%20b");
    expect(fileRawUrl("notes/x.txt")).toBe("/api/runtime/files?path=notes%2Fx.txt&raw=1");
    expect(fileInlineUrl("img.png")).toBe("/api/runtime/files?path=img.png&raw=1&inline=1");
  });

  test("fetchWorkspaceFile requests the encoded path through api()", async () => {
    const calls = stubFetch(JSON.stringify({ path: "notes/x.txt", bytes: 1 }), { status: 200 });
    const value = await fetchWorkspaceFile("notes/x.txt");
    expect(value.path).toBe("notes/x.txt");
    expect(calls[0]!.input).toBe("/api/runtime/files?path=notes%2Fx.txt");
  });
});
