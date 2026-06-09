import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateState, readState } from "../state";
import type { RuntimeConfig, RuntimeState, SkillRecord } from "../types";
import { findSkillScript, invokeSkillScript, listEnabledSkillScripts } from "./skill-scripts";

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

function writeScript(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, content);
  return scriptPath;
}

function pushSkill(
  state: RuntimeState,
  skill: Partial<SkillRecord> & Pick<SkillRecord, "name" | "manifestPath">
) {
  const { name, status, source, ...rest } = skill;
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
    source: source ?? "bundled",
    ...rest
  });
}

describe("findSkillScript", () => {
  test("returns null when the skill isn't enabled", async () => {
    const instance = "skfind-disabled";
    const skillDir = `${ROOT}/${instance}-skills/foo`;
    writeScript(join(skillDir, "scripts"), "go.ts", "console.log(JSON.stringify({ok:true}))");
    await mutateState(instance, (s) => {
      pushSkill(s, {
        name: "foo",
        manifestPath: `${skillDir}/SKILL.md`,
        status: "disabled"
      });
    });
    expect(findSkillScript(readState(instance), "foo", "go")).toBeNull();
  });

  test("matches by stem regardless of extension", async () => {
    const instance = "skfind-match";
    const skillDir = `${ROOT}/${instance}-skills/foo`;
    writeScript(join(skillDir, "scripts"), "do-thing.ts", "console.log(JSON.stringify({ok:true}))");
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "foo", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "foo", "do-thing");
    expect(handle).not.toBeNull();
    expect(handle?.scriptPath.endsWith("do-thing.ts")).toBe(true);
  });

  test("matches across language extensions (.sh / .py)", async () => {
    const instance = "skfind-langs";
    const skillDir = `${ROOT}/${instance}-skills/foo`;
    writeScript(join(skillDir, "scripts"), "shellish.sh", "#!/bin/bash\necho '{\"ok\":true}'\n");
    writeScript(join(skillDir, "scripts"), "pythonish.py", "import sys\nsys.stdout.write('{\"ok\":true}')\n");
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "foo", manifestPath: `${skillDir}/SKILL.md` });
    });
    const state = readState(instance);
    expect(findSkillScript(state, "foo", "shellish")?.scriptPath.endsWith(".sh")).toBe(true);
    expect(findSkillScript(state, "foo", "pythonish")?.scriptPath.endsWith(".py")).toBe(true);
  });

  test("ignores subdirectories under scripts/ (helper space)", async () => {
    const instance = "skfind-subdir";
    const skillDir = `${ROOT}/${instance}-skills/foo`;
    writeScript(join(skillDir, "scripts"), "go.ts", "console.log(JSON.stringify({ok:true}))");
    writeScript(join(skillDir, "scripts", "lib"), "helper.ts", "// not a script");
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "foo", manifestPath: `${skillDir}/SKILL.md` });
    });
    const state = readState(instance);
    expect(findSkillScript(state, "foo", "go")?.scriptPath.endsWith("scripts/go.ts")).toBe(true);
    expect(findSkillScript(state, "foo", "helper")).toBeNull();
  });
});

describe("listEnabledSkillScripts", () => {
  test("returns each enabled skill's script basenames, sorted", async () => {
    const instance = "sklist-sort";
    const a = `${ROOT}/${instance}-skills/aaa`;
    const b = `${ROOT}/${instance}-skills/bbb`;
    writeScript(join(a, "scripts"), "two.ts", "console.log('{}')");
    writeScript(join(a, "scripts"), "one.ts", "console.log('{}')");
    writeScript(join(b, "scripts"), "alpha.sh", "echo '{}'");
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "aaa", manifestPath: `${a}/SKILL.md` });
      pushSkill(s, { name: "bbb", manifestPath: `${b}/SKILL.md` });
    });
    const out = listEnabledSkillScripts(readState(instance));
    expect(out).toEqual([
      { skill: "aaa", scripts: ["one", "two"] },
      { skill: "bbb", scripts: ["alpha"] }
    ]);
  });

  test("user-installed skills surface too (trust handled at install_skill time)", async () => {
    const instance = "sklist-user";
    const skillDir = `${ROOT}/${instance}-skills/user-thing`;
    writeScript(join(skillDir, "scripts"), "x.ts", "console.log('{}')");
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "user-thing", manifestPath: `${skillDir}/SKILL.md`, source: "user" });
    });
    const out = listEnabledSkillScripts(readState(instance));
    expect(out.find((e) => e.skill === "user-thing")?.scripts).toEqual(["x"]);
  });
});

describe("invokeSkillScript", () => {
  test("happy path: env + stdin piped in, stdout parsed as JSON", async () => {
    const instance = "skinv-happy";
    const skillDir = `${ROOT}/${instance}-skills/echo-skill`;
    writeScript(join(skillDir, "scripts"), "echo.ts", `
const buf = [];
for await (const c of Bun.stdin.stream()) buf.push(c);
const args = JSON.parse(Buffer.concat(buf).toString("utf8") || "{}");
process.stdout.write(JSON.stringify({
  ok: true,
  echoed: args,
  instance: process.env.GINI_INSTANCE,
  uploads: process.env.GINI_UPLOADS_DIR,
  workspace: process.env.GINI_WORKSPACE,
  taskId: process.env.GINI_TASK_ID
}));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "echo-skill", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "echo-skill", "echo");
    expect(handle).not.toBeNull();
    const result = await invokeSkillScript(config(instance), handle!, { hello: "world" }, { taskId: "task_t1" });
    expect(result.ok).toBe(true);
    expect(result.parsed).toMatchObject({
      ok: true,
      echoed: { hello: "world" },
      instance,
      taskId: "task_t1"
    });
  });

  test("forwards benign ambient session vars (USER/LOGNAME) to the script", async () => {
    const instance = "skinv-ambient";
    const skillDir = `${ROOT}/${instance}-skills/probe`;
    writeScript(join(skillDir, "scripts"), "env.ts", `
process.stdout.write(JSON.stringify({
  ok: true,
  USER: process.env.USER ?? null,
  LOGNAME: process.env.LOGNAME ?? null
}));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "probe", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "probe", "env");
    const result = await invokeSkillScript(config(instance), handle!, {});
    expect(result.ok).toBe(true);
    expect(result.parsed).toMatchObject({
      ok: true,
      USER: process.env.USER ?? null,
      LOGNAME: process.env.LOGNAME ?? null
    });
  });

  test("non-zero exit + stderr surfaces as ok=false with error containing stderr", async () => {
    const instance = "skinv-fail";
    const skillDir = `${ROOT}/${instance}-skills/broken`;
    writeScript(join(skillDir, "scripts"), "bad.ts", `
process.stderr.write("kapow");
process.exit(7);
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "broken", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "broken", "bad");
    const result = await invokeSkillScript(config(instance), handle!, {});
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.error).toContain("kapow");
  });

  test("non-JSON stdout surfaces parse-error envelope", async () => {
    const instance = "skinv-badjson";
    const skillDir = `${ROOT}/${instance}-skills/talker`;
    writeScript(join(skillDir, "scripts"), "speak.ts", `process.stdout.write("hello not-json");`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "talker", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "talker", "speak");
    const result = await invokeSkillScript(config(instance), handle!, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not JSON/);
  });
});
