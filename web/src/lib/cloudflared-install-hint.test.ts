import { describe, expect, test } from "bun:test";
import { cloudflaredGuidance, type CloudflaredInstallHint } from "@/lib/cloudflared-install-hint";

// Coverage for the cloudflared install-guidance selector that both the
// TunnelCard and the floating TunnelQrLauncher use to decide whether to swap
// the raw "Last error" line for the actionable install block. The components
// depend on next/react-query/lucide modules that don't resolve in a plain
// bun:test runner, so pinning the pure selector pins the branch each UI takes.

const hint: CloudflaredInstallHint = {
  platform: "macos",
  command: "curl -L https://example/cloudflared-darwin-arm64.tgz | tar -xz && sudo mv cloudflared /usr/local/bin/",
  url: "https://github.com/cloudflare/cloudflared/releases"
};

describe("cloudflaredGuidance", () => {
  test("returns the lead-in message for the cloudflared_unavailable code", () => {
    // The selector returns only the message string; the actionable command +
    // releases link are rendered separately from the snapshot's
    // `cloudflaredInstall` hint, so they are intentionally not on the return.
    const g = cloudflaredGuidance("cloudflared_unavailable", hint);
    expect(typeof g).toBe("string");
    expect(g).toContain("cloudflared");
  });

  test("returns null for an unrelated error code", () => {
    expect(cloudflaredGuidance("web_port_unhealthy", hint)).toBeNull();
  });

  test("returns null when there is no error code", () => {
    expect(cloudflaredGuidance(null, hint)).toBeNull();
    expect(cloudflaredGuidance(undefined, hint)).toBeNull();
  });

  test("returns null when the hint is missing even if the code matches", () => {
    expect(cloudflaredGuidance("cloudflared_unavailable", null)).toBeNull();
    expect(cloudflaredGuidance("cloudflared_unavailable", undefined)).toBeNull();
  });
});
