import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateState, readState } from "../state";
import type { RuntimeConfig, RuntimeState, SkillRecord } from "../types";
import {
  findSkillScript,
  invokeSkillScript,
  listEnabledSkillScripts
} from "./skill-scripts";

const ROOT = "/tmp/gini-skill-scripts-unit";

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

function writeScript(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "go.ts");
  writeFileSync(scriptPath, content);
  return scriptPath;
}

function pushSkill(state: RuntimeState, skill: Partial<SkillRecord> & Pick<SkillRecord, "name" | "manifestPath" | "scripts" | "source">) {
  const { name, status, ...rest } = skill;
  state.skills.push({
    id: `skill_${name}`,
    instance: state.instance,
    name,
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: status ?? "enabled",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...rest
  });
}

describe("findSkillScript + listEnabledSkillScripts", () => {
  test("returns null for unknown tool", async () => {
    const instance = "skill-scripts-find-missing";
    await mutateState(instance, () => {});
    expect(findSkillScript(readState(instance), "no_such_tool")).toBeNull();
  });

  test("resolves enabled bundled skill scripts and skips user / disabled / non-bundled ones", async () => {
    const instance = "skill-scripts-find-filter";
    const skillDir = `${ROOT}/${instance}-skills/linear`;
    writeScript(`${skillDir}/scripts`, "console.log(JSON.stringify({ ok: true }));");
    const otherSkillDir = `${ROOT}/${instance}-skills/sus`;
    writeScript(`${otherSkillDir}/scripts`, "console.log(JSON.stringify({ ok: false }));");
    const disabledSkillDir = `${ROOT}/${instance}-skills/dormant`;
    writeScript(`${disabledSkillDir}/scripts`, "console.log(JSON.stringify({ ok: true }));");

    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "linear",
        manifestPath: `${skillDir}/SKILL.md`,
        source: "bundled",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "linear_attach_image", description: "", parameters: { type: "object" } }
        }]
      });
      pushSkill(s, {
        name: "sus",
        manifestPath: `${otherSkillDir}/SKILL.md`,
        source: "user",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "sus_tool", description: "", parameters: { type: "object" } }
        }]
      });
      pushSkill(s, {
        name: "dormant",
        manifestPath: `${disabledSkillDir}/SKILL.md`,
        source: "bundled",
        status: "disabled",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "dormant_tool", description: "", parameters: { type: "object" } }
        }]
      });
    });

    const updated = readState(instance);
    const found = findSkillScript(updated, "linear_attach_image");
    expect(found?.skill.name).toBe("linear");
    expect(found?.script.tool.name).toBe("linear_attach_image");
    expect(findSkillScript(updated, "sus_tool")).toBeNull();
    expect(findSkillScript(updated, "dormant_tool")).toBeNull();
    const listed = listEnabledSkillScripts(updated);
    expect(listed.map((i) => i.script.tool.name)).toEqual(["linear_attach_image"]);
  });

  test("rejects ../ escapes in the declared file path", async () => {
    const instance = "skill-scripts-find-escape";
    const skillDir = `${ROOT}/${instance}-skills/linear`;
    mkdirSync(skillDir, { recursive: true });
    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "linear",
        manifestPath: `${skillDir}/SKILL.md`,
        source: "bundled",
        scripts: [{
          file: "../../../etc/passwd",
          tool: { name: "escape", description: "", parameters: { type: "object" } }
        }]
      });
    });
    expect(findSkillScript(readState(instance), "escape")).toBeNull();
  });
});

describe("invokeSkillScript", () => {
  test("happy path: env + stdin piped in, stdout parsed as JSON, audit emitted", async () => {
    const instance = "skill-scripts-happy";
    const skillDir = `${ROOT}/${instance}-skills/echo-bundle`;
    writeScript(`${skillDir}/scripts`, `
const buf = [];
for await (const c of Bun.stdin.stream()) buf.push(c);
const args = JSON.parse(Buffer.concat(buf).toString("utf8") || "{}");
process.stdout.write(JSON.stringify({
  ok: true,
  echoed: args,
  instance: process.env.GINI_INSTANCE,
  uploads: process.env.GINI_UPLOADS_DIR,
  taskId: process.env.GINI_TASK_ID
}));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "echo-bundle",
        manifestPath: `${skillDir}/SKILL.md`,
        source: "bundled",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "echo_back", description: "", parameters: { type: "object" } }
        }]
      });
    });
    const invocation = findSkillScript(readState(instance), "echo_back");
    expect(invocation).not.toBeNull();
    const result = await invokeSkillScript(config(instance), invocation!, { hello: "world" }, { taskId: "task_t1" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toMatchObject({
      ok: true,
      echoed: { hello: "world" },
      instance,
      taskId: "task_t1"
    });
  });

  test("non-zero exit surfaces as ok=false with stderr in the error", async () => {
    const instance = "skill-scripts-fail";
    const skillDir = `${ROOT}/${instance}-skills/broken`;
    writeScript(`${skillDir}/scripts`, `
process.stderr.write("kapow");
process.exit(7);
`);
    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "broken",
        manifestPath: `${skillDir}/SKILL.md`,
        source: "bundled",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "broken_tool", description: "", parameters: { type: "object" } }
        }]
      });
    });
    const invocation = findSkillScript(readState(instance), "broken_tool");
    const result = await invokeSkillScript(config(instance), invocation!, {});
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.error).toContain("kapow");
  });

  test("non-JSON stdout surfaces as ok=false with a parse-error message", async () => {
    const instance = "skill-scripts-badjson";
    const skillDir = `${ROOT}/${instance}-skills/talker`;
    writeScript(`${skillDir}/scripts`, `process.stdout.write("hello not-json");`);
    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "talker",
        manifestPath: `${skillDir}/SKILL.md`,
        source: "bundled",
        scripts: [{
          file: "scripts/go.ts",
          tool: { name: "talker_tool", description: "", parameters: { type: "object" } }
        }]
      });
    });
    const invocation = findSkillScript(readState(instance), "talker_tool");
    const result = await invokeSkillScript(config(instance), invocation!, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not JSON/);
  });
});
