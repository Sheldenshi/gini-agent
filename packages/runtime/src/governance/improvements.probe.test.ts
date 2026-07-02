// Adversarial probe of the improvement APPLY slice (src/governance/improvements.ts):
// proposeImprovement / reviewImprovement (edit-apply branch) / revertImprovement
// and the legacy create-skill / create-job branches. Tries to break atomicity,
// idempotency, version semantics, and the honesty guarantees (a no-op never
// masquerades as an applied edit; a bundled target is refused without leaving
// the proposal applied; a concurrent double-approve applies once).
//
// Hermetic: echo provider config via makeConfig, a UNIQUE GINI_STATE_ROOT keyed
// on this slice ("apply-probe") so parallel probers don't collide.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readState, mutateState } from "../state";
import { reloadSkills } from "../capabilities/skills";
import {
  proposeImprovement,
  reviewImprovement,
  revertImprovement
} from "./improvements";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-apply-probe-improvements-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// Drop a user skill on disk under the instance skills dir, mirroring the
// installSkillFromBody layout (flat, no category subdir).
function writeUserSkill(instance: string, name: string, body: string): string {
  const dir = join(ROOT, "instances", instance, "skills", name);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "SKILL.md");
  writeFileSync(manifestPath, body);
  return manifestPath;
}

const USER_SKILL_BODY = `---
name: payment-flow
description: Pay an invoice
---

# Payment flow

1. Open the invoice.
2. Click Pay.
`;

// Seed an instance with the payment-flow user skill on disk + reloaded.
async function seedUserSkill(instance: string) {
  const config = makeConfig(instance);
  readState(instance);
  writeUserSkill(instance, "payment-flow", USER_SKILL_BODY);
  await reloadSkills(config);
  const before = readState(instance).skills.find((s) => s.name === "payment-flow");
  if (!before) throw new Error("seed failed: skill not loaded");
  return { config, before };
}

describe("apply-probe: edit-apply on a user skill", () => {
  test("approve bumps the numeric version by exactly 1 and keeps the same skill id", async () => {
    const { config, before } = await seedUserSkill("apply-version");
    const startVersion = before.version;

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Confirm before paying",
      rationale: "Wrong invoice paid twice.",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }]
      }
    });

    const applied = await reviewImprovement(config, proposal.id, "approve");
    expect(applied.status).toBe("applied");
    // appliedTargetId is the SAME skill row (matched by name+source on reload),
    // not a brand-new skill id.
    expect(applied.appliedTargetId).toBe(before.id);

    const after = readState("apply-version").skills.find((s) => s.id === before.id)!;
    expect(after).toBeDefined();
    // A body-changing reload bumps the numeric version exactly once.
    expect(after.version).toBe(startVersion + 1);
    // The prior body was snapshotted into previousVersions on the bump.
    expect(after.previousVersions.length).toBeGreaterThanOrEqual(1);
  });

  test("the on-disk SKILL.md file (not just state) is rewritten with the edit", async () => {
    const { config, before } = await seedUserSkill("apply-disk");
    const manifestPath = readState("apply-disk").skills.find((s) => s.id === before.id)!.manifestPath!;
    expect(manifestPath).toBeTruthy();

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Add a guard step",
      rationale: "Defensive.",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Verify the amount." }]
      }
    });
    await reviewImprovement(config, proposal.id, "approve");

    // The durable file on disk carries the edit AND still has its frontmatter
    // header intact (the split/reassemble must not drop or duplicate `---`).
    const onDisk = readFileSync(manifestPath, "utf8");
    expect(onDisk).toContain("3. Verify the amount.");
    expect(onDisk).toContain("Open the invoice.");
    expect(onDisk.startsWith("---\n")).toBe(true);
    // Exactly one frontmatter block (two `---` delimiter lines), not duplicated.
    const delimiterLines = onDisk.split("\n").filter((l) => l.trim() === "---").length;
    expect(delimiterLines).toBe(2);
  });

  test("normalizeImprovementPayload preserves all edit fields untouched (no create-only defaults leak in)", async () => {
    const { config, before } = await seedUserSkill("apply-normalize");
    const edits = [{ op: "append" as const, content: "3. Extra." }];
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit preserving fields",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        candidateBody: "candidate body snapshot",
        edits
      }
    });
    const p = proposal.payload;
    expect(p.mode).toBe("edit");
    expect(p.targetSkillId).toBe(before.id);
    expect(p.baseVersion).toBe(before.version);
    expect(p.baseBody).toBe(before.body);
    expect(p.candidateBody).toBe("candidate body snapshot");
    expect(p.edits).toEqual(edits);
    // The create-only defaults (name/steps) must NOT be injected onto an edit
    // payload — that would corrupt the edit shape.
    expect("name" in p).toBe(false);
    expect("steps" in p).toBe(false);
  });

  test("a partially-stale edit (one op matches, one misses) APPLIES (applied>0), not refused", async () => {
    const { config, before } = await seedUserSkill("apply-partial");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Partially stale",
      rationale: "One anchor is gone, one still matches.",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [
          // misses (target absent) -> skipped
          { op: "replace", target: "NONEXISTENT ANCHOR", content: "x" },
          // matches -> applied
          { op: "append", content: "3. Double-check the payee." }
        ]
      }
    });
    const applied = await reviewImprovement(config, proposal.id, "approve");
    // applied>0 so the edit is NOT a no-op; it must finalize, not throw.
    expect(applied.status).toBe("applied");
    const after = readState("apply-partial").skills.find((s) => s.id === before.id)!;
    expect(after.body).toContain("Double-check the payee.");
  });
});

