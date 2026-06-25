import { createHmac, timingSafeEqual } from "node:crypto";

// Capability URLs for upload previews. A mobile in-app browser
// (SFSafariViewController / Custom Tabs) can't attach the bearer header the
// gateway requires, and can't carry the gateway cookie either, so it can't open
// `/api/uploads/:id` directly. Instead the app mints a short-lived SIGNED url —
// the gateway HMACs `<id>.<exp>` with the owner config token and appends
// `?exp=&sig=`. The signed url authorizes ONE upload id until it expires; the
// signing secret never leaves the gateway. This mirrors an S3 presigned GET.
//
// The signature is scoped to the id, so a url minted for one upload can't be
// edited to fetch another (the sig won't re-verify), and `exp` bounds the leak
// window of a url that lands in browser history / a server log.

// Build the HMAC-SHA256 hex digest over the canonical `<id>.<exp>` string. The
// dot separator can't appear in an upload id (UUID) or in the decimal `exp`, so
// the signed message is unambiguous.
function digest(secret: string, id: string, exp: number): string {
  return createHmac("sha256", secret).update(`${id}.${exp}`).digest("hex");
}

// Mint the `{ exp, sig }` pair for an upload id. `expUnixSeconds` is the
// absolute expiry (unix seconds); callers compute it from a TTL.
export function signUploadParams(
  secret: string,
  id: string,
  expUnixSeconds: number
): { exp: number; sig: string } {
  return { exp: expUnixSeconds, sig: digest(secret, id, expUnixSeconds) };
}

// Verify a presented `sig`/`exp` for an upload id. Returns true only when the
// signature matches AND the url hasn't expired. Reads the raw query values
// (strings | null) so the caller passes `searchParams.get(...)` straight
// through. A malformed/missing exp, a non-matching sig, or a past exp all fail
// closed. The comparison is timing-safe and length-guarded.
export function verifyUploadSignature(
  secret: string,
  id: string,
  expRaw: string | null,
  sigRaw: string | null,
  nowMs: number
): boolean {
  if (!expRaw || !sigRaw) return false;
  // `exp` must be a clean positive integer (unix seconds). Reject anything
  // non-numeric so `Number("12abc")`/NaN/scientific notation can't slip by.
  if (!/^\d+$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return false;
  if (exp * 1000 <= nowMs) return false;
  const expected = digest(secret, id, exp);
  // A valid sig is ALWAYS lowercase hex (digest() ends in .digest("hex")), so
  // reject any non-hex sig up front. This also keeps the length guard below
  // byte-accurate: timingSafeEqual compares Buffer BYTE lengths, but a JS
  // string's `.length` counts UTF-16 units — a multibyte char could pass a
  // `.length` check yet differ in UTF-8 bytes and make timingSafeEqual THROW.
  // Constraining sig to ASCII hex makes .length === byte length, so the throw
  // can't happen and a malformed sig fails closed as a clean false (not a 500).
  if (!/^[0-9a-f]+$/.test(sigRaw)) return false;
  // Wrong-length sig is trivially invalid (and timingSafeEqual throws on a
  // length mismatch anyway), so guard the length before the timing-safe compare.
  if (sigRaw.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sigRaw), Buffer.from(expected));
}
