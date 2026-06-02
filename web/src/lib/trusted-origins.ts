// Shared parser for the `GINI_TRUSTED_ORIGINS` env var. Two callers:
//   - `web/src/proxy.ts` matches the inbound `Host` header against each
//     entry (with default-port equivalence — `host:443` ≡ `host`).
//   - `web/src/lib/runtime.ts` matches the inbound `Origin` header against
//     each entry's full origin string.
// Sharing the parse keeps the validation byte-equivalent so a typo that
// drops one consumer can't silently keep the other consumer matching
// against a more permissive shape.
//
// Validation rules (strict — operator-set env var, fail-loud on typo):
//   - empty / whitespace-only raw → null (unset; loopback-only fallback applies).
//   - per-entry split on comma, trim. Empty entries skipped.
//   - `new URL(entry)` must parse. Failures skipped individually.
//   - reject entries with non-empty pathname (other than `/`), search, hash,
//     username, or password — an operator who pasted a full URL like
//     `https://gini-server.tail.ts.net/path?q=1` would silently get a
//     broader allowlist than they meant. The outer caller decides what
//     to do when every entry is malformed (fail-closed for the
//     BFF guard, silently empty for the proxy classifier).
//   - return URL instances rather than pre-extracted strings so each
//     caller can pull the field it cares about (`.host` for the proxy
//     classifier, `${protocol}//${host}` for the BFF Origin guard)
//     without re-parsing.

/** Parse `GINI_TRUSTED_ORIGINS` into validated URL entries. Returns null
 *  when the env var is unset; returns an array (possibly empty) when the
 *  env var is set. */
export function parseTrustedOriginUrls(raw: string | undefined): URL[] | null {
  if (!raw || !raw.trim()) return null;
  const out: URL[] = [];
  for (const candidate of raw.split(",")) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.pathname !== "" && parsed.pathname !== "/")
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.username !== ""
        || parsed.password !== ""
      ) {
        continue;
      }
      out.push(parsed);
    } catch {
      // Skip malformed entries individually.
    }
  }
  return out;
}