describe("apply-probe: refusals leave the proposal re-approvable, never applied", () => {
  test("a bundled target throws and leaves the proposal NOT applied (released to proposed)", async () => {
    const instance = "apply-bundled";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      state.skills.unshift({
        id: "skill_bundled",
        instance,
        name: "bundled-skill",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tests: [],
        successCount: 0,
        failureCount: 0,
        previousVersions: [],
        body: "# Bundled\n",
        source: "bundled"
      });
    });
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit bundled",
      rationale: "refuse",
      payload: {
        mode: "edit",
        targetSkillId: "skill_bundled",
        baseBody: "# Bundled\n",
        edits: [{ op: "append", content: "x" }]
      }
    });
    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow();
    const stored = readState(instance).improvements.find((p) => p.id === proposal.id)!;
    expect(stored.status).toBe("proposed");
    // No improvement.applied audit was written.
    const appliedAudits = readState(instance).audit.filter(
      (a) => a.action === "improvement.applied" && a.target === proposal.id
    );
    expect(appliedAudits).toHaveLength(0);
  });

  test("a deleted/missing target throws and releases the claim back to proposed", async () => {
    const { config } = await seedUserSkill("apply-missing");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit a ghost",
      rationale: "target was deleted",
      payload: {
        mode: "edit",
        targetSkillId: "skill_does_not_exist",
        baseBody: "whatever",
        edits: [{ op: "append", content: "x" }]
      }
    });
    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow(/not found/i);
    const stored = readState("apply-missing").improvements.find((p) => p.id === proposal.id)!;
    expect(stored.status).toBe("proposed");
  });

  test("a fully-stale edit (applied===0) throws and does NOT touch the on-disk body or version", async () => {
    const { config, before } = await seedUserSkill("apply-stale");
    const startVersion = before.version;
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "All anchors gone",
      rationale: "body changed under the proposal",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "replace", target: "Step that does not exist", content: "x" }]
      }
    });
    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow(
      /changed since this proposal/
    );
    const stored = readState("apply-stale").improvements.find((p) => p.id === proposal.id)!;
    expect(stored.status).toBe("proposed");
    const after = readState("apply-stale").skills.find((s) => s.id === before.id)!;
    expect(after.body).toBe(before.body);
    // No spurious version bump from a no-op write.
    expect(after.version).toBe(startVersion);
  });
});

