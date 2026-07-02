// Orchestration tests for the tagged Google account registry.
//
// The gws subprocess boundary is stubbed via the injected `statusForDir` dep,
// so these never spawn a real `gws`. HOME is pointed at a unique mkdtemp dir so
// the registry writes land in a throwaway ~/.gini/google-accounts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAccountsWithStatus, registerAccount } from "./google-accounts";
import type { GwsSessionStatus } from "./gws-session";
import { configDirForAccount, googleAccountsRoot, readGoogleAccounts } from "../../state/google-accounts";

let scratchHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-gaccts-orch-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

function signedIn(email: string, scopes: string[] = []): GwsSessionStatus {
  const has = (needle: string) => scopes.some((s) => s.includes(needle));
  return {
    installed: true,
    clientConfigured: true,
    signedIn: true,
    services: {
      calendar: has("/auth/calendar"),
      gmail: has("/auth/gmail"),
      drive: has("/auth/drive"),
      docs: has("/auth/documents"),
      sheets: has("/auth/spreadsheets"),
      forms: has("/auth/forms"),
      meet: has("/auth/meetings")
    },
    scopes,
    email,
    message: "Signed in to Google"
  };
}

function signedOut(): GwsSessionStatus {
  return {
    installed: true,
    clientConfigured: true,
    signedIn: false,
    services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
    scopes: [],
    message: "Google sign-in needed"
  };
}

describe("registerAccount", () => {
  test("registers a signed-in dir and captures its email", async () => {
    const fetcher = async () => signedIn("me@example.com");
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    expect(account.tag).toBe("personal");
    expect(account.email).toBe("me@example.com");
    expect(account.configDir).toBe("/tmp/gws-personal");
    expect(account.id).toMatch(/^gacct_/);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("throws when the dir has no signed-in session", async () => {
    const fetcher = async () => signedOut();
    await expect(
      registerAccount({ tag: "work", configDir: "/tmp/gws-empty" }, { statusForDir: fetcher })
    ).rejects.toThrow("No signed-in Google session in /tmp/gws-empty");
    expect(readGoogleAccounts()).toEqual([]);
  });

  test("a configDir under the gini root takes its id from the dir basename", async () => {
    const configDir = configDirForAccount("gacct_abc12345");
    const account = await registerAccount(
      { tag: "personal", configDir },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.id).toBe("gacct_abc12345");
    // The dir↔id coupling holds, so removeAccount can reconstruct the dir.
    expect(configDirForAccount(account.id)).toBe(account.configDir);
    expect(account.configDir.startsWith(googleAccountsRoot())).toBe(true);
  });

  test("an adopted dir outside the root keeps a minted id", async () => {
    const account = await registerAccount(
      { tag: "default-gws", configDir: "/tmp/outside/.config/gws", adopt: true },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.id).toMatch(/^gacct_/);
    expect(account.id).not.toBe("gws");
  });

  test("re-registering the same configDir reuses the existing id", async () => {
    const fetcher = async () => signedIn("me@example.com");
    const first = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    const again = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: fetcher }
    );
    expect(again.id).toBe(first.id);
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("trusted:true registers without probing gws (gws may not be installed yet)", async () => {
    const configDir = configDirForAccount("gacct_trust01");
    // statusForDir must NOT be called on the trusted path — fail loudly if it is.
    const account = await registerAccount(
      { tag: "workspace", configDir, trusted: true },
      {
        statusForDir: async () => {
          throw new Error("statusForDir must not run on the trusted path");
        }
      }
    );
    expect(account.id).toBe("gacct_trust01");
    expect(account.tag).toBe("workspace");
    expect(account.email).toBe(""); // back-filled later by listAccountsWithStatus
    expect(account.provisioned).toBe(true); // immutable relay provenance
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("trusted:true preserves an existing account's email on re-register", async () => {
    const configDir = configDirForAccount("gacct_trust02");
    await registerAccount(
      { tag: "workspace", configDir },
      { statusForDir: async () => signedIn("known@example.com") }
    );
    // A later trusted re-register (e.g. re-provision) must not blank the email
    // that the earlier live probe captured.
    const again = await registerAccount(
      { tag: "workspace", configDir, trusted: true },
      {
        statusForDir: async () => {
          throw new Error("statusForDir must not run on the trusted path");
        }
      }
    );
    expect(again.email).toBe("known@example.com");
    expect(readGoogleAccounts()).toHaveLength(1);
  });

  test("a non-trusted register does NOT mark an account provisioned", async () => {
    const account = await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-user" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(account.provisioned).toBeUndefined();
  });

  test("the provisioned flag is sticky: a later non-trusted re-register keeps it", async () => {
    const configDir = configDirForAccount("gacct_trust03");
    const first = await registerAccount({ tag: "workspace", configDir, trusted: true });
    expect(first.provisioned).toBe(true);
    // Re-register the SAME dir on the probed path (e.g. a manual retag flow):
    // provenance must not be strippable.
    const again = await registerAccount(
      { tag: "renamed", configDir },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    expect(again.provisioned).toBe(true);
    expect(again.tag).toBe("renamed");
  });
});

describe("listAccountsWithStatus", () => {
  test("merges the registry with injected live status", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    await registerAccount(
      { tag: "work", configDir: "/tmp/gws-work" },
      { statusForDir: async () => signedIn("work@corp.com") }
    );

    const statuses: Record<string, GwsSessionStatus> = {
      "/tmp/gws-personal": signedIn("me@example.com", ["https://www.googleapis.com/auth/gmail.modify"]),
      "/tmp/gws-work": signedOut()
    };
    const list = await listAccountsWithStatus({
      statusForDir: async (dir) => statuses[dir]!
    });

    const personal = list.find((a) => a.tag === "personal");
    const work = list.find((a) => a.tag === "work");
    expect(personal?.signedIn).toBe(true);
    expect(personal?.services.gmail).toBe(true);
    expect(work?.signedIn).toBe(false);
    expect(work?.message).toBe("Google sign-in needed");
  });

  test("a rejecting status fetch degrades that account to signed-out", async () => {
    await registerAccount(
      { tag: "personal", configDir: "/tmp/gws-personal" },
      { statusForDir: async () => signedIn("me@example.com") }
    );
    const list = await listAccountsWithStatus({
      statusForDir: async () => { throw new Error("gws blew up"); }
    });
    expect(list[0]?.signedIn).toBe(false);
    expect(list[0]?.message).toBe("gws blew up");
  });

  test("empty registry → []", async () => {
    expect(await listAccountsWithStatus({ statusForDir: async () => signedOut() })).toEqual([]);
  });
});
