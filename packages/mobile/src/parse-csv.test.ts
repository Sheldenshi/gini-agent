import { describe, expect, test } from "bun:test";
import { parseCsv } from "./parse-csv";

describe("parseCsv", () => {
  test("parses a normal grid", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  test("handles CRLF row breaks", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  test("drops a single trailing empty row from a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  test("drops the spurious trailing row but keeps both real rows", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  test("preserves an explicit empty final row when input has no trailing break", () => {
    expect(parseCsv('a\n""')).toEqual([["a"], [""]]);
  });

  test("handles quoted fields containing the delimiter", () => {
    expect(parseCsv('name,note\n"Doe, John","hello"')).toEqual([
      ["name", "note"],
      ["Doe, John", "hello"]
    ]);
  });

  test("handles quoted fields containing newlines", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"]
    ]);
  });

  test("handles escaped double quotes inside a quoted field", () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([["a"], ['she said "hi"']]);
  });

  test("supports a tab delimiter for TSV", () => {
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });
});
