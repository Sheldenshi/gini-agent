import { describe, expect, test } from "bun:test";
import { redactTunnelSnapshot } from "./route";

describe("BFF tunnel snapshot redaction", () => {
  test("nulls the secret and publicUrl fields before forwarding", () => {
    const snapshot = {
      publicUrl: "https://x.trycloudflare.com/secret-abc-123/",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "secret-abc-123",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01T00:00:00Z",
      appleNotes: { enabled: true, folder: "gini", noteName: "tunnel-url", available: true, lastSyncedAt: null, lastError: null },
      lastError: null
    };
    const out = redactTunnelSnapshot(snapshot) as Record<string, unknown>;
    expect(out.secret).toBeNull();
    expect(out.publicUrl).toBeNull();
    expect(out.cloudflareUrl).toBe("https://x.trycloudflare.com");
    expect((out.appleNotes as Record<string, unknown>).enabled).toBe(true);
  });

  test("returns non-object payloads unchanged", () => {
    expect(redactTunnelSnapshot(null)).toBeNull();
    expect(redactTunnelSnapshot("oops")).toBe("oops");
    expect(redactTunnelSnapshot([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("does not mutate the input", () => {
    const input = { secret: "abc", publicUrl: "https://x/abc/", cloudflareUrl: "https://x" };
    redactTunnelSnapshot(input);
    expect(input.secret).toBe("abc");
    expect(input.publicUrl).toBe("https://x/abc/");
  });
});
