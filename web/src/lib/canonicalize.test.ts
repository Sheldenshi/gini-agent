// Mirror of src/runtime/tunnel/canonicalize.test.ts — pins the web copy
// against the same invariants. Both files are tested independently so a
// drift between the two (e.g., a developer edits one and forgets the
// other) is caught by CI. See docs/adr/tunnel-and-mobile-access.md
// "Architecture (summary)".
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

describe("web canonicalizePath", () => {
  test("simple path", () => {
    expect(pass("/api/runtime/tunnel")).toBe("/api/runtime/tunnel");
  });
  test("decodes percent-encoded characters", () => {
    expect(pass("/api/runtime/%74unnel")).toBe("/api/runtime/tunnel");
  });
  test("decodes doubly-encoded", () => {
    expect(pass("/api/runtime/%2570airing")).toBe("/api/runtime/pairing");
  });
  test("rejects traversal", () => {
    expect(reason("/api/runtime/../tunnel")).toBe("traversal");
  });
  test("rejects doubly-encoded traversal", () => {
    expect(reason("/api/runtime/%252e%252e/tunnel")).toBe("traversal");
  });
  test("rejects single-dot segment", () => {
    expect(reason("/api/runtime/./tunnel")).toBe("dot-segment");
  });
  test("rejects duplicate interior slash", () => {
    expect(reason("/api/runtime//tunnel")).toBe("duplicate-slash");
  });
  test("rejects backslash", () => {
    expect(reason("/api/runtime\\tunnel")).toBe("backslash-or-nul");
  });
  test("rejects embedded question mark", () => {
    expect(reason("/api/runtime/tunnel%3Fqr")).toBe("embedded-delimiter");
  });
  test("rejects embedded hash", () => {
    expect(reason("/api/runtime/tunnel%23foo")).toBe("embedded-delimiter");
  });
  test("rejects malformed percent", () => {
    expect(reason("/api/runtime/%ZZ")).toBe("malformed-percent-encoding");
  });
  test("preserves bare slash", () => {
    expect(pass("/")).toBe("/");
  });
  test("preserves single trailing slash", () => {
    const r = canonicalizePath("/api/runtime/tunnel/");
    expect(r.ok).toBe(true);
    expect(r.ok && r.hadTrailingSlash).toBe(true);
  });
  test("collapses multiple trailing slashes to one", () => {
    const r = canonicalizePath("/api/runtime/tunnel///");
    expect(r.ok).toBe(true);
    expect(r.ok && r.path).toBe("/api/runtime/tunnel/");
  });
  test("rejects over-length input", () => {
    expect(reason("/" + "a".repeat(5000))).toBe("too-long");
  });
});

describe("web noTrailingSlash", () => {
  test("strips trailing slash", () => {
    expect(noTrailingSlash("/api/runtime/tunnel/")).toBe("/api/runtime/tunnel");
  });
  test("leaves bare slash alone", () => {
    expect(noTrailingSlash("/")).toBe("/");
  });
});
