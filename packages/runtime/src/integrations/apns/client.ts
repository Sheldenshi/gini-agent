// APNs HTTP/2 client. Signs an ES256 JWT and POSTs the alert/background
// payload to api.push.apple.com per Apple's APNs Provider API. Designed
// to be testable: the http2 session factory is injectable so unit tests
// can feed a mock session.
//
// Config — all four env vars must be set for sendPush to function:
//   APNS_KEY_ID       — 10-char key identifier (from the Apple Developer
//                       console "Keys" page).
//   APNS_TEAM_ID      — 10-char Apple Developer team id.
//   APNS_KEY_P8_PATH  — absolute path to the ES256 private key (.p8)
//                       file downloaded once when the key was issued.
//   APNS_BUNDLE_ID    — the iOS app's bundle id. Used as a fallback
//                       topic if the per-call `topic` opt is absent.
// If any is unset, sendPush returns `{ ok: false, status: 0,
// reason: "apns_not_configured" }` and logs a single warning the first
// time it's called — the runtime continues normally and the dispatcher
// no-ops. This is intentional: dev installs without push credentials
// must not crash on first approval.
//
// JWT caching: signed once, reused for ~50 minutes. Apple caps tokens
// at 60 minutes; we refresh early to keep some headroom for clock skew
// and request-flight time. Without caching every push would re-sign the
// JWT (cheap, but wasteful).
//
// 410 Unregistered handling: callers (the dispatcher) treat
// `{ status: 410, reason: "Unregistered" }` as a signal to delete the
// token from the devices table. We surface the reason verbatim from
// Apple's response body so the caller can branch precisely.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import {
  connect as http2Connect,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  constants as http2Constants
} from "node:http2";

export interface APNsConfig {
  keyId?: string;
  teamId?: string;
  keyP8Path?: string;
  bundleId?: string;
  // Host override for tests / sandbox. Defaults to the production APNs
  // endpoint. Apple offers `api.sandbox.push.apple.com` for sandbox
  // builds but we use production here; staging differs only by host.
  host?: string;
}

export interface APNsPayload {
  // Apple-defined `aps` envelope. Callers build whatever shape they
  // need — the client doesn't constrain alert/sound/category/etc.
  aps: Record<string, unknown>;
  // Free-form application payload merged at the top level of the JSON
  // body. Read by the iOS notification service / response listener.
  [key: string]: unknown;
}

export interface APNsSendOptions {
  // `alert` shows a banner / lock-screen entry; `background` is silent
  // and requires `aps.content-available: 1`. The header maps to APNs'
  // `apns-push-type` which is mandatory on iOS 13+.
  pushType: "alert" | "background";
  // Priority 10 = "send immediately" (alerts). Priority 5 =
  // "throttle in the OS's discretion" (background). Required by Apple
  // for background pushes; recommended for alerts.
  priority: 5 | 10;
  // The topic header. For alerts this is the bundle id; for VoIP /
  // file-provider extensions it has suffixes. Callers pass the
  // device's stored bundle_id so a TestFlight install (different
  // bundle id) and a production install can coexist behind one set
  // of APNs creds.
  topic: string;
  // Optional collapse id — APNs coalesces same-id pushes in transit
  // so a flurry of approval-requested events for the same approval
  // doesn't pile up on lock screen. Max 64 bytes per Apple's spec.
  collapseId?: string;
  // Optional expiry — UNIX timestamp seconds. After this time APNs
  // discards the message if it hasn't delivered. Default behavior is
  // "best effort delivery"; we leave it unset for approvals so a
  // device returning from sleep still gets the prompt.
  expiration?: number;
}

export type APNsSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number; reason: string };

export interface APNsClient {
  sendPush(token: string, payload: APNsPayload, opts: APNsSendOptions): Promise<APNsSendResult>;
  close(): void;
}

// Internal — exposed for tests so they can stub the http2 session.
export interface APNsClientDeps {
  // Reads APNS_* values from somewhere — defaults to process.env.
  readConfig?: () => APNsConfig;
  // Reads the .p8 key file off disk — defaults to readFileSync(path, "utf8").
  // Tests inject a synthetic PEM string so they don't have to materialize
  // a real key on disk.
  readKey?: (path: string) => string;
  // Creates an http2 client session for the given origin. Tests inject
  // a fake session that resolves headers/data without touching the
  // network.
  connect?: (origin: string) => ClientHttp2Session;
  // Optional clock override — tests use this to advance time past the
  // 50-min JWT refresh threshold without sleeping.
  now?: () => number;
  // One-shot logger for missing-config warnings. Defaults to console.warn.
  warn?: (message: string) => void;
}

