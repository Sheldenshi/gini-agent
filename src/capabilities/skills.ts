import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { RuntimeConfig, SkillRecord } from "../types";
import { addAudit, appendEvent, createSkill, mutateState, now, readState } from "../state";
import { skillsDir } from "../paths";
import { loadSkillsFromDisk, parseSkillFile, validateParsedSkill, type SkillLoadResult } from "./skill-loader";

export async function reloadSkills(config: RuntimeConfig): Promise<SkillLoadResult> {
  return loadSkillsFromDisk(config);
}

export interface InstallSkillInput {
  // Raw SKILL.md contents (frontmatter + body).
  body: string;
  // Optional category override. When omitted, falls back to
  // metadata.gini.category or "user". The resulting file lives at
  // `<instance>/skills/<category>/<name>/SKILL.md`.
  category?: string;
  // Optional named-file payloads written next to SKILL.md
  // (e.g. `scripts/linear.sh`). Each entry's `name` is treated as a
  // relative path under the skill folder and must not escape it.
  files?: Array<{ name: string; content: string }>;
}

export interface InstallSkillResult {
  skill: SkillRecord;
  manifestPath: string;
  validation: { ok: boolean; issues: string[] };
}

// Persist a SKILL.md (and optional sidecar files) to the user-skills
// directory and trigger a reload so the new skill enters the runtime.
// This is the API counterpart to dropping a file in
// `~/.gini/instances/<instance>/skills/<category>/<name>/`; both end up
// in the same watched directory.
export async function installSkillFromBody(
  config: RuntimeConfig,
  input: InstallSkillInput
): Promise<InstallSkillResult> {
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new Error("Invalid input: body is required.");
  }
  const parsed = parseSkillFile(input.body);
  if (!parsed.name.trim()) {
    throw new Error("Invalid input: SKILL.md must declare a top-level `name`.");
  }
  // Derive a category from caller input → metadata.gini.category →
  // fallback "user". Keep the chosen value sanitized so the resulting path
  // can't escape the skills root.
  const meta = (parsed.frontmatter.metadata && typeof parsed.frontmatter.metadata === "object")
    ? (parsed.frontmatter.metadata as Record<string, unknown>)
    : {};
  const gini = (meta.gini && typeof meta.gini === "object") ? (meta.gini as Record<string, unknown>) : {};
  const category = sanitizeName(input.category ?? (typeof gini.category === "string" ? gini.category : "") ?? "user") || "user";
  const folderName = sanitizeName(parsed.name);
  if (!folderName) throw new Error(`Invalid skill name "${parsed.name}".`);

  // Validate before writing so the API rejects obviously-broken input.
  const issues = validateParsedSkill(parsed, { parentDirName: folderName });
  if (issues.length > 0) {
    throw new Error(`Skill failed validation:\n - ${issues.join("\n - ")}`);
  }

  const root = skillsDir(config.instance);
  const dir = join(root, category, folderName);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "SKILL.md");
  writeFileSync(manifestPath, input.body.endsWith("\n") ? input.body : `${input.body}\n`);

  for (const file of input.files ?? []) {
    if (typeof file?.name !== "string" || !file.name.trim()) continue;
    if (typeof file?.content !== "string") continue;
    const safe = sanitizeRelativePath(file.name);
    if (!safe) throw new Error(`Refusing to write file outside skill folder: ${file.name}`);
    const target = join(dir, safe);
    mkdirSync(join(target, ".."), { recursive: true });
    // Files dropped under `scripts/` are meant to be executed by the
    // agent's terminal_exec wrapper (see ADR connector-provider-spec-compliance.md §Skills); land them
    // mode 0755 so the spawn isn't blocked by a missing exec bit. Other
    // payloads (REFERENCES.md, asset files) keep default permissions.
    const isScript = safe.split(sep)[0] === "scripts";
    writeFileSync(target, file.content, isScript ? { mode: 0o755 } : undefined);
  }

  await loadSkillsFromDisk(config);
  const state = readState(config.instance);
  const skill = state.skills.find((s) => s.name === parsed.name && (s.source ?? "user") === "user");
  if (!skill) {
    throw new Error("Skill written to disk but did not appear in state after reload.");
  }
  return {
    skill,
    manifestPath,
    validation: { ok: issues.length === 0, issues }
  };
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeRelativePath(value: string): string | null {
  const normalized = normalize(value).replace(/^[/\\]+/, "");
  if (normalized.split(sep).some((segment) => segment === "..")) return null;
  if (normalized.startsWith(sep)) return null;
  return normalized;
}

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
    status: input.status === "disabled" || input.status === "archived" ? input.status : "enabled",
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
    // Status-only PATCH skips the version bump and previousVersions push.
    // Enablement is an operator decision, not a content edit.
    if (
      typeof input.status === "string" &&
      Object.keys(input).length === 1 &&
      ["enabled", "disabled", "archived", "trusted", "untrusted", "draft"].includes(input.status)
    ) {
      const next = normalizeSkillStatusInput(input.status);
      // Capture prior status BEFORE mutating so the audit evidence
      // accurately records the transition; otherwise previousStatus and
      // status would always be equal.
      const prev = skill.status;
      skill.status = next;
      skill.updatedAt = now();
      addAudit(state, {
        actor: "user",
        action: "skill.status",
        target: skill.id,
        risk: "low",
        evidence: { previousStatus: prev, status: next }
      });
      return skill;
    }
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

function normalizeSkillStatusInput(status: string): SkillRecord["status"] {
  if (status === "trusted") return "enabled";
  if (status === "draft" || status === "untrusted") return "disabled";
  if (status === "enabled" || status === "disabled" || status === "archived") return status;
  throw new Error(`Invalid skill status: ${status}`);
}

export async function setSkillStatus(config: RuntimeConfig, idOrName: string, status: "enabled" | "disabled" | "archived") {
  return mutateState(config.instance, (state) => {
    const skill = state.skills.find((item) => item.id === idOrName || item.name === idOrName);
    if (!skill) throw new Error(`Skill not found: ${idOrName}`);
    skill.status = status;
    skill.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: `skill.${status}`,
      target: skill.id,
      risk: "low"
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
  return readState(config.instance).skills.map((skill) => {
    const failures = validateSkillRecord(skill);
    return { id: skill.id, name: skill.name, ok: failures.length === 0, failures };
  });
}

function validateSkillRecord(skill: SkillRecord): string[] {
  const failures: string[] = [];
  if (!skill.name.trim()) failures.push("Skill name is required.");
  if (skill.status === "enabled" && skill.tests.length === 0 && !skill.manifestPath) {
    failures.push("Enabled API-created skills need at least one test.");
  }
  if (skill.steps.some((step) => !step.trim())) failures.push("Skill steps cannot be empty.");
  // Surface loader-time validation results so /api/skills/validate
  // reports spec compliance issues alongside legacy CRUD checks.
  if (skill.validationStatus === "unsupported" && skill.validationMessage) {
    failures.push(skill.validationMessage);
  }
  return failures;
}
