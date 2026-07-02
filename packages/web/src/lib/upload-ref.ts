// Web mirror of the gateway's gini-upload:// scheme (src/lib/upload-ref.ts).
// The agent embeds an attachment as `![alt](gini-upload://<id>)` or
// `[name](gini-upload://<id>)` in its reply markdown; MarkdownContent rewrites
// the ref to the BFF upload URL for an <img>/<a>. Web is a separate build that
// can't import the gateway lib, so this small constant + parser is duplicated
// deliberately. See ADR outbound-chat-attachments.md.

export const UPLOAD_REF_SCHEME = "gini-upload://";

// Extract the upload id from a single ref (an `<img src>` / `<a href>` value a
// markdown renderer hands us). Returns null for any non-upload URL — the caller
// MUST NOT auto-fetch a foreign URL (this is the allowlist that closes the SSRF
// / tracking-pixel surface); for an untrusted foreign http(s) image it renders
// an inert click-to-open chip instead, and drops a non-http(s) src.
export function uploadIdFromRef(ref: string | undefined | null): string | null {
  if (!ref || !ref.startsWith(UPLOAD_REF_SCHEME)) return null;
  const id = ref.slice(UPLOAD_REF_SCHEME.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
