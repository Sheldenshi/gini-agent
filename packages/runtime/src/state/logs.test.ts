import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLogStream, readLogTail } from "./logs";

// Pin a dedicated log root so logDir(instance) resolves to <root>/<instance>
// and the tests never touch a real ~/.gini tree.
const ROOT = "/tmp/gini-logs-reader-tests";
const PRIOR_LOG_ROOT = process.env.GINI_LOG_ROOT;

function logFile(instance: string, filename: string, body: string): void {
  const dir = join(ROOT, instance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
}

beforeEach(() => {
  process.env.GINI_LOG_ROOT = ROOT;
  rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (PRIOR_LOG_ROOT === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = PRIOR_LOG_ROOT;
});

describe("readLogTail", () => {
  test("parses runtime.jsonl into structured entries", () => {
    logFile(
      "parse",
      "runtime.jsonl",
      `${JSON.stringify({ at: "2026-06-07T00:00:00.000Z", instance: "parse", message: "boot", data: { ok: true } })}\n` +
        `${JSON.stringify({ at: "2026-06-07T00:00:01.000Z", instance: "parse", message: "ready" })}\n`
    );
    const tail = readLogTail("parse", "runtime", 500);
    expect(tail.stream).toBe("runtime");
    expect(tail.truncated).toBe(false);
    expect(tail.entries).toHaveLength(2);
    expect(tail.entries?.[0]?.message).toBe("boot");
    expect(tail.entries?.[0]?.data).toEqual({ ok: true });
    expect(tail.lines).toBeUndefined();
  });

  test("skips an unparseable runtime line without throwing", () => {
    logFile(
      "bad-line",
      "runtime.jsonl",
      `${JSON.stringify({ message: "good-1" })}\n` +
        `{not valid json\n` +
        `${JSON.stringify({ message: "good-2" })}\n`
    );
    const tail = readLogTail("bad-line", "runtime", 500);
    expect(tail.entries?.map((e) => e.message)).toEqual(["good-1", "good-2"]);
  });

  test("returns raw lines for stdout and web streams", () => {
    logFile("raw", "runtime-stdout.log", "line A\nline B\n");
    logFile("raw", "web.log", "web 1\nweb 2\n");
    const stdout = readLogTail("raw", "stdout", 500);
    expect(stdout.lines).toEqual(["line A", "line B"]);
    expect(stdout.entries).toBeUndefined();
    const web = readLogTail("raw", "web", 500);
    expect(web.lines).toEqual(["web 1", "web 2"]);
  });

  test("missing file yields an empty tail", () => {
    const runtime = readLogTail("absent", "runtime", 500);
    expect(runtime.entries).toEqual([]);
    expect(runtime.truncated).toBe(false);
    const web = readLogTail("absent", "web", 500);
    expect(web.lines).toEqual([]);
  });

  test("honors limit and flags truncation, keeping the most recent lines", () => {
    const body = Array.from({ length: 10 }, (_, i) => JSON.stringify({ message: `m${i}` })).join("\n") + "\n";
    logFile("limit", "runtime.jsonl", body);
    const tail = readLogTail("limit", "runtime", 3);
    expect(tail.truncated).toBe(true);
    expect(tail.entries?.map((e) => e.message)).toEqual(["m7", "m8", "m9"]);

    logFile("limit", "runtime-stdout.log", "a\nb\nc\nd\n");
    const raw = readLogTail("limit", "stdout", 2);
    expect(raw.truncated).toBe(true);
    expect(raw.lines).toEqual(["c", "d"]);
  });

  test("does not flag truncation when the file fits within the limit", () => {
    logFile("fits", "runtime.jsonl", `${JSON.stringify({ message: "only" })}\n`);
    const tail = readLogTail("fits", "runtime", 500);
    expect(tail.truncated).toBe(false);
    expect(tail.entries).toHaveLength(1);
  });
});

describe("isLogStream", () => {
  test("accepts the three known streams and rejects anything else", () => {
    expect(isLogStream("runtime")).toBe(true);
    expect(isLogStream("stdout")).toBe(true);
    expect(isLogStream("web")).toBe(true);
    expect(isLogStream("audit")).toBe(false);
    expect(isLogStream("")).toBe(false);
  });
});
