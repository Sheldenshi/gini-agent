// Tests for the filesystem skill loader. Covers:
//   - frontmatter / body parsing
//   - bundled + user roots both walked
//   - platform filtering (skipped reason recorded)
//   - re-load preserves user-set status, bumps version on content change
//   - apple-notes / apple-reminders bundled SKILL.md files load on macOS
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
import { setSkillStatus } from "./skills";

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
    expect(initial?.status).toBe("draft");

    // User trusts the skill.
    await setSkillStatus(config, initial!.id, "trusted");

    const v2 = v1.replace("First body.", "Second body, much improved.");
    writeSkill(bundled, null, "my-skill", v2);
    result = await loadSkillsFromDisk(config);
    expect(result.added.length).toBe(0);
    expect(result.updated.length).toBe(1);

    const updated = readState(config.instance).skills.find((s) => s.name === "my-skill");
    expect(updated?.version).toBeGreaterThan(1);
    expect(updated?.body).toContain("Second body");
    // Trusted status preserved.
    expect(updated?.status).toBe("trusted");
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

  test("auto-trusts vendored apple skills on first load", async () => {
    writeSkill(
      bundled,
      "apple",
      "apple-notes",
      [
        "---",
        "name: apple-notes",
        'description: "Apple Notes."',
        `platforms: [${process.platform === "darwin" ? "macos" : "linux"}]`,
        "---",
        "",
        "Body."
      ].join("\n")
    );
    const config = buildConfig("loader-autotrust");
    await loadSkillsFromDisk(config);
    const skill = readState(config.instance).skills.find((s) => s.name === "apple-notes");
    expect(skill?.status).toBe("trusted");
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
    expect(notes?.status).toBe("trusted");
    expect(notes?.platforms).toEqual(["macos"]);
    expect(notes?.prerequisites?.commands).toEqual(["memo"]);
    const reminders = skills.find((s) => s.name === "apple-reminders");
    expect(reminders?.body).toContain("remindctl");
    expect(reminders?.status).toBe("trusted");
  });
});
