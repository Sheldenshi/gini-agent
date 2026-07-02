// A reference to a doc served by the gateway's GET /api/docs endpoint, derived
// from a full hosted docs URL (https://gini.lilaclabs.ai/docs/<path>#<anchor>).
export interface DocRef {
  path: string;
  anchor?: string;
}

// A single doc (or #anchor section) returned by the gateway. Mirrors the
// DocSection shape in src/docs.ts; duplicated minimally on the web side.
export interface DocSection {
  path: string;
  title: string;
  markdown: string;
  anchor?: string;
}

// Derive the gateway doc path (+ anchor) from a hosted docs URL by taking
// everything after `/docs/` in the pathname. Returns null for non-/docs/ or
// unparseable URLs so callers can fall back to a plain external link.
export function parseDocsUrl(url: string): DocRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const marker = "/docs/";
  const at = parsed.pathname.indexOf(marker);
  if (at < 0) return null;
  const path = parsed.pathname.slice(at + marker.length).replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  const anchor = parsed.hash.replace(/^#/, "");
  return anchor ? { path, anchor } : { path };
}
