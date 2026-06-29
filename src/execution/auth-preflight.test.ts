// Tests for the deterministic auth preflight block builder. The module shells
// out to the real `yc` and `gws` CLIs (this build targets a provisioned fleet
// where both are installed). To test the BUILDER's logic without those
// binaries, we hand buildAuthPreflightBlock an env whose PATH points at an
// empty dir, so both probes fail to find their CLI and the function takes its
// "NOT authenticated" branch deterministically — which is exactly the path
// whose wording (the action directives) we want to lock down.

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthPreflightBlock } from "./auth-preflight";

// An env with a PATH that contains no `yc`/`gws`/`bash`-resolvable tools of
// ours. We keep a real PATH entry so `bash` itself resolves (the module runs
// `bash -lc`), but the login-state probes still fail because yc/gws aren't on
// it. Use an empty temp dir prepended and a minimal system path.
let sanitizedEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  const emptyDir = mkdtempSync(join(tmpdir(), "auth-preflight-empty-"));
  sanitizedEnv = { ...process.env, PATH: `${emptyDir}:/usr/bin:/bin` };
});

describe("buildAuthPreflightBlock", () => {
  test("emits a directive block when tools are not authenticated", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv);
    // Something is not authed in this sanitized env, so the block is non-empty.
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("AUTH PREFLIGHT");
    expect(block).toContain("END AUTH PREFLIGHT");
  });

  test("the block informs+routes (does not prescribe the procedure)", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv);
    // The hook's contract: it tells the agent it MUST act, and routes it to its
    // own instructions/skills for HOW — it does not itself perform the login.
    expect(block).toContain("does not perform any login");
    expect(block).toContain("following your own instructions and skills");
    expect(block).toContain("this notice only tells you that you must act, not how");
  });

  test("the directive is unconditional — act even if the tool is irrelevant", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv);
    expect(block).toContain("even if");
    expect(block.toLowerCase()).toContain("do not weigh relevance");
  });

  test("each failing tool carries a REQUIRED ACTION line", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv);
    expect(block).toContain("REQUIRED ACTION:");
  });

  test("flags yc when it cannot authenticate", async () => {
    const block = await buildAuthPreflightBlock(sanitizedEnv);
    expect(block).toContain("yc");
  });

  test("returns a string (never throws) even on a hostile env", async () => {
    // A completely empty PATH can't even resolve bash; the module must degrade
    // gracefully (best-effort) rather than throw into the turn.
    const block = await buildAuthPreflightBlock({ ...process.env, PATH: "" });
    expect(typeof block).toBe("string");
  });
});
