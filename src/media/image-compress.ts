// Image compression for the vision-attachment build boundary.
//
// Anthropic's Messages API rejects any image whose decoded `image.source.bytes`
// exceeds 5,242,880 (5 MB) with a hard server-side 400, failing the whole turn.
// Gini stores uploads full-size, so an oversized phone photo (e.g. a 5.5 MB
// HEIC/JPEG) would 400 every turn it replays on. We downscale + re-encode such
// images to fit under the provider's limit, lazily at the build boundary, and
// cache the derived bytes on disk (see uploads.ts) so the work runs once.
//
// Output is JPEG: it is universally accepted across providers (anthropic,
// openai, bedrock, gemini), and mozjpeg gives a strong size/quality ratio. We
// `.rotate()` to bake in EXIF orientation (phone photos carry orientation in
// metadata that a re-encode would otherwise drop) and `.flatten()` onto white
// to drop any alpha channel, since JPEG has no transparency.

import type { Instance } from "../types";
import { readUpload, readVisionVariant, writeVisionVariant } from "../state/uploads";
import { appendLog } from "../state";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// Downscale + re-encode `bytes` to a JPEG under `limitBytes`. Returns the
// original unchanged when it already fits, the best-effort smallest JPEG
// otherwise, or null when sharp cannot decode the input (e.g. some HEIC/SVG,
// corrupt bytes) so the caller can fall back to the original.
export async function compressImageToFit(
  bytes: Uint8Array,
  mimeType: string,
  limitBytes: number
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (bytes.length <= limitBytes) return { bytes, mimeType };

  // Dynamic import: sharp wraps libvips, a heavy native addon only needed on the
  // rare oversized-image path. A top-level import loads libvips into every Bun
  // test isolate that transitively imports chat-task, segfaulting the isolate
  // workers on teardown — and needlessly loads it at cold start even when no
  // oversized image is ever sent.
  const sharp = (await import("sharp")).default;
  // Attempt ladder, best quality first. The first attempt only re-encodes
  // (no downscale) so an image that's just over the limit keeps full
  // resolution; each later attempt downscales harder and drops quality. The
  // final attempt is a small, low-quality JPEG (tens of KB) that fits any
  // realistic per-image limit, so any decodable image converges. maxEdge=null
  // means "do not resize".
  const attempts: Array<{ maxEdge: number | null; quality: number }> = [
    { maxEdge: null, quality: 85 },
    { maxEdge: 2560, quality: 80 },
    { maxEdge: 2000, quality: 75 },
    { maxEdge: 1600, quality: 68 },
    { maxEdge: 1100, quality: 60 },
    { maxEdge: 640, quality: 48 },
  ];
  try {
    let smallest: Uint8Array | null = null;
    for (const a of attempts) {
      let pipeline = sharp(bytes, { failOn: "none" }).rotate().flatten({ background: "#ffffff" });
      if (a.maxEdge !== null) {
        pipeline = pipeline.resize({ width: a.maxEdge, height: a.maxEdge, fit: "inside", withoutEnlargement: true });
      }
      const out = new Uint8Array(await pipeline.jpeg({ quality: a.quality, mozjpeg: true }).toBuffer());
      if (smallest === null || out.length < smallest.length) smallest = out;
      if (out.length <= limitBytes) return { bytes: out, mimeType: "image/jpeg" };
    }
    // Nothing fit (only possible for a pathologically small limit): the smallest
    // JPEG is still strictly better than the original. Caller decides whether to
    // send it (see visionImageDataUrl, which refuses to send an over-limit one).
    return smallest ? { bytes: smallest, mimeType: "image/jpeg" } : null;
  } catch {
    return null;
  }
}

// Build the image_url data URL for a vision attachment, respecting the
// provider's per-image byte limit. Under-limit uploads pass through untouched
// (sharp is never invoked). Oversized uploads are compressed once and cached;
// later turns reuse the cached JPEG. Returns null when the upload is missing,
// undecodable, or still over the limit after max compression — the caller skips
// the image so the provider never gets an over-limit image_url to 400 on.
export async function visionImageDataUrl(
  instance: Instance,
  id: string,
  limitBytes: number
): Promise<string | null> {
  const upload = readUpload(instance, id);
  if (!upload) return null;

  // Fits already: send the original bytes untouched.
  if (upload.bytes.length <= limitBytes) {
    return `data:${upload.mimeType};base64,${base64(upload.bytes)}`;
  }

  // Cache hit: derived JPEG was computed on an earlier turn.
  const cached = readVisionVariant(instance, id, limitBytes);
  if (cached) return `data:image/jpeg;base64,${base64(cached)}`;

  const result = await compressImageToFit(upload.bytes, upload.mimeType, limitBytes);
  if (result && result.bytes.length <= limitBytes) {
    writeVisionVariant(instance, id, limitBytes, result.bytes);
    appendLog(instance, "chat.image.compressed", {
      uploadId: id,
      fromBytes: upload.bytes.length,
      toBytes: result.bytes.length,
      limitBytes
    });
    return `data:${result.mimeType};base64,${base64(result.bytes)}`;
  }

  // Undecodable (result null) or still over the limit after max compression
  // (a pathologically small limit). Don't emit an image_url the provider would
  // reject — drop it so the turn still succeeds. The caller logs chat.image.missing.
  appendLog(instance, "chat.image.compress_failed", {
    uploadId: id,
    bytes: upload.bytes.length,
    finalBytes: result ? result.bytes.length : null,
    limitBytes,
    mimeType: upload.mimeType
  });
  return null;
}
