// Shared BFF↔client protocol constants for the gateway-down envelope.
//
// Import-free on purpose: web/src/lib/runtime.ts is server-only (node:fs et
// al.) and must not enter the client bundle, while web/src/lib/api.ts is
// client code — this module is the one place both sides can import the
// contract from, so the BFF's 503 envelope and the client's detection of it
// cannot drift apart.

// Machine-readable marker for "the gateway itself is down", as opposed to a
// gateway-produced error. The client keys its transient "reconnecting"
// treatment on this code.
export const GATEWAY_UNREACHABLE_CODE = "gateway_unreachable";

// The user-facing message for that state — also the client-side fallback for
// a bodyless 5xx, so both paths read identically in toasts.
export const GATEWAY_RESTARTING_MESSAGE = "Gini is restarting — reconnecting.";
