// Reflection / optimizer pass (ADR skill-learning-from-outcomes.md), echo
// provider. A skill with >= 2 failures produces a bounded edit proposal; a
// bundled skill produces a finding not a disk edit; environment/credential
// verdicts produce findings; the >= 2 floor and maxProposals clip hold; the
// prompt forbids instance-specific edits.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSkill, mutateState, readState } from "../state";
import { createSkillOutcome } from "../state/records";
import { clearEchoStructuredResponses, setEchoStructuredResponse } from "../provider";
import { reloadSkills } from "../capabilities/skills";
import { reflectOnSkillOutcomes, reflectionValidator, REFLECT_SYSTEM_FORBIDS_INSTANCE_EDITS } from "./reflect";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-reflect-skill-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  clearEchoStructuredResponses();
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

const USER_SKILL_BODY = `---
name: payer
description: Pay invoices
---

# Payer

1. Open the invoice.
2. Click Pay.
`;

function writeUserSkill(instance: string, name: string, body: string): void {
  const dir = join(ROOT, "instances", instance, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

async function seedFailures(instance: string, skillId: string, count: number): Promise<void> {
  await mutateState(instance, (state) => {
    for (let i = 0; i < count; i++) {
      createSkillOutcome(state, {
        taskId: `task_${i}`,
        skillId,
        skillName: "payer",
        scriptName: "pay.sh",
        signal: "failure",
        source: "objective",
        exitCode: 1,
        consequential: true,
        selfVerifiable: true,
        reviewed: false,
        feedbackPrompted: false
      });
    }
  });
}

describe("reflectionValidator", () => {
  test("clamps unknown defectClass and drops malformed edits", () => {
    const v = reflectionValidator.parse({
      defectClass: "bogus",
      attributable: "yes",
      edits: [{ op: "append" }, { op: "replace", target: "x", content: "y" }, 42],
      rationale: 7
    });
    expect(v.defectClass).toBe("unknown");
    expect(v.attributable).toBe(false);
    // append with no content is dropped; the valid replace survives.
    expect(v.edits).toHaveLength(1);
    expect(v.edits[0]).toEqual({ op: "replace", target: "x", content: "y" });
    expect(v.rationale).toBe("");
  });
});

describe("reflectOnSkillOutcomes", () => {
  test("the system prompt forbids instance-specific edits", () => {
    expect(REFLECT_SYSTEM_FORBIDS_INSTANCE_EDITS).toContain("NEVER hard-code instance-specific");
  });

  test(">= 2 failures on a user skill produces a bounded edit proposal", async () => {
    const instance = "user-defect";
    const config = makeConfig(instance);
    readState(instance);
    writeUserSkill(instance, "payer", USER_SKILL_BODY);
    await reloadSkills(config);
    const skill = readState(instance).skills.find((s) => s.name === "payer")!;
    await seedFailures(instance, skill.id, 2);

    setEchoStructuredResponse(`skill-reflect:${skill.id}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }],
      rationale: "Missing a confirmation step."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
    const state = readState(instance);
    const proposal = state.improvements.find((p) => p.payload.mode === "edit");
    expect(proposal).toBeDefined();
    expect(proposal!.payload.targetSkillId).toBe(skill.id);
    expect(String(proposal!.payload.candidateBody)).toContain("Confirm the payee");
    expect(String(proposal!.payload.baseBody)).toBe(skill.body);
    // sourceTraceIds are real trace ids (or [] when the task has no trace), never
    // the task ids themselves — sourceTaskId stays the primary evidence pointer.
    expect(["task_0", "task_1"]).toContain(proposal!.sourceTaskId!);
    expect(proposal!.sourceTraceIds).not.toContain("task_0");
    expect(proposal!.sourceTraceIds).not.toContain("task_1");
    expect(proposal!.sourceTraceIds).toEqual([]);
    // All processed failure outcomes are marked reviewed.
    expect(state.skillOutcomes.every((o) => o.reviewed)).toBe(true);
  });

  test("a bundled skill defect produces a finding, not a proposal", async () => {
    const instance = "bundled-defect";
    const config = makeConfig(instance);
    let skillId = "";
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "bundled-payer",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        body: "# Bundled payer\n1. Do the thing.",
        source: "bundled"
      });
      skillId = skill.id;
    });
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "2. Confirm." }],
      rationale: "Needs a confirm step."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);
    const findings = readState(instance).learningFindings;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("bundled_skill");
    // No edit proposal was created for a bundled skill.
    expect(readState(instance).improvements.some((p) => p.payload.mode === "edit")).toBe(false);
  });

  test("environment / credential verdicts produce findings", async () => {
    const instance = "env-finding";
    const config = makeConfig(instance);
    let skillId = "";
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "fetcher",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        body: "# Fetcher\n1. Fetch.",
        source: "user"
      });
      skillId = skill.id;
    });
    await seedFailures(instance, skillId, 3);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "credential",
      attributable: false,
      edits: [],
      rationale: "Token expired.",
      nonSkillFinding: "Your Gmail token keeps expiring — reconnect?"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);
    const finding = readState(instance).learningFindings[0]!;
    expect(finding.kind).toBe("credential");
    expect(finding.summary).toContain("reconnect");
  });

  test("the >= 2 floor holds — a single failure is not optimized", async () => {
    const instance = "floor";
    const config = makeConfig(instance);
    let skillId = "";
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "lonely",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        body: "# Lonely\n1. Do.",
        source: "user"
      });
      skillId = skill.id;
    });
    await seedFailures(instance, skillId, 1);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "2. More." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    // The single outcome is left unreviewed for a future pass.
    expect(readState(instance).skillOutcomes.every((o) => !o.reviewed)).toBe(true);
  });

  test("maxProposals clips the number of edit proposals", async () => {
    const instance = "clip";
    const config = makeConfig(instance);
    const ids: string[] = [];
    for (const name of ["a-skill", "b-skill", "c-skill"]) {
      readState(instance);
      writeUserSkill(instance, name, USER_SKILL_BODY.replace("name: payer", `name: ${name}`));
      await reloadSkills(config);
      const skill = readState(instance).skills.find((s) => s.name === name)!;
      ids.push(skill.id);
      await seedFailures(instance, skill.id, 2);
      setEchoStructuredResponse(`skill-reflect:${skill.id}`, {
        defectClass: "skill_defect",
        attributable: true,
        edits: [{ op: "append", content: "3. Confirm." }],
        rationale: "x"
      });
    }
    // Re-tag every seeded outcome's taskId uniquely is not needed; failures are
    // grouped by skillId. Three skills each with 2 failures -> 3 candidate
    // proposals, clipped to maxProposals=2.
    const result = await reflectOnSkillOutcomes(config, { maxProposals: 2 });
    expect(result.proposalsCreated).toBe(2);
    expect(readState(instance).improvements.filter((p) => p.payload.mode === "edit")).toHaveLength(2);
  });

  test("a clipped user-skill defect creates no finding and leaves its batch unreviewed", async () => {
    const instance = "clip-defect";
    const config = makeConfig(instance);
    const ids: string[] = [];
    for (const name of ["a-skill", "b-skill", "c-skill"]) {
      readState(instance);
      writeUserSkill(instance, name, USER_SKILL_BODY.replace("name: payer", `name: ${name}`));
      await reloadSkills(config);
      const skill = readState(instance).skills.find((s) => s.name === name)!;
      ids.push(skill.id);
      await seedFailures(instance, skill.id, 2);
      setEchoStructuredResponse(`skill-reflect:${skill.id}`, {
        defectClass: "skill_defect",
        attributable: true,
        edits: [{ op: "append", content: "3. Confirm." }],
        rationale: "x"
      });
    }

    // Three user-skill defects with applicable edits, budget of 1: one proposal,
    // and the two clipped defects must NOT become spurious bundled_skill
    // findings, and their outcomes must stay unreviewed for a later pass.
    const result = await reflectOnSkillOutcomes(config, { maxProposals: 1 });
    expect(result.proposalsCreated).toBe(1);
    expect(result.findingsCreated).toBe(0);

    const state = readState(instance);
    expect(state.learningFindings).toHaveLength(0);
    // Exactly one skill's batch was reviewed (the proposed one); the two clipped
    // skills' outcomes remain unreviewed so they're retried next pass.
    const unreviewed = state.skillOutcomes.filter((o) => !o.reviewed);
    expect(unreviewed).toHaveLength(4);
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
  });
});
