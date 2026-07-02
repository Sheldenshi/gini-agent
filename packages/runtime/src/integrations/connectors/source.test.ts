import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, readState } from "../../state";
import type { RuntimeConfig } from "../../types";
import { createConnector, deleteConnector } from "./index";

const ROOT = mkdtempSync(join(tmpdir(), "gini-source-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7340,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("connector source field", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("CRUD-created connector defaults to source=user", async () => {
    const config = buildConfig("source-user");
    const created = await createConnector(config, { name: "demo-1", provider: "demo" });
    expect(created.source).toBe("user");
  });

  test("normalizeState backfills source=user on legacy records", async () => {
    const config = buildConfig("source-backfill");
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      // Mimic a pre-source persisted record by stripping the field.
      const legacy = {
        id: "id_legacy",
        instance: state.instance,
        name: "legacy",
        provider: "demo",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "unknown"
      };
      state.connectors.push(legacy as never);
    });
    // Force a re-read so normalizeState backfills the field.
    const state = readState(config.instance);
    const legacy = state.connectors.find((c) => c.id === "id_legacy");
    expect(legacy?.source).toBe("user");
  });

  test("delete on user-source connector physically removes the record", async () => {
    const config = buildConfig("source-delete-user");
    const created = await createConnector(config, { name: "demo-rm", provider: "demo" });
    const result = await deleteConnector(config, created.id);
    expect(result.tombstoned).toBeUndefined();
    const state = readState(config.instance);
    expect(state.connectors.find((c) => c.id === created.id)).toBeUndefined();
  });

  test("delete on auto-source connector tombstones (status=disabled)", async () => {
    const config = buildConfig("source-delete-auto");
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.connectors.push({
        id: "id_auto",
        instance: state.instance,
        name: "auto-claude",
        provider: "claude-code",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "auto"
      });
    });
    const result = await deleteConnector(config, "id_auto");
    expect(result.tombstoned).toBe(true);
    const state = readState(config.instance);
    const record = state.connectors.find((c) => c.id === "id_auto");
    expect(record).toBeDefined();
    expect(record?.status).toBe("disabled");
    // Audit event should be `connector.disable`, not `connector.delete`.
    expect(state.audit.some((event) => event.action === "connector.disable" && event.target === "id_auto")).toBe(true);
    expect(state.audit.some((event) => event.action === "connector.delete" && event.target === "id_auto")).toBe(false);
  });
});
