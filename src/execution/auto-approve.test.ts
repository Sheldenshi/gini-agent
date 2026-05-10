import { describe, expect, test } from "bun:test";
import { matchAutoApprove } from "./auto-approve";

describe("matchAutoApprove", () => {
  test("returns undefined when patterns is empty / undefined", () => {
    expect(matchAutoApprove(undefined, "memo notes")).toBeUndefined();
    expect(matchAutoApprove([], "memo notes")).toBeUndefined();
  });

  test("matches a simple prefix glob", () => {
    expect(matchAutoApprove(["memo *"], "memo notes -a -f Notes")).toBe("memo *");
    expect(matchAutoApprove(["memo *"], "memo")).toBeUndefined(); // no trailing space
    expect(matchAutoApprove(["memo *"], "remindctl ls")).toBeUndefined();
  });

  test("matches a literal command", () => {
    expect(matchAutoApprove(["ls"], "ls")).toBe("ls");
    expect(matchAutoApprove(["ls"], "ls -la")).toBeUndefined();
  });

  test("rejects prefix-injection attempts because patterns are end-anchored too", () => {
    expect(matchAutoApprove(["memo *"], "rm -rf / && memo notes")).toBeUndefined();
  });

  test("returns the first matching pattern", () => {
    expect(matchAutoApprove(["foo *", "memo *"], "memo notes")).toBe("memo *");
    expect(matchAutoApprove(["memo *", "memo notes"], "memo notes")).toBe("memo *");
  });

  test("? matches a single character", () => {
    expect(matchAutoApprove(["ls -?"], "ls -l")).toBe("ls -?");
    expect(matchAutoApprove(["ls -?"], "ls -la")).toBeUndefined();
  });

  test("escapes regex metacharacters in the literal portion", () => {
    expect(matchAutoApprove(["echo $HOME"], "echo $HOME")).toBe("echo $HOME");
    expect(matchAutoApprove(["echo $HOME"], "echo X")).toBeUndefined();
    expect(matchAutoApprove(["./foo"], "./foo")).toBe("./foo");
  });

  test("ignores empty / whitespace-only patterns", () => {
    expect(matchAutoApprove(["", "  ", "memo *"], "memo notes")).toBe("memo *");
  });
});
