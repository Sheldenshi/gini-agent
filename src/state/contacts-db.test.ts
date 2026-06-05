import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { closeAllMemoryDbs } from "./memory-db";
import {
  companyBreakdown,
  countContacts,
  deleteContact,
  findContactsByName,
  getContact,
  insertContact,
  mutualConnections,
  queryContacts,
  relationsFor,
  updateContact,
  upsertContactByKey,
  upsertRelation
} from "./contacts-db";

const ROOT = "/tmp/gini-contacts-db-test";

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

describe("contacts-db", () => {
  test("insert + exhaustive query returns ALL matches (no top-K)", () => {
    const inst = "ct-query";
    // 30 contacts, 12 at Google — recall would cap/rank these; the store must not.
    for (let i = 0; i < 12; i++) {
      insertContact(inst, A, { fullName: `G Person ${i}`, company: "Google", title: "Engineer", source: "linkedin_import" });
    }
    for (let i = 0; i < 18; i++) {
      insertContact(inst, A, { fullName: `O Person ${i}`, company: "OtherCo", source: "linkedin_import" });
    }
    const all = queryContacts(inst, A, { company: "google" }); // case-insensitive
    expect(all.total).toBe(12);
    expect(all.contacts.length).toBe(12);
    expect(all.hasMore).toBe(false);
    expect(countContacts(inst, A, { company: "Google" })).toBe(12);
    expect(countContacts(inst, A, {})).toBe(30);
  });

  test("per-agent isolation", () => {
    const inst = "ct-iso";
    insertContact(inst, "agent_x", { fullName: "X One", company: "Acme" });
    insertContact(inst, "agent_y", { fullName: "Y One", company: "Acme" });
    expect(countContacts(inst, "agent_x", {})).toBe(1);
    expect(countContacts(inst, "agent_y", {})).toBe(1);
    expect(queryContacts(inst, "agent_x", { company: "Acme" }).contacts[0]?.fullName).toBe("X One");
  });

  test("upsert dedups on linkedin_url then email, preserving non-empty fields", () => {
    const inst = "ct-upsert";
    const first = upsertContactByKey(inst, A, {
      fullName: "Sara Lindqvist",
      company: "Airbnb",
      linkedinUrl: "https://linkedin.com/in/sara-l-1",
      email: "sara@example.com"
    });
    expect(first.created).toBe(true);
    // Re-import same URL with a blank company must NOT wipe the company.
    const again = upsertContactByKey(inst, A, {
      fullName: "Sara Lindqvist",
      company: "",
      linkedinUrl: "https://linkedin.com/in/sara-l-1"
    });
    expect(again.created).toBe(false);
    expect(again.contact.id).toBe(first.contact.id);
    expect(again.contact.company).toBe("Airbnb");
    // A new title flows in.
    const enriched = upsertContactByKey(inst, A, {
      fullName: "Sara Lindqvist",
      title: "Data Scientist",
      linkedinUrl: "https://linkedin.com/in/sara-l-1"
    });
    expect(enriched.contact.title).toBe("Data Scientist");
    expect(countContacts(inst, A, {})).toBe(1);
    // URL match wins; with no URL, email dedups.
    const byEmail = upsertContactByKey(inst, A, { fullName: "Sara L", email: "sara@example.com" });
    expect(byEmail.created).toBe(false);
    expect(byEmail.contact.id).toBe(first.contact.id);
  });

  test("updateContact merges only provided fields; blanks clear", () => {
    const inst = "ct-update";
    const c = insertContact(inst, A, { fullName: "Kai Berg", company: "Stripe", title: "AE", location: "NYC" });
    const u1 = updateContact(inst, A, c.id, { company: "Notion" });
    expect(u1.company).toBe("Notion");
    expect(u1.title).toBe("AE"); // untouched
    expect(u1.location).toBe("NYC");
    const u2 = updateContact(inst, A, c.id, { title: "" }); // clear
    expect(u2.title).toBeNull();
    expect(u2.company).toBe("Notion");
  });

  test("substring + multi-attribute queries (case-insensitive)", () => {
    const inst = "ct-filter";
    insertContact(inst, A, { fullName: "Ana Costa", company: "Google", title: "Product Manager", location: "London" });
    insertContact(inst, A, { fullName: "Ben Cohen", company: "Google", title: "Software Engineer", location: "Berlin" });
    insertContact(inst, A, { fullName: "Cleo Park", company: "Meta", title: "Product Manager", location: "London" });
    expect(countContacts(inst, A, { company: "Google", title: "Product" })).toBe(1);
    expect(countContacts(inst, A, { title: "Product Manager" })).toBe(2);
    expect(countContacts(inst, A, { location: "London" })).toBe(2);
    expect(countContacts(inst, A, { q: "cohen" })).toBe(1);
    expect(countContacts(inst, A, { nameContains: "an" })).toBe(1); // "Ana"
    // COLLATE NOCASE: lower-case filters match mixed-case data.
    expect(countContacts(inst, A, { company: "google" })).toBe(2);
    expect(countContacts(inst, A, { title: "product manager" })).toBe(2);
    expect(countContacts(inst, A, { location: "london" })).toBe(2);
  });

  test("LIKE wildcards in input are matched literally", () => {
    const inst = "ct-like";
    insertContact(inst, A, { fullName: "Percent Co Person", company: "50%_Off Inc" });
    insertContact(inst, A, { fullName: "Other", company: "Google" });
    expect(countContacts(inst, A, { companyContains: "50%_Off" })).toBe(1);
    expect(countContacts(inst, A, { companyContains: "%" })).toBe(1); // literal %, not "match all"
  });

  test("hasCompany filter splits blank vs set", () => {
    const inst = "ct-hascompany";
    insertContact(inst, A, { fullName: "Has Co", company: "Figma" });
    insertContact(inst, A, { fullName: "No Co", company: "" });
    insertContact(inst, A, { fullName: "Also No Co" });
    expect(countContacts(inst, A, { hasCompany: true })).toBe(1);
    expect(countContacts(inst, A, { hasCompany: false })).toBe(2);
  });

  test("companyBreakdown groups + counts", () => {
    const inst = "ct-breakdown";
    for (let i = 0; i < 3; i++) insertContact(inst, A, { fullName: `g${i}`, company: "Google" });
    for (let i = 0; i < 2; i++) insertContact(inst, A, { fullName: `s${i}`, company: "Stripe" });
    insertContact(inst, A, { fullName: "blank" }); // excluded
    const bd = companyBreakdown(inst, A);
    expect(bd[0]).toEqual({ company: "Google", count: 3 });
    expect(bd.find((r) => r.company === "Stripe")?.count).toBe(2);
    expect(bd.some((r) => r.company === "")).toBe(false);
  });

  test("pagination via offset returns the full set across pages", () => {
    const inst = "ct-page";
    for (let i = 0; i < 25; i++) insertContact(inst, A, { fullName: `P ${String(i).padStart(2, "0")}`, company: "BigCo" });
    const page1 = queryContacts(inst, A, { company: "BigCo", limit: 10, offset: 0 });
    expect(page1.contacts.length).toBe(10);
    expect(page1.total).toBe(25);
    expect(page1.hasMore).toBe(true);
    const page3 = queryContacts(inst, A, { company: "BigCo", limit: 10, offset: 20 });
    expect(page3.contacts.length).toBe(5);
    expect(page3.hasMore).toBe(false);
  });

  test("relationships + mutual connections (the graph query)", () => {
    const inst = "ct-rel";
    const me = insertContact(inst, A, { fullName: "Alice" });
    const bob = insertContact(inst, A, { fullName: "Bob" });
    const carol = insertContact(inst, A, { fullName: "Carol" });
    const dave = insertContact(inst, A, { fullName: "Dave" });
    // Alice—Carol, Bob—Carol (Carol is mutual), Alice—Dave only.
    upsertRelation(inst, A, me.id, carol.id, "colleague");
    upsertRelation(inst, A, bob.id, carol.id, "colleague");
    upsertRelation(inst, A, me.id, dave.id, "knows");
    expect(relationsFor(inst, A, carol.id).length).toBe(2);
    const mutual = mutualConnections(inst, A, me.id, bob.id);
    expect(mutual.map((c) => c.fullName)).toEqual(["Carol"]);
    // Upsert is idempotent on (from,to,type).
    upsertRelation(inst, A, me.id, carol.id, "colleague", "worked together at Google");
    expect(relationsFor(inst, A, me.id).length).toBe(2); // carol + dave, not 3
  });

  test("relations are isolated per agent", () => {
    const inst = "ct-rel-iso";
    // Same names + same relation type under two agents must not cross.
    const x1 = insertContact(inst, "agent_x", { fullName: "Alice" });
    const x2 = insertContact(inst, "agent_x", { fullName: "Bob" });
    const y1 = insertContact(inst, "agent_y", { fullName: "Alice" });
    const y2 = insertContact(inst, "agent_y", { fullName: "Bob" });
    const yMid = insertContact(inst, "agent_y", { fullName: "Mid" });
    upsertRelation(inst, "agent_x", x1.id, x2.id, "knows");
    upsertRelation(inst, "agent_y", y1.id, yMid.id, "knows");
    upsertRelation(inst, "agent_y", y2.id, yMid.id, "knows");
    // agent_x sees only its own edge; agent_y sees only its two.
    expect(relationsFor(inst, "agent_x", x1.id).length).toBe(1);
    expect(relationsFor(inst, "agent_y", x1.id).length).toBe(0); // x1 isn't agent_y's
    expect(mutualConnections(inst, "agent_x", x1.id, x2.id).length).toBe(0);
    expect(mutualConnections(inst, "agent_y", y1.id, y2.id).map((c) => c.fullName)).toEqual(["Mid"]);
  });

  test("deleting a contact cascades its relations", () => {
    const inst = "ct-cascade";
    const a = insertContact(inst, A, { fullName: "A" });
    const b = insertContact(inst, A, { fullName: "B" });
    upsertRelation(inst, A, a.id, b.id, "knows");
    expect(relationsFor(inst, A, a.id).length).toBe(1);
    expect(deleteContact(inst, A, a.id)).toBe(true);
    expect(getContact(inst, A, a.id)).toBeNull();
    expect(relationsFor(inst, A, b.id).length).toBe(0); // cascaded
  });

  test("findContactsByName is case-insensitive", () => {
    const inst = "ct-name";
    insertContact(inst, A, { fullName: "Yuki Tanaka", company: "OpenAI" });
    expect(findContactsByName(inst, A, "yuki tanaka").length).toBe(1);
    expect(findContactsByName(inst, A, "YUKI TANAKA")[0]?.company).toBe("OpenAI");
  });
});
