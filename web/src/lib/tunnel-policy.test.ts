import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTunnelCookie,
  isQuickTunnelOrigin,
  isTunnelDenied,
  looksLikeSecretSegment,
  matchSecretPrefix,
  readLiveTunnelHost,
  readTunnelConfigFromDisk,
  readTunnelCookie,
  tunnelSecretEquals,
  withoutTrailingSlash
} from "./tunnel-policy";

describe("isTunnelDenied", () => {
  test("denies entire /api/runtime/pairing subtree on every method", () => {
    expect(isTunnelDenied("/api/runtime/pairing", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/claim", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/pairing/anything", "GET")).toBe(true);
  });

  test("allows bare /api/runtime/tunnel on GET (snapshot) and PATCH (mutate) only", () => {
    expect(isTunnelDenied("/api/runtime/tunnel", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel", "PATCH")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/", "PATCH")).toBe(false);
  });

  test("denies bare /api/runtime/tunnel on methods the live API doesn't support", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel", "DELETE")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel", "PUT")).toBe(true);
  });

  test("allows QR endpoints on GET only — operator gates them via click-to-reveal", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/qr.svg", "GET")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/qr.txt", "GET")).toBe(false);
  });

  test("denies QR endpoints on methods other than GET", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/qr.svg", "POST")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/qr.txt", "DELETE")).toBe(true);
  });

  test("allows /refresh-notes on POST only — GET shouldn't mutate iCloud", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "GET")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/refresh-notes", "PUT")).toBe(true);
  });

  test("denies unknown /api/runtime/tunnel/<sub> by default", () => {
    expect(isTunnelDenied("/api/runtime/tunnel/anything-new", "PATCH")).toBe(true);
    expect(isTunnelDenied("/api/runtime/tunnel/diagnostics", "GET")).toBe(true);
  });

  test("allows unrelated paths", () => {
    expect(isTunnelDenied("/api/runtime/chat", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/state", "GET")).toBe(false);
  });

  test("allows POST /api/runtime/push/devices — tunneled registrations are tagged + purged on rotate", () => {
    expect(isTunnelDenied("/api/runtime/push/devices", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/push/devices/", "POST")).toBe(false);
    expect(isTunnelDenied("/api/runtime/push/devices/tok_phone", "DELETE")).toBe(false);
    expect(isTunnelDenied("/api/runtime/push/devices", "GET")).toBe(false);
  });
});

describe("matchSecretPrefix", () => {
  test("matches /<secret>", () => {
    expect(matchSecretPrefix("/abc", "abc")).toEqual({ match: true, suffix: "/" });
  });

  test("matches /<secret>/", () => {
    expect(matchSecretPrefix("/abc/", "abc")).toEqual({ match: true, suffix: "/" });
  });

  test("matches /<secret>/<rest>", () => {
    expect(matchSecretPrefix("/abc/foo/bar", "abc")).toEqual({ match: true, suffix: "/foo/bar" });
  });

  test("does not match an unrelated path", () => {
    expect(matchSecretPrefix("/abc-other", "abc")).toBeNull();
  });

  test("does not match an empty secret", () => {
    expect(matchSecretPrefix("/abc", "")).toBeNull();
  });
});

describe("tunnelSecretEquals", () => {
  test("equal secrets compare equal", () => {
    expect(tunnelSecretEquals("X".repeat(32), "X".repeat(32))).toBe(true);
  });

  test("different secrets compare unequal", () => {
    expect(tunnelSecretEquals("X".repeat(32), "Y".repeat(32))).toBe(false);
  });

  test("length mismatch is unequal", () => {
    expect(tunnelSecretEquals("abc", "abcd")).toBe(false);
  });
});

describe("cookie helpers", () => {
  test("buildTunnelCookie sets HttpOnly + Secure + SameSite=Lax + no Domain", () => {
    const c = buildTunnelCookie("X".repeat(32));
    expect(c).toContain("gini_tunnel_session=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    expect(c).toContain("Path=/");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=86400");
    expect(c).not.toContain("Domain=");
  });

  test("readTunnelCookie extracts the named cookie from a multi-cookie header", () => {
    const headers = new Headers({ cookie: "foo=bar; gini_tunnel_session=ABCDEF; baz=qux" });
    expect(readTunnelCookie(headers)).toBe("ABCDEF");
  });

  test("readTunnelCookie returns null when missing", () => {
    expect(readTunnelCookie(new Headers())).toBeNull();
    expect(readTunnelCookie(new Headers({ cookie: "foo=bar" }))).toBeNull();
  });
});

describe("looksLikeSecretSegment", () => {
  test("accepts a 32-char base64url string", () => {
    expect(looksLikeSecretSegment("A".repeat(32))).toBe(true);
  });

  test("rejects too short", () => {
    expect(looksLikeSecretSegment("abc")).toBe(false);
  });

  test("rejects non base64url characters", () => {
    expect(looksLikeSecretSegment("AAAA====")).toBe(false);
  });
});

describe("withoutTrailingSlash", () => {
  test("strips trailing slash", () => {
    expect(withoutTrailingSlash("/api/runtime/tunnel/")).toBe("/api/runtime/tunnel");
  });

  test("leaves bare slash alone", () => {
    expect(withoutTrailingSlash("/")).toBe("/");
  });
});

describe("isQuickTunnelOrigin", () => {
  test("accepts a real quick-tunnel origin", () => {
    expect(isQuickTunnelOrigin("https://abc.trycloudflare.com")).toBe(true);
  });

  test("rejects a suffix-confusion attempt — must end with the literal suffix", () => {
    expect(isQuickTunnelOrigin("https://example.trycloudflare.com.evil.com")).toBe(false);
  });

  test("rejects a loopback origin", () => {
    expect(isQuickTunnelOrigin("https://127.0.0.1:7777")).toBe(false);
    expect(isQuickTunnelOrigin("http://localhost:7777")).toBe(false);
  });

  test("returns false on URL parse failure", () => {
    expect(isQuickTunnelOrigin("not-a-url")).toBe(false);
    expect(isQuickTunnelOrigin("")).toBe(false);
  });

  test("is case-insensitive on the host suffix", () => {
    expect(isQuickTunnelOrigin("https://ABC.TRYCLOUDFLARE.COM")).toBe(true);
    expect(isQuickTunnelOrigin("https://Mixed.TryCloudflare.com")).toBe(true);
  });
});

describe("readTunnelConfigFromDisk", () => {
  let tmpRoot: string;
  let savedStateRoot: string | undefined;
  let savedInstance: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gini-tunnel-policy-"));
    savedStateRoot = process.env.GINI_STATE_ROOT;
    savedInstance = process.env.GINI_INSTANCE;
    process.env.GINI_STATE_ROOT = tmpRoot;
    process.env.GINI_INSTANCE = "test-instance";
    mkdirSync(join(tmpRoot, "instances", "test-instance"), { recursive: true });
  });

  afterEach(() => {
    if (savedStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = savedStateRoot;
    if (savedInstance === undefined) delete process.env.GINI_INSTANCE;
    else process.env.GINI_INSTANCE = savedInstance;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("returns enabled/secret when the config file is present", () => {
    const configFile = join(tmpRoot, "instances", "test-instance", "config.json");
    writeFileSync(configFile, JSON.stringify({ tunnel: { enabled: true, secret: "ABC" } }), "utf8");
    expect(readTunnelConfigFromDisk()).toEqual({ enabled: true, secret: "ABC" });
  });

  test("returns disabled/empty when the config file is missing", () => {
    expect(readTunnelConfigFromDisk()).toEqual({ enabled: false, secret: "" });
  });

  test("returns disabled/empty when the config file is malformed", () => {
    const configFile = join(tmpRoot, "instances", "test-instance", "config.json");
    writeFileSync(configFile, "not-json", "utf8");
    expect(readTunnelConfigFromDisk()).toEqual({ enabled: false, secret: "" });
  });

  test("coerces non-string secret to empty and non-true enabled to false", () => {
    const configFile = join(tmpRoot, "instances", "test-instance", "config.json");
    writeFileSync(configFile, JSON.stringify({ tunnel: { enabled: "yes", secret: 42 } }), "utf8");
    expect(readTunnelConfigFromDisk()).toEqual({ enabled: false, secret: "" });
  });

  test("falls back to default instance when GINI_INSTANCE is unset", () => {
    delete process.env.GINI_INSTANCE;
    mkdirSync(join(tmpRoot, "instances", "default"), { recursive: true });
    const configFile = join(tmpRoot, "instances", "default", "config.json");
    writeFileSync(configFile, JSON.stringify({ tunnel: { enabled: true, secret: "D" } }), "utf8");
    expect(readTunnelConfigFromDisk()).toEqual({ enabled: true, secret: "D" });
  });

  test("falls back to HOME-based state dir when GINI_STATE_ROOT is unset", () => {
    delete process.env.GINI_STATE_ROOT;
    const savedHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    try {
      mkdirSync(join(tmpRoot, ".gini", "instances", "test-instance"), { recursive: true });
      const configFile = join(tmpRoot, ".gini", "instances", "test-instance", "config.json");
      writeFileSync(configFile, JSON.stringify({ tunnel: { enabled: true, secret: "H" } }), "utf8");
      expect(readTunnelConfigFromDisk()).toEqual({ enabled: true, secret: "H" });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

describe("readLiveTunnelHost", () => {
  let tmpRoot: string;
  let savedStateRoot: string | undefined;
  let savedInstance: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gini-tunnel-policy-host-"));
    savedStateRoot = process.env.GINI_STATE_ROOT;
    savedInstance = process.env.GINI_INSTANCE;
    process.env.GINI_STATE_ROOT = tmpRoot;
    process.env.GINI_INSTANCE = "test-instance";
    mkdirSync(join(tmpRoot, "instances", "test-instance"), { recursive: true });
  });

  afterEach(() => {
    if (savedStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = savedStateRoot;
    if (savedInstance === undefined) delete process.env.GINI_INSTANCE;
    else process.env.GINI_INSTANCE = savedInstance;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("returns lowercased host when the publicUrl file is present", () => {
    const f = join(tmpRoot, "instances", "test-instance", "tunnel.publicUrl");
    writeFileSync(f, "https://ABC.trycloudflare.com\n", "utf8");
    expect(readLiveTunnelHost()).toBe("abc.trycloudflare.com");
  });

  test("returns empty string when the publicUrl file is missing", () => {
    expect(readLiveTunnelHost()).toBe("");
  });

  test("returns empty string when the file is blank", () => {
    const f = join(tmpRoot, "instances", "test-instance", "tunnel.publicUrl");
    writeFileSync(f, "  \n", "utf8");
    expect(readLiveTunnelHost()).toBe("");
  });

  test("returns empty string when the file contents are not a valid URL", () => {
    const f = join(tmpRoot, "instances", "test-instance", "tunnel.publicUrl");
    writeFileSync(f, "not a url", "utf8");
    expect(readLiveTunnelHost()).toBe("");
  });
});
