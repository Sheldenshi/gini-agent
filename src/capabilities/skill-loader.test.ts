// Tests for the filesystem skill loader. Covers:
//   - frontmatter / body parsing
//   - bundled + user roots both walked
//   - platform filtering (skipped reason recorded)
//   - re-load preserves user-set status, bumps version on content change
//   - bundled Gini SKILL.md files are enabled on first load
//
// Tests stand up an isolated temp instance via GINI_STATE_ROOT and an
// override bundled-skills root via GINI_BUNDLED_SKILLS, so the test never
// touches the developer's real ~/.gini or the repo's vendored skills/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDisk, parseSkillFile, parseFrontmatter, splitFrontmatter } from "./skill-loader";
import { readState, mutateState } from "../state";
import type { RuntimeConfig } from "../types";
import { setSkillStatus, validateSkills } from "./skills";

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-skill-loader-ws",
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-skill-loader-state",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-skill-loader-log"
  };
}

function writeSkill(root: string, category: string | null, skill: string, body: string): string {
  const dir = category ? join(root, category, skill) : join(root, skill);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, body);
  return path;
}

describe("skill-loader frontmatter parsing", () => {
  test("splitFrontmatter splits the YAML block from the body", () => {
    const text = "---\nname: foo\nversion: 1\n---\n\n# body\n\nhello";
    const split = splitFrontmatter(text);
    expect(split.frontmatter).toBe("name: foo\nversion: 1");
    expect(split.body.trim()).toBe("# body\n\nhello");
  });

  test("splitFrontmatter returns the whole text as body when no frontmatter", () => {
    const text = "# no frontmatter here";
    const split = splitFrontmatter(text);
    expect(split.frontmatter).toBe("");
    expect(split.body).toBe(text);
  });

  test("parseFrontmatter handles scalars, arrays, and nested maps", () => {
    const input = [
      "name: apple-notes",
      'description: "Manage Apple Notes."',
      "version: 1.0.0",
      "platforms: [macos]",
      "prerequisites:",
      "  commands: [memo]",
      "  env: [HOME]"
    ].join("\n");
    const parsed = parseFrontmatter(input);
    expect(parsed.name).toBe("apple-notes");
    expect(parsed.description).toBe("Manage Apple Notes.");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.platforms).toEqual(["macos"]);
    expect(parsed.prerequisites).toEqual({ commands: ["memo"], env: ["HOME"] });
  });

  test("parseSkillFile returns body trimmed and frontmatter normalized", () => {
    const text = [
      "---",
      "name: my-skill",
      'description: "A test skill"',
      "platforms: [macos, linux]",
      "---",
      "",
      "# Body starts here",
      "",
      "Some content."
    ].join("\n");
    const parsed = parseSkillFile(text);
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe("A test skill");
    expect(parsed.platforms).toEqual(["macos", "linux"]);
    expect(parsed.body).toContain("# Body starts here");
    expect(parsed.body).toContain("Some content.");
  });
});

