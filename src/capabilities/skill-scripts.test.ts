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

  test("an aborted signal SIGTERMs the running script well before its natural end", async () => {
    const instance = "skinv-abort";
    const skillDir = `${ROOT}/${instance}-skills/sleeper`;
    // A script that would run for 30s if left alone. The abort must kill it
    // promptly rather than letting it run to completion (or to the 5-minute
    // default timeout).
    writeScript(join(skillDir, "scripts"), "sleep.ts", `
await Bun.sleep(30000);
process.stdout.write(JSON.stringify({ ok: true, slept: true }));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "sleeper", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "sleeper", "sleep");
    expect(handle).not.toBeNull();

    const controller = new AbortController();
    // Fire the abort shortly after the script spawns so it's genuinely mid-run.
    const fired = setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    const result = await invokeSkillScript(config(instance), handle!, {}, { signal: controller.signal });
    clearTimeout(fired);
    const elapsed = Date.now() - startedAt;
    // The kill lands far below the 30s sleep — the script was SIGTERM'd.
    expect(elapsed).toBeLessThan(5000);
    // A killed proc exits non-zero with no JSON stdout → ok=false envelope and
    // no parsed payload (the script never reached its stdout.write).
    expect(result.ok).toBe(false);
    expect(result.parsed).toBeNull();
    // The abort WON the race, so the run is reported aborted.
    expect(result.aborted).toBe(true);
  });

  test("a signal already aborted at entry kills the script immediately", async () => {
    const instance = "skinv-abort-preentry";
    const skillDir = `${ROOT}/${instance}-skills/sleeper2`;
    writeScript(join(skillDir, "scripts"), "sleep.ts", `
await Bun.sleep(30000);
process.stdout.write(JSON.stringify({ ok: true, slept: true }));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "sleeper2", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "sleeper2", "sleep");
    const controller = new AbortController();
    controller.abort(); // already aborted before invoke
    const startedAt = Date.now();
    // Pass a taskId so the pre-spawn skip's trace branch is exercised too.
    const result = await invokeSkillScript(config(instance), handle!, {}, { signal: controller.signal, taskId: "task_preabort" });
    // Pre-aborted: the spawn is skipped entirely (no 30s sleep), reported aborted.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  test("a cancel landing during env-resolve (after entry, before spawn) skips the spawn", async () => {
    const instance = "skinv-abort-midsetup";
    const skillDir = `${ROOT}/${instance}-skills/sleeper3`;
    writeScript(join(skillDir, "scripts"), "sleep.ts", `
await Bun.sleep(30000);
process.stdout.write(JSON.stringify({ ok: true, slept: true }));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "sleeper3", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "sleeper3", "sleep");
    const controller = new AbortController();
    // Start the invoke (NOT aborted at entry, so the entry check passes), then
    // abort on the next macrotask — during the awaited resolveSkillEnv window,
    // before the spawn. The second pre-spawn `signal.aborted` check catches it.
    const startedAt = Date.now();
    const promise = invokeSkillScript(config(instance), handle!, {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    const result = await promise;
    // The script (30s sleep) never ran to completion — the spawn was skipped or
    // killed at the source well under the sleep.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });

  test("a signal that fires AFTER the script already completed does NOT mark it aborted (drain window)", async () => {
    const instance = "skinv-abort-drain";
    const skillDir = `${ROOT}/${instance}-skills/quick`;
    // A script that completes essentially immediately.
    writeScript(join(skillDir, "scripts"), "quick.ts", `process.stdout.write(JSON.stringify({ ok: true, done: true }));`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "quick", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "quick", "quick");
    const controller = new AbortController();
    // The script finishes fast; the abort is fired well after it would have
    // exited. proc.exited wins the race, so the run must be reported as a clean
    // success — NOT mislabeled aborted just because the signal eventually fired.
    const result = await invokeSkillScript(config(instance), handle!, {}, { signal: controller.signal });
    controller.abort();
    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.parsed).toMatchObject({ ok: true, done: true });
  });

  test("a script exceeding timeoutMs is killed by the timeout (not the abort signal)", async () => {
    const instance = "skinv-timeout";
    const skillDir = `${ROOT}/${instance}-skills/slowpoke`;
    writeScript(join(skillDir, "scripts"), "slow.ts", `
await Bun.sleep(30000);
process.stdout.write(JSON.stringify({ ok: true, slept: true }));
`);
    await mutateState(instance, (s) => {
      pushSkill(s, { name: "slowpoke", manifestPath: `${skillDir}/SKILL.md` });
    });
    const handle = findSkillScript(readState(instance), "slowpoke", "slow");
    const startedAt = Date.now();
    // Tiny timeout, no abort signal — the timeout handler SIGTERMs the proc.
    const result = await invokeSkillScript(config(instance), handle!, {}, { timeoutMs: 50 });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    // A timeout kill is NOT a cancel — aborted stays false (no signal fired).
    expect(result.aborted).toBe(false);
    expect(result.parsed).toBeNull();
  });
});
