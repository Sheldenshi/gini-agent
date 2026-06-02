// Parity check: the runtime canonicalizer (`src/runtime/tunnel/canonicalize.ts`)
// and the BFF canonicalizer (`web/src/lib/canonicalize.ts`) are intentionally
// duplicated because Next.js refuses to bundle modules outside its `web/`
// project root. The two trust layers (proxy, BFF) re-canonicalize before
// their deny checks — a quiet drift between the two would let a request
// pass the proxy's check on one form and the BFF's check on a different
// form, bypassing the deny list.
//
// This test pins the byte-equal-output contract: for every input below,
// both implementations must return the same `{ ok, path | reason }`
// shape. Add new inputs here whenever a canonicalize edge case is
// patched in either file so the two never diverge silently.
//
// The web bundle prohibits the runtime side from importing the web
// helper at runtime, but at TEST time we run under `bun test` outside
// Next.js, so relative imports across the tree work fine. Tests live
// on the runtime side because that's where `bun test` is invoked from
// by the root `bun test` script.

import { describe, expect, test } from "bun:test";
import { canonicalizePath as runtimeCanonicalize, noTrailingSlash as runtimeNoTrailing } from "./canonicalize";
import { canonicalizePath as webCanonicalize, noTrailingSlash as webNoTrailing } from "../../../web/src/lib/canonicalize";

const CANONICAL_PATH_INPUTS: readonly string[] = [
  // Simple identity cases.
  "/api/runtime/tunnel",
  "/api/runtime/tunnel/",
  "/api/runtime/tunnel/qr.svg",
  "/api/runtime/pairing",
  "/api/runtime/pairing/claim",
  "/",
  "/foo",
  "/foo/bar/baz",
  // Percent-decode happy paths.
  "/api/runtime/%74unnel",
  "/api/runtime/tunnel/%71r.svg",
  // Doubly-encoded.
  "/api/runtime/%2570airing",
  "/api/runtime/%252Fpairing",
  // Traversal — both sides must reject identically.
  "/api/runtime/../tunnel",
  "/api/runtime/./tunnel",
  "/api/../etc/passwd",
  "/..",
  "/.",
  // Duplicate / mixed slashes.
  "/api//runtime/tunnel",
  "/api/runtime///tunnel",
  // Embedded delimiters that must reject.
  "/api/runtime/tunnel%00secret",
  "/api/runtime/tunnel%23frag",
  "/api/runtime/tunnel%3Fquery",
  // Edge: empty / pathological.
  "",
  "//",
  "///",
  // Encoded slash inside a segment.
  "/api%2Fruntime%2Ftunnel",
  // Long-tail percent forms.
  "/%41%50%49/runtime/tunnel",
  // Case variants.
  "/API/RUNTIME/TUNNEL",
  "/api/runtime/tunnel/QR.SVG"
];

describe("canonicalizePath — runtime / BFF parity", () => {
  for (const input of CANONICAL_PATH_INPUTS) {
    test(`agrees on input: ${JSON.stringify(input)}`, () => {
      const runtime = runtimeCanonicalize(input);
      const web = webCanonicalize(input);
      // Same ok/error decision.
      expect(web.ok).toBe(runtime.ok);
      // Same payload — `path` on ok, `reason` on error.
      if (runtime.ok && web.ok) {
        expect(web.path).toBe(runtime.path);
      } else if (!runtime.ok && !web.ok) {
        expect(web.reason).toBe(runtime.reason);
      }
    });
  }
});

const NO_TRAILING_INPUTS: readonly string[] = [
  "/api/runtime/tunnel",
  "/api/runtime/tunnel/",
  "/",
  "",
  "/a/b/c/",
  "/a/b/c",
  "//",
  "/a//"
];

describe("noTrailingSlash — runtime / BFF parity", () => {
  for (const input of NO_TRAILING_INPUTS) {
    test(`agrees on input: ${JSON.stringify(input)}`, () => {
      expect(webNoTrailing(input)).toBe(runtimeNoTrailing(input));
    });
  }
});