describe("apply-probe: concurrency (single-flight claim)", () => {
  test("Promise.all of two approves applies once, audits once, no double-append", async () => {
    const { config, before } = await seedUserSkill("apply-race");
    const startVersion = before.version;
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Race",
      rationale: "two approvers",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }]
      }
    });

    const results = await Promise.allSettled([
      reviewImprovement(config, proposal.id, "approve"),
      reviewImprovement(config, proposal.id, "approve")
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const state = readState("apply-race");
    const stored = state.improvements.find((p) => p.id === proposal.id)!;
    expect(stored.status).toBe("applied");

    const after = state.skills.find((s) => s.id === before.id)!;
    const occurrences =
      after.body.split("3. Confirm the payee before clicking Pay.").length - 1;
    expect(occurrences).toBe(1);
    // Exactly one version bump despite two approvers.
    expect(after.version).toBe(startVersion + 1);

    const appliedAudits = state.audit.filter(
      (a) => a.action === "improvement.applied" && a.target === proposal.id
    );
    expect(appliedAudits).toHaveLength(1);
  });

  test("three concurrent approves still apply exactly once", async () => {
    const { config, before } = await seedUserSkill("apply-race3");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Triple race",
      rationale: "three approvers",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Sanity-check the total." }]
      }
    });
    const results = await Promise.allSettled([
      reviewImprovement(config, proposal.id, "approve"),
      reviewImprovement(config, proposal.id, "approve"),
      reviewImprovement(config, proposal.id, "approve")
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const state = readState("apply-race3");
    const after = state.skills.find((s) => s.id === before.id)!;
    expect(after.body.split("3. Sanity-check the total.").length - 1).toBe(1);
    expect(
      state.audit.filter((a) => a.action === "improvement.applied" && a.target === proposal.id)
    ).toHaveLength(1);
  });
});

describe("apply-probe: reject path for edit proposals", () => {
  test("reject of an edit proposal marks it rejected, writes no disk change, no applied audit", async () => {
    const { config, before } = await seedUserSkill("apply-reject");
    const startVersion = before.version;
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Reject me",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Should never land." }]
      }
    });
    const rejected = await reviewImprovement(config, proposal.id, "reject");
    expect(rejected.status).toBe("rejected");

    const state = readState("apply-reject");
    const after = state.skills.find((s) => s.id === before.id)!;
    expect(after.body).toBe(before.body);
    expect(after.version).toBe(startVersion);
    expect(
      state.audit.filter((a) => a.action === "improvement.applied" && a.target === proposal.id)
    ).toHaveLength(0);
    expect(
      state.audit.filter((a) => a.action === "improvement.rejected" && a.target === proposal.id)
    ).toHaveLength(1);
  });

  test("approving an already-rejected edit proposal throws (no re-apply)", async () => {
    const { config, before } = await seedUserSkill("apply-reject-then-approve");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Reject then approve",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Must not apply." }]
      }
    });
    await reviewImprovement(config, proposal.id, "reject");
    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow(/already/i);
    const after = readState("apply-reject-then-approve").skills.find((s) => s.id === before.id)!;
    expect(after.body).toBe(before.body);
  });
});

describe("apply-probe: revertImprovement", () => {
  test("revert re-installs the stored baseBody and audits improvement.reverted", async () => {
    const { config, before } = await seedUserSkill("apply-revert");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit then regret",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }]
      }
    });
    await reviewImprovement(config, proposal.id, "approve");

    const edited = readState("apply-revert").skills.find((s) => s.id === before.id)!;
    expect(edited.body).toContain("Confirm the payee before clicking Pay.");

    await revertImprovement(config, proposal.id);

    const reverted = readState("apply-revert").skills.find((s) => s.id === before.id)!;
    // Body is back to the original (the appended line is gone).
    expect(reverted.body).not.toContain("Confirm the payee before clicking Pay.");
    expect(reverted.body.trim()).toBe(before.body.trim());

    const audits = readState("apply-revert").audit.filter(
      (a) => a.action === "improvement.reverted" && a.target === proposal.id
    );
    expect(audits).toHaveLength(1);

    // The on-disk file is restored too, not just state.
    const onDisk = readFileSync(reverted.manifestPath!, "utf8");
    expect(onDisk).not.toContain("Confirm the payee before clicking Pay.");
    expect(onDisk).toContain("Open the invoice.");
  });

  test("revert of a non-applied (proposed) proposal throws", async () => {
    const { config, before } = await seedUserSkill("apply-revert-unapplied");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Never applied",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "x" }]
      }
    });
    await expect(revertImprovement(config, proposal.id)).rejects.toThrow(/not applied/i);
  });

  test("revert of a create-skill (non-edit) proposal throws", async () => {
    const config = makeConfig("apply-revert-create");
    readState("apply-revert-create");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Create skill",
      rationale: "r",
      payload: { name: "fresh-skill", steps: ["do a thing"] }
    });
    const applied = await reviewImprovement(config, proposal.id, "approve");
    expect(applied.status).toBe("applied");
    await expect(revertImprovement(config, proposal.id)).rejects.toThrow(/edit/i);
  });

  test("double revert: the second revert still succeeds and is idempotent in effect", async () => {
    const { config, before } = await seedUserSkill("apply-revert-double");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit then revert twice",
      rationale: "r",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Reverted twice." }]
      }
    });
    await reviewImprovement(config, proposal.id, "approve");
    await revertImprovement(config, proposal.id);
    // A second revert re-installs the same baseBody; since content is unchanged
    // the loader treats it as a noop reload but must not throw or corrupt.
    await revertImprovement(config, proposal.id);
    const reverted = readState("apply-revert-double").skills.find((s) => s.id === before.id)!;
    expect(reverted.body).not.toContain("Reverted twice.");
    expect(reverted.body.trim()).toBe(before.body.trim());
  });
});

