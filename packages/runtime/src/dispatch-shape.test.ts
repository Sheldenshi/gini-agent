import { describe, expect, test } from "bun:test";
import {
  matchesShape,
  shapeCode,
  shapeFind,
  shapeList,
  shapePatch,
  shapeRead,
  shapeShell,
  shapeWeb,
  shapeWrite
} from "./dispatch-shape";

describe("shapeWrite", () => {
  test("accepts tool syntax with `::` separator", () => {
    expect(shapeWrite("file.txt :: hi")).toBe(true);
    expect(shapeWrite("docs/notes.md::content")).toBe(true);
  });
  test("rejects natural language without `::`", () => {
    expect(shapeWrite("a thorough technical plan for a todo app")).toBe(false);
    expect(shapeWrite("up the test coverage")).toBe(false);
  });
});

describe("shapePatch", () => {
  test("accepts when both `::` and `=>` are present", () => {
    expect(shapePatch("file.txt :: old => new")).toBe(true);
  });
  test("rejects missing either separator", () => {
    expect(shapePatch("file.txt :: just content")).toBe(false);
    expect(shapePatch("file.txt old => new")).toBe(false);
    expect(shapePatch("the production database")).toBe(false);
  });
});

describe("shapeRead", () => {
  test("accepts single path token", () => {
    expect(shapeRead("README.md")).toBe(true);
    expect(shapeRead("src/file.ts")).toBe(true);
  });
  test("accepts path-like prefixes even with spaces", () => {
    expect(shapeRead("./path with space")).toBe(true);
    expect(shapeRead("/abs/path")).toBe(true);
    expect(shapeRead("~/notes.md")).toBe(true);
  });
  test("rejects natural language", () => {
    expect(shapeRead("this paper carefully")).toBe(false);
    expect(shapeRead("the docs for me")).toBe(false);
  });
  test("rejects empty rest", () => {
    expect(shapeRead("")).toBe(false);
  });
});

describe("shapeList", () => {
  test("accepts empty (cwd)", () => {
    expect(shapeList("")).toBe(true);
  });
  test("accepts single token or path-like prefix", () => {
    expect(shapeList("src")).toBe(true);
    expect(shapeList("./src")).toBe(true);
  });
  test("rejects natural language", () => {
    expect(shapeList("everything you remember about me")).toBe(false);
  });
});

describe("shapeFind", () => {
  test("accepts `... in <dir>` form", () => {
    expect(shapeFind("Gini in README.md")).toBe(true);
    expect(shapeFind("Foo in src/")).toBe(true);
  });
  test("accepts glob patterns", () => {
    expect(shapeFind("*.ts")).toBe(true);
    expect(shapeFind("src/**/foo?.js")).toBe(true);
  });
  test("rejects natural language", () => {
    expect(shapeFind("me a good restaurant")).toBe(false);
    expect(shapeFind("out who wrote this")).toBe(false);
  });
});

describe("shapeWeb", () => {
  test("accepts http/https URLs", () => {
    expect(shapeWeb("https://example.com")).toBe(true);
    expect(shapeWeb("http://example.com")).toBe(true);
    expect(shapeWeb("HTTPS://EXAMPLE.COM")).toBe(true);
  });
  test("rejects natural language", () => {
    expect(shapeWeb("search for something")).toBe(false);
    expect(shapeWeb("example.com")).toBe(false);
  });
});

describe("shapeCode", () => {
  test("accepts <lang> :: <source>", () => {
    expect(shapeCode("js :: console.log(1)")).toBe(true);
    expect(shapeCode("python::print(1)")).toBe(true);
    expect(shapeCode("javascript :: 1+1")).toBe(true);
  });
  test("rejects natural language", () => {
    expect(shapeCode("review this PR")).toBe(false);
    expect(shapeCode("up the docs")).toBe(false);
  });
});

describe("shapeShell", () => {
  test("accepts command-like rests", () => {
    expect(shapeShell("ls -la")).toBe(true);
    expect(shapeShell("./script.sh")).toBe(true);
    expect(shapeShell("cat foo | wc")).toBe(true);
    expect(shapeShell("echo $HOME")).toBe(true);
    expect(shapeShell("ls *.ts")).toBe(true);
    expect(shapeShell("/usr/bin/env")).toBe(true);
  });
  test("rejects sentences", () => {
    expect(shapeShell("out the work to someone else")).toBe(false);
    expect(shapeShell("script the deployment")).toBe(false);
  });
});

describe("matchesShape", () => {
  test("positive: `write file.txt :: hi` routes to write", () => {
    expect(matchesShape("write file.txt :: hi", "write ", shapeWrite)).toBe(true);
  });
  test("negative: `Write a thorough plan` falls through", () => {
    expect(matchesShape("Write a thorough technical plan for a todo app", "write ", shapeWrite)).toBe(false);
  });
  test("positive: `read README.md` routes to read", () => {
    expect(matchesShape("read README.md", "read ", shapeRead)).toBe(true);
  });
  test("negative: `read this paper carefully` falls through", () => {
    expect(matchesShape("read this paper carefully", "read ", shapeRead)).toBe(false);
  });
  test("positive: `find Foo in src/` routes to find", () => {
    expect(matchesShape("find Foo in src/", "find ", shapeFind)).toBe(true);
  });
  test("negative: `find me a good restaurant` falls through", () => {
    expect(matchesShape("find me a good restaurant", "find ", shapeFind)).toBe(false);
  });
  test("positive: `shell ls -la` routes to shell", () => {
    expect(matchesShape("shell ls -la", "shell ", shapeShell)).toBe(true);
  });
  test("negative: `shell out the work to someone else` falls through", () => {
    expect(matchesShape("shell out the work to someone else", "shell ", shapeShell)).toBe(false);
  });
  test("positive: `list src` routes to list", () => {
    expect(matchesShape("list src", "list ", shapeList)).toBe(true);
  });
  test("negative: `list everything you remember about me` falls through", () => {
    expect(matchesShape("list everything you remember about me", "list ", shapeList)).toBe(false);
  });
  test("positive: smoke canonical `find Gini in README.md`", () => {
    expect(matchesShape("find Gini in README.md", "find ", shapeFind)).toBe(true);
  });
  test("case-insensitive prefix match", () => {
    expect(matchesShape("READ README.md", "read ", shapeRead)).toBe(true);
  });
  test("non-matching prefix returns false", () => {
    expect(matchesShape("hello world", "write ", shapeWrite)).toBe(false);
  });
});
