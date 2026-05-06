import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Lane, RuntimeConfig } from "./types";

const DEFAULT_PORT = 7337;

export function parseLane(args = Bun.argv.slice(2)): Lane {
  const flagIndex = args.indexOf("--lane");
  if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
  return process.env.GINI_LANE ?? "dev";
}

export function projectRoot(): string {
  return resolve(import.meta.dir, "..");
}

export function baseStateRoot(): string {
  return process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(homedir(), "Library", "Application Support", "Gini");
}

export function baseLogRoot(): string {
  return process.env.GINI_LOG_ROOT
    ? resolve(process.env.GINI_LOG_ROOT)
    : join(homedir(), "Library", "Logs", "Gini");
}

export function laneRoot(lane: Lane): string {
  return join(baseStateRoot(), lane);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function configPath(lane: Lane): string {
  return join(laneRoot(lane), "config.json");
}

export function statePath(lane: Lane): string {
  return join(laneRoot(lane), "state.json");
}

export function pidPath(lane: Lane): string {
  return join(laneRoot(lane), "runtime.pid");
}

export function traceDir(lane: Lane): string {
  return join(laneRoot(lane), "traces");
}

export function logDir(lane: Lane): string {
  return join(baseLogRoot(), lane);
}

export function skillsDir(lane: Lane): string {
  return join(laneRoot(lane), "skills");
}

export function defaultConfig(lane: Lane): RuntimeConfig {
  const providerName = process.env.GINI_PROVIDER === "openai" || process.env.GINI_PROVIDER === "codex"
    ? process.env.GINI_PROVIDER
    : "echo";
  return {
    lane,
    port: Number(process.env.GINI_PORT ?? DEFAULT_PORT),
    token: crypto.randomUUID(),
    provider: {
      name: providerName,
      model: process.env.GINI_MODEL ?? (providerName === "echo" ? "gini-echo-v0" : providerName === "codex" ? "gpt-5.4" : "gpt-5.4-mini"),
      apiKeyEnv: providerName === "openai" ? "OPENAI_API_KEY" : undefined
    },
    workspaceRoot: projectRoot(),
    stateRoot: laneRoot(lane),
    logRoot: logDir(lane)
  };
}

export function loadConfig(lane: Lane): RuntimeConfig {
  ensureDir(laneRoot(lane));
  ensureDir(traceDir(lane));
  ensureDir(logDir(lane));
  ensureDir(skillsDir(lane));

  const path = configPath(lane);
  if (!existsSync(path)) {
    const config = defaultConfig(lane);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeConfig;
  return {
    ...defaultConfig(lane),
    ...parsed,
    lane,
    stateRoot: laneRoot(lane),
    logRoot: logDir(lane)
  };
}
