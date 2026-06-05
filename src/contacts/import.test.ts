import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { closeAllMemoryDbs } from "../state/memory-db";
import { countContacts, queryContacts } from "../state/contacts-db";
import {
  ContactImportError,
  detectColumns,
  importContactsFromCsv,
  parseConnectedOn,
  parseCsv
} from "./import";

const ROOT = "/tmp/gini-contacts-import-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});
afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

const A = "agent_a";

// A miniature LinkedIn export: 3 preamble lines, then the real header.
const LINKEDIN_CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Aisha,Khan,https://www.linkedin.com/in/aisha-khan-1,aisha@example.com,Google,Staff Engineer,05 Jun 2024
Liam,"O'Brien, Jr.",https://www.linkedin.com/in/liam-2,,Google,Product Manager,12 Jan 2023
Sofia,Rossi,https://www.linkedin.com/in/sofia-3,sofia@example.com,Stripe,Account Executive,01 Dec 2022
,,https://www.linkedin.com/in/nameless-4,,Meta,Recruiter,03 Mar 2021
Yuki,Tanaka,https://www.linkedin.com/in/yuki-5,,,,07 Aug 2020
`;

describe("parseCsv", () => {
  test("handles quoted fields with embedded commas and apostrophes", () => {
    const rows = parseCsv(`a,b,c\n1,"two, 2","th""ree"\n`);
    expect(rows[0]).toEqual(["a", "b", "c"]);
    expect(rows[1]).toEqual(["1", "two, 2", 'th"ree']);
  });
  test("tolerates CRLF and a missing trailing newline", () => {
    const rows = parseCsv("x,y\r\n1,2\r\n3,4");
    expect(rows).toEqual([["x", "y"], ["1", "2"], ["3", "4"]]);
  });
});

describe("detectColumns", () => {
  test("finds the header past LinkedIn preamble and maps fields", () => {
    const map = detectColumns(parseCsv(LINKEDIN_CSV));
    expect(map).not.toBeNull();
    expect(map!.headerIndex).toBe(3);
    expect(map!.columns.firstName).toBe(0);
    expect(map!.columns.company).toBe(4);
    expect(map!.columns.connectedAt).toBe(6);
  });
  test("returns null when no header row exists", () => {
    expect(detectColumns(parseCsv("just,some,random\n1,2,3\n"))).toBeNull();
  });
});

describe("parseConnectedOn", () => {
  test("normalizes LinkedIn date forms to ISO", () => {
    expect(parseConnectedOn("05 Jun 2024")).toBe("2024-06-05");
    expect(parseConnectedOn("Jun 5, 2024")).toBe("2024-06-05");
    expect(parseConnectedOn("2024-06-05")).toBe("2024-06-05");
  });
  test("falls back to raw on unparseable input", () => {
    expect(parseConnectedOn("sometime last year")).toBe("sometime last year");
  });
});

describe("importContactsFromCsv", () => {
  test("imports each row, skips the nameless row, parses dates", () => {
    const inst = "imp-basic";
    const report = importContactsFromCsv(inst, A, LINKEDIN_CSV);
    expect(report.total).toBe(5);
    expect(report.created).toBe(4);
    expect(report.skipped).toBe(1);
    expect(report.skippedReasons["no name"]).toBe(1);
    expect(countContacts(inst, A, { company: "Google" })).toBe(2);
    const stripe = queryContacts(inst, A, { company: "Stripe" }).contacts[0]!;
    expect(stripe.fullName).toBe("Sofia Rossi");
    expect(stripe.connectedAt).toBe("2022-12-01");
    // Quoted last name with comma survived intact.
    expect(queryContacts(inst, A, { nameContains: "O'Brien" }).contacts[0]?.fullName).toBe("Liam O'Brien, Jr.");
  });

  test("re-import is idempotent (dedup on URL); no duplicates", () => {
    const inst = "imp-idem";
    importContactsFromCsv(inst, A, LINKEDIN_CSV);
    const second = importContactsFromCsv(inst, A, LINKEDIN_CSV);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(4);
    expect(second.contactsTotal).toBe(4);
  });

  test("throws a clear error when no header is found", () => {
    expect(() => importContactsFromCsv("imp-noheader", A, "foo,bar\n1,2\n")).toThrow(ContactImportError);
  });

  test("maps alternate headers (City→location) and tolerates a missing email column", () => {
    const inst = "imp-altheaders";
    const csv = `Name,Company,Role,City\nJin Park,Figma,Design Engineer,Toronto\nMei Suzuki,Notion,Sales,Singapore\n`;
    const report = importContactsFromCsv(inst, A, csv);
    expect(report.created).toBe(2);
    expect(report.detectedColumns).toContain("location");
    expect(report.detectedColumns).toContain("title"); // "Role"
    const jin = queryContacts(inst, A, { nameContains: "Jin" }).contacts[0]!;
    expect(jin.location).toBe("Toronto");
    expect(jin.title).toBe("Design Engineer");
    expect(jin.email).toBeNull(); // no email column at all
    expect(countContacts(inst, A, { location: "singapore" })).toBe(1);
  });

  test("report includes a company breakdown and sample", () => {
    const inst = "imp-report";
    const report = importContactsFromCsv(inst, A, LINKEDIN_CSV);
    expect(report.companies.find((c) => c.company === "Google")?.count).toBe(2);
    expect(report.sample.length).toBeGreaterThan(0);
    expect(report.detectedColumns).toContain("company");
  });
});
