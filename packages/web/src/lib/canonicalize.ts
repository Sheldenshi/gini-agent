// Path canonicalization used by the BFF proxy route
// (web/src/app/api/runtime/[...path]/route.ts) to normalize a request path
// before forwarding it to the gateway — rejecting traversal, duplicate
// slashes, embedded delimiters, and over-long input.

export interface CanonicalizeResult {
  ok: true;
  /** The canonical pathname. Preserves a single trailing slash if the input
   *  had one; collapses multiple trailing slashes to one. Bare "/" stays as
   *  "/". */
  path: string;
  /** True when the canonical path ends in a single trailing slash, so a
   *  consumer can preserve the exact form the client sent rather than
   *  recomputing it. */
  hadTrailingSlash: boolean;
}

export interface CanonicalizeError {
  ok: false;
  reason:
    | "malformed-percent-encoding"
    | "decode-not-stable"
    | "traversal"
    | "dot-segment"
    | "duplicate-slash"
    | "residual-percent"
    | "backslash-or-nul"
    | "embedded-delimiter"
    | "too-long";
}

const MAX_DECODE_ROUNDS = 8;
const MAX_LENGTH = 4096;

function strictPercentDecode(input: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    if (ch !== 0x25) {
      if (ch < 0x80) {
        bytes.push(ch);
      } else {
        const enc = new TextEncoder().encode(input[i]!);
        for (const b of enc) bytes.push(b);
      }
      continue;
    }
    if (i + 2 >= input.length) return null;
    const hi = input.charCodeAt(i + 1);
    const lo = input.charCodeAt(i + 2);
    const hiVal = hexVal(hi);
    const loVal = hexVal(lo);
    if (hiVal < 0 || loVal < 0) return null;
    bytes.push((hiVal << 4) | loVal);
    i += 2;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function hexVal(charCode: number): number {
  if (charCode >= 0x30 && charCode <= 0x39) return charCode - 0x30;
  if (charCode >= 0x41 && charCode <= 0x46) return charCode - 0x41 + 10;
  if (charCode >= 0x61 && charCode <= 0x66) return charCode - 0x61 + 10;
  return -1;
}

export function canonicalizePath(input: string): CanonicalizeResult | CanonicalizeError {
  if (input.length > MAX_LENGTH) return { ok: false, reason: "too-long" };

  let cur = input;
  let stabilized = false;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = strictPercentDecode(cur);
    if (next === null) return { ok: false, reason: "malformed-percent-encoding" };
    if (next === cur) {
      stabilized = true;
      break;
    }
    cur = next;
    if (cur.length > MAX_LENGTH) return { ok: false, reason: "too-long" };
  }
  if (!stabilized) return { ok: false, reason: "decode-not-stable" };

  let hadTrailingSlash = false;
  let work = cur;
  if (work.length > 1 && work.endsWith("/")) {
    hadTrailingSlash = true;
    while (work.length > 1 && work.endsWith("//")) {
      work = work.slice(0, -1);
    }
  }

  if (work.length > MAX_LENGTH) return { ok: false, reason: "too-long" };
  if (work.includes("%")) return { ok: false, reason: "residual-percent" };
  if (work.includes("\\") || work.includes("\0")) return { ok: false, reason: "backslash-or-nul" };
  if (work.includes("?") || work.includes("#")) return { ok: false, reason: "embedded-delimiter" };

  if (!work.startsWith("/")) {
    return { ok: false, reason: "duplicate-slash" };
  }
  if (work === "/") return { ok: true, path: "/", hadTrailingSlash: false };
  const segments = work.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (seg === "..") return { ok: false, reason: "traversal" };
    if (seg === ".") return { ok: false, reason: "dot-segment" };
    const isLeading = i === 0;
    const isTrailing = i === segments.length - 1 && hadTrailingSlash;
    if (seg === "" && !isLeading && !isTrailing) {
      return { ok: false, reason: "duplicate-slash" };
    }
  }

  return { ok: true, path: work, hadTrailingSlash };
}

export function noTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}
