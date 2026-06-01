import { describe, expect, test } from "bun:test";
import {
  DANGEROUS_SCHEME_PREFIXES,
  DEFAULT_FALLBACK_MS,
  DEFAULT_SCHEME,
  MOBILE_UA_PATTERN,
  clampMs,
  singleParam,
  userAgentLooksMobile,
  validateHttpUrl,
  validateSameOriginUrl,
  validateScheme,
  validateToken,
} from "./validators";

describe("validateScheme", () => {
  const fallback = DEFAULT_SCHEME;

  test("returns fallback when value is undefined or empty", () => {
    expect(validateScheme(undefined, fallback)).toBe(fallback);
    expect(validateScheme("", fallback)).toBe(fallback);
  });

  test("returns fallback when value exceeds 256 chars", () => {
    const longValue = "gini://" + "a".repeat(250);
    expect(longValue.length).toBe(257);
    expect(validateScheme(longValue, fallback)).toBe(fallback);
  });

  test("rejects every dangerous scheme prefix in mixed case", () => {
    const cases = [
      "JaVaScRiPt:alert(1)",
      "DATA:text/html,<script>",
      "VbScRiPt:msgbox()",
      "FILE:///etc/passwd",
      "Blob:https://example.com",
      "ABOUT:blank",
    ];
    expect(cases.length).toBe(DANGEROUS_SCHEME_PREFIXES.length);
    for (const c of cases) {
      expect(validateScheme(c, fallback)).toBe(fallback);
    }
  });

  test("rejects a scheme without ://", () => {
    expect(validateScheme("gini:connect", fallback)).toBe(fallback);
    expect(validateScheme("gini:/connect", fallback)).toBe(fallback);
  });

  test("accepts a valid gini://connect scheme", () => {
    expect(validateScheme("gini://connect", fallback)).toBe("gini://connect");
  });

  test("rejects body with % to block doubly-encoded payloads", () => {
    expect(validateScheme("gini://path%20with-percent", fallback)).toBe(fallback);
  });

  test("rejects a scheme that does not start with a lowercase letter", () => {
    expect(validateScheme("1bad://x", fallback)).toBe(fallback);
    expect(validateScheme("Bad://x", fallback)).toBe(fallback);
  });
});

