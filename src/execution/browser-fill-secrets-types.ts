// Shared types + parser for the browser_fill_secrets approval flow.
//
// Three layers need to parse `slots` from a payload: the dispatcher
// that mints the approval (server), the /connect handler that runs the
// per-slot fill (server), and the chat-card UI that renders the inputs
// (browser, via the @runtime/* tsconfig path alias). Keeping the parser
// in one place — and the kind allowlist in one place — prevents drift
// where one layer accepts an attacker-supplied `kind` value that
// another layer rejects, which would let a malicious payload widen the
// rendered input type past what the UI's own allowlist would have
// permitted.
//
// This module must stay free of any Node-only imports so the web
// bundle can import it without dragging in src/state, playwright, etc.

export type FillSecretSlotKind =
  | "text"
  | "password"
  | "email"
  | "tel"
  | "number"
  | "url";

export const FILL_SECRET_ALLOWED_KINDS: ReadonlySet<FillSecretSlotKind> = new Set([
  "text",
  "password",
  "email",
  "tel",
  "number",
  "url"
]);

export interface FillSecretSlot {
  name: string;
  locator: string;
  label: string;
  kind: FillSecretSlotKind;
}

// Parses an unknown payload field into a list of well-formed slots.
// Slots with non-string `name` or `locator` are dropped silently;
// unknown `kind` values fall through to "text" so a malformed
// payload (or a future field we haven't taught the parser about)
// can't widen the rendered input type at any layer. `label`
// defaults to the slot's `name` when absent.
export function parseFillSecretSlots(raw: unknown): FillSecretSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as { name?: unknown; locator?: unknown; label?: unknown; kind?: unknown };
    if (typeof e.name !== "string" || typeof e.locator !== "string") return [];
    const kind: FillSecretSlotKind = typeof e.kind === "string"
      && (FILL_SECRET_ALLOWED_KINDS as ReadonlySet<string>).has(e.kind)
      ? (e.kind as FillSecretSlotKind)
      : "text";
    const label = typeof e.label === "string" ? e.label : e.name;
    return [{ name: e.name, locator: e.locator, label, kind }];
  });
}

// Returns origin + pathname for a raw URL, dropping the query string,
// fragment, userinfo, and any other component that may carry secrets
// (OAuth `code`/`state`, password-reset `token`, magic-link nonces,
// embedded session ids). Used by the dispatcher to build a
// redaction-safe `target` on the approval row, by the bounded
// fill_secret handler to compare live URL against approvedUrl, and
// by browserFillByLocator to re-check the page URL just before the
// playwright .fill(). Lives in this leaf module (no Node-only
// imports) so all three callers share the same normalization
// without crossing the dispatcher → browser tool dependency
// boundary.
//
// Returns undefined for invalid / non-http(s) URLs so the caller
// can either refuse the operation (dispatcher: refuse to mint an
// approval) or fall back to a locator-only target.
export function sanitizeUrlForAuditTarget(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}
