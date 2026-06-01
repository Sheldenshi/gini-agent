// QR encoder wrappers. We delegate to the `qrcode` npm package — its
// encoder is conformant with ISO/IEC 18004 and is decoded successfully by
// jsQR / iOS Camera / every commodity scanner. An earlier in-tree
// implementation passed structural unit tests (matrix shape, format-bit
// placement, RS polynomial values) but produced output that jsQR refused
// to decode in practice. The bug was subtle enough that fixing it in
// isolation isn't worth the maintenance cost — a maintained dep is
// strictly better for a commodity output format.

import QRCode from "qrcode";

export interface QrMatrix {
  size: number;
  modules: ReadonlyArray<ReadonlyArray<boolean>>;
}

const QUIET_ZONE = 4;
// Error-correction level M. Matches the level the hand-rolled encoder was
// using. ISO/IEC 18004 Table 11 specifies ECL-M's redundancy as 15% of the
// codewords recoverable; pixel density is similar to ECL-L but with
// stronger camera-distortion resilience.
const ECL: QRCode.QRCodeErrorCorrectionLevel = "M";

export function encodeQr(text: string): QrMatrix {
  // `qrcode.create` returns a bit matrix where `data[i]` is 1 for dark and 0
  // for light. The matrix already includes the function patterns + masking;
  // it does NOT include the quiet zone (we add that in the SVG/ANSI
  // renderers, same convention as the old encoder).
  const code = QRCode.create(text, { errorCorrectionLevel: ECL });
  const size = code.modules.size;
  const data = code.modules.data;
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      row.push(data[y * size + x] === 1);
    }
    modules.push(row);
  }
  return { size, modules };
}

export function renderQrSvg(text: string, scale = 8): string {
  const { size, modules } = encodeQr(text);
  const dim = (size + QUIET_ZONE * 2) * scale;
  const rects: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y]![x]) continue;
      const px = (x + QUIET_ZONE) * scale;
      const py = (y + QUIET_ZONE) * scale;
      rects.push(`<rect x="${px}" y="${py}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

/** Render an ANSI half-block QR for a terminal. Two cells per character: top
 *  half (U+2580) when only the top row is dark, bottom half (U+2584) when
 *  only the bottom row is dark, full block (U+2588) when both, and a plain
 *  space when neither. Includes a 4-cell quiet zone.
 *
 *  Terminals tend to be dark-on-light or light-on-dark; the half-block
 *  convention here inverts the matrix so DARK QR modules render as space and
 *  LIGHT modules render as filled glyphs — the readable orientation on a
 *  typical dark terminal background for iPhone Camera scanning off the
 *  operator's screen. */
export function renderQrAnsi(text: string): string {
  const { size, modules } = encodeQr(text);
  const total = size + QUIET_ZONE * 2;
  const padded: boolean[][] = [];
  for (let y = 0; y < total; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < total; x += 1) {
      const sx = x - QUIET_ZONE;
      const sy = y - QUIET_ZONE;
      row.push(sx >= 0 && sy >= 0 && sx < size && sy < size ? modules[sy]![sx]! : false);
    }
    padded.push(row);
  }
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x += 1) {
      const top = padded[y]![x]!;
      const bottom = y + 1 < total ? padded[y + 1]![x]! : false;
      if (!top && !bottom) line += "█";
      else if (!top && bottom) line += "▀";
      else if (top && !bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
