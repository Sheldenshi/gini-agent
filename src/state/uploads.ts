import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
}

function ensureUploadsDir(instance: Instance): string {
  const dir = uploadsDir(instance);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionFor(mimeType: string): string {
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
  const ext = extensionFor(manifest.mimeType);
  const blobPath = join(dir, `${id}.${ext}`);
  if (!existsSync(blobPath)) return null;
  const bytes = readFileSync(blobPath);
  return { bytes: new Uint8Array(bytes), mimeType: manifest.mimeType, filename: manifest.filename };
}

export function uploadDataUrl(instance: Instance, id: string): string | null {
  const upload = readUpload(instance, id);
  if (!upload) return null;
  const base64 = Buffer.from(upload.bytes).toString("base64");
  return `data:${upload.mimeType};base64,${base64}`;
}

export function uploadExists(instance: Instance, id: string): boolean {
  return existsSync(join(uploadsDir(instance), `${id}.json`));
}

// Best-effort metadata read used by /api/uploads/:id HEAD and for
// downstream callers that just need size/type without the bytes.
export function uploadStat(instance: Instance, id: string): { size: number; mimeType: string; filename?: string } | null {
  const dir = uploadsDir(instance);
  const manifestPath = join(dir, `${id}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UploadManifest;
    const ext = extensionFor(manifest.mimeType);
    const blobPath = join(dir, `${id}.${ext}`);
    const size = existsSync(blobPath) ? statSync(blobPath).size : manifest.size;
    return { size, mimeType: manifest.mimeType, filename: manifest.filename };
  } catch {
    return null;
  }
}
