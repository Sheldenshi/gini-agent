import { describe, expect, test } from "bun:test";
import { canonicalizePath, noTrailingSlash } from "./canonicalize";

function pass(input: string): string {
  const r = canonicalizePath(input);
  if (!r.ok) throw new Error(`expected ok for ${input}, got reason=${r.reason}`);
  return r.path;
}

function reason(input: string): string {
  const r = canonicalizePath(input);
  if (r.ok) throw new Error(`expected reject for ${input}, got ok path=${r.path}`);
  return r.reason;
}

describe("canonicalizePath", () => {
  test("preserves a simple absolute path", () => {
    expect(pass("/api/runtime/tunnel")).toBe("/api/runtime/tunnel");
  });

  test("decodes percent-encoded characters to fixed point", () => {
    expect(pass("/api/runtime/%74unnel")).toBe("/api/runtime/tunnel");
  });

  test("decodes doubly-encoded segments", () => {
    expect(pass("/api/runtime/%2570airing")).toBe("/api/runtime/pairing");
  });

  test("rejects path traversal", () => {
    expect(reason("/api/runtime/../tunnel")).toBe("traversal");
  });

  test("rejects doubly-encoded path traversal", () => {
    expect(reason("/api/runtime/%252e%252e/tunnel")).toBe("traversal");
  });

  test("rejects single-dot segment", () => {
    expect(reason("/api/runtime/./tunnel")).toBe("dot-segment");
  });

  test("rejects percent-encoded single-dot segment", () => {
    expect(reason("/api/runtime/%2e/tunnel")).toBe("dot-segment");
  });

  test("rejects duplicate interior slashes", () => {
    expect(reason("/api/runtime//tunnel")).toBe("duplicate-slash");
  });

  test("rejects backslash", () => {
    expect(reason("/api/runtime\\tunnel")).toBe("backslash-or-nul");
  });

  test("rejects NUL byte", () => {
    expect(reason("/api/runtime/tu\0nnel")).toBe("backslash-or-nul");
  });

  test("rejects encoded question mark (path-vs-query split)", () => {
    expect(reason("/api/runtime/tunnel%3Fqr")).toBe("embedded-delimiter");
  });

  test("rejects encoded hash", () => {
    expect(reason("/api/runtime/tunnel%23foo")).toBe("embedded-delimiter");
  });

  test("rejects malformed percent-encoding", () => {
    expect(reason("/api/runtime/%ZZ")).toBe("malformed-percent-encoding");
  });

  test("preserves a single trailing slash", () => {
    const r = canonicalizePath("/api/runtime/tunnel/");
    expect(r.ok).toBe(true);
    expect(r.ok && r.hadTrailingSlash).toBe(true);
  });

  test("collapses multiple trailing slashes to one", () => {
    const r = canonicalizePath("/api/runtime/tunnel///");
    expect(r.ok).toBe(true);
    expect(r.ok && r.path).toBe("/api/runtime/tunnel/");
  });

  test("preserves bare slash", () => {
    expect(pass("/")).toBe("/");
  });

  test("rejects too-long input", () => {
    expect(reason("/" + "a".repeat(5000))).toBe("too-long");
  });

  test("rejects decode that does not stabilize within the cap", () => {
    // Stage a deeply nested encoding that doubles each round.
    let v = "%2525"; // -> %25 -> %25 (stable after one round)
    for (let i = 0; i < 12; i += 1) v = encodeURIComponent(v);
    const r = canonicalizePath(`/${v}`);
    // either stabilizes to something benign or rejects with too-long; both
    // are acceptable. The reason here is whichever fires first.
    expect(["decode-not-stable", "too-long", "residual-percent", "malformed-percent-encoding"]).toContain(
      r.ok ? "ok" : r.reason
    );
  });
});

describe("noTrailingSlash", () => {
  test("strips a single trailing slash", () => {
    expect(noTrailingSlash("/api/runtime/tunnel/")).toBe("/api/runtime/tunnel");
  });

  test("preserves bare slash", () => {
    expect(noTrailingSlash("/")).toBe("/");
  });

  test("leaves unsuffixed path unchanged", () => {
    expect(noTrailingSlash("/api/runtime/tunnel")).toBe("/api/runtime/tunnel");
  });
});
