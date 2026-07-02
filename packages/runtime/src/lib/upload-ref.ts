// Canonical reference for an agent-produced ATTACHMENT (any file the agent
// uploaded — a screenshot, a generated chart, a PDF, a CSV, a log) that should
// appear INLINE in the chat reply. Attachment-producing tools (browser_vision,
// attachments/promote-file) hand the model a ready-to-paste markdown tag and
// the model drops it into its reply text wherever the attachment belongs (so
// it can land mid-prose, between the model's sentences).
//
// Markdown SYNTAX carries the intent:
//   - an image  → `![alt](gini-upload://<id>)`  → renders inline as a picture
//   - any file  → `[filename](gini-upload://<id>)` → renders a clickable
//                  download chip (same affordance inbound file attachments get)
//
// Each client rewrites the `gini-upload://<id>` ref to its own authed source:
//   - web: /api/runtime/uploads/<id> (BFF injects the bearer server-side)
//   - mobile: <gatewayOrigin>/api/uploads/<id> + Authorization header
//   - cli: fetch <gatewayOrigin>/api/uploads/<id> with the bearer, save to disk
//   - telegram: resolve the upload's on-disk path; send images as a photo and
//     other files as a document
//
// A dedicated scheme (not a real http(s) URL or path) is deliberate: it can't
// collide with a genuine external URL, so a client renderer can hard-allowlist
// `gini-upload://` refs and never AUTO-FETCH any other image/link src — closing
// the SSRF / tracking-pixel surface that arbitrary model-authored markdown
// images/links would otherwise open. A foreign http(s) image isn't loaded
// inline; it renders an inert click-to-open chip that fetches only on an
// explicit click, while a non-http(s) src (data:/javascript:) is dropped
// entirely. See ADR outbound-chat-attachments.md.

export const UPLOAD_REF_SCHEME = "gini-upload://";

// Upload ids are crypto.randomUUID() (see src/state/uploads.ts) — hex digits
// and hyphens only. The id charset matches that (plus underscore for headroom)
// but deliberately EXCLUDES `.` so a ref written bare in prose can't absorb a
// trailing sentence period into the id. Anchored to the scheme so nothing else
// matches.
const UPLOAD_REF_RE = /gini-upload:\/\/([A-Za-z0-9_-]+)/g;

// Build the canonical reference for an upload id.
export function uploadRefFor(uploadId: string): string {
  return `${UPLOAD_REF_SCHEME}${uploadId}`;
}

// Strip control chars / markdown-breaking chars from a label so it can't inject
// extra markdown structure into the tag.
function sanitizeLabel(label: string, fallback: string): string {
  return label.replace(/[\r\n\]]+/g, " ").trim() || fallback;
}

// Build the ready-to-paste markdown tag the tool hands the model. An image
// mime yields an image tag (inline picture); any other mime yields a link tag
// (download chip), labeled with the filename when known.
export function uploadTagFor(
  uploadId: string,
  opts: { mimeType?: string; filename?: string; alt?: string } = {}
): string {
  const ref = uploadRefFor(uploadId);
  const isImage = (opts.mimeType ?? "").startsWith("image/");
  if (isImage) {
    return `![${sanitizeLabel(opts.alt ?? "image", "image")}](${ref})`;
  }
  return `[${sanitizeLabel(opts.filename ?? opts.alt ?? "file", "file")}](${ref})`;
}

// Convenience for an image-only producer (browser_vision screenshots).
export function imageTagFor(uploadId: string, alt = "image"): string {
  return uploadTagFor(uploadId, { mimeType: "image/png", alt });
}

// Extract the upload id from a single ref string (e.g. an `<img src>` / `<a
// href>` value a markdown renderer hands us). Returns null when the value isn't
// a gini-upload ref — the client MUST then leave the node alone / drop it
// rather than fetch a foreign URL.
export function uploadIdFromRef(ref: string | undefined | null): string | null {
  if (!ref || !ref.startsWith(UPLOAD_REF_SCHEME)) return null;
  const id = ref.slice(UPLOAD_REF_SCHEME.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

// Extract every distinct upload id referenced in a block of reply text, in
// first-seen order. Used by the surfaces that render from the raw reply string
// (Telegram mirror, CLI) rather than from a markdown AST.
export function uploadIdsFromText(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of text.matchAll(UPLOAD_REF_RE)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
