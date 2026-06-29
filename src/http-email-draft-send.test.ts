// Gateway routes for the email-draft card's direct, server-side send:
//   POST /api/email/drafts/send  — sends a SAVED Gmail draft by id (no LLM turn),
//                                  records a durable sentDrafts marker + audit row.
//   GET  /api/email/drafts/sent  — reads the marker so the card renders a
//                                  persistent "Sent" across a page refresh.
//
// The gws subprocess and the Google-accounts registry are injected via the
// gmail-draft-send module's test seams (setDraftSendRunner / setAccountsProvider)
// rather than a process-wide module mock, so nothing leaks into sibling suites
// and the test never spawns a real `gws`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "./http";
import { readState } from "./state";
import { setAccountsProvider, setDraftSendRunner } from "./integrations/connectors/gmail-draft-send";
import type { RuntimeConfig } from "./types";

const ROOT = mkdtempSync(join(tmpdir(), "gini-draft-send-"));

// What the stubbed runner returns; each test sets it. The runner captures the
// args it was called with so the test can assert account→configDir resolution.
let runnerStdout = JSON.stringify({ id: "sent-msg-1", labelIds: ["SENT"] });
let runnerCalls: Array<{ draftId: string; configDir?: string }> = [];
// The registered Google accounts the resolution reads. Default: empty (no
// configDir => default gws). A test sets one to exercise account→configDir.
let registeredAccounts: { email: string; configDir: string; signedIn: boolean }[] = [];

let restoreRunner: () => void;
let restoreAccounts: () => void;

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

beforeEach(() => {
  runnerStdout = JSON.stringify({ id: "sent-msg-1", labelIds: ["SENT"] });
  runnerCalls = [];
  registeredAccounts = [];
  restoreRunner = setDraftSendRunner(async (args) => {
    runnerCalls.push(args);
    return { stdout: runnerStdout, exitCode: 0 };
  });
  restoreAccounts = setAccountsProvider(async () => registeredAccounts);
});

afterEach(() => {
  restoreRunner();
  restoreAccounts();
});

describe("email draft send routes", () => {
  test("POST /api/email/drafts/send sends, records sentDrafts + audit, returns messageId", async () => {
    const config = testConfig("draft-send-ok");
    const handler = createHandler(config);

    const result = await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "r123" })
    });
    expect(result).toEqual({ ok: true, messageId: "sent-msg-1" });

    const state = readState(config.instance);
    expect(state.sentDrafts).toContain("r123");
    const audit = state.audit.find((e) => e.action === "email.draft_sent");
    expect(audit).toBeDefined();
    expect((audit!.evidence as { draftId?: string }).draftId).toBe("r123");
    expect((audit!.evidence as { messageId?: string }).messageId).toBe("sent-msg-1");
    // No account given + no registered accounts => default gws (no configDir).
    expect(runnerCalls).toEqual([{ draftId: "r123" }]);
  });

  test("a repeat send of the same id does not duplicate the sentDrafts entry", async () => {
    const config = testConfig("draft-send-dedupe");
    const handler = createHandler(config);

    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "rdup" })
    });
    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "rdup" })
    });
    const ids = readState(config.instance).sentDrafts!.filter((id) => id === "rdup");
    expect(ids.length).toBe(1);
  });

  test("resolves the named account to its gws config dir", async () => {
    const config = testConfig("draft-send-account");
    const handler = createHandler(config);
    registeredAccounts = [
      { email: "me@work.com", configDir: "/cfg/work", signedIn: true },
      { email: "me@home.com", configDir: "/cfg/home", signedIn: true }
    ];

    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "racct", account: "me@home.com" })
    });
    expect(runnerCalls).toEqual([{ draftId: "racct", configDir: "/cfg/home" }]);
  });

  test("a failed send returns 502 ok:false and does NOT mark the draft sent", async () => {
    const config = testConfig("draft-send-fail");
    const handler = createHandler(config);
    runnerStdout = JSON.stringify({ error: { code: 400, message: "Invalid draft" } });

    const response = await rawCall(
      handler,
      config,
      "/api/email/drafts/send",
      { method: "POST", body: JSON.stringify({ draftId: "rbad" }) },
      config.token
    );
    expect(response.status).toBe(502);
    const value = await response.json();
    expect(value).toEqual({ ok: false, message: "Invalid draft" });

    const state = readState(config.instance);
    expect(state.sentDrafts ?? []).not.toContain("rbad");
    expect(state.audit.some((e) => e.action === "email.draft_sent")).toBe(false);
  });

  test("rejects a missing or malformed draftId with 400 (and never sends)", async () => {
    const config = testConfig("draft-send-bad-id");
    const handler = createHandler(config);

    for (const draftId of ["", "  ", "bad id", "drop'; rm -rf"]) {
      const response = await rawCall(
        handler,
        config,
        "/api/email/drafts/send",
        { method: "POST", body: JSON.stringify({ draftId }) },
        config.token
      );
      expect(response.status).toBe(400);
    }
    expect(runnerCalls).toEqual([]);
  });

  test("GET /api/email/drafts/sent returns the subset of ids already sent", async () => {
    const config = testConfig("draft-sent-query");
    const handler = createHandler(config);

    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "rA" })
    });
    const result = await call(handler, config, "/api/email/drafts/sent?ids=rA,rB,rC", { method: "GET" });
    expect(result).toEqual({ sent: ["rA"] });
  });

  test("GET /api/email/drafts/sent with no ids param returns every recorded id", async () => {
    const config = testConfig("draft-sent-all");
    const handler = createHandler(config);

    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "rA" })
    });
    await call(handler, config, "/api/email/drafts/send", {
      method: "POST",
      body: JSON.stringify({ draftId: "rB" })
    });

    // No `ids` param => the chat surface's eager prime: every recorded id.
    const all = await call(handler, config, "/api/email/drafts/sent", { method: "GET" });
    expect(new Set((all as { sent: string[] }).sent)).toEqual(new Set(["rA", "rB"]));

    // An empty `ids=` param is treated the same as absent (return all).
    const empty = await call(handler, config, "/api/email/drafts/sent?ids=", { method: "GET" });
    expect(new Set((empty as { sent: string[] }).sent)).toEqual(new Set(["rA", "rB"]));
  });

  test("GET /api/email/drafts/sent with no recorded sends returns an empty list", async () => {
    const config = testConfig("draft-sent-none");
    const handler = createHandler(config);
    const all = await call(handler, config, "/api/email/drafts/sent", { method: "GET" });
    expect(all).toEqual({ sent: [] });
  });
});

function testConfig(instance: string): RuntimeConfig {
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`,
    approvalMode: "strict"
  };
}

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, config.token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? value.message ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  path: string,
  init: RequestInit = {},
  token?: string
) {
  return handler(
    new Request(`http://127.0.0.1:${config.port}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {})
      }
    })
  );
}
