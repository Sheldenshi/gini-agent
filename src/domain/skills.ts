import type { RuntimeConfig, SkillRecord } from "../types";
import { addAudit, appendEvent, createSkill, mutateState, now, readState } from "../state";

export function listSkills(config: RuntimeConfig) {
  return readState(config.instance).skills;
}

export async function createSkillFromInput(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => createSkill(state, {
    name: String(input.name ?? "Untitled skill"),
    description: String(input.description ?? ""),
    trigger: String(input.trigger ?? ""),
    steps: Array.isArray(input.steps) ? input.steps.map(String) : [],
    requiredTools: Array.isArray(input.requiredTools) ? input.requiredTools.map(String) : [],
    requiredPermissions: Array.isArray(input.requiredPermissions) ? input.requiredPermissions.map(String) : [],
    sourceTaskId: typeof input.sourceTaskId === "string" ? input.sourceTaskId : undefined,
    status: input.status === "trusted" ? "trusted" : "draft",
    tests: Array.isArray(input.tests) ? input.tests.map(String) : []
  }));
}

export function getSkill(config: RuntimeConfig, idOrName: string): SkillRecord {
  const skill = readState(config.instance).skills.find((item) => item.id === idOrName || item.name === idOrName);
  if (!skill) throw new Error(`Skill not found: ${idOrName}`);
  return skill;
}

export function searchSkills(config: RuntimeConfig, query: string) {
  const normalized = query.trim().toLowerCase();
  return readState(config.instance).skills.filter((skill) => {
    if (!normalized) return true;
    return [skill.name, skill.description, skill.trigger, skill.steps.join("\n")].some((value) => value.toLowerCase().includes(normalized));
  });
}

export async function updateSkill(config: RuntimeConfig, idOrName: string, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => {
    const skill = state.skills.find((item) => item.id === idOrName || item.name === idOrName);
    if (!skill) throw new Error(`Skill not found: ${idOrName}`);
    skill.previousVersions.unshift({
      version: skill.version,
      updatedAt: skill.updatedAt,
      description: skill.description,
      trigger: skill.trigger,
      steps: skill.steps,
      requiredTools: skill.requiredTools,
      requiredPermissions: skill.requiredPermissions
    });
    if (typeof input.name === "string") skill.name = input.name;
    if (typeof input.description === "string") skill.description = input.description;
    if (typeof input.trigger === "string") skill.trigger = input.trigger;
    if (Array.isArray(input.steps)) skill.steps = input.steps.map(String);
    if (Array.isArray(input.requiredTools)) skill.requiredTools = input.requiredTools.map(String);
    if (Array.isArray(input.requiredPermissions)) skill.requiredPermissions = input.requiredPermissions.map(String);
    if (Array.isArray(input.tests)) skill.tests = input.tests.map(String);
    skill.version += 1;
    skill.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "skill.updated",
      target: skill.id,
      risk: "medium",
      evidence: { version: skill.version, previousVersions: skill.previousVersions.length }
    });
    return skill;
  });
}

export async function setSkillStatus(config: RuntimeConfig, idOrName: string, status: "trusted" | "disabled" | "archived") {
  return mutateState(config.instance, (state) => {
    const skill = state.skills.find((item) => item.id === idOrName || item.name === idOrName);
    if (!skill) throw new Error(`Skill not found: ${idOrName}`);
    skill.status = status;
    skill.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `skill.${status}`,
      target: skill.id,
      risk: status === "trusted" ? "medium" : "low"
    });
    return skill;
  });
}

export async function rollbackSkill(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const skill = state.skills.find((item) => item.id === idOrName || item.name === idOrName);
    if (!skill) throw new Error(`Skill not found: ${idOrName}`);
    const prior = skill.previousVersions.shift();
    if (!prior) throw new Error(`Skill has no rollback version: ${idOrName}`);
    skill.previousVersions.unshift({
      version: skill.version,
      updatedAt: skill.updatedAt,
      description: skill.description,
      trigger: skill.trigger,
      steps: skill.steps,
      requiredTools: skill.requiredTools,
      requiredPermissions: skill.requiredPermissions
    });
    skill.description = prior.description;
    skill.trigger = prior.trigger;
    skill.steps = prior.steps;
    skill.requiredTools = prior.requiredTools;
    skill.requiredPermissions = prior.requiredPermissions;
    skill.version += 1;
    skill.updatedAt = now();
    addAudit(state, { actor: "user", action: "skill.rollback", target: skill.id, risk: "medium", evidence: { restoredVersion: prior.version } });
    return skill;
  });
}

export async function testSkill(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const skill = state.skills.find((item) => item.id === idOrName || item.name === idOrName);
    if (!skill) throw new Error(`Skill not found: ${idOrName}`);
    const failures = validateSkillRecord(skill);
    if (failures.length === 0) skill.successCount += 1;
    else skill.failureCount += 1;
    skill.updatedAt = now();
    appendEvent(state, {
      kind: "skill",
      action: "skill.tested",
      target: skill.id,
      risk: "low",
      summary: failures.length === 0 ? "Skill test passed" : "Skill test failed",
      data: { failures }
    });
    return { skill, ok: failures.length === 0, failures };
  });
}

export function validateSkills(config: RuntimeConfig) {
  return readState(config.instance).skills.map((skill) => ({ id: skill.id, name: skill.name, ok: validateSkillRecord(skill).length === 0, failures: validateSkillRecord(skill) }));
}

function validateSkillRecord(skill: SkillRecord): string[] {
  const failures: string[] = [];
  if (!skill.name.trim()) failures.push("Skill name is required.");
  if (skill.status === "trusted" && skill.tests.length === 0) failures.push("Trusted skills need at least one test.");
  if (skill.steps.some((step) => !step.trim())) failures.push("Skill steps cannot be empty.");
  return failures;
}
