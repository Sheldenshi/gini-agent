import { describe, expect, test } from "bun:test";
import { signUploadParams, verifyUploadSignature } from "./upload-signing";

const SECRET = "owner-secret-token";
const ID = "0c8f4e2a-1111-2222-3333-444455556666";
const NOW = 1_000_000_000_000; // fixed "now" in ms

describe("signUploadParams", () => {
  test("echoes the exp and produces a stable hex signature", () => {
    const exp = 1_700_000_000;
    const a = signUploadParams(SECRET, ID, exp);
    const b = signUploadParams(SECRET, ID, exp);
    expect(a.exp).toBe(exp);
    expect(a.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sig).toBe(b.sig); // deterministic for the same inputs
  });

  test("a different id or secret yields a different signature", () => {
    const exp = 1_700_000_000;
    const base = signUploadParams(SECRET, ID, exp).sig;
    expect(signUploadParams(SECRET, "other-id", exp).sig).not.toBe(base);
    expect(signUploadParams("other-secret", ID, exp).sig).not.toBe(base);
    expect(signUploadParams(SECRET, ID, exp + 1).sig).not.toBe(base);
  });
});

describe("verifyUploadSignature", () => {
  function freshSig(id = ID, ttlSeconds = 60, secret = SECRET) {
    const exp = Math.floor(NOW / 1000) + ttlSeconds;
    const { sig } = signUploadParams(secret, id, exp);
    return { exp: String(exp), sig };
  }

  test("accepts a valid, unexpired signature", () => {
    const { exp, sig } = freshSig();
    expect(verifyUploadSignature(SECRET, ID, exp, sig, NOW)).toBe(true);
  });

  test("rejects a missing exp or sig", () => {
    const { exp, sig } = freshSig();
    expect(verifyUploadSignature(SECRET, ID, null, sig, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, exp, null, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, "", sig, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, exp, "", NOW)).toBe(false);
  });

  test("rejects an expired signature (exp at or before now)", () => {
    const past = Math.floor(NOW / 1000) - 1;
    const { sig } = signUploadParams(SECRET, ID, past);
    expect(verifyUploadSignature(SECRET, ID, String(past), sig, NOW)).toBe(false);
    // exactly now is also rejected (<=)
    const exactly = Math.floor(NOW / 1000);
    const { sig: sig2 } = signUploadParams(SECRET, ID, exactly);
    expect(verifyUploadSignature(SECRET, ID, String(exactly), sig2, exactly * 1000)).toBe(false);
  });

  test("rejects a non-numeric or unsafe exp", () => {
    const { sig } = freshSig();
    expect(verifyUploadSignature(SECRET, ID, "12abc", sig, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, "1e10", sig, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, "-5", sig, NOW)).toBe(false);
    expect(verifyUploadSignature(SECRET, ID, "99999999999999999999", sig, NOW)).toBe(false);
  });

  test("rejects a signature minted for a DIFFERENT upload id", () => {
    // The crux of the scoping guarantee: a url signed for one id can't be
    // edited to fetch another.
    const { exp, sig } = freshSig("other-id");
    expect(verifyUploadSignature(SECRET, ID, exp, sig, NOW)).toBe(false);
  });

  test("rejects a signature made with a different secret", () => {
    const { exp, sig } = freshSig(ID, 60, "attacker-secret");
    expect(verifyUploadSignature(SECRET, ID, exp, sig, NOW)).toBe(false);
  });

  test("rejects a wrong-length sig without throwing", () => {
    const { exp } = freshSig();
    expect(verifyUploadSignature(SECRET, ID, exp, "deadbeef", NOW)).toBe(false);
  });

  test("rejects a same-length but tampered sig", () => {
    const { exp, sig } = freshSig();
    const tampered = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(verifyUploadSignature(SECRET, ID, exp, tampered, NOW)).toBe(false);
  });

  test("rejects a non-hex sig WITHOUT throwing (multibyte char can't crash the compare)", () => {
    const { exp, sig } = freshSig();
    // A sig whose JS .length matches the 64-char hex digest but contains a
    // multibyte char would, without the hex guard, pass the .length check and
    // make timingSafeEqual throw on a UTF-8 byte-length mismatch. The hex guard
    // rejects it as a clean false instead.
    const multibyte = "é".repeat(sig.length); // .length === 64, but >64 UTF-8 bytes
    expect(multibyte.length).toBe(sig.length);
    expect(verifyUploadSignature(SECRET, ID, exp, multibyte, NOW)).toBe(false);
    // Uppercase hex is also non-canonical (digest emits lowercase) → rejected.
    expect(verifyUploadSignature(SECRET, ID, exp, sig.toUpperCase(), NOW)).toBe(false);
  });
});
