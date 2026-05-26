// Note: this test asserts only the canonicalization helper, isolated from
// Next.js routing. Hitting the full handler requires booting the BFF.
import { describe, expect, test } from "bun:test";
import { canonicalFirstSegmentIsTunnel } from "./canonical";

describe("BFF catch-all tunnel guard", () => {
  test("literal tunnel segment is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["tunnel"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tunnel", "qr.svg"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tunnel", "qr.txt"])).toBe(true);
  });

  test("case-folded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["TUNNEL"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["TuNnEl", "qr.svg"])).toBe(true);
  });

  test("single-encoded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["%74unnel"])).toBe(true);
    expect(canonicalFirstSegmentIsTunnel(["tun%6Eel", "qr.svg"])).toBe(true);
  });

  test("double-encoded tunnel is recognized", () => {
    expect(canonicalFirstSegmentIsTunnel(["%2574unnel"])).toBe(true);
  });

  test("unrelated segments are not flagged", () => {
    expect(canonicalFirstSegmentIsTunnel(["status"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel(["tunneled"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel(["tunnels"])).toBe(false);
    expect(canonicalFirstSegmentIsTunnel([])).toBe(false);
  });

  test("malformed percent escapes are not flagged", () => {
    expect(canonicalFirstSegmentIsTunnel(["%ZZunnel"])).toBe(false);
  });
});
