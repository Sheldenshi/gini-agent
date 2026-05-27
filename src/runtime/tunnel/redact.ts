// Centralized redact() helper. Replaces any occurrence of the live tunnel
// secret, any prior secret still inside the rotation window, the live public
// URL, and the trycloudflare.com hostname suffix with `<redacted-secret>`.
// Percent-encoded variants are matched too — some sinks log raw inbound paths
// before canonicalization. See PLAN.md "Log redaction".

const PLACEHOLDER = "<redacted-secret>";
const TRYCLOUDFLARE_HOSTNAME_SUFFIX = "trycloudflare.com";
const ROTATION_TIME_FLOOR_MS = 30_000;

interface PriorSecret {
  value: string;
  /** ms timestamp at which this secret was rotated out (commit). */
  rotatedAt: number;
  /** Count of in-flight requests captured at the rotation commit. Decrement
   *  as those requests finish; the secret only leaves the redaction set when
   *  this hits 0 AND ROTATION_TIME_FLOOR_MS has elapsed since rotatedAt. */
  inFlight: number;
}

// Module-level singleton state. Initialized via setRedactionSecret() on
// startup and on rotation; queried on every redact() call. Process-bound;
// distinct runtime processes maintain their own ring (each owns its own
// config.json reads).
const state: {
  current: string | null;
  publicUrl: string | null;
  prior: PriorSecret[];
} = {
  current: null,
  publicUrl: null,
  prior: []
};

export function setRedactionSecret(secret: string | null): void {
  if (state.current === secret) return;
  if (state.current) {
    state.prior.push({ value: state.current, rotatedAt: Date.now(), inFlight: 0 });
  }
  state.current = secret;
}

export function setRedactionPublicUrl(url: string | null): void {
  state.publicUrl = url;
}

function pruneRotationRing(now: number = Date.now()): void {
  state.prior = state.prior.filter((entry) => {
    if (entry.inFlight > 0) return true;
    return now - entry.rotatedAt < ROTATION_TIME_FLOOR_MS;
  });
}

/** Replace every occurrence of the redaction targets in `input` with the
 *  placeholder. Handles raw + percent-encoded variants. Returns the input
 *  unchanged when nothing matches. */
export function redact(input: string): string {
  pruneRotationRing();
  if (!input) return input;
  let out = input;
  for (const target of collectTargets()) {
    if (!target) continue;
    out = replaceAll(out, target, PLACEHOLDER);
    const enc = percentEncodeRfc3986(target);
    if (enc && enc !== target) out = replaceAll(out, enc, PLACEHOLDER);
  }
  return out;
}

function* collectTargets(): Iterable<string> {
  if (state.current) yield state.current;
  yield* state.prior.map((entry) => entry.value);
  if (state.publicUrl) yield state.publicUrl;
  yield TRYCLOUDFLARE_HOSTNAME_SUFFIX;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  // String.prototype.replaceAll on a literal needle is escape-free.
  return haystack.split(needle).join(replacement);
}

function percentEncodeRfc3986(value: string): string {
  // encodeURIComponent leaves !'()*-._~ unencoded. For redaction we want a
  // form that matches the way our own URL writer encodes the secret in a
  // path segment, which is what encodeURIComponent produces. Base64url uses
  // [A-Z][a-z][0-9]_- which encodeURIComponent leaves alone, so the
  // typical secret value comes back unchanged. The function still handles
  // the publicUrl + hostname targets, which may carry chars that encode.
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Test-only: reset module state. Production callers never call this. */
export function __resetRedactionForTests(): void {
  state.current = null;
  state.publicUrl = null;
  state.prior = [];
}
