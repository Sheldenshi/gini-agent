// Coverage for resolveImageSource — the platform branch that lets a gateway
// upload render with bearer auth on BOTH native and web. RN Web's <img> can't
// send an Authorization header, so on web we render a fetched blob URL instead
// (and nothing until it resolves); native passes headers through directly.

import { describe, expect, test } from "bun:test";
import { resolveImageSource } from "./authed-image-source";

const HDR = { Authorization: "Bearer t" };
const URI = "http://gw.local/api/uploads/up_1";

describe("resolveImageSource", () => {
  test("native passes the direct uri with bearer headers", () => {
    expect(resolveImageSource("ios", URI, HDR, null)).toEqual({ uri: URI, headers: HDR });
    expect(resolveImageSource("android", URI, HDR, null)).toEqual({ uri: URI, headers: HDR });
  });

  test("web renders the resolved blob url, header-free", () => {
    expect(resolveImageSource("web", URI, HDR, "blob:abc")).toEqual({ uri: "blob:abc" });
  });

  test("web returns undefined while the blob is still loading (no header-less request)", () => {
    expect(resolveImageSource("web", URI, HDR, null)).toBeUndefined();
  });
});
