import { describe, expect, test } from "bun:test";
import { redactLogTail } from "./log-redaction";
import type { LogTail } from "../state/logs";

describe("redactLogTail", () => {
  test("drops `data` and scrubs a bearer token from runtime entries, keeping benign text", () => {
    const tail: LogTail = {
      stream: "runtime",
      truncated: false,
      entries: [
        { at: "2026-06-07T00:00:00.000Z", message: "calling provider with Bearer sk-abc123secret", data: { token: "sk-abc123secret" } },
        { at: "2026-06-07T00:00:01.000Z", message: "task completed", data: { ok: true } }
      ]
    };
    const out = redactLogTail(tail);
    expect(out.entries).toHaveLength(2);
    // `data` is dropped on every entry regardless of content.
    expect(out.entries?.[0]).not.toHaveProperty("data");
    expect(out.entries?.[1]).not.toHaveProperty("data");
    // The bearer token is scrubbed from the surviving message.
    expect(out.entries?.[0]?.message).not.toContain("sk-abc123secret");
    expect(out.entries?.[0]?.message).toContain("[redacted]");
    // The timestamp is preserved; benign text survives untouched.
    expect(out.entries?.[0]?.at).toBe("2026-06-07T00:00:00.000Z");
    expect(out.entries?.[1]?.message).toBe("task completed");
  });

  test("scrubs a literal secrets-env value from raw lines", () => {
    const literal = "hunter2-literal-value";
    const tail: LogTail = {
      stream: "web",
      truncated: false,
      lines: [`server starting with key ${literal} in env`, "listening on 127.0.0.1"]
    };
    const out = redactLogTail(tail, { secretsEnvBody: `export OPENAI_API_KEY='${literal}'\nFOO=bar` });
    expect(out.lines?.[0]).not.toContain(literal);
    expect(out.lines?.[0]).toContain("[redacted]");
    // A benign line with no secret is left as-is.
    expect(out.lines?.[1]).toBe("listening on 127.0.0.1");
  });

  test("preserves the stream and truncated flag", () => {
    const tail: LogTail = { stream: "stdout", truncated: true, lines: ["plain"] };
    const out = redactLogTail(tail);
    expect(out.stream).toBe("stdout");
    expect(out.truncated).toBe(true);
    expect(out.entries).toBeUndefined();
  });
});
