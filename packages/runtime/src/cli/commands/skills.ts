import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";
import { parseSkillFile, validateParsedSkill } from "../../capabilities/skill-loader";

export async function skill(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const name = restAfter(cliArgs, sub)[0];
    const description = restAfter(cliArgs, sub).slice(1).join(" ");
    if (!name) throw new Error("Usage: gini skill add <name> [description]");
    print(await api(config, "/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, trigger: name, steps: [description || `Use ${name}`], status: "enabled" })
    }));
    return;
  }
  if (sub === "validate") {
    // Two modes:
    //   gini skill validate           — validate every loaded skill via the API
    //   gini skill validate <path>    — validate a SKILL.md file or skill dir
    //                                   without hitting the runtime
    const rest = restAfter(cliArgs, sub);
    if (rest.length === 0) {
      print(await api(config, "/api/skills/validate"));
      return;
    }
    const results: Array<{ path: string; ok: boolean; issues: string[] }> = [];
    for (const arg of rest) {
      const target = resolveSkillMd(arg);
      const parentDir = dirname(target);
      const parentDirName = basename(parentDir);
      const text = readFileSync(target, "utf8");
      const parsed = parseSkillFile(text, target);
      const issues = validateParsedSkill(parsed, { manifestPath: target, parentDirName });
      results.push({ path: target, ok: issues.length === 0, issues });
    }
    print(results);
    if (results.some((r) => !r.ok)) {
      process.exit(1);
    }
    return;
  }
  if (sub === "show" || sub === "test" || sub === "enable" || sub === "disable" || sub === "rollback") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini skill ${sub} <skill-id-or-name>`);
    print(await api(config, `/api/skills/${encodeURIComponent(id)}${sub === "show" ? "" : `/${sub}`}`, { method: sub === "show" ? "GET" : "POST" }));
    return;
  }
  if (sub === "search") {
    const query = restAfter(cliArgs, sub).join(" ").trim();
    print(await api(config, `/api/skills?q=${encodeURIComponent(query)}`));
    return;
  }
  print(await api(config, "/api/skills"));
}

// Resolve a CLI argument to a SKILL.md file: accept either a SKILL.md path
// directly or a skill directory whose immediate child is SKILL.md. The
// latter matches the common "validate this skill folder" mental model.
function resolveSkillMd(arg: string): string {
  const absolute = resolve(arg);
  if (!existsSync(absolute)) {
    throw new Error(`Path does not exist: ${arg}`);
  }
  const st = statSync(absolute);
  if (st.isDirectory()) {
    const nested = join(absolute, "SKILL.md");
    if (!existsSync(nested)) {
      throw new Error(`No SKILL.md found under ${arg}`);
    }
    return nested;
  }
  return absolute;
}
