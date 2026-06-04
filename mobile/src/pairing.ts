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

import { normalizeBaseUrl } from "./auth";

// The wire status union, mirroring the gateway's PairingRequestStatus.
export type PairingStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "claimed"
  | "expired"
  | "cancelled";

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
  create(): Promise<PairingHandshake>;
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

  async function call(
    path: string,
    init: { method?: string; secret?: string; body?: boolean }
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [NATIVE_CLIENT_HEADER]: "native"
    };
    if (init.secret) headers[NATIVE_SECRET_HEADER] = init.secret;
    const response = await fetchImpl(`${origin}/api/pairing${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body ? "{}" : undefined
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

    async create() {
      const body = await call("/request", { method: "POST", body: true });
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
      if (typeof status !== "string") {
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
