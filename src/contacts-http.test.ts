// Integration coverage for the /api/contacts routes: auth, route-regex
// ordering (specific paths vs the :id catch-all), agent scoping, and the
// query/import/upsert/relate/mutual contract. Business logic is covered in
// src/state/contacts-db.test.ts and src/contacts/import.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "./http";
import { closeAllMemoryDbs } from "./state/memory-db";
import type { RuntimeConfig } from "./types";

const ROOT = mkdtempSync(join(tmpdir(), "gini-contacts-http-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
});
afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

function testConfig(instance: string): RuntimeConfig {
  const workspaceRoot = join(ROOT, instance, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    instance,
    port: 0,
    token: "test-token",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function call(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const response = await handler(
    new Request(`http://127.0.0.1/${path.replace(/^\//, "")}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) }
    })
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const CSV = `Notes:
"preamble"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Aisha,Khan,https://linkedin.com/in/aisha,,Google,Staff Engineer,05 Jun 2024
Liam,Park,https://linkedin.com/in/liam,,Google,Product Manager,01 Jan 2023
Sofia,Rossi,https://linkedin.com/in/sofia,,Stripe,Account Executive,02 Feb 2022
`;

describe("/api/contacts", () => {
  test("requires auth", async () => {
    const config = testConfig("http-auth");
    const handler = createHandler(config);
    const res = await handler(new Request("http://127.0.0.1/api/contacts"));
    expect(res.status).toBe(401);
  });

  test("import → query → count → get → relate → relations → mutual → delete", async () => {
    const config = testConfig("http-full");
    writeFileSync(join(config.workspaceRoot, "Connections.csv"), CSV);
    const handler = createHandler(config);

    const imp = await call(handler, config, "/api/contacts/import", {
      method: "POST",
      body: JSON.stringify({ path: "Connections.csv" })
    });
    expect(imp.status).toBe(201);
    expect(imp.body.created).toBe(3);

    // Exhaustive query — specific filter returns all and only matches.
    const q = await call(handler, config, "/api/contacts?company=Google");
    expect(q.status).toBe(200);
    expect(q.body.total).toBe(2);
    expect(q.body.contacts.length).toBe(2);

    const count = await call(handler, config, "/api/contacts/count?breakdown=company");
    expect(count.body.count).toBe(3);
    expect(count.body.companies.find((c: any) => c.company === "Google").count).toBe(2);

    // Create via POST, then GET /:id (catch-all must not shadow /count above).
    const created = await call(handler, config, "/api/contacts", {
      method: "POST",
      body: JSON.stringify({ fullName: "Tom Greco", company: "Acme", title: "Founder" })
    });
    expect(created.status).toBe(201);
    const tomId = created.body.contact.id;
    const got = await call(handler, config, `/api/contacts/${tomId}`);
    expect(got.body.company).toBe("Acme");

    // Relate Aisha ↔ Tom, then read relations + a mutual query.
    const aisha = (await call(handler, config, "/api/contacts?company=Google")).body.contacts.find(
      (c: any) => c.fullName === "Aisha Khan"
    );
    const rel = await call(handler, config, "/api/contacts/relations", {
      method: "POST",
      body: JSON.stringify({ from: aisha.id, to: tomId, relationType: "colleague" })
    });
    expect(rel.status).toBe(201);
    expect(rel.body.ok).toBe(true);

    const relations = await call(handler, config, `/api/contacts/${tomId}/relations`);
    expect(relations.body.relations.length).toBe(1);

    const mutual = await call(handler, config, `/api/contacts/mutual?a=${aisha.id}&b=${tomId}`);
    expect(mutual.status).toBe(200);
    expect(Array.isArray(mutual.body.mutualConnections)).toBe(true);

    const del = await call(handler, config, `/api/contacts/${tomId}`, { method: "DELETE" });
    expect(del.body.ok).toBe(true);
    const gone = await call(handler, config, `/api/contacts/${tomId}`);
    expect(gone.status).toBe(404);
  });

  test("upsert with id of a missing contact 404s; ambiguous name 409s", async () => {
    const config = testConfig("http-upsert-edge");
    const handler = createHandler(config);
    // Updating a non-existent id is a clean 404, not a 500.
    const missing = await call(handler, config, "/api/contacts", {
      method: "POST",
      body: JSON.stringify({ id: "contact_doesnotexist", company: "X" })
    });
    expect(missing.status).toBe(404);
    // Two same-name people via distinct URLs.
    await call(handler, config, "/api/contacts", { method: "POST", body: JSON.stringify({ fullName: "Sam Twin", linkedinUrl: "https://linkedin.com/in/sam1" }) });
    await call(handler, config, "/api/contacts", { method: "POST", body: JSON.stringify({ fullName: "Sam Twin", linkedinUrl: "https://linkedin.com/in/sam2" }) });
    const ambiguous = await call(handler, config, "/api/contacts", { method: "POST", body: JSON.stringify({ fullName: "Sam Twin", company: "X" }) });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.candidates.length).toBe(2);
  });

  test("import with no recognizable header returns 400, not 500", async () => {
    const config = testConfig("http-import-bad");
    writeFileSync(join(config.workspaceRoot, "junk.csv"), "alpha,beta\n1,2\n");
    const handler = createHandler(config);
    const res = await call(handler, config, "/api/contacts/import", { method: "POST", body: JSON.stringify({ path: "junk.csv" }) });
    expect(res.status).toBe(400);
  });
});
