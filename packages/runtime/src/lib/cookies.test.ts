import { describe, expect, test } from "bun:test";
import { cookieValue, parseCookies, serializeCookie } from "./cookies";

describe("parseCookies", () => {
  test("returns empty for missing header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  test("parses a single pair", () => {
    expect(parseCookies("gini_session=abc")).toEqual({ gini_session: "abc" });
  });

  test("parses multiple pairs with whitespace", () => {
    expect(parseCookies("a=1; b=2 ;  c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("keeps everything after the first = in the value", () => {
    expect(parseCookies("token=a=b=c")).toEqual({ token: "a=b=c" });
  });

  test("URL-decodes values", () => {
    expect(parseCookies("x=a%20b%3Dc")).toEqual({ x: "a b=c" });
  });

  test("falls back to the raw value on malformed percent-encoding", () => {
    expect(parseCookies("x=%E0%A4%A")).toEqual({ x: "%E0%A4%A" });
  });

  test("skips segments without = and empty names", () => {
    expect(parseCookies("novalue; =orphan; good=1")).toEqual({ good: "1" });
  });

  test("later duplicate wins", () => {
    expect(parseCookies("a=1; a=2")).toEqual({ a: "2" });
  });
});

describe("cookieValue", () => {
  test("reads a named cookie off a request", () => {
    const request = new Request("https://x.test", { headers: { cookie: "gini_session=tok; other=1" } });
    expect(cookieValue(request, "gini_session")).toBe("tok");
    expect(cookieValue(request, "missing")).toBeUndefined();
  });

  test("undefined when no cookie header", () => {
    expect(cookieValue(new Request("https://x.test"), "gini_session")).toBeUndefined();
  });
});

describe("serializeCookie", () => {
  test("encodes the value and emits no attributes by default", () => {
    expect(serializeCookie("a", "b c")).toBe("a=b%20c");
  });

  test("emits the full attribute set in order", () => {
    expect(
      serializeCookie("gini_session", "tok", {
        path: "/",
        domain: "x.test",
        maxAge: 100.9,
        sameSite: "Lax",
        secure: true,
        httpOnly: true
      })
    ).toBe("gini_session=tok; Path=/; Domain=x.test; Max-Age=100; SameSite=Lax; Secure; HttpOnly");
  });

  test("Max-Age=0 clears the cookie", () => {
    expect(serializeCookie("gini_session", "", { path: "/", maxAge: 0, httpOnly: true })).toBe(
      "gini_session=; Path=/; Max-Age=0; HttpOnly"
    );
  });
});
