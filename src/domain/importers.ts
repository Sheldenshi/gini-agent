import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportSource, RuntimeConfig } from "../types";
import { createImportReport, mutateState } from "../state";

export async function inspectImportSource(config: RuntimeConfig, source: ImportSource, path: string) {
  const report = inspectPath(source, path);
  return mutateState(config.instance, (state) => createImportReport(state, report));
}

function inspectPath(source: ImportSource, path: string) {
  if (!existsSync(path)) {
    return {
      source,
      path,
      mode: "inspect" as const,
      status: "failed" as const,
      counts: {},
      findings: [],
      error: `Path does not exist: ${path}`
    };
  }

  const files = walk(path, 500);
  const counts = {
    files: files.length,
    json: files.filter((file) => file.endsWith(".json")).length,
    markdown: files.filter((file) => file.endsWith(".md") || file.endsWith(".mdx")).length,
    skills: files.filter((file) => file.toLowerCase().includes("skill")).length,
    memory: files.filter((file) => file.toLowerCase().includes("memor")).length,
    jobs: files.filter((file) => file.toLowerCase().includes("cron") || file.toLowerCase().includes("job")).length,
    config: files.filter((file) => file.toLowerCase().includes("config") || file.toLowerCase().includes("profile")).length
  };
  return {
    source,
    path,
    mode: "inspect" as const,
    status: "completed" as const,
    counts,
    findings: findingsFor(source, counts)
  };
}

function walk(root: string, limit: number): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift()!;
    const stat = statSync(current);
    if (stat.isFile()) {
      out.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const child of readdirSync(current)) {
      if (child === "node_modules" || child === ".git") continue;
      queue.push(join(current, child));
    }
  }
  return out;
}

function findingsFor(source: ImportSource, counts: Record<string, number>): string[] {
  const findings = [`Inspected ${source} source without mutating it.`];
  if (counts.skills > 0) findings.push("Potential skills/procedures found.");
  if (counts.memory > 0) findings.push("Potential memory files found.");
  if (counts.jobs > 0) findings.push("Potential scheduled job files found.");
  if (counts.config > 0) findings.push("Potential config/profile files found.");
  return findings;
}
