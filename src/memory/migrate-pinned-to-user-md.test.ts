// Unit tests for the one-shot state.memories → USER.md migration.
// See ADR runtime-identity-files.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePinnedMemoriesToUserProfile } from "./migrate-pinned-to-user-md";
import { mutateState, readState } from "../state";
import { userProfilePath } from "../runtime/identity-files";
import { ensureDir } from "../paths";
import type { RuntimeConfig } from "../types";

let root: string;
let prevState: string | undefined;
let prevLog: string | undefined;

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: root,
    stateRoot: root,
    logRoot: `${root}-logs`
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-pinned-migrate-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-logs`, { recursive: true, force: true });
});

async function seedMemories(config: RuntimeConfig, items: Array<{ id: string; content: string; status?: "active" | "proposed" | "archived" }>): Promise<void> {
  await mutateState(config.instance, (state) => {
    const at = "2026-01-01T00:00:00.000Z";
    // `state.memories` was removed from the type alongside the
    // consolidation. The migration helper still reads through to the
    // legacy on-disk shape, so the test seeds the array via an `unknown`
    // cast to mimic an existing-instance state file. See ADR
    // runtime-identity-files.md.
    const stateDyn = state as unknown as { memories: Array<Record<string, unknown>> };
    stateDyn.memories = items.map((item) => ({
      id: item.id,
      instance: state.instance,
      agentId: "agent_default",
      content: item.content,
      confidence: 1,
      sensitivity: "normal" as const,
      provenance: "test",
      status: (item.status ?? "active"),
      createdAt: at,
      updatedAt: at
    }));
  });
}

describe("migratePinnedMemoriesToUserProfile", () => {
  test("empty state.memories runs the migration as a no-op and sets the marker", async () => {
    const config = makeConfig("empty-memories");
    // Force the state file to exist so readState doesn't seed.
    await mutateState(config.instance, () => {});

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.ran).toBe(true);
    expect(report.migrated).toBe(0);
    expect(report.marker).toBeDefined();

    const state = readState(config.instance);
    const stateDyn = state as unknown as { memories?: unknown[]; migrations?: { statePinnedToUserMd?: string } };
    // After dropDeadMemoriesField runs (post-migration), the field is
    // stripped from the in-memory shape. Either an undefined or an
    // empty array is acceptable as the post-migration shape.
    expect(stateDyn.memories === undefined || (Array.isArray(stateDyn.memories) && stateDyn.memories.length === 0)).toBe(true);
    expect(stateDyn.migrations?.statePinnedToUserMd).toBe(report.marker);

    // No USER.md created on disk when there is nothing to write.
    expect(existsSync(userProfilePath(config.instance))).toBe(false);
  });

  test("populated state.memories writes a USER.md section and clears the array", async () => {
    const config = makeConfig("populated-memories");
    await seedMemories(config, [
      { id: "mem_a", content: "Name is Shelden." },
      { id: "mem_b", content: "Prefers concise replies." }
    ]);

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.ran).toBe(true);
    expect(report.migrated).toBe(2);
    expect(report.marker).toBeDefined();

    const body = readFileSync(userProfilePath(config.instance), "utf8");
    expect(body).toContain("<!-- migrated from pinned memories on ");
    expect(body).toContain("- Name is Shelden.");
    expect(body).toContain("- Prefers concise replies.");

    const state = readState(config.instance);
    const stateDyn = state as unknown as { memories?: unknown[] };
    expect(stateDyn.memories === undefined || (Array.isArray(stateDyn.memories) && stateDyn.memories.length === 0)).toBe(true);

    const audit = state.audit.find((event) => event.action === "memory.pinned.migrated");
    expect(audit).toBeDefined();
    expect(audit?.evidence?.migrated).toBe(2);
  });

  test("appends below existing USER.md body, separated by a blank line", async () => {
    const config = makeConfig("existing-user-md");
    const path = userProfilePath(config.instance);
    ensureDir(join(root, "instances", config.instance));
    writeFileSync(path, "User name: Shelden.\n");
    await seedMemories(config, [{ id: "mem_a", content: "Likes TypeScript." }]);

    await migratePinnedMemoriesToUserProfile(config);

    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/User name: Shelden\.\n\n<!-- migrated from pinned memories on /);
    expect(body).toContain("- Likes TypeScript.");
  });

  test("skips proposed and archived rows", async () => {
    const config = makeConfig("proposed-skipped");
    await seedMemories(config, [
      { id: "mem_a", content: "Active fact", status: "active" },
      { id: "mem_b", content: "Proposed fact", status: "proposed" },
      { id: "mem_c", content: "Archived fact", status: "archived" }
    ]);

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.migrated).toBe(1);

    const body = readFileSync(userProfilePath(config.instance), "utf8");
    expect(body).toContain("- Active fact");
    expect(body).not.toContain("Proposed fact");
    expect(body).not.toContain("Archived fact");
  });

  test("deduplicates rows with identical content before writing", async () => {
    const config = makeConfig("dedupe");
    await seedMemories(config, [
      { id: "mem_a", content: "Same fact." },
      { id: "mem_b", content: "Same fact." },
      { id: "mem_c", content: "Other fact." }
    ]);

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.migrated).toBe(2);

    const body = readFileSync(userProfilePath(config.instance), "utf8");
    const occurrences = (body.match(/Same fact\./g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("does not double-append when USER.md already carries the migration header (crash recovery)", async () => {
    const config = makeConfig("crash-recovery");
    // Seed state.memories AND a USER.md that already carries the migration
    // header. Simulates a crash between the file write and the marker
    // stamp on a previous startup. The header check must skip the second
    // append while still clearing the array and stamping the marker.
    await seedMemories(config, [{ id: "mem_a", content: "First fact." }]);
    const path = userProfilePath(config.instance);
    ensureDir(join(root, "instances", config.instance));
    writeFileSync(path, "<!-- migrated from pinned memories on 2026-05-21T00:00:00.000Z -->\n- First fact.\n");
    const beforeBytes = readFileSync(path, "utf8");

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.ran).toBe(true);
    // The file is left alone — the on-disk header signals the prior pass
    // wrote it. The marker still lands so the array is drained.
    const afterBytes = readFileSync(path, "utf8");
    expect(afterBytes).toBe(beforeBytes);

    const state = readState(config.instance);
    const stateDyn = state as unknown as { migrations?: { statePinnedToUserMd?: string }; memories?: unknown[] };
    expect(stateDyn.migrations?.statePinnedToUserMd).toBeDefined();
    expect(stateDyn.memories === undefined || (Array.isArray(stateDyn.memories) && stateDyn.memories.length === 0)).toBe(true);
  });

  test("emits per-row migrated audit events alongside the summary", async () => {
    const config = makeConfig("per-row-audit");
    await seedMemories(config, [
      { id: "mem_a", content: "Alpha fact." },
      { id: "mem_b", content: "Bravo fact." }
    ]);

    await migratePinnedMemoriesToUserProfile(config);
    const state = readState(config.instance);
    const rowAudits = state.audit.filter((event) => event.action === "memory.pinned.migrated.row");
    expect(rowAudits).toHaveLength(2);
    const ids = rowAudits.map((event) => event.evidence?.memoryId);
    expect(ids).toContain("mem_a");
    expect(ids).toContain("mem_b");
    const contents = rowAudits.map((event) => event.evidence?.content);
    expect(contents).toContain("Alpha fact.");
    expect(contents).toContain("Bravo fact.");
  });

  test("tolerates malformed state.memories rows without throwing", async () => {
    const config = makeConfig("malformed-rows");
    await mutateState(config.instance, (state) => {
      const stateDyn = state as unknown as { memories: unknown };
      // Hand-edited / corrupted state: missing fields, wrong types,
      // non-objects, nullish entries. The migration must skip these.
      stateDyn.memories = [
        null,
        "not an object",
        { id: "mem_a", status: "active" }, // missing content
        { id: "mem_b", status: "active", content: 42 }, // non-string content
        { id: "mem_c", status: "active", content: "Valid fact." }
      ];
    });

    const report = await migratePinnedMemoriesToUserProfile(config);
    expect(report.ran).toBe(true);
    expect(report.migrated).toBe(1);

    const body = readFileSync(userProfilePath(config.instance), "utf8");
    expect(body).toContain("- Valid fact.");
  });

  test("is idempotent — second call returns ran: false with no new write", async () => {
    const config = makeConfig("idempotent");
    await seedMemories(config, [{ id: "mem_a", content: "First fact." }]);

    const first = await migratePinnedMemoriesToUserProfile(config);
    expect(first.ran).toBe(true);
    expect(first.migrated).toBe(1);

    const bodyAfterFirst = readFileSync(userProfilePath(config.instance), "utf8");

    const second = await migratePinnedMemoriesToUserProfile(config);
    expect(second.ran).toBe(false);
    expect(second.migrated).toBe(0);

    // USER.md body unchanged on the second pass.
    const bodyAfterSecond = readFileSync(userProfilePath(config.instance), "utf8");
    expect(bodyAfterSecond).toBe(bodyAfterFirst);

    // Marker still present and unchanged.
    const state = readState(config.instance);
    const stateDyn = state as unknown as { migrations?: { statePinnedToUserMd?: string } };
    expect(stateDyn.migrations?.statePinnedToUserMd).toBe(first.marker);
  });
});
