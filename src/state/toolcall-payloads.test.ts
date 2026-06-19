// Tests for toolCallState payload externalization (ADR
// toolcall-payload-externalization.md).
//
// GINI_STATE_ROOT is pointed at a unique mkdtemp dir per test so side files
// land under a throwaway instance dir and never touch real state. Coverage
// targets every branch: threshold gating, byte-exact round-trip, content-
// addressed dedup, the no-mutation guarantee, inline fallback on write failure,
// leave-marker-on-miss, corrupt/truncated side-file rejection, marker
// non-forgeability, and the provider-boundary assert.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolCallPayloadsDir } from "../paths";
import {
  assertNoPayloadRef,
  dehydrateMessages,
  isPayloadRef,
  rehydrateMessages,
  __testing
} from "./toolcall-payloads";

const INSTANCE = "tcp-test";
let scratch: string;
let prev: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gini-tcp-"));
  prev = process.env.GINI_STATE_ROOT;
  process.env.GINI_STATE_ROOT = scratch;
});

afterEach(() => {
  if (prev === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prev;
  rmSync(scratch, { recursive: true, force: true });
});

// A base64-ish payload comfortably over the externalization floor.
function bigB64(seed: string): string {
  return seed.repeat(Math.ceil((__testing.EXTERNALIZE_MIN_BYTES + 100) / seed.length));
}

function imageMsg(url: string) {
  return { role: "user", content: [{ type: "image_url", image_url: { url } }] };
}
function docMsg(data: string, mimeType = "application/pdf", filename = "f.pdf") {
  return { role: "user", content: [{ type: "document", document: { mimeType, data, filename } }] };
}

describe("dehydrate / rehydrate round-trip", () => {
  test("byte-exact image data-URL survives a full round-trip", () => {
    const url = `data:image/png;base64,${bigB64("AAAABBBBCCCCDDDD")}`;
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const ref = (dehydrated[0] as any).content[0].image_url.url;
    expect(isPayloadRef(ref)).toBe(true);
    expect(ref).not.toBe(url);

    const rehydrated = rehydrateMessages(INSTANCE, dehydrated);
    expect((rehydrated[0] as any).content[0].image_url.url).toBe(url);
  });

  test("byte-exact document base64 survives a round-trip and keeps siblings", () => {
    const data = bigB64("PDFPAYLOAD0123456789");
    const dehydrated = dehydrateMessages(INSTANCE, [docMsg(data)]);
    const part = (dehydrated[0] as any).content[0];
    expect(isPayloadRef(part.document.data)).toBe(true);
    expect(part.document.mimeType).toBe("application/pdf");
    expect(part.document.filename).toBe("f.pdf");

    const rehydrated = rehydrateMessages(INSTANCE, dehydrated);
    expect((rehydrated[0] as any).content[0].document.data).toBe(data);
  });

  test("identical payloads de-duplicate to one content-addressed side file", () => {
    const url = `data:image/png;base64,${bigB64("DEDUPEME01234567")}`;
    dehydrateMessages(INSTANCE, [imageMsg(url), imageMsg(url)]);
    const files = readdirSync(toolCallPayloadsDir(INSTANCE)).filter((f) => f.endsWith(".b64"));
    expect(files.length).toBe(1);
  });
});

describe("threshold gating", () => {
  test("a string at or below the floor stays inline", () => {
    const small = "data:image/png;base64,SMALL";
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(small)]);
    expect((dehydrated[0] as any).content[0].image_url.url).toBe(small);
    expect(existsSync(toolCallPayloadsDir(INSTANCE))).toBe(false);
  });

  test("a string exactly at the floor is NOT externalized (strict greater-than)", () => {
    const exact = "x".repeat(__testing.EXTERNALIZE_MIN_BYTES);
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(exact)]);
    expect((dehydrated[0] as any).content[0].image_url.url).toBe(exact);
  });
});

describe("no-mutation guarantee", () => {
  test("dehydrate does not mutate the input messages array or its parts", () => {
    const url = `data:image/png;base64,${bigB64("NOMUTATE01234567")}`;
    const input = [imageMsg(url)];
    const inputPartRef = (input[0] as any).content[0];
    dehydrateMessages(INSTANCE, input);
    expect((input[0] as any).content[0].image_url.url).toBe(url); // unchanged
    expect((input[0] as any).content[0]).toBe(inputPartRef); // same object identity
  });

  test("rehydrate does not mutate its input", () => {
    const url = `data:image/png;base64,${bigB64("NOMUTATE89012345")}`;
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const ref = (dehydrated[0] as any).content[0].image_url.url;
    rehydrateMessages(INSTANCE, dehydrated);
    expect((dehydrated[0] as any).content[0].image_url.url).toBe(ref); // still the ref
  });
});

