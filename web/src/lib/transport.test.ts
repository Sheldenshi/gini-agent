import { describe, test, expect } from "bun:test";
import { inferTunnelTransport } from "./transport";

// Input table — every case we care about. Mirrors the runtime copy at
// src/runtime/tunnel/transport.test.ts so the two implementations stay
// in sync.
const cases: Array<{ name: string; input: string | null; expected: "sse" | "poll" }> = [
  { name: "null publicUrl → sse", input: null, expected: "sse" },
  { name: "empty string → sse", input: "", expected: "sse" },
  { name: "quick-tunnel hostname (lowercase) → poll", input: "https://abc.trycloudflare.com", expected: "poll" },
  { name: "quick-tunnel hostname (uppercase) → poll", input: "https://ABC.TRYCLOUDFLARE.COM", expected: "poll" },
  { name: "non-trycloudflare hostname → sse", input: "https://foo.example.com", expected: "sse" },
  { name: "named tunnel on apex domain → sse", input: "https://gini.lilaclabs.ai", expected: "sse" },
  { name: "unparseable URL → sse (fail-safe)", input: "not a url", expected: "sse" }
];

describe("inferTunnelTransport (web)", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(inferTunnelTransport(c.input)).toBe(c.expected);
    });
  }
});
