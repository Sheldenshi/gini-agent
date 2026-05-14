import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState } from "../../state";
import type { IdentityRecord, SkillRecord } from "../../types";
import { isSkillActive } from "./index";

const ROOT = "/tmp/gini-identities-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function newSkill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: "skill_test",
    instance: "dev",
    name: "test",
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: "trusted",
    version: 1,
    createdAt: "",
    updatedAt: "",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...overrides
  };
}

function newIdentity(overrides: Partial<IdentityRecord>): IdentityRecord {
  return {
    id: "id_test",
    instance: "dev",
    name: "test",
    kind: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

describe("isSkillActive", () => {
  test("returns true when the skill has no required identities", () => {
    const state = createEmptyState("dev");
    state.identities = [];
    const skill = newSkill({ requiredIdentities: [] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns true when every required kind has a healthy identity", () => {
    const state = createEmptyState("dev");
    state.identities = [newIdentity({ kind: "linear", health: "healthy" })];
    const skill = newSkill({ requiredIdentities: [{ kind: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns false when the matching identity is unhealthy", () => {
    const state = createEmptyState("dev");
    state.identities = [newIdentity({ kind: "linear", health: "unhealthy" })];
    const skill = newSkill({ requiredIdentities: [{ kind: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("returns false when no identity of the required kind exists", () => {
    const state = createEmptyState("dev");
    state.identities = [newIdentity({ kind: "github", health: "healthy" })];
    const skill = newSkill({ requiredIdentities: [{ kind: "linear" }] });
    expect(isSkillActive(state, skill)).toBe(false);
  });
});
