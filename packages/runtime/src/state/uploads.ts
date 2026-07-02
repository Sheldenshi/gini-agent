import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageAttachment, Instance } from "../types";
import { uploadsDir } from "../paths";

// Image bytes attached to chat messages live on disk under
// ~/.gini/instances/<instance>/uploads/<id>.<ext>. We never embed base64 in
// state.json or chat_blocks — the upload id is the canonical reference and
// the bytes stay outside the JSON write path. A small companion file
// (<id>.json) carries the mimeType + original filename so reads don't have
// to sniff the bytes.

interface UploadManifest {
  id: string;
  mimeType: string;
  filename?: string;
  size: number;
  createdAt: string;
}

// Uploads were image-only when the only ingestion path was the chat
// drop-zone. Now `signed_download` and `promote_file` route any byte
// stream into the same upload space (PDFs, build logs, transcripts,
// CSVs), so we accept any non-empty mime that looks structurally valid.
// Vision-only callers (provider vision context) still gate at
// `buildAttachmentContent` based on the stored mimeType; non-image uploads
// won't accidentally land in a vision call.
export function isPlausibleMime(mimeType: string): boolean {
  if (!mimeType) return false;
  const slash = mimeType.indexOf("/");
  if (slash <= 0 || slash === mimeType.length - 1) return false;
  // Reject whitespace; valid RFC 6838 mime grammar has none.
  return !/\s/.test(mimeType);
}


// Strip control/newline chars and collapse whitespace before persisting a
// filename — it is later rendered into the model-facing attachment marker,
// where an embedded newline could spoof extra marker lines / inject text.
export function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
}

function ensureUploadsDir(instance: Instance): string {
  const dir = uploadsDir(instance);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    case "image/svg+xml": return "svg";
    default: {
      const slash = mimeType.indexOf("/");
      return slash >= 0 ? mimeType.slice(slash + 1).replace(/[^a-z0-9]/gi, "") || "bin" : "bin";
    }
  }
}

// Resolve the on-disk blob path for a stored upload. The blob's extension is
// chosen by the WRITER (storeUpload, or the promote-file skill script), and
// those maps can disagree for a given mime — e.g. text/markdown is written
// `.md` by promote-file but `extensionFor` derives `markdown`. So try the
// computed extension first (fast path; correct for every storeUpload write and
// most promote writes), then fall back to any `<id>.<ext>` blob in the dir,
// excluding the `.json` manifest and the `.vis-*.jpg` vision-variant caches.
// Returns null when no blob exists. This keeps the reader tolerant of writer
// extension drift instead of 404-ing on a file that is plainly on disk.
function resolveBlobPath(dir: string, id: string, mimeType: string): string | null {
  const direct = join(dir, `${id}.${extensionFor(mimeType)}`);
  if (existsSync(direct)) return direct;
  // Fall back to any `<id>.<ext>` blob in the dir. Every caller has already
  // confirmed the `<id>.json` manifest exists in this dir, so the read can't
  // ENOENT. Exclude the manifest itself and the `.vis-*.jpg` vision-variant
  // caches so neither is mistaken for the blob.
  const match = readdirSync(dir).find(
    (name) => name.startsWith(`${id}.`) && !name.endsWith(".json") && !name.includes(`${id}.vis-`)
  );
  return match ? join(dir, match) : null;
}

export function storeUpload(
  instance: Instance,
  bytes: Uint8Array,
  mimeType: string,
  filename?: string
): ImageAttachment {
  if (!isPlausibleMime(mimeType)) {
    throw new Error(`Unsupported upload mime type: ${mimeType}`);
  }
  if (bytes.length === 0) throw new Error("Upload is empty.");
  const dir = ensureUploadsDir(instance);
  const id = crypto.randomUUID();
  const ext = extensionFor(mimeType);
  writeFileSync(join(dir, `${id}.${ext}`), bytes);
  const manifest: UploadManifest = {
    id,
    mimeType,
    filename: filename ? (sanitizeFilename(filename) || undefined) : undefined,
    size: bytes.length,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(manifest));
  return { id, mimeType, size: bytes.length };
}

export function readUpload(instance: Instance, id: string): { bytes: Uint8Array; mimeType: string; filename?: string } | null {
  const dir = uploadsDir(instance);
  const manifestPath = join(dir, `${id}.json`);
  if (!existsSync(manifestPath)) return null;
  let manifest: UploadManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UploadManifest;
  } catch {
    return null;
  }
  const blobPath = resolveBlobPath(dir, id, manifest.mimeType);
  if (!blobPath) return null;
  const bytes = readFileSync(blobPath);
  return { bytes: new Uint8Array(bytes), mimeType: manifest.mimeType, filename: manifest.filename };
}

export function uploadExists(instance: Instance, id: string): boolean {
  return existsSync(join(uploadsDir(instance), `${id}.json`));
}

// Vision variant: a derived, downscaled JPEG of an oversized upload, produced
// to fit a provider's per-image byte limit (e.g. Anthropic's 5 MB). Images
// replay on every turn, so the derived bytes are computed once and cached on
// disk next to the original. The output is always JPEG, so the limit is baked
// into the filename — a different limit produces a different cache file and a
// fresh recompress. The original upload is never mutated.
function visionVariantPath(instance: Instance, id: string, limitBytes: number): string {
  return join(uploadsDir(instance), `${id}.vis-${limitBytes}.jpg`);
}

export function readVisionVariant(instance: Instance, id: string, limitBytes: number): Uint8Array | null {
  const path = visionVariantPath(instance, id, limitBytes);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

export function writeVisionVariant(instance: Instance, id: string, limitBytes: number, bytes: Uint8Array): void {
  // Best-effort: the cache is an optimization, so a write failure (e.g. disk
  // full, races) must not break the turn — the caller already has the bytes.
  try {
    ensureUploadsDir(instance);
    writeFileSync(visionVariantPath(instance, id, limitBytes), bytes);
  } catch {
    // ignore — recompute next turn.
  }
}

// Best-effort metadata read used by /api/uploads/:id HEAD and for
// downstream callers that just need size/type without the bytes.
export function uploadStat(instance: Instance, id: string): { size: number; mimeType: string; filename?: string } | null {
  const dir = uploadsDir(instance);
  const manifestPath = join(dir, `${id}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UploadManifest;
    const blobPath = resolveBlobPath(dir, id, manifest.mimeType);
    const size = blobPath ? statSync(blobPath).size : manifest.size;
    return { size, mimeType: manifest.mimeType, filename: manifest.filename };
  } catch {
    return null;
  }
}

// Resolve the on-disk blob path for a stored upload, or null when the upload
// doesn't exist. Used by outbound dispatch paths (e.g. mirroring a screenshot
// to a messaging bridge) that need the actual file path rather than the bytes.
export function uploadPathFor(instance: Instance, id: string): string | null {
  const dir = uploadsDir(instance);
  const manifestPath = join(dir, `${id}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UploadManifest;
    return resolveBlobPath(dir, id, manifest.mimeType);
  } catch {
    return null;
  }
}
