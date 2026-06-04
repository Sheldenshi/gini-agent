import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { createPairingRequest, hashSecret, mutateState } from "../state";
import { publicState } from "./views";

function testConfig(instance: string): RuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), `gini-views-${instance}-`));
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

describe("publicState pairing-request exposure", () => {
  test("omits pairingRequests entirely (no raw rows, no bindHash leak via the spread)", async () => {
    const config = testConfig("views-pairing");
    await mutateState(config.instance, (state) =>
      createPairingRequest(state, {
        userAgent: "Mozilla/5.0 (iPhone) Safari",
        relayHost: "sub.gini-relay.lilaclabs.ai",
        bindSecret: "super-secret"
      })
    );
    const snapshot = publicState(config) as Record<string, unknown>;
    // The whole field is omitted (it has no client consumer; the operator panel
    // uses the loopback-only GET /api/pairing/requests).
    expect("pairingRequests" in snapshot).toBe(false);
    // And nothing in the payload carries the binding-secret hash.
    expect(JSON.stringify(snapshot)).not.toContain("bindHash");
    expect(JSON.stringify(snapshot)).not.toContain(hashSecret("super-secret"));
  });
});
