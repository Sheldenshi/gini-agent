// Decode the live QR through jsQR to prove whether the encoder output is
// actually scannable end-to-end. We render the QR matrix directly to an
// RGBA buffer (no canvas dep) and feed it through jsQR — the same library
// browsers / scanners use under the hood.

import jsQR from "jsqr";
import { encodeQr } from "../src/runtime/tunnel";

const url = process.argv[2] ?? "https://example.trycloudflare.com/abcdefghijklmnopqrstuvwxyz012345/";
const matrix = encodeQr(url);
const QUIET = 4;
const SCALE = 4;
const total = (matrix.size + QUIET * 2) * SCALE;
const buf = new Uint8ClampedArray(total * total * 4);
for (let py = 0; py < total; py += 1) {
  for (let px = 0; px < total; px += 1) {
    const mx = Math.floor(px / SCALE) - QUIET;
    const my = Math.floor(py / SCALE) - QUIET;
    const dark = mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size && matrix.modules[my]![mx]!;
    const v = dark ? 0 : 255;
    const o = (py * total + px) * 4;
    buf[o] = v; buf[o + 1] = v; buf[o + 2] = v; buf[o + 3] = 255;
  }
}
const result = jsQR(buf, total, total);
if (!result) {
  console.error(`DECODE FAILED — input=${JSON.stringify(url)} matrix=${matrix.size}x${matrix.size}`);
  process.exit(1);
}
console.log(`DECODE OK — version inferred ${(matrix.size - 17) / 4}`);
console.log(`expected: ${url}`);
console.log(`got:      ${result.data}`);
if (result.data !== url) {
  console.error("MISMATCH — encoder is corrupting the payload");
  process.exit(2);
}
console.log("MATCH");
