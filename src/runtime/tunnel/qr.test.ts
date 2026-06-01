// QR encoder round-trip tests. Renders the encoder output to an RGBA pixel
// buffer and feeds it through jsQR — the same decoder iOS Camera (and
// every commodity scanner) uses under the hood. A previous in-tree
// encoder passed structural tests but failed decode on every real device,
// so the test contract is decode-or-fail, not module-counts-only.
import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";
import { encodeQr, renderQrAnsi, renderQrSvg } from "./qr";

function renderToRgba(text: string, scale = 4, quiet = 4): { buf: Uint8ClampedArray; total: number } {
  const { size, modules } = encodeQr(text);
  const total = (size + quiet * 2) * scale;
  const buf = new Uint8ClampedArray(total * total * 4);
  for (let py = 0; py < total; py += 1) {
    for (let px = 0; px < total; px += 1) {
      const mx = Math.floor(px / scale) - quiet;
      const my = Math.floor(py / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my]![mx]!;
      const v = dark ? 0 : 255;
      const o = (py * total + px) * 4;
      buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
    }
  }
  return { buf, total };
}

describe("encodeQr round-trip via jsQR", () => {
  test("decodes a short ASCII payload", () => {
    const input = "hi";
    const { buf, total } = renderToRgba(input);
    const result = jsQR(buf, total, total);
    expect(result).not.toBeNull();
    expect(result?.data).toBe(input);
  });

  test("decodes a typical bootstrap URL (32-char base64url secret + trycloudflare host)", () => {
    const input = "https://constant-contests-rochester-concentration.trycloudflare.com/8Zea6FDRac6QQeJ7OpOPwpA_PXiZJNEB/";
    const { buf, total } = renderToRgba(input);
    const result = jsQR(buf, total, total);
    expect(result).not.toBeNull();
    expect(result?.data).toBe(input);
  });

  test("decodes URLs containing reserved characters that exercise the byte mode", () => {
    const input = "https://example.com/path?x=1&y=2#frag";
    const { buf, total } = renderToRgba(input);
    const result = jsQR(buf, total, total);
    expect(result).not.toBeNull();
    expect(result?.data).toBe(input);
  });
});

describe("renderQrSvg / renderQrAnsi", () => {
  test("SVG is parseable + contains rect elements", () => {
    const svg = renderQrSvg("https://x.trycloudflare.com/abc/");
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<rect");
  });

  test("ANSI is a multi-line string of half-block characters", () => {
    const ansi = renderQrAnsi("https://x.trycloudflare.com/abc/");
    expect(ansi.split("\n").length).toBeGreaterThan(10);
    expect(/^[█▀▄ \n]+$/.test(ansi)).toBe(true);
  });
});
