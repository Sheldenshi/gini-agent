import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  AgentDataError,
  MAX_RESULT_ROWS,
  agentDataDbPath,
  closeAllAgentDataDbs,
  dbExecute,
  dbListTables,
  dbQuery
} from "./agent-data-db";

const ROOT = "/tmp/gini-agent-data-db-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});
afterAll(() => {
  closeAllAgentDataDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

const A = "agent_a";

describe("agent-data-db", () => {
  test("execute DDL/DML, query returns all rows, schema introspection", () => {
    const inst = "add-basic";
    dbExecute(inst, A, "CREATE TABLE people (name TEXT, company TEXT)");
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Ada", "Google"]);
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Ben", "Google"]);
    dbExecute(inst, A, "INSERT INTO people (name, company) VALUES (?, ?)", ["Cleo", "Stripe"]);

    const all = dbQuery(inst, A, "SELECT name FROM people WHERE company = ? ORDER BY name", ["Google"]);
    expect(all.rowCount).toBe(2);
    expect(all.columns).toEqual(["name"]);
    expect(all.rows.map((r) => r.name)).toEqual(["Ada", "Ben"]);
    expect(all.truncated).toBe(false);

    const count = dbQuery(inst, A, "SELECT COUNT(*) AS n FROM people");
    expect(count.rows[0]!.n).toBe(3);

    const schema = dbListTables(inst, A);
    expect(schema.length).toBe(1);
    expect(schema[0]!.name).toBe("people");
    expect(schema[0]!.rowCount).toBe(3);
    expect(schema[0]!.columns.map((c) => c.name).sort()).toEqual(["company", "name"]);
  });

  test("each agent has an isolated database file", () => {
    const inst = "add-iso";
    expect(agentDataDbPath(inst, "agent_x")).not.toBe(agentDataDbPath(inst, "agent_y"));
    dbExecute(inst, "agent_x", "CREATE TABLE secrets (v TEXT)");
    dbExecute(inst, "agent_x", "INSERT INTO secrets VALUES ('x-only')");
    // agent_y's DB doesn't see agent_x's table at all.
    expect(dbListTables(inst, "agent_y").length).toBe(0);
    expect(() => dbQuery(inst, "agent_y", "SELECT * FROM secrets")).toThrow();
  });

  test("db_query is read-only — writes are rejected", () => {
    const inst = "add-readonly";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    expect(() => dbQuery(inst, A, "INSERT INTO t VALUES (1)")).toThrow(AgentDataError);
    expect(() => dbQuery(inst, A, "DROP TABLE t")).toThrow(AgentDataError);
    expect(() => dbQuery(inst, A, "UPDATE t SET n = 2")).toThrow(AgentDataError);
  });

  test("rejects multi-statement smuggling and sandbox-escape statements", () => {
    const inst = "add-guard";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    expect(() => dbQuery(inst, A, "SELECT 1; DROP TABLE t")).toThrow(/one SQL statement/i);
    expect(() => dbExecute(inst, A, "ATTACH DATABASE 'x.db' AS x")).toThrow(/not allowed/i);
    expect(() => dbExecute(inst, A, "DETACH DATABASE x")).toThrow(/not allowed/i);
    expect(() => dbQuery(inst, A, "SELECT load_extension('evil')")).toThrow(/not allowed/i);
    // A trailing semicolon on a single statement is fine.
    expect(dbQuery(inst, A, "SELECT 1 AS one;").rows[0]!.one).toBe(1);
  });

  test("a write smuggled behind a CTE (WITH … INSERT) is rejected by the read-only connection", () => {
    const inst = "add-cte-write";
    dbExecute(inst, A, "CREATE TABLE t (n INTEGER)");
    dbExecute(inst, A, "INSERT INTO t VALUES (1)");
    // Begins with WITH (passes the prefix regex) but mutates — must still fail.
    expect(() => dbQuery(inst, A, "WITH c(x) AS (SELECT 2) INSERT INTO t(n) SELECT x FROM c")).toThrow(AgentDataError);
    expect(dbQuery(inst, A, "SELECT COUNT(*) AS n FROM t").rows[0]!.n).toBe(1); // unchanged
  });

  test("caps result rows and flags truncation", () => {
    const inst = "add-cap";
    dbExecute(inst, A, "CREATE TABLE big (n INTEGER)");
    dbExecute(
      inst,
      A,
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${MAX_RESULT_ROWS + 50}) INSERT INTO big(n) SELECT x FROM c`
    );
    const res = dbQuery(inst, A, "SELECT n FROM big");
    expect(res.truncated).toBe(true);
    expect(res.rowCount).toBe(MAX_RESULT_ROWS);
    // The agent can still get the true total via COUNT.
    expect(dbQuery(inst, A, "SELECT COUNT(*) AS n FROM big").rows[0]!.n).toBe(MAX_RESULT_ROWS + 50);
  });

  test("relationship JOIN works (mutual-connections shape)", () => {
    const inst = "add-join";
    dbExecute(inst, A, "CREATE TABLE rel (a TEXT, b TEXT)");
    // Alice-Carol, Bob-Carol  → Carol is mutual to Alice & Bob.
    dbExecute(inst, A, "INSERT INTO rel VALUES ('Alice','Carol'),('Bob','Carol'),('Alice','Dave')");
    const mutual = dbQuery(
      inst,
      A,
      "SELECT r1.b AS who FROM rel r1 JOIN rel r2 ON r1.b = r2.b WHERE r1.a = ? AND r2.a = ?",
      ["Alice", "Bob"]
    );
    expect(mutual.rows.map((r) => r.who)).toEqual(["Carol"]);
  });
});