// Reads APNS_* env vars without throwing on missing keys. The dispatcher
// inspects each field and falls into the "not configured" branch when
// any of the four required fields is absent.
function defaultReadConfig(): APNsConfig {
  return {
    keyId: process.env.APNS_KEY_ID || undefined,
    teamId: process.env.APNS_TEAM_ID || undefined,
    keyP8Path: process.env.APNS_KEY_P8_PATH || undefined,
    bundleId: process.env.APNS_BUNDLE_ID || undefined,
    host: process.env.APNS_HOST || undefined
  };
}

function defaultReadKey(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultConnect(origin: string): ClientHttp2Session {
  return http2Connect(origin);
}

// Returns `true` if all four required APNs config fields are present.
function isConfigured(config: APNsConfig): config is Required<Pick<APNsConfig, "keyId" | "teamId" | "keyP8Path" | "bundleId">> & APNsConfig {
  return Boolean(config.keyId && config.teamId && config.keyP8Path && config.bundleId);
}

// JWT cache scoped to the (keyId, teamId, keyP8Path) tuple. If any
// field changes (rotated key, redeployed config) the cache is dropped
// and a fresh token is signed.
interface CachedToken {
  jwt: string;
  cacheKey: string;
  issuedAtMs: number;
}

// 50 minutes — Apple's hard cap is 60. The 10-minute headroom covers
// clock skew between us and Apple, plus the in-flight window of any
// long-running request that would otherwise straddle the cap.
const JWT_TTL_MS = 50 * 60 * 1000;

// Base64url without padding — JWT spec demands it.
function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function signJwt(config: Required<Pick<APNsConfig, "keyId" | "teamId" | "keyP8Path">>, readKey: (path: string) => string, nowMs: number): string {
  // APNs JWT header: { alg: "ES256", kid: <keyId>, typ: "JWT" }.
  // Apple requires `kid` to be the 10-char key id from the developer
  // console. Without it APNs rejects with 400 InvalidProviderToken.
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }));
  // Claims: iss = team id, iat = unix seconds. Apple ignores `exp` —
  // the 60-minute cap is enforced server-side based on iat.
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  const pem = readKey(config.keyP8Path);
  // Sign with ES256 (SHA-256 over the secp256r1 P-256 curve). Node's
  // crypto.createSign produces DER signatures by default; APNs wants
  // raw r||s. dsaEncoding: "ieee-p1363" emits the raw 64-byte form.
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: pem, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

function buildCacheKey(config: APNsConfig): string {
  return `${config.keyId}|${config.teamId}|${config.keyP8Path}`;
}

class APNsClientImpl implements APNsClient {
  private readonly deps: Required<Pick<APNsClientDeps, "readConfig" | "readKey" | "connect" | "now" | "warn">>;
  private cached: CachedToken | null = null;
  private session: ClientHttp2Session | null = null;
  private notConfiguredWarned = false;

  constructor(deps?: APNsClientDeps) {
    this.deps = {
      readConfig: deps?.readConfig ?? defaultReadConfig,
      readKey: deps?.readKey ?? defaultReadKey,
      connect: deps?.connect ?? defaultConnect,
      now: deps?.now ?? Date.now,
      warn: deps?.warn ?? ((message: string) => console.warn(message))
    };
  }

  private getOrRefreshJwt(config: Required<Pick<APNsConfig, "keyId" | "teamId" | "keyP8Path">>, nowMs: number): string {
    const cacheKey = buildCacheKey(config);
    if (
      this.cached &&
      this.cached.cacheKey === cacheKey &&
      nowMs - this.cached.issuedAtMs < JWT_TTL_MS
    ) {
      return this.cached.jwt;
    }
    const jwt = signJwt(config, this.deps.readKey, nowMs);
    this.cached = { jwt, cacheKey, issuedAtMs: nowMs };
    return jwt;
  }