describe("pass-through of non-carrier content", () => {
  test("text parts, string content, null content, and unknown parts pass through", () => {
    const messages = [
      { role: "system", content: "plain string" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "mystery", blob: "x" }] },
      "not even an object",
      { role: "user", content: [null, 42] }
    ];
    const out = dehydrateMessages(INSTANCE, messages);
    expect(out[0]).toEqual({ role: "system", content: "plain string" });
    expect((out[1] as any).tool_calls).toEqual([{ id: "c1" }]);
    expect((out[2] as any).content[0]).toEqual({ type: "text", text: "hi" });
    expect((out[2] as any).content[1]).toEqual({ type: "mystery", blob: "x" });
    expect(out[3]).toBe("not even an object");
    expect((out[4] as any).content).toEqual([null, 42]);
  });

  test("image_url with a non-string url is left untouched", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: 123 } }] }];
    const out = dehydrateMessages(INSTANCE, messages);
    expect((out[0] as any).content[0].image_url.url).toBe(123);
  });

  test("document with a non-string data is left untouched", () => {
    const messages = [{ role: "user", content: [{ type: "document", document: { mimeType: "x/y", data: null } }] }];
    const out = dehydrateMessages(INSTANCE, messages);
    expect((out[0] as any).content[0].document.data).toBe(null);
  });
});

describe("inline fallback on write failure", () => {
  test("a side-file write failure leaves the payload inline and does not throw", () => {
    // Place a regular FILE where the payloads directory should be, so the
    // mkdir inside writeSideFile fails → externalizeString catches and falls
    // back to inline. The instance dir already exists (created by an earlier
    // op or here), so only the leaf collides.
    const dir = toolCallPayloadsDir(INSTANCE);
    require("node:fs").mkdirSync(join(scratch, "instances", INSTANCE), { recursive: true });
    writeFileSync(dir, "i am a file, not a dir");

    const url = `data:image/png;base64,${bigB64("FALLBACK012345678")}`;
    const out = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    // Left inline — no throw, byte-for-byte original.
    expect((out[0] as any).content[0].image_url.url).toBe(url);
    expect(isPayloadRef((out[0] as any).content[0].image_url.url)).toBe(false);
  });

  test("an open failure (unwritable dir) cleans up and falls back to inline", () => {
    // Pre-create the payloads dir as read-only so openSync of the temp file
    // throws (covers the externalizeString catch → inline fallback path).
    const dir = toolCallPayloadsDir(INSTANCE);
    require("node:fs").mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500); // r-x: cannot create the temp file inside
    try {
      const url = `data:image/png;base64,${bigB64("OPENFAIL012345678")}`;
      const out = dehydrateMessages(INSTANCE, [imageMsg(url)]);
      expect((out[0] as any).content[0].image_url.url).toBe(url); // inline fallback
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach rmSync can clean up
    }
  });

  test("a rename failure cleans up the temp file and falls back to inline", () => {
    // Pre-create a NON-EMPTY DIRECTORY at the exact target side-file path. The
    // temp file opens + writes fine, but renameSync(tmp, target) fails
    // (ENOTEMPTY/EISDIR), exercising the writeSideFile rename-catch + temp
    // cleanup. The payload then falls back to inline.
    const url = `data:image/png;base64,${bigB64("RENAMEFAIL0123456")}`;
    const hash = __testing.sha256Hex(url);
    const target = __testing.sidePath(INSTANCE, hash);
    const fs = require("node:fs");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(join(target, "blocker"), "x"); // make it non-empty so rename fails
    const out = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    expect((out[0] as any).content[0].image_url.url).toBe(url); // inline fallback
    // The temp file must have been cleaned up — only the blocker dir remains.
    const leftover = readdirSync(toolCallPayloadsDir(INSTANCE)).filter((f) => f.endsWith(".tmp"));
    expect(leftover.length).toBe(0);
  });
});

