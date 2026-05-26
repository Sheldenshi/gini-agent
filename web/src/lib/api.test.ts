import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, HttpError } from "./api";

// api() wraps fetch with an HttpError-vs-network-error contract that
// downstream callers (TunnelSettingsCard's self-severing race) rely
// on. The hazard pinned here: response.json() must NOT run before
// response.ok is checked. If a reverse proxy returns a 502 with an
// HTML body, parsing the body first throws SyntaxError, which is
// indistinguishable from a network failure to callers that branch on
// `instanceof HttpError`. The bug surfaced as a false "Tunnel
// disabled" toast on real upstream errors.

const originalFetch = globalThis.fetch;

function stubFetch(response: Response): void {
  // typeof fetch carries a `preconnect` property the stub doesn't
  // need; route through `unknown` so we don't have to shape-match it.
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api", () => {
  test("returns parsed JSON on 200", async () => {
    stubFetch(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const result = await api<{ hello: string }>("/anything");
    expect(result).toEqual({ hello: "world" });
  });

  test("throws HttpError with the parsed error message on 500 + JSON body", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "foo" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );
    let caught: unknown;
    try {
      await api("/anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).message).toBe("foo");
    expect((caught as HttpError).status).toBe(500);
  });

  test("throws HttpError with the raw text on 500 + text/plain body (not SyntaxError)", async () => {
    // The body is not valid JSON, so json() would throw SyntaxError
    // if it ran first. The fix path must fall back to text().
    stubFetch(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" }
      })
    );
    let caught: unknown;
    try {
      await api("/anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).message).toContain("Internal Server Error");
    expect((caught as HttpError).status).toBe(500);
  });

  test("throws HttpError (not SyntaxError) on 502 with HTML body", async () => {
    // The 502-from-a-reverse-proxy case that motivated the fix. An
    // HTML body cannot be parsed as JSON; without the ok-first guard
    // and text fallback this would propagate a SyntaxError that
    // resolveSelfSeveringDisable would mis-classify as a network
    // failure and toast "Tunnel disabled" while the tunnel is up.
    stubFetch(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" }
      })
    );
    let caught: unknown;
    try {
      await api("/anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as HttpError).status).toBe(502);
  });

  test("falls back to 'HTTP <status>' when error body is empty", async () => {
    // Both json() and text() yield nothing useful; the message
    // should still be a stable HttpError tag rather than crashing.
    stubFetch(
      new Response("", {
        status: 504,
        headers: { "content-type": "text/plain" }
      })
    );
    let caught: unknown;
    try {
      await api("/anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).message).toBe("HTTP 504");
    expect((caught as HttpError).status).toBe(504);
  });
});
