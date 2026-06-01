import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createSkill, mutateState, readState } from "../state";
import type { RuntimeConfig, SkillRecord } from "../types";
import { grantConnectorToSkill, installSkillFromBody, revokeConnectorGrant, setSkillStatus, updateSkill } from "./skills";

const ROOT = "/tmp/gini-skills-capability-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function config(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: `${ROOT}/${instance}`,
    logRoot: `${ROOT}/${instance}/logs`
  };
}

async function seedSkill(instance: string, overrides: Partial<SkillRecord>) {
  return mutateState(instance, (state) =>
    createSkill(state, {
      name: "test-skill",
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "disabled",
      source: "user",
      requiredConnectors: [{ provider: "linear" }],
      ...overrides
    })
  );
}

describe("grantConnectorToSkill / revokeConnectorGrant", () => {
  // Grants are keyed by credential NAME (the /complete handler passes the
  // credential name, and the state migration canonicalizes any legacy
  // provider-string grants to their credential name on read).
  test("grant appends the credential name and writes an audit row; idempotent", async () => {
    const instance = "skills-grant";
    const skill = await seedSkill(instance, {});
    const granted = await grantConnectorToSkill(config(instance), skill.id, "LINEAR_API_KEY");
    expect(granted.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    // Re-granting the same credential is a no-op (no duplicate entry).
    const again = await grantConnectorToSkill(config(instance), skill.id, "LINEAR_API_KEY");
    expect(again.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
    const state = readState(instance);
    expect(state.audit.filter((a) => a.action === "skill.connector.granted").length).toBe(1);
  });

  test("revoke removes the credential name and writes an audit row", async () => {
    const instance = "skills-revoke";
    // A legacy provider-string grant is canonicalized to LINEAR_API_KEY by the
    // migration on read, so revoke targets the credential name.
    const skill = await seedSkill(instance, { grantedConnectors: ["linear"] });
    const revoked = await revokeConnectorGrant(config(instance), skill.id, "LINEAR_API_KEY");
    expect(revoked.grantedConnectors).toEqual([]);
    const state = readState(instance);
    expect(state.audit.some((a) => a.action === "skill.connector.revoked")).toBe(true);
  });
});

describe("setSkillStatus disable transition", () => {
  test("disabling a skill clears its connector grants and emits a revoked audit per provider", async () => {
    const instance = "skills-disable-clears";
    const skill = await seedSkill(instance, { status: "enabled", grantedConnectors: ["linear", "generic"] });
    const disabled = await setSkillStatus(config(instance), skill.id, "disabled");
    expect(disabled.status).toBe("disabled");
    expect(disabled.grantedConnectors).toEqual([]);
    const state = readState(instance);
    const revoked = state.audit.filter((a) => a.action === "skill.connector.revoked" && a.target === skill.id);
    expect(revoked.length).toBe(2);
  });

  test("enabling a skill leaves grants untouched", async () => {
    const instance = "skills-enable-keeps";
    // The seeded legacy "linear" grant is canonicalized to LINEAR_API_KEY by
    // the migration on read; enabling must leave it as-is.
    const skill = await seedSkill(instance, { status: "disabled", grantedConnectors: ["linear"] });
    const enabled = await setSkillStatus(config(instance), skill.id, "enabled");
    expect(enabled.status).toBe("enabled");
    expect(enabled.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
  });
});

describe("installSkillFromBody frontmatter warnings", () => {
  test("returns advisory warnings for a near-miss frontmatter without blocking install", async () => {
    const instance = "skills-install-warn";
    const body = [
      "---",
      "name: weather3",
      "description: Check the weather.",
      "gini:",
      "  requirements:",
      "    credentials:",
      "      - WEATHER3_API_KEY",
      "---",
      "",
      "# Weather3"
    ].join("\n");
    const result = await installSkillFromBody(config(instance), { body });
    expect(result.validation.ok).toBe(true);
    expect(result.validation.warnings.length).toBeGreaterThan(0);
    expect(result.validation.warnings.join(" ")).toContain("requires");
    // The dropped credential is reflected on the installed record.
    expect(result.skill.requiredCredentials).toBeUndefined();
  });

  test("returns no warnings for a correct metadata.gini skill", async () => {
    const instance = "skills-install-clean";
    const body = [
      "---",
      "name: weather3",
      "description: Check the weather.",
      "metadata:",
      "  gini:",
      "    requires:",
      "      credentials:",
      "        - WEATHER3_API_KEY",
      "---",
      "",
      "# Weather3"
    ].join("\n");
    const result = await installSkillFromBody(config(instance), { body });
    expect(result.validation.warnings).toEqual([]);
    expect(result.skill.requiredCredentials).toEqual(["WEATHER3_API_KEY"]);
  });
});

describe("updateSkill status-only PATCH disable", () => {
  test("disabling via PATCH clears connector grants and emits a revoked audit", async () => {
    const instance = "skills-patch-disable-clears";
    const skill = await seedSkill(instance, { status: "enabled", grantedConnectors: ["linear"] });
    const disabled = await updateSkill(config(instance), skill.id, { status: "disabled" });
    expect(disabled.status).toBe("disabled");
    expect(disabled.grantedConnectors).toEqual([]);
    const state = readState(instance);
    expect(state.audit.some((a) => a.action === "skill.connector.revoked" && a.target === skill.id)).toBe(true);
  });
});
