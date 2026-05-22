// Minimal QR code generator. Encodes a UTF-8 string as a byte-mode QR
// symbol with error correction level L. Supports symbol versions 1 through
// 10, which gives a payload ceiling of 230 ISO-8859-1 bytes — comfortably
// above any realistic `https://*.trycloudflare.com/<secret>/` URL.
//
// References:
//   - ISO/IEC 18004:2015 §6 (encoding), §7 (Reed-Solomon), §8 (matrix)
//   - Project Nayuki's QR reference implementation. The data structures
//     mirror that prose closely so a reader who knows that source can
//     follow without ceremony. No code is copied verbatim.
//
// Why hand-rolled: the runtime ships zero new dependencies for this work.
// The QR spec is finite, the symbol size ceiling is bounded, and the
// rendering paths (ANSI block art, SVG, raw matrix) all derive from one
// shared bit matrix.

export type QrMatrix = readonly (readonly boolean[])[];

interface VersionParams {
  size: number;          // edge length in modules
  alignmentCenters: number[]; // module coordinates of alignment-pattern centers
  totalBytes: number;    // total codeword capacity (data + ecc) per ISO §9
  dataBytes: number;     // data codeword capacity at ECL=L
  eccBytes: number;      // EC codewords per block at ECL=L
  ecBlockGroups: Array<{ count: number; dataCodewords: number }>;
}

// Hard-coded table for versions 1..10 at error correction level L. Each
// row mirrors ISO/IEC 18004 Table 9. We only carry what the encoder needs;
// alignment centers come from Annex A.3 (Table E.1).
const VERSIONS: ReadonlyArray<VersionParams> = [
  { size: 21, alignmentCenters: [], totalBytes: 26, dataBytes: 19, eccBytes: 7, ecBlockGroups: [{ count: 1, dataCodewords: 19 }] },
  { size: 25, alignmentCenters: [6, 18], totalBytes: 44, dataBytes: 34, eccBytes: 10, ecBlockGroups: [{ count: 1, dataCodewords: 34 }] },
  { size: 29, alignmentCenters: [6, 22], totalBytes: 70, dataBytes: 55, eccBytes: 15, ecBlockGroups: [{ count: 1, dataCodewords: 55 }] },
  { size: 33, alignmentCenters: [6, 26], totalBytes: 100, dataBytes: 80, eccBytes: 20, ecBlockGroups: [{ count: 1, dataCodewords: 80 }] },
  { size: 37, alignmentCenters: [6, 30], totalBytes: 134, dataBytes: 108, eccBytes: 26, ecBlockGroups: [{ count: 1, dataCodewords: 108 }] },
  { size: 41, alignmentCenters: [6, 34], totalBytes: 172, dataBytes: 136, eccBytes: 18, ecBlockGroups: [{ count: 2, dataCodewords: 68 }] },
  { size: 45, alignmentCenters: [6, 22, 38], totalBytes: 196, dataBytes: 156, eccBytes: 20, ecBlockGroups: [{ count: 2, dataCodewords: 78 }] },
  { size: 49, alignmentCenters: [6, 24, 42], totalBytes: 242, dataBytes: 194, eccBytes: 24, ecBlockGroups: [{ count: 2, dataCodewords: 97 }] },
  { size: 53, alignmentCenters: [6, 26, 46], totalBytes: 292, dataBytes: 232, eccBytes: 30, ecBlockGroups: [{ count: 2, dataCodewords: 116 }] },
  { size: 57, alignmentCenters: [6, 28, 50], totalBytes: 346, dataBytes: 274, eccBytes: 18, ecBlockGroups: [{ count: 2, dataCodewords: 68 }, { count: 2, dataCodewords: 69 }] }
];

const MODE_BYTE = 0b0100;

// Format-info bits for ECL=L combined with each mask (0..7). Pre-computed:
// reading these from a table avoids re-deriving the BCH every encode.
// See ISO/IEC 18004 Table C.1; the values below are the 15-bit format
// strings with XOR mask 0x5412 already applied.
const FORMAT_INFO_L: readonly number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976
];

