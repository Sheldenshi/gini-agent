// Minimal AWS Signature Version 4 signer for the Bedrock provider.
//
// gini's bedrock provider calls the model-agnostic Converse API by POSTing to
// `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse`
// (and `/converse-stream`). Those requests are authenticated with a SigV4
// signature over standard AWS credentials — no bearer token, no key minting,
// so a long-lived IAM key or a refreshed SSO/role session both work.
//
// This module implements exactly what that path needs with `node:crypto` (no
// AWS SDK dependency): the SigV4 canonical-request → string-to-sign → signing-
// key HMAC chain → signature, plus credential/region resolution from the
// standard AWS_* env vars. The SigV4 service name for the Converse endpoint is
// `bedrock`. The model id carries a ':' (e.g. `us.amazon.nova-pro-v1:0`) that
// lands in the request path, so canonicalUri double-encodes it to match how AWS
// recomputes the signed path.
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  // Present only for temporary (STS) credentials; long-lived IAM access keys
  // omit it. When present it is sent as x-amz-security-token.
  sessionToken?: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

// `2026-06-08T18:00:00.000Z` -> `20260608T180000Z` (SigV4 x-amz-date).
function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// SigV4 canonical-URI encoding for non-S3 services: the request path is
// URI-encoded a SECOND time (each segment encoded; '/' preserved; unreserved
// chars A-Za-z0-9-_.~ left as-is). The caller already encodeURIComponent's a
// path segment that carries reserved chars (e.g. a Bedrock model id's ':' ->
// '%3A'), and AWS re-encodes the received path when recomputing the signature
// ('%3A' -> '%253A'); encoding pathname here matches that so the signature
// agrees. encodeURIComponent leaves !*'() unencoded, so encode those too.
function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    )
    .join("/");
}

// Sign a request and return the auth headers to merge into the outgoing fetch.
// `extraSignedHeaders` are non-SigV4 headers (e.g. content-type,
// anthropic-version) that are also sent on the request and must therefore be
// folded into the signature — their names/values have to match the fetch
// exactly. `host`, `x-amz-date`, and `x-amz-content-sha256` are always signed.
export function signAwsRequest(opts: {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  extraSignedHeaders?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const url = new URL(opts.url);
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = sha256Hex(opts.body);

  const signed: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp
  };
  // Temporary (STS/SSO/assumed-role) credentials MUST sign x-amz-security-token,
  // not just send it: Bedrock recomputes the signature over a canonical request
  // that includes the header, so an unsigned token yields 403 SignatureDoesNotMatch.
  if (opts.credentials.sessionToken) signed["x-amz-security-token"] = opts.credentials.sessionToken;
  for (const [name, value] of Object.entries(opts.extraSignedHeaders ?? {})) {
    signed[name.toLowerCase()] = value;
  }

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri(url.pathname),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const kDate = hmac(`AWS4${opts.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const headers: Record<string, string> = {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": stamp,
    "x-amz-content-sha256": payloadHash
  };
  if (opts.credentials.sessionToken) headers["x-amz-security-token"] = opts.credentials.sessionToken;
  return headers;
}

// Resolve AWS credentials for signing from the standard AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN env vars. Returns null when the
// access key or secret is absent. Gini does NOT read `~/.aws/credentials`, SSO
// session caches, `~/.aws/config` role chains, process/web-identity, or
// IMDS/container roles: the keys are entered explicitly when the bedrock
// provider is added (web Add Provider, `gini setup`, or `gini provider set`)
// and persisted to ~/.gini/secrets.env, which the gateway sources into the
// environment on launch. A user holding only a temporary session passes its
// access key + secret + session token through that same entry point.
export function resolveAwsCredentials(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
  }
  return null;
}
