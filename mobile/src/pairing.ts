// Native relay-pairing handshake client.
//
// The device shows a code and waits for the operator to approve it on the web
// app — the mirror of `web/src/app/pair/page.tsx`, but for a non-browser client.
// A browser claim hands back the session as an HttpOnly cookie; a React Native
// app can't read that, so the gateway's NATIVE pairing path (gated on the
// `X-Gini-Pair-Client: native` header + the absence of Sec-Fetch-*) instead
// returns the binding secret and the session token in the response BODY. This
// client carries the binding secret in `X-Gini-Pair-Secret` (no cookie jar) and
// stores the token for use as `Authorization: Bearer`. See ADR
// device-pairing-auth.md ("Native pairing client").

import type { PairingRequestStatus } from "@runtime/types";
import { normalizeBaseUrl } from "./auth";
import { isPairableHost } from "./relay-link";

// Re-export the runtime contract's status union so the mobile client can't drift
// from the wire (mirrors web/src/lib/pairing.ts). It's a type-only import,
// erased at build, so no server code enters the RN bundle.
export type PairingStatus = PairingRequestStatus;

// The runtime ships the union as a TYPE only; this is the matching VALUE set used
// to validate a status string off the wire before trusting it. Removing a member
// from the runtime union makes the corresponding literal here fail typecheck (the
// drift guard); a newly-ADDED member won't fail typecheck but is safely rejected
// at runtime as off-contract until it's added here too.
const PAIRING_STATUSES: ReadonlySet<PairingStatus> = new Set<PairingStatus>([
  "pending",
  "approved",
  "rejected",
  "claimed",
  "expired",
  "cancelled"
]);

// Carries the HTTP status so the pair screen can tell a terminal 401/403/404
// (start over) from a transient relay blip (keep polling).
export class PairingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PairingError";
  }
}

export interface PairingHandshake {
  id: string;
  code: string;
  bindSecret: string;
}

export interface PairingClient {
  // The gateway origin this client is bound to (normalized).
  readonly origin: string;
  // deviceName is an optional human label (e.g. "iPhone 16 Pro") the operator
  // sees on the approval row; the gateway sanitizes it and falls back to a
  // User-Agent-derived label when absent.
  create(deviceName?: string): Promise<PairingHandshake>;
  poll(id: string, bindSecret: string): Promise<PairingStatus>;
  // Returns the minted device token (used as Authorization: Bearer).
  claim(id: string, bindSecret: string): Promise<string>;
  cancel(id: string, bindSecret: string): Promise<void>;
}

type FetchFn = typeof fetch;

const NATIVE_CLIENT_HEADER = "x-gini-pair-client";
const NATIVE_SECRET_HEADER = "x-gini-pair-secret";

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A relay-pairing handshake client bound to ONE gateway origin. The origin is
// normalized and transport-checked up front (normalizeBaseUrl rejects a public
// http:// host) so a bad or hostile link can never ship a pairing request — or
// later the bearer — in cleartext to the wrong place. `fetchImpl` is injectable
// for tests.
export function createPairingClient(relayUrl: string, fetchImpl: FetchFn = fetch): PairingClient {
  const origin = normalizeBaseUrl(relayUrl);
  // Enforce the relay/loopback pairing policy in the client itself so it's
  // safe-by-construction — a caller can never drive a pairing handshake (or, on
  // claim, ship the bearer) against an arbitrary https host that merely passed the
  // transport guard. normalizeBaseUrl permits any https origin; this narrows it.
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    host = "";
  }
  if (!isPairableHost(host)) {
    throw new PairingError(0, "Pairing requires a Gini relay or local gateway origin.");
  }

  async function call(
    path: string,
    init: { method?: string; secret?: string; body?: boolean; payload?: Record<string, unknown> }
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [NATIVE_CLIENT_HEADER]: "native"
    };
    if (init.secret) headers[NATIVE_SECRET_HEADER] = init.secret;
    const response = await fetchImpl(`${origin}/api/pairing${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.payload ? JSON.stringify(init.payload) : init.body ? "{}" : undefined
    });
    const text = await response.text();
    const value = text ? safeParse(text) : null;
    if (!response.ok) {
      const message =
        value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string"
          ? (value as { error: string }).error
          : `HTTP ${response.status}`;
      throw new PairingError(response.status, message);
    }
    return value;
  }

  return {
    origin,

    async create(deviceName) {
      const body = await call("/request", {
        method: "POST",
        body: true,
        payload: deviceName ? { deviceName } : undefined
      });
      if (
        !body
        || typeof body !== "object"
        || typeof (body as PairingHandshake).id !== "string"
        || typeof (body as PairingHandshake).code !== "string"
        || typeof (body as PairingHandshake).bindSecret !== "string"
      ) {
        throw new PairingError(0, "Gateway returned a malformed pairing response.");
      }
      const { id, code, bindSecret } = body as PairingHandshake;
      return { id, code, bindSecret };
    },

    async poll(id, bindSecret) {
      const body = await call(`/request/${encodeURIComponent(id)}`, { secret: bindSecret });
      const status = (body as { status?: unknown } | null)?.status;
      if (typeof status !== "string" || !PAIRING_STATUSES.has(status as PairingStatus)) {
        throw new PairingError(0, "Gateway returned a malformed status response.");
      }
      return status as PairingStatus;
    },

    async claim(id, bindSecret) {
      const body = await call(`/request/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        secret: bindSecret,
        body: true
      });
      const token = (body as { token?: unknown } | null)?.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new PairingError(0, "Gateway did not return a session token.");
      }
      return token;
    },

    async cancel(id, bindSecret) {
      await call(`/request/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        secret: bindSecret,
        body: true
      });
    }
  };
}
