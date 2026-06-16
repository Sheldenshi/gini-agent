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

  try {
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    const longestEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    // Start no larger than 2000px on the longest edge — well above what any
    // model needs for vision, but a big reduction from a full phone capture.
    let maxEdge = Math.min(longestEdge || 2000, 2000);
    let quality = 82;
    const qualityFloor = 50;
    const edgeFloor = 512;

    let smallest: Uint8Array | null = null;
    // Bounded so the loop always terminates: drop quality to the floor, then
    // shrink the longest edge 20% and reset quality, until under the limit.
    for (let i = 0; i < 8; i++) {
      const out = await sharp(bytes, { failOn: "none" })
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      const result = new Uint8Array(out);
      if (smallest === null || result.length < smallest.length) smallest = result;
      if (result.length <= limitBytes) return { bytes: result, mimeType: "image/jpeg" };

      if (quality > qualityFloor) {
        quality = Math.max(qualityFloor, quality - 15);
      } else if (maxEdge > edgeFloor) {
        maxEdge = Math.max(edgeFloor, Math.round(maxEdge * 0.8));
        quality = 82;
      } else {
        break;
      }
    }
    // Nothing fit, but the smallest JPEG is still strictly better than the
    // original (which already failed the limit) — return it best-effort.
    return smallest ? { bytes: smallest, mimeType: "image/jpeg" } : null;
  } catch {
    // Undecodable format or corrupt bytes: let the caller fall back to the
    // original rather than dropping the image.
    return null;
  }
}

// Build the image_url data URL for a vision attachment, respecting the
// provider's per-image byte limit. Under-limit uploads pass through untouched
// (sharp is never invoked). Oversized uploads are compressed once and cached;
// later turns reuse the cached JPEG. Returns null only when the upload itself
// is missing.
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
  if (result) {
    writeVisionVariant(instance, id, limitBytes, result.bytes);
    appendLog(instance, "chat.image.compressed", {
      uploadId: id,
      fromBytes: upload.bytes.length,
      toBytes: result.bytes.length,
      limitBytes
    });
    return `data:${result.mimeType};base64,${base64(result.bytes)}`;
  }

  // Couldn't compress (undecodable): send the original and let the provider
  // decide — nothing else we can do here.
  appendLog(instance, "chat.image.compress_failed", {
    uploadId: id,
    bytes: upload.bytes.length,
    limitBytes,
    mimeType: upload.mimeType
  });
  return `data:${upload.mimeType};base64,${base64(upload.bytes)}`;
}
