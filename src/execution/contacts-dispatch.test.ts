// End-to-end coverage for the contacts_* branches of dispatchToolCall: the
// tool args → handler → JSON-result contract, agent resolution, and the
// workspace-backed import path. Storage/parsing internals are covered in
// src/state/contacts-db.test.ts and src/contacts/import.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, mutateState, upsertTask } from "../state";
import { closeAllMemoryDbs } from "../state/memory-db";
import type { RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";

const ROOT = mkdtempSync(join(tmpdir(), "gini-contacts-dispatch-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
});
afterAll(() => {
  closeAllMemoryDbs();
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
  const task = createTask(config.instance, "contacts dispatch test");
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "contacts dispatch session");
    task.chatSessionId = session.id;
    upsertTask(state, task);
  });
  return task.id;
}

async function call(config: RuntimeConfig, taskId: string, tool: string, args: unknown): Promise<any> {
  const res = await dispatchToolCall(config, taskId, tool, `tc_${tool}`, JSON.stringify(args));
  if (res.kind !== "sync") throw new Error(`expected sync result for ${tool}, got ${res.kind}`);
  return JSON.parse(res.result);
}

const CSV = `Notes:
"preamble line"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Aisha,Khan,https://linkedin.com/in/aisha,,Google,Staff Engineer,05 Jun 2024
Liam,Park,https://linkedin.com/in/liam,,Google,Product Manager,01 Jan 2023
Sofia,Rossi,https://linkedin.com/in/sofia,,Stripe,Account Executive,02 Feb 2022
`;

describe("contacts dispatch", () => {
  test("import → count → exhaustive query", async () => {
    const config = buildConfig("cd-import");
    mkdirSync(config.workspaceRoot, { recursive: true });
    writeFileSync(join(config.workspaceRoot, "Connections.csv"), CSV);
    const taskId = await newTask(config);

    const imp = await call(config, taskId, "contacts_import", { path: "Connections.csv" });
    expect(imp.created).toBe(3);
    expect(imp.contactsTotal).toBe(3);

    const count = await call(config, taskId, "contacts_count", { company: "Google" });
    expect(count.count).toBe(2);

    const countBreakdown = await call(config, taskId, "contacts_count", { breakdown: "company" });
    expect(countBreakdown.count).toBe(3);
    expect(countBreakdown.companies.find((c: any) => c.company === "Google").count).toBe(2);

    const q = await call(config, taskId, "contacts_query", { company: "Google" });
    expect(q.total).toBe(2);
    expect(q.returned).toBe(2);
    expect(q.hasMore).toBe(false);
    expect(q.contacts.map((c: any) => c.name).sort()).toEqual(["Aisha Khan", "Liam Park"]);
  });

  test("upsert creates then updates by name; ambiguity is surfaced", async () => {
    const config = buildConfig("cd-upsert");
    mkdirSync(config.workspaceRoot, { recursive: true });
    const taskId = await newTask(config);

    const created = await call(config, taskId, "contacts_upsert", { fullName: "Nina Volkova", company: "OpenAI" });
    expect(created.action).toBe("created");
    expect(created.contact.company).toBe("OpenAI");

    const updated = await call(config, taskId, "contacts_upsert", { fullName: "Nina Volkova", title: "Research Lead" });
    expect(updated.action).toBe("updated");
    expect(updated.contact.title).toBe("Research Lead");
    expect(updated.contact.company).toBe("OpenAI"); // preserved

    // Two distinct people, same name → ambiguous on the next name-only upsert.
    await call(config, taskId, "contacts_upsert", { fullName: "Nina Volkova", linkedinUrl: "https://linkedin.com/in/nina2" });
    const ambiguous = await call(config, taskId, "contacts_upsert", { fullName: "Nina Volkova", location: "Berlin" });
    expect(ambiguous.action).toBe("ambiguous");
    expect(ambiguous.candidates.length).toBe(2);
  });

  test("relate + relations + mutual connections", async () => {
    const config = buildConfig("cd-relate");
    mkdirSync(config.workspaceRoot, { recursive: true });
    const taskId = await newTask(config);

    await call(config, taskId, "contacts_upsert", { fullName: "Alice A" });
    await call(config, taskId, "contacts_upsert", { fullName: "Bob B" });
    await call(config, taskId, "contacts_upsert", { fullName: "Carol C" });

    const rel = await call(config, taskId, "contacts_relate", { from: "Alice A", to: "Carol C", relationType: "colleague" });
    expect(rel.action).toBe("related");
    await call(config, taskId, "contacts_relate", { from: "Bob B", to: "Carol C", relationType: "colleague" });

    const relations = await call(config, taskId, "contacts_relations", { name: "Carol C" });
    expect(relations.relations.length).toBe(2);

    const mutual = await call(config, taskId, "contacts_relations", { name: "Alice A", mutualWith: "Bob B" });
    expect(mutual.mutualConnections.map((c: any) => c.name)).toEqual(["Carol C"]);
  });

  test("relate an unknown person returns a clear unresolved message (no throw)", async () => {
    const config = buildConfig("cd-unresolved");
    mkdirSync(config.workspaceRoot, { recursive: true });
    const taskId = await newTask(config);
    await call(config, taskId, "contacts_upsert", { fullName: "Solo Person" });
    const res = await call(config, taskId, "contacts_relate", { from: "Solo Person", to: "Ghost Person" });
    expect(res.action).toBe("unresolved");
    expect(res.message).toContain("Ghost Person");
  });
});
