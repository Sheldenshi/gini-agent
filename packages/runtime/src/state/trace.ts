import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Instance, TraceRecord } from "../types";
import { ensureDir, logDir, traceDir } from "../paths";
import { id, now } from "./ids";

export function tracePath(instance: Instance, taskId: string): string {
  return join(traceDir(instance), `${taskId}.jsonl`);
}

export function appendTrace(
  instance: Instance,
  taskId: string,
  record: Omit<TraceRecord, "id" | "taskId" | "instance" | "at">
): TraceRecord {
  ensureDir(traceDir(instance));
  const trace: TraceRecord = {
    id: id("trace"),
    taskId,
    instance,
    at: now(),
    ...record
  };
  if (trace.redacted === true) trace.data = undefined;
  const path = tracePath(instance, taskId);
  const line = `${JSON.stringify(trace)}\n`;
  writeFileSync(path, line, { flag: "a" });
  return trace;
}

export function readTrace(instance: Instance, taskId: string): TraceRecord[] {
  const path = tracePath(instance, taskId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRecord);
}

export function appendLog(instance: Instance, message: string, data?: Record<string, unknown>): void {
  ensureDir(logDir(instance));
  writeFileSync(
    join(logDir(instance), "runtime.jsonl"),
    `${JSON.stringify({ at: now(), instance, message, data })}\n`,
    { flag: "a" }
  );
}
