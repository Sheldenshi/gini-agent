// Codex connector probe honesty (issue #233): the probe resolves credentials
// through the provider's own reader (CODEX_AUTH_JSON honored as a filesystem
// path) and decodes the OAuth access token's JWT `exp` locally — an expired
// token reports unhealthy with the expiry time, with NO network calls.
// Crafted fake JWTs in unique temp dirs throughout; the real ~/.codex/auth.json
// is never read because CODEX_AUTH_JSON is pinned per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCodexCredentials } from "../../provider";
import {
  __setCodexRetryDelayForTests,
  __setCodexWhichForTests,
  codexProvider,
  evaluateCodexAuth,
  whichBinary
} from "./codex";
import type { ProbeContext } from "./types";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Minimal three-segment JWT whose payload is caller-controlled. The signature
// is junk — the decoder only reads the payload segment.
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.fake-signature`;
}

// probe() reads only ctx.config.provider (to honor a codex apiKeyEnv custom
// auth path); a hollow object degrades to the default CODEX_AUTH_JSON /
// ~/.codex/auth.json resolution, which is what these tests pin.
const PROBE_CTX = {} as ProbeContext;

describe("codex credential probe", () => {
  let root: string;
  let prevAuthJson: string | undefined;
  let prevOpenAiKey: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-codex-probe-"));
    prevAuthJson = process.env.CODEX_AUTH_JSON;
    prevOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevAuthJson === undefined) delete process.env.CODEX_AUTH_JSON;
    else process.env.CODEX_AUTH_JSON = prevAuthJson;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    __setCodexWhichForTests(null);
    __setCodexRetryDelayForTests(null);
    rmSync(root, { recursive: true, force: true });
  });

  function writeAuth(contents: unknown): string {
    const authPath = join(root, "auth.json");
    writeFileSync(authPath, typeof contents === "string" ? contents : JSON.stringify(contents));
    process.env.CODEX_AUTH_JSON = authPath;
    return authPath;
  }

  test("probeCodexCredentials surfaces the JWT exp claim without exposing the bearer", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    writeAuth({ tokens: { access_token: makeJwt({ exp }), refresh_token: "r" } });
    const creds = probeCodexCredentials();
    expect(creds.ok).toBe(true);
    expect(creds.credentialType).toBe("access_token");
    expect(creds.accessTokenExp).toBe(exp);
    // The bearer must never ride along on the probe payload.
    expect(JSON.stringify(creds)).not.toContain("fake-signature");
  });

  test("probeCodexCredentials: api-key shape has no exp; non-JWT and junk-payload tokens read as unknown", () => {
    writeAuth({ OPENAI_API_KEY: "sk-test-key-1234567890" });
    let creds = probeCodexCredentials();
    expect(creds.ok).toBe(true);
    expect(creds.credentialType).toBe("api_key");
    expect(creds.accessTokenExp).toBeUndefined();

    // Opaque (non-JWT) access token: usable, expiry unknown.
    writeAuth({ tokens: { access_token: "opaque-token-no-dots" } });
    creds = probeCodexCredentials();
    expect(creds.ok).toBe(true);
    expect(creds.credentialType).toBe("access_token");
    expect(creds.accessTokenExp).toBeUndefined();

    // Three segments but the payload isn't JSON → unknown, not unhealthy.
    writeAuth({ tokens: { access_token: "aGVhZGVy.bm90LWpzb24.sig" } });
    expect(probeCodexCredentials().accessTokenExp).toBeUndefined();

    // Parseable payload that isn't an object (JSON scalar) → unknown.
    writeAuth({ tokens: { access_token: `x.${Buffer.from("123").toString("base64url")}.y` } });
    expect(probeCodexCredentials().accessTokenExp).toBeUndefined();

    // Parseable payload without a numeric exp → unknown.
    writeAuth({ tokens: { access_token: makeJwt({ exp: "soon" }) } });
    expect(probeCodexCredentials().accessTokenExp).toBeUndefined();
  });

  test("probeCodexCredentials flags an unparseable auth file as transient (mid-rewrite read)", () => {
    // The codex CLI saves auth.json via truncate+write; a reader landing
    // between the two sees a partial document. That must surface as a
    // retryable transient failure, not steady-state "no credentials".
    writeAuth('{"tokens":{');
    const creds = probeCodexCredentials();
    expect(creds.ok).toBe(false);
    expect(creds.transient).toBe(true);
    expect(creds.message).toContain("Could not read Codex credentials");
  });

  test("probe retries a transient torn read once and succeeds when the rewrite lands", async () => {
    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    __setCodexRetryDelayForTests(0);
    const authPath = writeAuth('{"tokens":{');
    // The first read happens on the microtask queue (behind the cached
    // dynamic import), so a macrotask-scheduled repair lands strictly
    // between the first read and the retry's own setTimeout.
    setTimeout(() => writeAuth({ tokens: { access_token: "opaque-token" } }), 0);
    const result = await codexProvider.probe!(PROBE_CTX);
    expect(result).toEqual({ ok: true, message: `codex available; auth via ${authPath}` });
  });

  test("probe and detect report a persistently torn auth file as unhealthy after the retry", async () => {
    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    __setCodexRetryDelayForTests(0);
    writeAuth('{"tokens":{');
    const result = await codexProvider.probe!(PROBE_CTX);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Could not read Codex credentials");

    const detected = await codexProvider.detect!();
    expect(detected.detected).toBe(false);
    expect(detected.message).toContain("no auth source");
  });

  test("probeCodexCredentials reports a missing auth file as not ok with the resolved path", () => {
    process.env.CODEX_AUTH_JSON = join(root, "does-not-exist.json");
    const creds = probeCodexCredentials();
    expect(creds.ok).toBe(false);
    expect(creds.message).toContain(join(root, "does-not-exist.json"));
    expect(creds.accessTokenExp).toBeUndefined();
  });

  test("evaluateCodexAuth: expired exp → not ok, naming the expiry time and `codex login`", () => {
    const exp = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
    const result = evaluateCodexAuth(
      { ok: true, authPath: "/x/auth.json", credentialType: "access_token", message: "ok", accessTokenExp: exp },
      {},
      Date.parse("2026-06-10T00:00:00.000Z")
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("2026-01-01T00:00:00.000Z");
    expect(result.message).toContain("codex login");
  });

  test("evaluateCodexAuth: future exp, unknown exp, and api-key shapes are ok; env key is the fallback", () => {
    const nowMs = Date.now();
    const future = Math.floor(nowMs / 1000) + 600;
    expect(
      evaluateCodexAuth(
        { ok: true, authPath: "/x/auth.json", credentialType: "access_token", message: "ok", accessTokenExp: future },
        {},
        nowMs
      )
    ).toEqual({ ok: true, message: "codex available; auth via /x/auth.json" });
    expect(
      evaluateCodexAuth(
        { ok: true, authPath: "/x/auth.json", credentialType: "access_token", message: "ok" },
        {},
        nowMs
      ).ok
    ).toBe(true);
    expect(
      evaluateCodexAuth(
        { ok: true, authPath: "/x/auth.json", credentialType: "api_key", message: "ok" },
        {},
        nowMs
      ).ok
    ).toBe(true);
    // No usable file credentials, but the env var fallback is present.
    expect(
      evaluateCodexAuth({ ok: false, authPath: "/x/auth.json", message: "missing" }, { OPENAI_API_KEY: "sk-env" }, nowMs)
    ).toEqual({ ok: true, message: "codex available; auth via OPENAI_API_KEY" });
    // Nothing anywhere — the resolver's own message passes through.
    expect(
      evaluateCodexAuth({ ok: false, authPath: "/x/auth.json", message: "No Codex credentials found" }, {}, nowMs)
    ).toEqual({ ok: false, message: "No Codex credentials found" });
  });

  test("probe: expired token in the auth file → unhealthy with the expiry message; future token → healthy", async () => {
    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    const past = Math.floor(Date.now() / 1000) - 60;
    writeAuth({ tokens: { access_token: makeJwt({ exp: past }) } });
    const expired = await codexProvider.probe!(PROBE_CTX);
    expect(expired.ok).toBe(false);
    expect(expired.message).toContain("Codex access token expired at");
    expect(expired.message).toContain("codex login");

    const authPath = writeAuth({ tokens: { access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) } });
    const healthy = await codexProvider.probe!(PROBE_CTX);
    expect(healthy).toEqual({ ok: true, message: `codex available; auth via ${authPath}` });
  });

  test("probe: codex missing from PATH short-circuits; missing auth falls back to OPENAI_API_KEY presence", async () => {
    __setCodexWhichForTests(() => null);
    expect(await codexProvider.probe!(PROBE_CTX)).toEqual({ ok: false, message: "codex not found on PATH." });

    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    process.env.CODEX_AUTH_JSON = join(root, "missing.json");
    const noAuth = await codexProvider.probe!(PROBE_CTX);
    expect(noAuth.ok).toBe(false);
    expect(noAuth.message).toContain("No Codex credentials found");

    process.env.OPENAI_API_KEY = "sk-env-fallback";
    expect(await codexProvider.probe!(PROBE_CTX)).toEqual({
      ok: true,
      message: "codex available; auth via OPENAI_API_KEY"
    });
  });

  test("detect honors the same credential resolution: file → detected, env → detected, neither → not detected", async () => {
    __setCodexWhichForTests(() => null);
    expect(await codexProvider.detect!()).toEqual({ detected: false });

    __setCodexWhichForTests(() => "/opt/codex/bin/codex");
    process.env.CODEX_AUTH_JSON = join(root, "missing.json");
    const none = await codexProvider.detect!();
    expect(none.detected).toBe(false);
    expect(none.message).toContain("/opt/codex/bin/codex");

    const authPath = writeAuth({ tokens: { access_token: "anything" } });
    const viaFile = await codexProvider.detect!();
    expect(viaFile.detected).toBe(true);
    expect(viaFile.suggestedName).toBe("Codex");
    expect(viaFile.message).toContain(authPath);

    process.env.CODEX_AUTH_JSON = join(root, "missing.json");
    process.env.OPENAI_API_KEY = "sk-env-fallback";
    const viaEnv = await codexProvider.detect!();
    expect(viaEnv.detected).toBe(true);
    expect(viaEnv.message).toContain("OPENAI_API_KEY");
  });

  test("probe honors the configured codex provider's apiKeyEnv auth path", async () => {
    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    // Default resolution (CODEX_AUTH_JSON) points at a HEALTHY file...
    writeAuth({ tokens: { access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "r" } });
    // ...but the instance's codex provider names a custom path env whose file
    // holds an EXPIRED token — the file a chat turn would actually read. The
    // probe must consult that one, or connector health and chat resolution
    // disagree about the same install.
    const customPath = join(root, "custom-auth.json");
    writeFileSync(
      customPath,
      JSON.stringify({ tokens: { access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }), refresh_token: "r" } })
    );
    const prev = process.env.MY_CODEX_AUTH;
    process.env.MY_CODEX_AUTH = customPath;
    try {
      const ctx = {
        config: { provider: { name: "codex", model: "gpt-5.5", apiKeyEnv: "MY_CODEX_AUTH" } }
      } as ProbeContext;
      const probe = await codexProvider.probe!(ctx);
      expect(probe.ok).toBe(false);
      expect(probe.message).toContain("Codex access token expired at");
    } finally {
      if (prev === undefined) delete process.env.MY_CODEX_AUTH;
      else process.env.MY_CODEX_AUTH = prev;
    }
  });

  test("detect ignores token expiry: an expired JWT still materializes the connector while probe reports it unhealthy", async () => {
    __setCodexWhichForTests(() => "/usr/local/bin/codex");
    const past = Math.floor(Date.now() / 1000) - 60;
    const authPath = writeAuth({ tokens: { access_token: makeJwt({ exp: past }) } });
    const detected = await codexProvider.detect!();
    expect(detected.detected).toBe(true);
    expect(detected.suggestedName).toBe("Codex");
    expect(detected.message).toContain(authPath);
    // Same credentials, same instant: probe() consults exp and reports
    // unhealthy. detect() must NOT — the expired install has to materialize
    // so this probe state is visible (issue #233).
    const probe = await codexProvider.probe!(PROBE_CTX);
    expect(probe.ok).toBe(false);
    expect(probe.message).toContain("Codex access token expired at");
  });

  test("whichBinary resolves an existing binary to a path and a missing one to null", () => {
    // `sh` is guaranteed on every POSIX host this suite runs on.
    expect(whichBinary("sh")).toContain("/sh");
    expect(whichBinary("gini-definitely-not-a-binary-233")).toBeNull();
  });
});