/**
 * Encode `payload` as a QR matrix sized to the smallest version 1..10 that
 * fits. Throws when the payload is too large for v10.
 */
export function encodeQr(payload: string): QrMatrix {
  const bytes = stringToBytes(payload);
  const version = chooseVersion(bytes.length);
  const params = VERSIONS[version - 1]!;

  // Build the bit stream: mode indicator + character count + data + terminator.
  const bits = new BitBuffer();
  bits.appendBits(MODE_BYTE, 4);
  bits.appendBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bits.appendBits(b, 8);
  // Terminator: up to four zero bits. Pad short codewords with the alternating
  // EC-prep pattern 0xEC, 0x11.
  const capacityBits = params.dataBytes * 8;
  const remaining = capacityBits - bits.length;
  bits.appendBits(0, Math.min(4, remaining));
  while (bits.length % 8 !== 0) bits.appendBits(0, 1);
  let pad = 0;
  while (bits.length < capacityBits) {
    bits.appendBits(pad === 0 ? 0xec : 0x11, 8);
    pad = pad ^ 1;
  }
  const dataCodewords = bits.toBytes();

  // Interleave per ISO §8.6. Each block group splits into blocks; each block
  // gets its own RS calculation. Then we interleave data codewords first,
  // then ecc codewords, column-major across blocks.
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let cursor = 0;
  for (const group of params.ecBlockGroups) {
    for (let blockIndex = 0; blockIndex < group.count; blockIndex += 1) {
      const block = dataCodewords.slice(cursor, cursor + group.dataCodewords);
      cursor += group.dataCodewords;
      blocks.push(block);
      eccBlocks.push(reedSolomon(block, params.eccBytes));
    }
  }
  const maxBlockLen = Math.max(...blocks.map((b) => b.length));
  const interleaved: number[] = [];
  for (let i = 0; i < maxBlockLen; i += 1) {
    for (const block of blocks) {
      if (i < block.length) interleaved.push(block[i]!);
    }
  }
  for (let i = 0; i < params.eccBytes; i += 1) {
    for (const ecc of eccBlocks) {
      interleaved.push(ecc[i]!);
    }
  }

  const matrix = buildMatrix(params, interleaved);
  return matrix;
}

/**
 * Render `matrix` as ANSI-art half-height block characters. Each terminal
 * row covers two QR rows, so for a v1 QR (21×21 modules + 2 padding on each
 * side = 25-cell edge) the rendered art occupies 13 lines.
 * Uses the upper/lower half block trick so the aspect ratio looks square.
 */
export function renderQrAnsi(matrix: QrMatrix, options: { padding?: number } = {}): string {
  const padding = options.padding ?? 2;
  const size = matrix.length;
  const total = size + padding * 2;
  const isOn = (x: number, y: number): boolean => {
    if (x < padding || y < padding || x >= size + padding || y >= size + padding) return false;
    return Boolean(matrix[y - padding]![x - padding]);
  };
  const out: string[] = [];
  for (let row = 0; row < total; row += 2) {
    let line = "";
    for (let col = 0; col < total; col += 1) {
      const top = isOn(col, row);
      const bottom = row + 1 < total ? isOn(col, row + 1) : false;
      const ch = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      line += ch;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Render `matrix` as an SVG document. Suitable for serving from an HTTP
 * endpoint and for embedding in HTML. `moduleSize` controls how many SVG
 * units cover one QR module; the viewBox scales naturally.
 */
export function renderQrSvg(
  matrix: QrMatrix,
  options: { moduleSize?: number; padding?: number } = {}
): string {
  const moduleSize = options.moduleSize ?? 8;
  const padding = options.padding ?? 2;
  const size = matrix.length;
  const dim = (size + padding * 2) * moduleSize;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}">`);
  parts.push(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!matrix[y]![x]) continue;
      const px = (x + padding) * moduleSize;
      const py = (y + padding) * moduleSize;
      parts.push(`<rect x="${px}" y="${py}" width="${moduleSize}" height="${moduleSize}" fill="#000000"/>`);
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v += 1) {
    const params = VERSIONS[v - 1]!;
    const charCountBits = v <= 9 ? 8 : 16;
    const usedBits = 4 + charCountBits + byteLength * 8 + 4;
    if (usedBits <= params.dataBytes * 8) return v;
  }
  throw new Error(`Payload too large for QR v1-v10 byte mode (${byteLength} bytes)`);
}

function stringToBytes(input: string): number[] {
  const encoded = new TextEncoder().encode(input);
  const out: number[] = new Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) out[i] = encoded[i]!;
  return out;
}