describe("loadSkillsFromDisk", () => {
  let root: string;
  let bundled: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let prevBundled: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-loader-state-"));
    bundled = mkdtempSync(join(tmpdir(), "gini-loader-bundled-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    prevBundled = process.env.GINI_BUNDLED_SKILLS;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    process.env.GINI_BUNDLED_SKILLS = bundled;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevBundled === undefined) delete process.env.GINI_BUNDLED_SKILLS;
    else process.env.GINI_BUNDLED_SKILLS = prevBundled;
    rmSync(root, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  });

  test("loads bundled skills from a category dir and creates SkillRecords", async () => {
    writeSkill(
      bundled,
      "apple",
      "apple-notes",
      [
        "---",
        "name: apple-notes",
        'description: "Apple Notes via memo."',
        "version: 1.0.0",
        `platforms: [${process.platform === "darwin" ? "macos" : "linux"}]`,
        "prerequisites:",
        "  commands: [memo]",
        "---",
        "",
        "# Apple Notes",
        "",
        "Use the memo CLI."
      ].join("\n")
    );

    const config = buildConfig("loader-bundled");
    const result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(1);
    expect(result.updated.length).toBe(0);
    expect(result.skipped.length).toBe(0);

    const skill = readState(config.instance).skills.find((s) => s.name === "apple-notes");
    expect(skill).toBeDefined();
    expect(skill?.body).toContain("Use the memo CLI.");
    expect(skill?.category).toBe("apple");
    expect(skill?.manifestPath).toContain("apple-notes/SKILL.md");
    expect(skill?.platforms).toEqual([process.platform === "darwin" ? "macos" : "linux"]);
  });

  test("loads user skills directly under <instance>/skills/<name>/SKILL.md", async () => {
    const config = buildConfig("loader-user");
    // Pre-create state so skillsDir() exists.
    await mutateState(config.instance, () => undefined);
    const userSkills = join(root, "instances", config.instance, "skills");
    writeSkill(
      userSkills,
      null,
      "weather",
      [
        "---",
        "name: weather",
        'description: "Check the weather."',
        "version: 0.1.0",
        "---",
        "",
        "# Weather",
        "",
        "Fetch a forecast."
      ].join("\n")
    );

    const result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(1);
    const skill = readState(config.instance).skills.find((s) => s.name === "weather");
    expect(skill?.category).toBeUndefined();
    expect(skill?.body).toContain("Fetch a forecast.");
  });

  test("skips skills whose platforms don't include the host", async () => {
    const otherPlatform = process.platform === "darwin" ? "linux" : "macos";
    writeSkill(
      bundled,
      "stuff",
      "platform-mismatch",
      [
        "---",
        "name: platform-mismatch",
        'description: "Won\'t load."',
        `platforms: [${otherPlatform}]`,
        "---",
        "",
        "Body."
      ].join("\n")
    );
    const config = buildConfig("loader-platform");
    const result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.name).toBe("platform-mismatch");
  });

  test("re-loading bumps version when body changes and preserves user-set status", async () => {
    const config = buildConfig("loader-reload");
    const platformTag = process.platform === "darwin" ? "macos" : "linux";
    const v1 = [
      "---",
      "name: my-skill",
      'description: "v1"',
      "version: 1.0.0",
      `platforms: [${platformTag}]`,
      "---",
      "",
      "First body."
    ].join("\n");
    writeSkill(bundled, null, "my-skill", v1);
    let result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(1);
    const initial = readState(config.instance).skills.find((s) => s.name === "my-skill");
    expect(initial?.version).toBe(1);
    expect(initial?.status).toBe("enabled");

    // User disables the skill.
    await setSkillStatus(config, initial!.id, "disabled");

    const v2 = v1.replace("First body.", "Second body, much improved.");
    writeSkill(bundled, null, "my-skill", v2);
    result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(0);
    expect(result.updated.length).toBe(1);

    const updated = readState(config.instance).skills.find((s) => s.name === "my-skill");
    expect(updated?.version).toBeGreaterThan(1);
    expect(updated?.body).toContain("Second body");
    // User-managed status preserved.
    expect(updated?.status).toBe("disabled");
  });

  test("noop when content is unchanged across loads", async () => {
    const config = buildConfig("loader-noop");
    const platformTag = process.platform === "darwin" ? "macos" : "linux";
    const text = [
      "---",
      "name: stable-skill",
      'description: "stable"',
      `platforms: [${platformTag}]`,
      "---",
      "",
      "Body."
    ].join("\n");
    writeSkill(bundled, null, "stable-skill", text);
    await loadSkillsFromDisk(config);
    const result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(0);
    expect(result.updated.length).toBe(0);
  });

  test("preserves disabled bundled records on reload", async () => {
    const config = buildConfig("loader-disabled-bundled");
    const platformTag = process.platform === "darwin" ? "macos" : "linux";
    const text = [
      "---",
      "name: legacy-bundled",
      'description: "legacy"',
      `platforms: [${platformTag}]`,
      "---",
      "",
      "Body."
    ].join("\n");
    writeSkill(bundled, null, "legacy-bundled", text);
    await loadSkillsFromDisk(config);
    await mutateState(config.instance, (state) => {
      const skill = state.skills.find((s) => s.name === "legacy-bundled");
      if (!skill) throw new Error("missing skill");
      skill.status = "disabled";
    });

    const result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(0);
    expect(result.updated.length).toBe(0);
    const skill = readState(config.instance).skills.find((s) => s.name === "legacy-bundled");
    expect(skill?.status).toBe("disabled");
    expect(skill?.version).toBe(1);
    expect(skill?.previousVersions.length).toBe(0);
  });

  test("enables bundled skills on first load", async () => {
    writeSkill(
      bundled,
      "tools",
      "repo-review",
      [
        "---",
        "name: repo-review",
        'description: "Review repository changes."',
        `platforms: [${process.platform === "darwin" ? "macos" : "linux"}]`,
        "---",
        "",
        "Body."
      ].join("\n")
    );
    const config = buildConfig("loader-auto-enable");
    await loadSkillsFromDisk(config);
    const skill = readState(config.instance).skills.find((s) => s.name === "repo-review");
    expect(skill?.status).toBe("enabled");
    expect(skill?.source).toBe("bundled");
    expect(validateSkills(config).find((item) => item.name === "repo-review")?.ok).toBe(true);
  });

  // Same-name regression test: a user-instance skill named the same as a
  // bundled skill must NOT replace the bundled row's body / manifestPath /
  // status. They must coexist as separate records.
  test("user-instance skill with bundled name lands as a separate row", async () => {
    const platformTag = process.platform === "darwin" ? "macos" : "linux";
    // Bundled apple-notes — enabled on first load.
    writeSkill(
      bundled,
      "apple",
      "apple-notes",
      [
        "---",
        "name: apple-notes",
        'description: "Bundled Apple Notes via memo."',
        `platforms: [${platformTag}]`,
        "---",
        "",
        "Bundled body — vendored."
      ].join("\n")
    );
    const config = buildConfig("loader-same-name");
    await loadSkillsFromDisk(config);
    const afterFirst = readState(config.instance).skills.filter((s) => s.name === "apple-notes");
    expect(afterFirst).toHaveLength(1);
    const bundledRec = afterFirst[0]!;
    expect(bundledRec.status).toBe("enabled");
    expect(bundledRec.source).toBe("bundled");
    expect(bundledRec.body).toContain("Bundled body");
    const bundledManifest = bundledRec.manifestPath;

    // Now write a user-instance SKILL.md *with the same name*. Without the
    // fix, this would mutate the bundled record (replace body / preserve
    // enabled status). With the fix it lands as its own row, source="user".
    const userSkills = join(root, "instances", config.instance, "skills");
    writeSkill(
      userSkills,
      null,
      "apple-notes",
      [
        "---",
        "name: apple-notes",
        'description: "Malicious user skill."',
        `platforms: [${platformTag}]`,
        "---",
        "",
        "Attacker-controlled prompt content."
      ].join("\n")
    );
    await loadSkillsFromDisk(config);

    const both = readState(config.instance).skills.filter((s) => s.name === "apple-notes");
    expect(both).toHaveLength(2);
    const stillBundled = both.find((s) => s.source === "bundled")!;
    const userRow = both.find((s) => s.source === "user")!;
    // Bundled record body / manifest / status unchanged.
    expect(stillBundled.body).toContain("Bundled body");
    expect(stillBundled.manifestPath).toBe(bundledManifest);
    expect(stillBundled.status).toBe("enabled");
    expect(stillBundled.description).toBe("Bundled Apple Notes via memo.");
    // User record is its own enabled row with its own body.
    expect(userRow.status).toBe("enabled");
    expect(userRow.body).toContain("Attacker-controlled");
    expect(userRow.description).toBe("Malicious user skill.");
  });
});

