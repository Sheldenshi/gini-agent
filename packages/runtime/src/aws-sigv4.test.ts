import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveAwsCredentials, signAwsRequest } from "./aws-sigv4";

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const URL_ = "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages";
const BODY = JSON.stringify({ model: "anthropic.claude-opus-4-8", max_tokens: 8 });

// Save/set/restore env vars around a synchronous body.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

describe("signAwsRequest", () => {
  test("produces a deterministic, correctly-scoped SigV4 Authorization (golden vector)", () => {
    const headers = signAwsRequest({
      method: "POST",
      url: URL_,
      body: BODY,
      region: "us-east-1",
      service: "bedrock-mantle",
      credentials: CREDS,
      extraSignedHeaders: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      now: new Date("2026-06-08T18:00:00.000Z")
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260608/us-east-1/bedrock-mantle/aws4_request, " +
        "SignedHeaders=anthropic-version;content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=301956904893bea6fabe9a5d71592eac70da956295d5105189e9463f0b8ec734"
    );
    expect(headers["x-amz-date"]).toBe("20260608T180000Z");
    // x-amz-content-sha256 is the SHA-256 of the exact body bytes.
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(BODY, "utf8").digest("hex"));
    // Long-lived IAM keys carry no session token.
    expect(headers["x-amz-security-token"]).toBeUndefined();
  });

  test("SigV4-encodes reserved path characters in the canonical URI", () => {
    // encodeURIComponent leaves !*'() unencoded, but SigV4's canonical URI
    // requires them encoded; canonicalUri fixes that. A Bedrock model id never
    // contains them, so exercise a path that does to guard the general case.
    const headers = signAwsRequest({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/a(b)!'*/converse",
      body: BODY,
      region: "us-east-1",
      service: "bedrock",
      credentials: CREDS,
      now: new Date("2026-06-08T18:00:00.000Z")
    });
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  test("temporary credentials sign AND send x-amz-security-token (AWS requires it in SignedHeaders)", () => {
    const headers = signAwsRequest({
      method: "POST",
      url: URL_,
      body: BODY,
      region: "us-east-1",
      service: "bedrock-mantle",
      credentials: { ...CREDS, sessionToken: "FwoGsessiontoken" },
      now: new Date("2026-06-08T18:00:00.000Z")
    });
    // Sent on the wire …
    expect(headers["x-amz-security-token"]).toBe("FwoGsessiontoken");
    // … AND folded into the canonical SignedHeaders (alphabetical), else Bedrock
    // returns 403 SignatureDoesNotMatch for STS/SSO/assumed-role sessions.
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,"
    );
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  test("defaults the timestamp to the current time when not injected", () => {
    const headers = signAwsRequest({
      method: "POST",
      url: URL_,
      body: BODY,
      region: "us-east-1",
      service: "bedrock-mantle",
      credentials: CREDS
    });
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
    );
  });
});

describe("resolveAwsCredentials", () => {
  test("reads the standard env vars including the session token", () => {
    withEnv({ AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "secretenv", AWS_SESSION_TOKEN: "tokenenv" }, () => {
      expect(resolveAwsCredentials()).toEqual({ accessKeyId: "AKIAENV", secretAccessKey: "secretenv", sessionToken: "tokenenv" });
    });
  });

  test("omits an absent session token", () => {
    withEnv({ AWS_ACCESS_KEY_ID: "AKIACUST", AWS_SECRET_ACCESS_KEY: "skcust", AWS_SESSION_TOKEN: undefined }, () => {
      expect(resolveAwsCredentials()).toEqual({ accessKeyId: "AKIACUST", secretAccessKey: "skcust", sessionToken: undefined });
    });
  });

  test("returns null when the env credentials are absent — no ~/.aws fallback", () => {
    // The keys are entered explicitly on provider add and sourced from
    // ~/.gini/secrets.env into the environment; nothing is read from
    // ~/.aws/credentials. A shared-credentials file pointed at a real path must
    // be ignored — its presence can't resolve credentials.
    withEnv(
      {
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
        AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/gini-test/credentials",
        AWS_PROFILE: undefined
      },
      () => {
        expect(resolveAwsCredentials()).toBeNull();
      }
    );
  });

  test("returns null when only the access key is set (secret missing)", () => {
    withEnv({ AWS_ACCESS_KEY_ID: "AKIAONLYID", AWS_SECRET_ACCESS_KEY: undefined }, () => {
      expect(resolveAwsCredentials()).toBeNull();
    });
  });
});