// -------- bit buffer --------

class BitBuffer {
  private bits: number[] = [];

  appendBits(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8 && i + j < this.bits.length; j += 1) {
        byte = (byte << 1) | this.bits[i + j]!;
      }
      bytes.push(byte);
    }
    return bytes;
  }
}

// -------- Reed-Solomon --------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR primitive polynomial
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i += 1) {
    g = polyMul(g, [1, GF_EXP[i]!]);
  }
  return g;
}

function polyMul(a: number[], b: number[]): number[] {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] ^= gfMul(a[i]!, b[j]!);
    }
  }
  return out;
}

function reedSolomon(data: number[], eccLength: number): number[] {
  const generator = rsGenerator(eccLength);
  const buffer = data.concat(new Array(eccLength).fill(0));
  for (let i = 0; i < data.length; i += 1) {
    const coef = buffer[i]!;
    if (coef !== 0) {
      for (let j = 0; j < generator.length; j += 1) {
        buffer[i + j] ^= gfMul(generator[j]!, coef);
      }
    }
  }
  return buffer.slice(data.length);
}

// -------- matrix construction --------

function buildMatrix(params: VersionParams, codewords: number[]): boolean[][] {
  const size = params.size;
  const grid: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  drawFinderPattern(grid, reserved, 0, 0);
  drawFinderPattern(grid, reserved, size - 7, 0);
  drawFinderPattern(grid, reserved, 0, size - 7);
  reserveFormatArea(reserved, size);
  drawTimingPatterns(grid, reserved, size);
  drawAlignmentPatterns(grid, reserved, params.alignmentCenters, size);
  // Dark module: row=4*version+9, col=8 per §8.4 (always 1)
  const darkRow = 4 * versionFor(size) + 9;
  grid[darkRow]![8] = true;
  reserved[darkRow]![8] = true;

  placeData(grid, reserved, codewords, size);

  // Choose best mask by penalty score (ISO §8.8).
  let best: { mask: number; matrix: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(grid as boolean[][], reserved, mask, size);
    drawFormatInfo(candidate, mask, size);
    const score = scoreMask(candidate, size);
    if (best === null || score < best.score) best = { mask, matrix: candidate, score };
  }
  return best!.matrix;
}

function versionFor(size: number): number {
  return Math.floor((size - 17) / 4);
}

function drawFinderPattern(
  grid: (boolean | null)[][],
  reserved: boolean[][],
  x0: number,
  y0: number
): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= grid.length || y >= grid.length) continue;
      const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const onBorder = inOuter && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const onCenter = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      grid[y]![x] = onBorder || onCenter;
      reserved[y]![x] = true;
    }
  }
}

function reserveFormatArea(reserved: boolean[][], size: number): void {
  for (let i = 0; i < 9; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
}

function drawTimingPatterns(
  grid: (boolean | null)[][],
  reserved: boolean[][],
  size: number
): void {
  for (let i = 8; i < size - 8; i += 1) {
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
    reserved[6]![i] = true;
    reserved[i]![6] = true;
  }
}

function drawAlignmentPatterns(
  grid: (boolean | null)[][],
  reserved: boolean[][],
  centers: number[],
  size: number
): void {
  for (const cy of centers) {
    for (const cx of centers) {
      // Skip when overlapping a finder pattern.
      const tlFinder = cx < 8 && cy < 8;
      const trFinder = cx > size - 9 && cy < 8;
      const blFinder = cx < 8 && cy > size - 9;
      if (tlFinder || trFinder || blFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const onRing = Math.abs(dx) === 2 || Math.abs(dy) === 2;
          const onCenter = dx === 0 && dy === 0;
          grid[cy + dy]![cx + dx] = onRing || onCenter;
          reserved[cy + dy]![cx + dx] = true;
        }
      }
    }
  }
}

