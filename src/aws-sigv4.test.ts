import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAwsProfileCredentials, resolveAwsCredentials, signAwsRequest } from "./aws-sigv4";

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

function tempCredsFile(body: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "gini-aws-"));
  const file = join(dir, "credentials");
  writeFileSync(file, body);
  return { dir, file };
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

  test("falls back to ~/.aws/credentials when env credentials are absent", () => {
    const { dir, file } = tempCredsFile("[default]\naws_access_key_id = AKIAFILE\naws_secret_access_key = skfile\n");
    try {
      withEnv(
        { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: undefined },
        () => {
          expect(resolveAwsCredentials()).toEqual({ accessKeyId: "AKIAFILE", secretAccessKey: "skfile", sessionToken: undefined });
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readAwsProfileCredentials", () => {
  test("parses the named profile, skipping comments/blank lines, other profiles, and value-less lines", () => {
    const { dir, file } = tempCredsFile(
      [
        "# a comment",
        "; another comment",
        "",
        "[other]",
        "aws_access_key_id = NOPE",
        "",
        "[work]",
        "  aws_access_key_id = AKIAWORK ",
        "aws_secret_access_key = skwork",
        "aws_session_token = tokwork",
        "novalueline",
        "[trailing]",
        "aws_access_key_id = X"
      ].join("\n")
    );
    try {
      withEnv({ AWS_SHARED_CREDENTIALS_FILE: file }, () => {
        expect(readAwsProfileCredentials("work")).toEqual({ accessKeyId: "AKIAWORK", secretAccessKey: "skwork", sessionToken: "tokwork" });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for a profile that is not present", () => {
    const { dir, file } = tempCredsFile("[default]\naws_access_key_id = A\naws_secret_access_key = B\n");
    try {
      withEnv({ AWS_SHARED_CREDENTIALS_FILE: file }, () => {
        expect(readAwsProfileCredentials("missing")).toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the profile has an id but no secret", () => {
    const { dir, file } = tempCredsFile("[default]\naws_access_key_id = onlyid\n");
    try {
      withEnv({ AWS_SHARED_CREDENTIALS_FILE: file }, () => {
        expect(readAwsProfileCredentials("default")).toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the configured credentials file does not exist", () => {
    const missing = join(tmpdir(), "gini-aws-nonexistent-dir-xyz", "credentials");
    withEnv({ AWS_SHARED_CREDENTIALS_FILE: missing }, () => {
      expect(readAwsProfileCredentials("default")).toBeNull();
    });
  });

  test("uses the ~/.aws default path when AWS_SHARED_CREDENTIALS_FILE is unset", () => {
    // No env override exercises the homedir() default path. A profile that
    // cannot exist there resolves to null whether or not a real file is present.
    withEnv({ AWS_SHARED_CREDENTIALS_FILE: undefined }, () => {
      expect(readAwsProfileCredentials("gini-no-such-profile-z28f1a")).toBeNull();
    });
  });
});
