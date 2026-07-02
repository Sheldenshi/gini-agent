// Pins the "best-effort, but observable" contract on the
// checkConnector → syncProviderMcpServers integration: when the MCP
// auto-register call throws (a malformed provider descriptor, a state
// corruption, etc.) the connector's health write must still land AND a
// `mcp.auto_register_failed` audit row must be emitted so the failure
// is diagnosable without re-running the probe.
//
// Lives in its own file because it relies on `mock.module` to force a
// throw out of `../mcp-sync`, and that mock would leak into the broader
// mcp-sync.test.ts suite.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "gini-cc-mcp-fail-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  // Mock BEFORE importing checkConnector so the module under test picks
  // up the failing implementation.
  mock.module("../mcp-sync", () => ({
    syncProviderMcpServers: async () => {
      throw new Error("simulated sync explosion Authorization: Bearer SECRET");
    }
  }));
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

describe("checkConnector observability when MCP sync fails", () => {
  test("emits mcp.auto_register_failed with redacted error and leaves connector healthy", async () => {
    // Late import after the mock is installed.
    const { checkConnector } = await import("./index");
    const { mutateState, readState } = await import("../../state");

    const instance = "cc-mcp-fail";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`
    };
    await mutateState(instance, (state) => {
      state.connectors.push({
        id: "id_demo",
        instance,
        name: "Demo",
        provider: "demo",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "unknown",
        source: "user"
      });
    });
    const updated = await checkConnector(config, "id_demo");
    // Health write must not be unwound by the sync failure.
    expect(updated.health).toBe("healthy");

    const state = readState(instance);
    const failure = state.audit.find((a) => a.action === "mcp.auto_register_failed");
    expect(failure).toBeDefined();
    expect(failure?.actor).toBe("runtime");
    expect(failure?.target).toBe("id_demo");
    const evidence = failure?.evidence as { provider?: string; error?: string } | undefined;
    expect(evidence?.provider).toBe("demo");
    // Error message must be sanitized — no `Bearer <token>` leaked into
    // the audit row.
    expect(evidence?.error).toBeTruthy();
    expect(evidence?.error).not.toContain("Bearer SECRET");
    expect(evidence?.error).toContain("[REDACTED]");
  });
});