  private getOrOpenSession(origin: string): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = this.deps.connect(origin);
    // Drop the cached session on error/close so the next sendPush opens
    // a fresh connection. APNs occasionally closes idle sessions; the
    // recovery path is just "open a new one on demand".
    session.once("close", () => {
      if (this.session === session) this.session = null;
    });
    session.once("error", () => {
      if (this.session === session) this.session = null;
    });
    this.session = session;
    return session;
  }

  async sendPush(
    token: string,
    payload: APNsPayload,
    opts: APNsSendOptions
  ): Promise<APNsSendResult> {
    const config = this.deps.readConfig();
    if (!isConfigured(config)) {
      if (!this.notConfiguredWarned) {
        this.notConfiguredWarned = true;
        this.deps.warn(
          "[apns] APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8_PATH, and APNS_BUNDLE_ID must all be set for push delivery; dispatcher will no-op until configured."
        );
      }
      return { ok: false, status: 0, reason: "apns_not_configured" };
    }
    const nowMs = this.deps.now();
    let jwt: string;
    try {
      jwt = this.getOrRefreshJwt(config, nowMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, reason: `jwt_sign_error: ${message}` };
    }
    const host = config.host ?? "https://api.push.apple.com";
    let session: ClientHttp2Session;
    try {
      session = this.getOrOpenSession(host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, reason: `connect_error: ${message}` };
    }

    const headers: Record<string, string | number> = {
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
      [http2Constants.HTTP2_HEADER_SCHEME]: "https",
      authorization: `bearer ${jwt}`,
      "apns-topic": opts.topic,
      "apns-push-type": opts.pushType,
      "apns-priority": String(opts.priority)
    };
    if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId;
    if (typeof opts.expiration === "number") headers["apns-expiration"] = String(opts.expiration);

    return await new Promise<APNsSendResult>((resolve) => {
      let stream: ClientHttp2Stream;
      try {
        stream = session.request(headers);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ ok: false, status: 0, reason: `request_error: ${message}` });
        return;
      }
      let status = 0;
      let bodyChunks: Buffer[] = [];
      stream.setEncoding("utf8");
      stream.on("response", (responseHeaders) => {
        const raw = responseHeaders[http2Constants.HTTP2_HEADER_STATUS];
        status = typeof raw === "string" ? Number(raw) : Number(raw ?? 0);
      });
      stream.on("data", (chunk: string | Buffer) => {
        bodyChunks.push(Buffer.from(chunk));
      });
      stream.on("end", () => {
        const body = Buffer.concat(bodyChunks).toString("utf8");
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
          return;
        }
        // Apple's error response is JSON with a `reason` field, e.g.
        //   { "reason": "Unregistered", "timestamp": 1234567890 }
        // The dispatcher branches on this verbatim; we don't normalize
        // anything except "missing body" → empty reason.
        let reason = "";
        if (body) {
          try {
            const parsed = JSON.parse(body) as { reason?: string };
            reason = String(parsed.reason ?? body);
          } catch {
            reason = body;
          }
        }
        resolve({ ok: false, status, reason: reason || `http_${status}` });
      });
      stream.on("error", (error) => {
        resolve({ ok: false, status: 0, reason: `stream_error: ${error.message}` });
      });
      try {
        stream.end(JSON.stringify(payload));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ ok: false, status: 0, reason: `write_error: ${message}` });
      }
    });
  }

  close(): void {
    if (this.session) {
      try { this.session.close(); } catch { /* already closed */ }
      this.session = null;
    }
    this.cached = null;
  }
}

// Module-level singleton — the dispatcher imports `defaultClient()` once
// at startup and reuses it for every push. Tests build their own via
// `createApnsClient({...})` with injected deps.
let defaultInstance: APNsClient | null = null;

export function createApnsClient(deps?: APNsClientDeps): APNsClient {
  return new APNsClientImpl(deps);
}

export function defaultClient(): APNsClient {
  if (!defaultInstance) defaultInstance = createApnsClient();
  return defaultInstance;
}

// Test helper — resets the module-level singleton so subsequent
// `defaultClient()` calls produce a fresh instance. Used by tests that
// want to clear cached JWT / sessions between cases.
export function __resetDefaultClientForTests(): void {
  if (defaultInstance) defaultInstance.close();
  defaultInstance = null;
}