function placeData(
  grid: (boolean | null)[][],
  reserved: boolean[][],
  codewords: number[],
  size: number
): void {
  let bitIndex = 0;
  // Two-module-wide columns walked bottom-to-top, then top-to-bottom, etc.
  // The column at x=6 is the timing pattern and is skipped.
  let upward = true;
  for (let x = size - 1; x > 0; x -= 2) {
    if (x === 6) x -= 1;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const col = x - dx;
        if (reserved[y]![col]) continue;
        const codewordIndex = bitIndex >> 3;
        const bitInByte = 7 - (bitIndex & 7);
        const value = codewordIndex < codewords.length
          ? (codewords[codewordIndex]! >> bitInByte) & 1
          : 0;
        grid[y]![col] = value === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(
  grid: boolean[][],
  reserved: boolean[][],
  mask: number,
  size: number
): boolean[][] {
  const out = grid.map((row) => row.slice());
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y]![x]) continue;
      if (maskBit(mask, x, y)) out[y]![x] = !out[y]![x];
    }
  }
  return out;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return ((x + y) % 2) === 0;
    case 1: return (y % 2) === 0;
    case 2: return (x % 3) === 0;
    case 3: return ((x + y) % 3) === 0;
    case 4: return ((Math.floor(y / 2) + Math.floor(x / 3)) % 2) === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    default: return false;
  }
}

function drawFormatInfo(grid: boolean[][], mask: number, size: number): void {
  const bits = FORMAT_INFO_L[mask]!;
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    if (i < 6) {
      grid[8]![i] = bit;
    } else if (i < 8) {
      grid[8]![i + 1] = bit;
    } else if (i < 9) {
      grid[7]![8] = bit;
    } else {
      grid[14 - i]![8] = bit;
    }
    if (i < 8) {
      grid[size - 1 - i]![8] = bit;
    } else {
      grid[8]![size - 15 + i] = bit;
    }
  }
  grid[8]![size - 8] = true;
}

function scoreMask(grid: boolean[][], size: number): number {
  // ISO §8.8.2: lower is better. Implemented faithfully but compactly.
  let score = 0;
  // Rule 1: runs of >=5 same-color modules.
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (grid[y]![x] === grid[y]![x - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (grid[y]![x] === grid[y - 1]![x]) {
        run += 1;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 2: 2x2 blocks of identical color.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const a = grid[y]![x];
      if (a === grid[y]![x + 1] && a === grid[y + 1]![x] && a === grid[y + 1]![x + 1]) score += 3;
    }
  }
  // Rule 3: 1:1:3:1:1 + adjacent four-light pattern.
  const pattern = [true, false, true, true, true, false, true];
  const findPattern = (cells: boolean[]): number => {
    let hits = 0;
    for (let i = 0; i + 7 <= cells.length; i += 1) {
      let match = true;
      for (let k = 0; k < 7; k += 1) if (cells[i + k] !== pattern[k]) { match = false; break; }
      if (!match) continue;
      const before = i >= 4 ? cells.slice(i - 4, i).every((c) => c === false) : false;
      const after = i + 7 + 4 <= cells.length ? cells.slice(i + 7, i + 11).every((c) => c === false) : false;
      if (before || after) hits += 1;
    }
    return hits;
  };
  for (let y = 0; y < size; y += 1) score += 40 * findPattern(grid[y]!);
  for (let x = 0; x < size; x += 1) {
    const col: boolean[] = [];
    for (let y = 0; y < size; y += 1) col.push(grid[y]![x]!);
    score += 40 * findPattern(col);
  }
  // Rule 4: proportion of dark modules deviating from 50%.
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (grid[y]![x]) dark += 1;
  const ratio = dark / (size * size);
  const deviation = Math.floor(Math.abs(ratio * 100 - 50) / 5);
  score += deviation * 10;
  return score;
}
