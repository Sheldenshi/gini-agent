// Tests for the browser_fill_secrets dispatch surface.
//
// The amber approval card that fill_secret relies on is web-only React
// UI; the messaging bridge mirrors (Telegram, Discord) only forward
// assistant_text after the task reaches a terminal status. If the tool
// were allowed to mint an approval while the conversation was
// originating from Telegram/Discord, the task would park in
// awaiting_approval and the mirror would skip with
// reply_skip_non_terminal — the messaging-surface user would see a
// typing indicator that eventually stops and never any card.
//
// The dispatch refuses the tool synchronously when the owning chat
// session has a messaging source, so the agent gets a structured error
// it can verbalize back as plain assistant text ("open the web chat to
// enter credentials"), which IS something the mirror relays.
//
// Tests below pin:
//   - Telegram-sourced session => sync error envelope, no approval row
//   - Discord-sourced session  => sync error envelope, no approval row
//   - Web-only session (no source) => pending approval as before

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dispatchToolCall } from "./tool-dispatch";
import { sanitizeUrlForAuditTarget } from "./browser-fill-secrets-types";
import { createChatSession, createTask, mutateState, readState, upsertTask } from "../state";
import { __test as browserTest } from "../tools/browser";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-browser-fill-secrets-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

async function seedTaskWithSession(
  config: RuntimeConfig,
  source?: Parameters<typeof createChatSession>[2]
): Promise<string> {
  return mutateState(config.instance, (state) => {
    const session = createChatSession(state, "test session", source);
    const task = createTask(state.instance, "test");
    task.chatSessionId = session.id;
    upsertTask(state, task);
    session.taskIds.push(task.id);
    return task.id;
  });
}

const VALID_ARGS = JSON.stringify({
  slots: [{ name: "username", locator: "@e1", label: "Username", kind: "text" }],
  reason: "Login"
});

describe("browser_fill_secrets dispatch surface guard", () => {
  test("returns sync error when chat session originates from Telegram", async () => {
    const config = makeConfig("fill-secrets-telegram");
    const taskId = await seedTaskWithSession(config, {
      kind: "telegram",
      bridgeId: "bridge_t",
      chatId: 123,
      target: "123"
    });

    const result = await dispatchToolCall(config, taskId, "browser_fill_secrets", "call_1", VALID_ARGS);

    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("only works in the web chat");
    expect(parsed.error).toContain("telegram");

    // No approval row should have been created — the guard fires before
    // mutateState/createApproval runs.
    const state = readState(config.instance);
    expect(state.approvals.length).toBe(0);
  });

  test("returns sync error when chat session originates from Discord", async () => {
    const config = makeConfig("fill-secrets-discord");
    const taskId = await seedTaskWithSession(config, {
      kind: "discord",
      bridgeId: "bridge_d",
      channelId: "999",
      target: "999"
    });

    const result = await dispatchToolCall(config, taskId, "browser_fill_secrets", "call_1", VALID_ARGS);

    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("only works in the web chat");
    expect(parsed.error).toContain("discord");

    const state = readState(config.instance);
    expect(state.approvals.length).toBe(0);
  });

  test("rejects duplicate slot names with a sync error", async () => {
    const config = makeConfig("fill-secrets-dupe");
    const taskId = await seedTaskWithSession(config, undefined);
    const dupeArgs = JSON.stringify({
      slots: [
        { name: "password", locator: "@e1", label: "Username", kind: "text" },
        { name: "password", locator: "@e2", label: "Password", kind: "password" }
      ],
      reason: "Login"
    });

    const result = await dispatchToolCall(config, taskId, "browser_fill_secrets", "call_1", dupeArgs);

    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must be unique");
    expect(parsed.error).toContain("password");

    const state = readState(config.instance);
    expect(state.approvals.length).toBe(0);
  });

  test("sanitizeUrlForAuditTarget strips query and fragment, keeps origin+pathname", () => {
    // The audit writer-boundary only drops `evidence` on
    // redacted:true (see src/state/audit.ts); `target` is kept
    // intact. Any URL with a token in the query string would
    // otherwise land verbatim in state.audit[].target, so the
    // dispatcher uses this helper to normalize URLs to
    // origin+pathname before writing them onto an approval.
    expect(sanitizeUrlForAuditTarget("https://example.com/login")).toBe("https://example.com/login");
    expect(sanitizeUrlForAuditTarget("https://example.com/oauth/callback?code=secret&state=xyz")).toBe("https://example.com/oauth/callback");
    expect(sanitizeUrlForAuditTarget("https://example.com/reset?token=top-secret-bytes#fragment")).toBe("https://example.com/reset");
    expect(sanitizeUrlForAuditTarget("https://user:pw@example.com/path?q=1")).toBe("https://example.com/path");
    expect(sanitizeUrlForAuditTarget("http://localhost:8080/admin")).toBe("http://localhost:8080/admin");
    // Non-http(s) and malformed inputs fall through to undefined so
    // the caller can use a locator-only target.
    expect(sanitizeUrlForAuditTarget("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeUrlForAuditTarget("file:///etc/passwd")).toBeUndefined();
    expect(sanitizeUrlForAuditTarget("not a url at all")).toBeUndefined();
    expect(sanitizeUrlForAuditTarget("")).toBeUndefined();
    expect(sanitizeUrlForAuditTarget(undefined)).toBeUndefined();
  });

  test("refuses dispatch when no live browser session exists", async () => {
    // The dispatcher captures peekCurrentBrowserUrl(taskId) into the
    // approval payload's approvedUrl so /connect's origin guard has
    // something to compare against. Without a session, no URL can be
    // captured, so the only safe behavior is to refuse and tell the
    // agent to navigate first.
    const config = makeConfig("fill-secrets-no-session");
    const taskId = await seedTaskWithSession(config, undefined);

    const result = await dispatchToolCall(config, taskId, "browser_fill_secrets", "call_1", VALID_ARGS);

    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("active browser session");
    expect(parsed.error).toContain("browser_navigate");

    const state = readState(config.instance);
    expect(state.approvals.length).toBe(0);
  });

  test("mints a pending approval when a browser session is bound to the task", async () => {
    const config = makeConfig("fill-secrets-with-session");
    const taskId = await seedTaskWithSession(config, undefined);
    // Inject a fake playwright session so peekCurrentBrowserUrl
    // returns a URL the dispatcher can capture into approvedUrl.
    const fakePage = {
      url: () => "https://example.com/login?next=/dashboard",
      close: () => Promise.resolve()
    };
    browserTest.installFakeSessionWithPageForTest(taskId, fakePage);

    const result = await dispatchToolCall(config, taskId, "browser_fill_secrets", "call_1", VALID_ARGS);

    expect(result.kind).toBe("pending");
    if (result.kind !== "pending") throw new Error("unreachable");
    expect(typeof result.approvalId).toBe("string");

    const state = readState(config.instance);
    const approval = state.approvals.find((a) => a.id === result.approvalId);
    expect(approval).toBeDefined();
    expect(approval?.action).toBe("browser.fill_secret");
    // approvedUrl is stripped of query string by sanitizeUrlForAuditTarget.
    expect(approval?.payload.approvedUrl).toBe("https://example.com/login");
    expect(approval?.target).toBe("https://example.com/login");
  });
});
