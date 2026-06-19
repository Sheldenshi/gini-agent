import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Instance } from "../types";
import { toolCallPayloadsDir } from "../paths";

// Externalize the large inline base64 strings that a paused (`waiting_approval`)
// task keeps inside `toolCallState.messages`. Those strings — an image's
// `image_url.url` data-URL, or a `document.data` base64 blob — would otherwise
// live inside state.json, which is parsed in full on EVERY read. One paused
// task carrying a few images can inflate the document by tens of megabytes and
// tax every request (see ADR toolcall-payload-externalization.md).
//
// The fix mirrors the uploads.ts principle ("never embed base64 in state.json —
// keep the bytes outside the JSON write path"): we lift the big string out to a
// content-addressed side file and leave a short reference STRING in its place.
// The reference replaces only the string VALUE of `image_url.url` /
// `document.data` — the part's `type` and object shape are untouched, so every
// `part.type` consumer (provider serializers, the read_skill scan in
// tool-dispatch) is unaffected, and JSON round-trips losslessly.
//
// Design guarantees, each closing a specific failure mode:
//  - BYTE-EXACT: the original string is stored and restored verbatim (utf8),
//    keyed by the SHA-256 of those exact bytes. No decode/re-encode, so resume
//    sends the model identical bytes.
//  - WRITE-BEFORE-REFERENCE + FSYNC: the side file is fsync'd to disk before the
//    state write that references it, and is itself written atomically (temp +
//    rename). A reference can never point at a missing or torn file.
//  - VERIFY-ON-READ: rehydrate re-hashes the loaded bytes and only substitutes
//    when the hash matches the reference, so a truncated/corrupt side file is
//    rejected rather than fed to the model.
//  - INLINE FALLBACK: if externalization fails for any reason (disk full, etc.),
//    the payload is left inline. The state write still succeeds; we trade bytes
//    for safety, never a stranded task.
//  - LEAVE-MARKER-ON-MISS: if a side file is gone at rehydrate time, the marker
//    string is left in place. Provider serializers are hardened to THROW on an
//    unresolved marker rather than silently drop the part, so a missing payload
//    surfaces loudly instead of silently losing an image.

// Reserved sentinel. The 0x1e (record-separator) control byte makes the prefix
// impossible to produce from a base64 data-URL or base64 blob (both of which
// are printable-ASCII only), so a marker can never collide with — or be forged
// by — legitimate payload content.
const MARKER_PREFIX = "\x1egini-toolcall-ref:sha256:";

// Only externalize strings at least this large. Small strings cost more in
// side-file overhead than they save; the win is entirely in the multi-MB
// image/document payloads. Strictly-greater so a string exactly at the floor
// stays inline.
const EXTERNALIZE_MIN_BYTES = 4096;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isPayloadRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MARKER_PREFIX);
}

// Guard for the provider request-build boundary. An externalized payload should
// always be rehydrated before it reaches a serializer; if a marker survives to
// here its side file was missing/corrupt, and the alternatives (Anthropic /
// Converse silently drop an unparseable image part) would send the model a
// turn with the image invisibly gone. Throwing instead turns that silent
// correctness loss into a loud, recoverable failure.
export function assertNoPayloadRef(value: unknown): void {
  if (isPayloadRef(value)) {
    throw new Error(
      "Unresolved toolCallState payload reference reached the provider request boundary — " +
        "its side file is missing or corrupt. The turn was stopped rather than silently dropping the attachment."
    );
  }
}

function refFor(hash: string): string {
  return `${MARKER_PREFIX}${hash}`;
}

function hashFromRef(ref: string): string {
  return ref.slice(MARKER_PREFIX.length);
}

function sidePath(instance: Instance, hash: string): string {
  return join(toolCallPayloadsDir(instance), `${hash}.b64`);
}

