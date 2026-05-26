// Canonicalization helpers for the `/api/runtime/[...path]` BFF guard.
//
// These live in a sibling module (rather than inside `route.ts`) because the
// Next.js App Router treats `route.ts` as a special file whose only allowed
// exports are HTTP method handlers (`GET`, `POST`, ...) and a small allowlist
// of segment-config metadata (`runtime`, `dynamic`, ...). Exporting an
// arbitrary helper from `route.ts` would either be stripped by the router or
// produce a build-time warning depending on the Next.js version. Keeping the
// helpers here lets the production handler and the unit test import the same
// implementation, so the guard and its tests can never drift.

export function canonicalFirstSegmentIsTunnel(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  return decodeAndLower(path[0] ?? "") === "tunnel";
}

export function canonicalSecondSegmentIsQrSvg(path: readonly string[]): boolean {
  if (path.length < 2) return false;
  return decodeAndLower(path[1] ?? "") === "qr.svg";
}

export function decodeAndLower(input: string): string {
  let segment = input;
  // Decode up to a few times so an encoded segment (`%74unnel`,
  // `%71r%2Esvg`, double-encoded variants) collapses to its canonical
  // value before the comparison. Five iterations is enough to outrun
  // any realistic nesting and matches the canonicalizer depth used
  // downstream.
  for (let i = 0; i < 5; i += 1) {
    let next: string;
    try { next = decodeURIComponent(segment); } catch { return ""; }
    if (next === segment) break;
    segment = next;
  }
  return segment.toLowerCase();
}
