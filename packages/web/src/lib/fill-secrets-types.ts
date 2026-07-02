// Shared types + parser for the browser_fill_secret approval flow.
//
// Mirror of src/execution/browser-fill-secrets-types.ts (the
// gateway-side canonical source). The duplication exists because
// Next.js' Turbopack refuses to resolve module paths outside the
// web/ project root, even with a tsconfig path alias that
// typecheck honors (verified via `bun run web:build`). Until we
// publish the shared module as a workspace package, the web copy
// stays byte-for-byte equivalent to the gateway copy for the
// parser logic — the kind allowlist MUST match what the gateway
// dispatch and /connect handler enforce, otherwise a malformed
// approval payload could widen the rendered input type past what
// the gateway permits.
//
// If you change the parser or the kind allowlist, update BOTH
// files together. The dispatch test
// src/execution/browser-fill-secrets-dispatch.test.ts pins the
// gateway-side behavior; the contract here is implicit visual
// review.

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