describe("rehydrate failure modes leave the marker", () => {
  test("missing side file → marker left in place", () => {
    const url = `data:image/png;base64,${bigB64("MISSING0123456789")}`;
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const ref = (dehydrated[0] as any).content[0].image_url.url;
    // delete the side file
    rmSync(toolCallPayloadsDir(INSTANCE), { recursive: true, force: true });
    const rehydrated = rehydrateMessages(INSTANCE, dehydrated);
    expect((rehydrated[0] as any).content[0].image_url.url).toBe(ref);
  });

  test("corrupt/truncated side file (hash mismatch) → marker left in place", () => {
    const url = `data:image/png;base64,${bigB64("CORRUPT0123456789")}`;
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const ref = (dehydrated[0] as any).content[0].image_url.url;
    const hash = ref.slice(__testing.MARKER_PREFIX.length);
    // overwrite the side file with wrong bytes (hash no longer matches)
    writeFileSync(__testing.sidePath(INSTANCE, hash), "tampered");
    const rehydrated = rehydrateMessages(INSTANCE, dehydrated);
    expect((rehydrated[0] as any).content[0].image_url.url).toBe(ref);
  });

  test("a non-ref string is returned unchanged by rehydrate", () => {
    const messages = [imageMsg("data:image/png;base64,SHORT")];
    const out = rehydrateMessages(INSTANCE, messages);
    expect((out[0] as any).content[0].image_url.url).toBe("data:image/png;base64,SHORT");
  });

  test("an unreadable side file (read throws) → marker left in place", () => {
    const url = `data:image/png;base64,${bigB64("UNREADABLE0123456")}`;
    const dehydrated = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const ref = (dehydrated[0] as any).content[0].image_url.url;
    const hash = ref.slice(__testing.MARKER_PREFIX.length);
    // Make the side file exist-but-unreadable so readFileSync throws.
    chmodSync(__testing.sidePath(INSTANCE, hash), 0o000);
    try {
      const rehydrated = rehydrateMessages(INSTANCE, dehydrated);
      expect((rehydrated[0] as any).content[0].image_url.url).toBe(ref);
    } finally {
      chmodSync(__testing.sidePath(INSTANCE, hash), 0o600);
    }
  });
});

describe("marker discipline", () => {
  test("the marker prefix carries a non-printable byte so payloads can't forge it", () => {
    expect(__testing.MARKER_PREFIX.charCodeAt(0)).toBe(0x1e);
    // A realistic base64 data-URL is printable ASCII and never starts with 0x1e.
    expect(isPayloadRef("data:image/png;base64,QUJD")).toBe(false);
  });

  test("isPayloadRef rejects non-strings", () => {
    expect(isPayloadRef(123)).toBe(false);
    expect(isPayloadRef(null)).toBe(false);
    expect(isPayloadRef({})).toBe(false);
  });

  test("re-dehydrating an already-externalized message is a no-op (ref stays a ref, no new file)", () => {
    const url = `data:image/png;base64,${bigB64("IDEMPOTENT0123456")}`;
    const once = dehydrateMessages(INSTANCE, [imageMsg(url)]);
    const filesAfterOne = readdirSync(toolCallPayloadsDir(INSTANCE)).filter((f) => f.endsWith(".b64")).length;
    const twice = dehydrateMessages(INSTANCE, once);
    const ref1 = (once[0] as any).content[0].image_url.url;
    const ref2 = (twice[0] as any).content[0].image_url.url;
    expect(ref2).toBe(ref1);
    const filesAfterTwo = readdirSync(toolCallPayloadsDir(INSTANCE)).filter((f) => f.endsWith(".b64")).length;
    expect(filesAfterTwo).toBe(filesAfterOne);
  });
});

describe("assertNoPayloadRef (provider boundary guard)", () => {
  test("throws on a payload reference", () => {
    const ref = `${__testing.MARKER_PREFIX}${__testing.sha256Hex("x")}`;
    expect(() => assertNoPayloadRef(ref)).toThrow(/Unresolved toolCallState payload reference/);
  });

  test("is a no-op for a normal data-URL string", () => {
    expect(() => assertNoPayloadRef("data:image/png;base64,QUJD")).not.toThrow();
  });

  test("is a no-op for non-strings", () => {
    expect(() => assertNoPayloadRef(undefined)).not.toThrow();
  });
});
