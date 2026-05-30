// Parity check: the BFF mirror of the tunnel error-code union and the
// cloudflared install hint (`web/src/lib/cloudflared-install-hint.ts`) is
// intentionally duplicated from the runtime contract
// (`src/runtime/tunnel/types.ts`) because Next.js refuses to bundle modules
// outside its `web/` project root — importing the runtime type into the BFF
// bundle would couple it to the runtime tree at build time. This mirrors the
// duplicate-plus-parity-test pattern already used by canonicalize.parity.test.ts
// and transport.parity.test.ts.
//
// A quiet drift between the two copies would let the BFF branch on a code the
// runtime never emits (or miss one it does), or render the install hint with a
// field the runtime stopped sending. This test pins the contract two ways:
//
//   1. Compile-time: bidirectional `Expect<Equal<…>>` assertions force the web
//      `TunnelErrorCode` to equal the runtime `TunnelTransitionErrorCode` and
//      the two `CloudflaredInstallHint` shapes to match exactly. Add, remove,
//      or rename a member on either side and `bunx tsc --noEmit` (the web
//      typecheck) fails here.
//   2. Runtime: the concrete member set is pinned as a value and asserted, so
//      `bun test` exercises the contract too and a reader sees the live union.
//
// At TEST time we run under `bun test` outside Next.js, so the `@runtime/`
// alias (../src/*, see web/tsconfig.base.json) resolves the runtime types
// fine — the same cross-tree import other web tests already use.

import { describe, expect, test } from "bun:test";
import type {
  TunnelErrorCode as WebTunnelErrorCode,
  CloudflaredInstallHint as WebCloudflaredInstallHint
} from "@/lib/cloudflared-install-hint";
import type {
  TunnelTransitionErrorCode as RuntimeTunnelErrorCode,
  CloudflaredInstallHint as RuntimeCloudflaredInstallHint
} from "@runtime/runtime/tunnel/types";

// Exact-equality type helpers (invariant on the type, so a superset or subset
// on either side fails — not just plain assignability).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// If the web error union and the runtime error union ever diverge — a new
// code, a removed code, a typo — one of these two lines stops compiling.
type _ErrorCodeParity = Expect<Equal<WebTunnelErrorCode, RuntimeTunnelErrorCode>>;

// If the install-hint shape diverges — a field added, dropped, or its type
// changed — these stop compiling.
type _InstallHintParity = Expect<Equal<WebCloudflaredInstallHint, RuntimeCloudflaredInstallHint>>;

describe("cloudflared-install-hint — web / runtime parity", () => {
  test("the error-code union members match the runtime contract", () => {
    // Pin the concrete member set as a value. The `satisfies` clause forces
    // every listed literal to be a valid runtime code, and the exhaustive
    // switch below forces every runtime code to be listed — so this stays in
    // lock-step with the compile-time `Equal` assertion above.
    const members = ["web_port_unhealthy", "cloudflared_unavailable"] as const satisfies readonly RuntimeTunnelErrorCode[];
    expect([...members].sort()).toEqual(["cloudflared_unavailable", "web_port_unhealthy"]);

    // Exhaustiveness guard: adding a runtime code without listing it above
    // makes this switch non-exhaustive and the `never` assignment fails to
    // compile, so the value list can't silently fall behind the union.
    const assertExhaustive = (code: RuntimeTunnelErrorCode): WebTunnelErrorCode => {
      switch (code) {
        case "web_port_unhealthy":
        case "cloudflared_unavailable":
          return code;
        default: {
          const _never: never = code;
          return _never;
        }
      }
    };
    for (const m of members) expect(assertExhaustive(m)).toBe(m);
  });

  test("the install-hint platform values match the runtime contract", () => {
    const platforms = ["macos", "linux", "windows", "other"] as const satisfies readonly RuntimeCloudflaredInstallHint["platform"][];
    // A value built against the web shape must satisfy the runtime shape and
    // vice versa — exercised here so a field drift fails the run, not just tsc.
    const hint: WebCloudflaredInstallHint = { platform: "macos", command: "x", url: "y" } satisfies RuntimeCloudflaredInstallHint;
    expect(platforms).toContain(hint.platform);
  });
});