describe("validateToken", () => {
  test("accepts the 32-character base64url shape minted by generateTunnelSecret", () => {
    // Example shape: the runtime mints 24 random bytes and base64url-
    // encodes them, yielding exactly 32 characters drawn from
    // `[A-Za-z0-9_-]`.
    const sample = "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGLO";
    expect(sample.length).toBe(32);
    expect(validateToken(sample)).toBe(sample);
  });

  test("accepts all characters in the base64url alphabet at 32 chars", () => {
    // Build a 32-char string containing every legal character at least
    // once so the regex's character class is exercised.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    expect(alphabet.length).toBe(32);
    expect(validateToken(alphabet)).toBe(alphabet);
    const digits = "0123456789ghijklmnopqrstuvwxyz_-";
    expect(digits.length).toBe(32);
    expect(validateToken(digits)).toBe(digits);
  });

  test("rejects the broader printable charset that the prior validator permitted", () => {
    // Each of `+`, `=`, `:`, `.`, `~`, `/` was previously legal under
    // the old `/^[A-Za-z0-9._~+/=:-]+$/` regex. The tightened validator
    // refuses all of them.
    const builders: Array<{ name: string; value: string }> = [
      { name: "plus", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL+" },
      { name: "equals", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL=" },
      { name: "colon", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL:" },
      { name: "dot", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL." },
      { name: "tilde", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL~" },
      { name: "slash", value: "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL/" }
    ];
    for (const c of builders) {
      expect(c.value.length).toBe(32);
      expect(validateToken(c.value)).toBeUndefined();
    }
  });

  test("rejects spaces, < > and & characters", () => {
    expect(validateToken("abc def0123456789012345678901234")).toBeUndefined();
    expect(validateToken("abc<def0123456789012345678901234")).toBeUndefined();
    expect(validateToken("abc>def0123456789012345678901234")).toBeUndefined();
    expect(validateToken("abc&def0123456789012345678901234")).toBeUndefined();
  });

  test("rejects empty and undefined input", () => {
    expect(validateToken(undefined)).toBeUndefined();
    expect(validateToken("")).toBeUndefined();
  });

  test("rejects a 31-char string (one under the runtime secret length)", () => {
    const short = "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGL";
    expect(short.length).toBe(31);
    expect(validateToken(short)).toBeUndefined();
  });

  test("rejects a 33-char string (one over the runtime secret length)", () => {
    const long = "ATFSaxaXkptHZj8C7BfeEKn8FPB6lGLOX";
    expect(long.length).toBe(33);
    expect(validateToken(long)).toBeUndefined();
  });

  test("rejects oversize input (513 chars)", () => {
    const oversize = "a".repeat(513);
    expect(oversize.length).toBe(513);
    expect(validateToken(oversize)).toBeUndefined();
  });
});

describe("clampMs", () => {
  test("returns fallback for undefined input", () => {
    expect(clampMs(undefined, DEFAULT_FALLBACK_MS)).toBe(DEFAULT_FALLBACK_MS);
    expect(clampMs("", DEFAULT_FALLBACK_MS)).toBe(DEFAULT_FALLBACK_MS);
  });

  test("rejects non-finite values and returns fallback", () => {
    expect(clampMs("not-a-number", 1500)).toBe(1500);
    expect(clampMs("Infinity", 1500)).toBe(1500);
    expect(clampMs("NaN", 1500)).toBe(1500);
  });

  test("floors at 250", () => {
    expect(clampMs("0", 1500)).toBe(250);
    expect(clampMs("100", 1500)).toBe(250);
    expect(clampMs("-50", 1500)).toBe(250);
  });

  test("ceils at 10_000", () => {
    expect(clampMs("999999", 1500)).toBe(10_000);
    expect(clampMs("10001", 1500)).toBe(10_000);
  });

  test("floors fractional values", () => {
    expect(clampMs("1499.9", 1500)).toBe(1499);
    expect(clampMs("500.7", 1500)).toBe(500);
  });

  test("accepts a value already in range", () => {
    expect(clampMs("3000", 1500)).toBe(3000);
  });
});

describe("validateHttpUrl", () => {
  test("accepts https URLs", () => {
    expect(validateHttpUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  test("accepts http URLs", () => {
    expect(validateHttpUrl("http://example.com/")).toBe("http://example.com/");
  });

  test("rejects gini: scheme", () => {
    expect(validateHttpUrl("gini://connect")).toBeUndefined();
  });

  test("rejects file: scheme", () => {
    expect(validateHttpUrl("file:///etc/passwd")).toBeUndefined();
  });

  test("rejects malformed URL", () => {
    expect(validateHttpUrl("not a url")).toBeUndefined();
    expect(validateHttpUrl("://broken")).toBeUndefined();
  });

  test("returns undefined for empty / undefined input", () => {
    expect(validateHttpUrl(undefined)).toBeUndefined();
    expect(validateHttpUrl("")).toBeUndefined();
  });
});

describe("validateSameOriginUrl", () => {
  test("accepts a same-origin URL", () => {
    expect(
      validateSameOriginUrl("https://gini.example/foo", "https://gini.example"),
    ).toBe("https://gini.example/foo");
  });

  test("rejects a cross-origin URL pointing at a different host", () => {
    expect(
      validateSameOriginUrl(
        "https://phishing.example/foo",
        "https://gini.example",
      ),
    ).toBeUndefined();
  });

  test("rejects a substring-confusion lookalike host", () => {
    // `gini.example.evil` shares the prefix but has a different origin,
    // so a substring-style match must NOT pass.
    expect(
      validateSameOriginUrl(
        "https://gini.example.evil/foo",
        "https://gini.example",
      ),
    ).toBeUndefined();
  });

  test("returns undefined for empty / undefined input", () => {
    expect(validateSameOriginUrl(undefined, "https://gini.example")).toBeUndefined();
  });

  test("returns undefined for a malformed URL", () => {
    expect(validateSameOriginUrl("not-a-url", "https://gini.example")).toBeUndefined();
  });
});

describe("userAgentLooksMobile", () => {
  test("matches iPhone, iPad, iPod, Android (case-insensitive)", () => {
    expect(userAgentLooksMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(userAgentLooksMobile("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)")).toBe(true);
    expect(userAgentLooksMobile("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0)")).toBe(true);
    expect(userAgentLooksMobile("Mozilla/5.0 (Linux; Android 14)")).toBe(true);
    expect(userAgentLooksMobile("mozilla/5.0 (iphone)")).toBe(true);
    expect(userAgentLooksMobile("MOZILLA/5.0 (ANDROID)")).toBe(true);
  });

  test("rejects bare Mac desktop UA (no Safari token)", () => {
    expect(
      userAgentLooksMobile(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      ),
    ).toBe(false);
  });

  test("accepts iPadOS / macOS Safari UA (Mac-shaped + Safari)", () => {
    // iPadOS Safari has sent a Mac-shaped UA since iPadOS 13 — same
    // wire-shape as macOS Safari, no `iPad` token. Treat it as mobile
    // so iPad users with the app get the scheme handoff.
    expect(
      userAgentLooksMobile(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      ),
    ).toBe(true);
  });

  test("rejects macOS Chrome (has Chrome token after Safari)", () => {
    expect(
      userAgentLooksMobile(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  test("rejects macOS Firefox (no Safari token at all)", () => {
    expect(
      userAgentLooksMobile(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
      ),
    ).toBe(false);
  });

  test("iPhone Safari still matched via the iPhone branch", () => {
    expect(
      userAgentLooksMobile(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
  });

  test("returns false on null, undefined, empty", () => {
    expect(userAgentLooksMobile(null)).toBe(false);
    expect(userAgentLooksMobile(undefined)).toBe(false);
    expect(userAgentLooksMobile("")).toBe(false);
  });

  test("exported MOBILE_UA_PATTERN matches expected shape", () => {
    expect(MOBILE_UA_PATTERN.test("iPhone")).toBe(true);
    expect(MOBILE_UA_PATTERN.test("Macintosh")).toBe(false);
  });
});

describe("singleParam", () => {
  test("returns undefined for arrays", () => {
    expect(singleParam(["a", "b"])).toBeUndefined();
    expect(singleParam([])).toBeUndefined();
  });

  test("returns the string verbatim", () => {
    expect(singleParam("hello")).toBe("hello");
    expect(singleParam("")).toBe("");
  });

  test("returns undefined for undefined input", () => {
    expect(singleParam(undefined)).toBeUndefined();
  });
});
