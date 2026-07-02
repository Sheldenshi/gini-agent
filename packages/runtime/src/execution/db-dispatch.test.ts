// Coverage for the db_* branches of dispatchToolCall: tool args → handler →
// JSON contract, agent resolution, and the workspace-backed import path.
// Storage internals are covered in src/state/agent-data-db.test.ts and
// src/data/import-table.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, mutateState, upsertTask } from "../state";
import { closeAllAgentDataDbs } from "../state/agent-data-db";
import type { RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";

const ROOT = mkdtempSync(join(tmpdir(), "gini-db-dispatch-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
});
afterAll(() => {
  closeAllAgentDataDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  const task = createTask(config.instance, "db dispatch test");
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "db dispatch session");
    task.chatSessionId = session.id;
    upsertTask(state, task);
  });
  return task.id;
}

async function call(config: RuntimeConfig, taskId: string, tool: string, args: unknown): Promise<any> {
  const res = await dispatchToolCall(config, taskId, tool, `tc_${tool}`, JSON.stringify(args));
  if (res.kind !== "sync") throw new Error(`expected sync result for ${tool}`);
  return JSON.parse(res.result);
}

const CSV = `Notes:
"preamble"

First Name,Last Name,Company,Position
Aisha,Khan,Google,Staff Engineer
Liam,Park,Google,Product Manager
Sofia,Rossi,Stripe,Account Executive
`;

describe("db dispatch", () => {
  test("import → schema → exhaustive query", async () => {
    const config = buildConfig("dbd-import");
    mkdirSync(config.workspaceRoot, { recursive: true });
    writeFileSync(join(config.workspaceRoot, "Connections.csv"), CSV);
    const taskId = await newTask(config);

    const imp = await call(config, taskId, "db_import", { path: "Connections.csv", table: "contacts" });
    expect(imp.rowsInserted).toBe(3);

    const schema = await call(config, taskId, "db_schema", {});
    expect(schema.tables[0].name).toBe("contacts");
    expect(schema.tables[0].rowCount).toBe(3);

    const q = await call(config, taskId, "db_query", {
      sql: "SELECT first_name FROM contacts WHERE company = ? ORDER BY first_name",
      params: ["Google"]
    });
    expect(q.rowCount).toBe(2);
    expect(q.rows.map((r: any) => r.first_name)).toEqual(["Aisha", "Liam"]);
  });

  test("execute creates + mutates; query reflects it", async () => {
    const config = buildConfig("dbd-execute");
    mkdirSync(config.workspaceRoot, { recursive: true });
    const taskId = await newTask(config);

    await call(config, taskId, "db_execute", { sql: "CREATE TABLE books (title TEXT, read INTEGER)" });
    const ins = await call(config, taskId, "db_execute", { sql: "INSERT INTO books VALUES (?, ?)", params: ["Dune", 1] });
    expect(ins.changes).toBe(1);
    const cnt = await call(config, taskId, "db_query", { sql: "SELECT COUNT(*) AS n FROM books WHERE read = 1" });
    expect(cnt.rows[0].n).toBe(1);
  });

  test("db_query rejects a write (read-only gate surfaces to the model)", async () => {
    const config = buildConfig("dbd-readonly");
    mkdirSync(config.workspaceRoot, { recursive: true });
    const taskId = await newTask(config);
    await call(config, taskId, "db_execute", { sql: "CREATE TABLE t (n INTEGER)" });
    await expect(call(config, taskId, "db_query", { sql: "INSERT INTO t VALUES (1)" })).rejects.toThrow();
  });
});
