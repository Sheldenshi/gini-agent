// Minimal cookie parsing + Set-Cookie serialization for the gateway. The
// gateway is otherwise bearer-only; cookies exist for the relay device-pairing
// session (gini_session), the per-request binding secret (gini_pair), and the
// per-browser client-id (gini_client) — a non-secret identity value, NOT a
// credential. Kept dependency-free and side-effect-free so it is trivially
// unit-tested.

// Parse a `Cookie:` request header into a name→value map. Tolerates missing
// header, stray whitespace, and `=` inside values (only the first `=` splits a
// pair). Values are URL-decoded; names are taken verbatim. Later duplicates win.
// For the credential cookies (gini_session/gini_pair) that's safe because their
// values are validated against hashed server-stored secrets downstream, so a
// smuggled duplicate can't be forged into a valid value and the gate fails
// closed. gini_client is NOT hash-validated (it's a non-secret identity key used
// verbatim); its anti-tossing safety instead comes from the `__Host-` prefix plus
// the secure-front no-plain-fallback read in clientCookieValue (see src/http.ts),
// so a sibling-subdomain-tossed plain duplicate is never honored on a secure front.
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!name) continue;
    const rawValue = trimmed.slice(eq + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Malformed percent-encoding: fall back to the raw value rather than throw.
    }
    out[name] = value;
  }
  return out;
}

// Read a single cookie value off a request, or undefined when absent.
export function cookieValue(request: Request, name: string): string | undefined {
  const cookies = parseCookies(request.headers.get("cookie"));
  return cookies[name];
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  // Seconds. 0 expires the cookie immediately (clear). Omit for a session cookie.
  maxAge?: number;
  // Intentionally rarely set: omitting Domain makes the cookie host-only, which
  // is what relay per-subdomain isolation needs.
  domain?: string;
}

// Build a Set-Cookie header value. The value is URL-encoded so tokens with
// reserved characters round-trip through parseCookies. Attribute order follows
// the conventional Set-Cookie layout.
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.path) segments.push(`Path=${options.path}`);
  if (options.domain) segments.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (options.secure) segments.push("Secure");
  if (options.httpOnly) segments.push("HttpOnly");
  return segments.join("; ");
}
