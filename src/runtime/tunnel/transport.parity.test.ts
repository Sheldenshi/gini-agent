// Parity check: the runtime transport classifier
// (`src/runtime/tunnel/transport.ts`), the BFF transport classifier
// (`web/src/lib/transport.ts`), and the mobile transport classifier
// (`mobile/src/transport.ts`) are intentionally triplicated. Next.js
// refuses to bundle modules outside its `web/` project root, and
// React Native (Metro/Hermes) refuses to import modules outside the
// `mobile/` workspace — mirroring the canonicalize triplication
// already in this repo. All three copies decide whether the active
// `publicUrl` is a quick-tunnel hostname (`*.trycloudflare.com`,
// SSE-stripping) so server pickers, web renderers, and the mobile
// client downgrade to long-polling consistently. A quiet drift
// between any pair would let one side pick SSE and another pick
// polling for the same tunnel, breaking streams.
//
// This test pins the byte-equal-output contract: for every input
// below, all three implementations must return the same `"sse" |
// "poll"` value. Mirrors `canonicalize.parity.test.ts` — add new
// inputs here whenever a transport edge case is patched in any
// copy so the three never diverge silently.
//
// The web and mobile bundles prohibit the runtime side from
// importing their helpers at runtime, but at TEST time we run under
// `bun test` outside Next.js / Metro, so relative imports across
// the tree work fine.

import { describe, expect, test } from "bun:test";
import { inferTunnelTransport as runtimeInfer } from "./transport";
import { inferTunnelTransport as webInfer } from "../../../web/src/lib/transport";
import { inferTunnelTransport as mobileInfer } from "../../../mobile/src/transport";

const TRANSPORT_INPUTS: ReadonlyArray<string | null> = [
  // Null / empty — fail-safe to "sse" on all sides.
  null,
  "",
  // Quick-tunnel hostnames, lowercase and uppercase — must all be "poll".
  "https://abc.trycloudflare.com",
  "https://ABC.TRYCLOUDFLARE.COM",
  // Apex / regular hostnames — must all be "sse".
  "https://foo.example.com",
  "https://gini.lilaclabs.ai",
  // Unparseable URL — fail-safe to "sse" on all sides.
  "not a url",
  // Trailing-dot edge case — the hostname suffix check sees `.com.`, not
  // `.com`, so this must NOT be classified as a quick tunnel even though
  // it's textually adjacent. All three sides have to agree.
  "https://x.trycloudflare.com."
];

describe("inferTunnelTransport — runtime / BFF / mobile parity", () => {
  for (const input of TRANSPORT_INPUTS) {
    test(`agrees on input: ${JSON.stringify(input)}`, () => {
      const runtime = runtimeInfer(input);
      const web = webInfer(input);
      const mobile = mobileInfer(input);
      expect(web).toBe(runtime);
      expect(mobile).toBe(runtime);
    });
  }
});