// Atomically write the exact UTF-8 bytes of `value` to the content-addressed
// side file, fsync'd. Idempotent: an identical payload already on disk is left
// as-is (content-addressing → same name, same bytes). Returns true once the
// payload is durably present.
function writeSideFile(instance: Instance, hash: string, value: string): void {
  const dir = toolCallPayloadsDir(instance);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = sidePath(instance, hash);
  // Only short-circuit on a real FILE already at the content-addressed path.
  // A non-file at that path (e.g. a directory) is anomalous; fall through so
  // the write+rename runs and surfaces the problem rather than returning a
  // reference to something that isn't the payload.
  if (existsSync(target) && statSync(target).isFile()) return;
  const tmp = `${target}.${process.pid}.${createHash("sha1").update(`${hash}${value.length}`).digest("hex").slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

// Replace a large string value with a reference, persisting its bytes first.
// On any failure, returns the ORIGINAL string unchanged (inline fallback) so a
// state write is never blocked by externalization. The side file is written and
// fsync'd before this returns, so by the time the caller persists the
// reference, the bytes are durably on disk.
function externalizeString(instance: Instance, value: string): string {
  if (Buffer.byteLength(value, "utf8") <= EXTERNALIZE_MIN_BYTES) return value;
  if (isPayloadRef(value)) return value; // already a reference
  const hash = sha256Hex(value);
  try {
    writeSideFile(instance, hash, value);
    return refFor(hash);
  } catch {
    return value; // inline fallback — bytes stay in state, but the write succeeds
  }
}

// Restore a reference to its exact original bytes. Verifies the loaded bytes
// hash back to the reference; on miss or mismatch, returns null so the caller
// leaves the marker in place (provider serializers then throw loudly).
function resolveRef(instance: Instance, ref: string): string | null {
  const hash = hashFromRef(ref);
  const path = sidePath(instance, hash);
  if (!existsSync(path)) return null;
  let value: string;
  try {
    value = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (sha256Hex(value) !== hash) return null; // truncated / corrupt side file
  return value;
}

// Structural shape we walk. We only touch the two known large-string carriers;
// every other part/field passes through untouched.
type ContentPartLike =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "document"; document: { mimeType: string; data: string; filename?: string } }
  | { type?: string; [k: string]: unknown };

type MessageLike = { content?: unknown; [k: string]: unknown };

// Apply `transform` to the large-string carriers of a single content part,
// returning a NEW part object (never mutating the input). Non-carrier parts are
// returned as-is.
function mapPart(part: ContentPartLike, transform: (value: string) => string): ContentPartLike {
  if (part && typeof part === "object" && part.type === "image_url") {
    const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
    if (typeof url === "string") {
      return { ...part, image_url: { ...(part as { image_url: object }).image_url, url: transform(url) } };
    }
  }
  if (part && typeof part === "object" && part.type === "document") {
    const data = (part as { document?: { data?: unknown } }).document?.data;
    if (typeof data === "string") {
      return { ...part, document: { ...(part as { document: object }).document, data: transform(data) } };
    }
  }
  return part;
}

// Deep-copy + transform the messages array. Returns a brand-new array of new
// message objects with new content arrays; the input graph is never mutated
// (so a snapshot that shares its array with the live loop is safe to pass in).
function mapMessages(messages: unknown[], transform: (value: string) => string): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const msg = message as MessageLike;
    if (!Array.isArray(msg.content)) return { ...msg };
    return {
      ...msg,
      content: msg.content.map((part) =>
        part && typeof part === "object" ? mapPart(part as ContentPartLike, transform) : part
      )
    };
  });
}

// Dehydrate: lift large inline image/document payloads out of the messages
// array into content-addressed side files, returning a new array with reference
// strings in their place. Pure w.r.t. the input (deep-copies before replacing),
// so the caller's live array is never mutated. Side-file bytes are durably
// fsync'd before this returns.
export function dehydrateMessages(instance: Instance, messages: unknown[]): unknown[] {
  return mapMessages(messages, (value) => externalizeString(instance, value));
}

// Rehydrate: restore reference strings to their exact original bytes. A
// reference whose side file is missing or corrupt is LEFT as a marker (provider
// serializers throw on it), never silently blanked. Pure w.r.t. the input.
export function rehydrateMessages(instance: Instance, messages: unknown[]): unknown[] {
  return mapMessages(messages, (value) => {
    if (!isPayloadRef(value)) return value;
    const resolved = resolveRef(instance, value);
    return resolved ?? value;
  });
}

// Test/introspection helpers.
export const __testing = {
  MARKER_PREFIX,
  EXTERNALIZE_MIN_BYTES,
  sha256Hex,
  sidePath
};