describe("apply-probe: legacy create branches unchanged", () => {
  test("create-skill proposal creates a NEW skill and sets appliedTargetId to its id", async () => {
    const config = makeConfig("apply-create-skill");
    readState("apply-create-skill");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Brand new skill",
      rationale: "from evidence",
      payload: {
        name: "weekly-report",
        description: "Build the weekly report",
        trigger: "weekly report",
        steps: ["Gather metrics", "Render the doc"],
        requiredTools: ["db_query"]
      }
    });
    const applied = await reviewImprovement(config, proposal.id, "approve");
    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId).toBeTruthy();
    expect(applied.appliedTargetId!.startsWith("skill_")).toBe(true);

    const created = readState("apply-create-skill").skills.find(
      (s) => s.id === applied.appliedTargetId
    )!;
    expect(created).toBeDefined();
    expect(created.name).toBe("weekly-report");
    expect(created.steps).toEqual(["Gather metrics", "Render the doc"]);
    expect(created.requiredTools).toEqual(["db_query"]);

    const appliedAudits = readState("apply-create-skill").audit.filter(
      (a) => a.action === "improvement.applied" && a.target === proposal.id
    );
    expect(appliedAudits).toHaveLength(1);
  });

  test("create-job proposal creates a NEW job and sets appliedTargetId to its id", async () => {
    const config = makeConfig("apply-create-job");
    readState("apply-create-job");
    const proposal = await proposeImprovement(config, {
      kind: "job",
      title: "Nightly cleanup",
      rationale: "recurring chore",
      payload: {
        name: "nightly-cleanup",
        prompt: "Clean up stale temp files",
        intervalSeconds: 7200
      }
    });
    const applied = await reviewImprovement(config, proposal.id, "approve");
    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId!.startsWith("job_")).toBe(true);

    const job = readState("apply-create-job").jobs.find((j) => j.id === applied.appliedTargetId)!;
    expect(job).toBeDefined();
    expect(job.name).toBe("nightly-cleanup");
    expect(job.prompt).toBe("Clean up stale temp files");
    expect(job.intervalSeconds).toBe(7200);
  });

  test("create-job interval is floored at 1 second for a zero/negative interval", async () => {
    const config = makeConfig("apply-create-job-floor");
    readState("apply-create-job-floor");
    const proposal = await proposeImprovement(config, {
      kind: "job",
      title: "Bad interval",
      rationale: "r",
      payload: { name: "bad-interval", prompt: "x", intervalSeconds: -5 }
    });
    const applied = await reviewImprovement(config, proposal.id, "approve");
    const job = readState("apply-create-job-floor").jobs.find(
      (j) => j.id === applied.appliedTargetId
    )!;
    expect(job.intervalSeconds).toBeGreaterThanOrEqual(1);
  });

  test("double-approve of a legacy create-skill proposal does NOT create two skills", async () => {
    // The sync create path flips proposed->approved->applied inside ONE
    // mutateState. A concurrent second approve must see a non-proposed status
    // and refuse, so exactly one skill is created (not a duplicate).
    const config = makeConfig("apply-create-race");
    readState("apply-create-race");
    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Race a create",
      rationale: "r",
      payload: { name: "race-skill", steps: ["s"] }
    });
    const results = await Promise.allSettled([
      reviewImprovement(config, proposal.id, "approve"),
      reviewImprovement(config, proposal.id, "approve")
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const skills = readState("apply-create-race").skills.filter((s) => s.name === "race-skill");
    expect(skills).toHaveLength(1);
    const appliedAudits = readState("apply-create-race").audit.filter(
      (a) => a.action === "improvement.applied" && a.target === proposal.id
    );
    expect(appliedAudits).toHaveLength(1);
  });
});