// Verify the actual vendored apple SKILL.md files in skills/apple/* parse
// and load on macOS. Skipped on non-macOS so CI on Linux still passes.
describe("bundled apple skills (macOS only)", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let prevBundled: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-apple-skills-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    prevBundled = process.env.GINI_BUNDLED_SKILLS;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    // Use the real bundled skills root for this test.
    delete process.env.GINI_BUNDLED_SKILLS;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevBundled !== undefined) process.env.GINI_BUNDLED_SKILLS = prevBundled;
    rmSync(root, { recursive: true, force: true });
  });

  test.if(process.platform === "darwin")("loads apple-notes and apple-reminders verbatim", async () => {
    const config = buildConfig("loader-apple-vendored");
    const result = await loadSkillsFromDisk(config);
    const names = result.added.map((s) => s.name);
    expect(names).toContain("apple-notes");
    expect(names).toContain("apple-reminders");
    const skills = readState(config.instance).skills;
    const notes = skills.find((s) => s.name === "apple-notes");
    expect(notes?.body).toContain("memo notes");
    expect(notes?.status).toBe("enabled");
    expect(notes?.platforms).toEqual(["macos"]);
    expect(notes?.prerequisites?.commands).toEqual(["memo"]);
    const reminders = skills.find((s) => s.name === "apple-reminders");
    expect(reminders?.body).toContain("remindctl");
    expect(reminders?.status).toBe("enabled");
  });
});

describe("bundled autonomous agent skills", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let prevBundled: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-agent-skills-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    prevBundled = process.env.GINI_BUNDLED_SKILLS;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    delete process.env.GINI_BUNDLED_SKILLS;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevBundled !== undefined) process.env.GINI_BUNDLED_SKILLS = prevBundled;
    rmSync(root, { recursive: true, force: true });
  });

  test("loads codex and claude-code as enabled bundled skills", async () => {
    const config = buildConfig("loader-autonomous-agent-vendored");
    const result = await loadSkillsFromDisk(config);
    const names = result.added.map((s) => s.name);
    expect(names).toContain("codex");
    expect(names).toContain("claude-code");

    const skills = readState(config.instance).skills;
    const codex = skills.find((s) => s.name === "codex");
    expect(codex?.source).toBe("bundled");
    expect(codex?.category).toBe("agents");
    expect(codex?.status).toBe("enabled");
    expect(codex?.prerequisites?.commands).toEqual(["codex", "git"]);

    const claudeCode = skills.find((s) => s.name === "claude-code");
    expect(claudeCode?.source).toBe("bundled");
    expect(claudeCode?.category).toBe("agents");
    expect(claudeCode?.status).toBe("enabled");
    expect(claudeCode?.prerequisites?.commands).toEqual(["claude", "git"]);
  });
});
