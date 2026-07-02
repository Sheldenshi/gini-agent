// Mobile mirror of the gateway's gini-upload:// scheme (src/lib/upload-ref.ts).
// The agent embeds an attachment as `![alt](gini-upload://<id>)` /
// `[name](gini-upload://<id>)` in its reply markdown; the markdown image/link
// rules rewrite the ref to an authed image (AuthedImage) or a tap-to-open
// upload URL. Mobile is a separate build that can't import the gateway lib, so
// this small parser is duplicated deliberately. See ADR
// outbound-chat-attachments.md.

export const UPLOAD_REF_SCHEME = "gini-upload://";

// Extract the upload id from a single ref. Returns null for any non-upload
// value — the caller MUST NOT auto-fetch a foreign URL (the allowlist that
// closes the SSRF / tracking-pixel surface); it renders an inert click-to-open
// chip for a foreign http(s) image instead, or drops a non-http(s) src.
export function uploadIdFromRef(ref: string | undefined | null): string | null {
  if (!ref || !ref.startsWith(UPLOAD_REF_SCHEME)) return null;
  const id = ref.slice(UPLOAD_REF_SCHEME.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
