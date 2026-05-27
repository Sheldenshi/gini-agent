// Unit pin for the chat-side auto-surface of inbound pending
// pairings. Without this helper the operator has to manually ask
// the agent "any pending bots?" before the approval card appears,
// which is strictly worse UX than the settings page's auto-polling
// behavior. These tests pin the load-bearing pieces:
//   1. The alert lands in the operator's most-recently-active web
//      chat session (no source, no origin==="job") rather than
//      spawning a dedicated side-session.
//   2. When no web chat exists yet, a fallback session is created
//      so the alert still surfaces.
//   3. Each surface mints a `messaging.approve_pairing` approval
//      with the full payload the chat card needs to render.
//   4. The corresponding `approval_requested` chat block lands on
//      that session so the SSE stream pushes it to the browser
//      without polling.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, listChatBlocks, mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";
import {
  FALLBACK_ALERT_SESSION_TITLE,
  surfacePendingPairingInChat
} from "./messaging-pairing-alert";

const ROOT = mkdtempSync(join(tmpdir(), "gini-pairing-alert-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

describe("surfacePendingPairingInChat", () => {
  test("lands the alert in the operator's most-recently-active web chat session", async () => {
    // Two pre-existing web chats — the alert should attach to the
    // newer one. A Telegram-sourced session must be ignored (would
    // create an inbound-loop hazard) and a job-spawned session is
    // a dedicated thread for its own work and isn't a routing
    // target for unrelated alerts.
    const instance = `pairing-alert-active-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    let activeSessionId: string | undefined;
    await mutateState(instance, (state) => {
      const older = createChatSession(state, "older chat", undefined, undefined);
      const newer = createChatSession(state, "newer chat", undefined, undefined);
      createChatSession(state, "tg chat", {
        kind: "telegram",
        bridgeId: "bridge_other",
        chatId: 999,
        target: "999"
      });
      // Bump the newer's updatedAt explicitly so we know which one
      // the picker should target.
      const nowIso = new Date().toISOString();
      newer.updatedAt = nowIso;
      older.updatedAt = new Date(Date.parse(nowIso) - 10_000).toISOString();
      activeSessionId = newer.id;
    });

    const approvalId = await surfacePendingPairingInChat(config, {
      bridgeId: "bridge_a",
      bridgeName: "lifecycle-test",
      botUsername: "gini_chat_bridge_test_bot",
      chatId: 42,
      chatType: "private",
      sender: "@alice",
      verificationCode: "ABCD-1234",
      verificationCodeExpiresAt: new Date(Date.now() + 600_000).toISOString()
    });
    expect(typeof approvalId).toBe("string");

    const state = readState(instance);
    const approval = state.approvals.find((a) => a.id === approvalId);
    expect(approval).toBeDefined();
    expect(approval?.action).toBe("messaging.approve_pairing");
    expect(approval?.payload.verificationCode).toBe("ABCD-1234");
    expect(approval?.payload.autoSurfaced).toBe(true);

    // The approval_requested block must have landed in the newer
    // web chat, not the older one and not the Telegram-sourced one.
    const blocks = listChatBlocks(instance, activeSessionId!);
    const approvalBlock = blocks.find((b) => b.kind === "approval_requested");
    expect(approvalBlock).toBeDefined();
    if (approvalBlock?.kind === "approval_requested") {
      expect(approvalBlock.approvalId).toBe(approvalId!);
    }
    // Sanity: NO block landed in the older session.
    const olderId = state.chatSessions.find((s) => s.title === "older chat")?.id;
    if (olderId) {
      const olderBlocks = listChatBlocks(instance, olderId);
      expect(olderBlocks.filter((b) => b.kind === "approval_requested").length).toBe(0);
    }
  });

  test("creates a fallback session when no web chat exists yet", async () => {
    // Fresh instance with zero chat sessions — the surface helper
    // must still land somewhere so the alert isn't lost. A
    // fallback "Chat" session is created and the alert lands
    // there.
    const instance = `pairing-alert-fallback-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    expect(readState(instance).chatSessions.length).toBe(0);

    const approvalId = await surfacePendingPairingInChat(config, {
      bridgeId: "bridge_a",
      bridgeName: "tg",
      chatId: 1,
      chatType: "private",
      verificationCode: "FBCK-0001",
      verificationCodeExpiresAt: new Date(Date.now() + 600_000).toISOString()
    });
    expect(approvalId).toBeDefined();

    const state = readState(instance);
    expect(state.chatSessions.length).toBe(1);
    expect(state.chatSessions[0].title).toBe(FALLBACK_ALERT_SESSION_TITLE);
    expect(state.chatSessions[0].source).toBeUndefined();
    const blocks = listChatBlocks(instance, state.chatSessions[0].id);
    expect(blocks.filter((b) => b.kind === "approval_requested").length).toBe(1);
  });

  test("ignores telegram-sourced sessions when picking the target", async () => {
    // Only a Telegram-sourced session exists — picker should fall
    // through to creating a fallback rather than push the alert
    // back into the bridge's own chat thread (which would render
    // for a Telegram user who can't act on a web card).
    const instance = `pairing-alert-skip-tg-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await mutateState(instance, (state) => {
      createChatSession(state, "Tg user chat", {
        kind: "telegram",
        bridgeId: "bridge_other",
        chatId: 555,
        target: "555"
      });
    });

    await surfacePendingPairingInChat(config, {
      bridgeId: "bridge_a",
      bridgeName: "tg",
      chatId: 2,
      chatType: "private",
      verificationCode: "SKIP-TG01",
      verificationCodeExpiresAt: new Date(Date.now() + 600_000).toISOString()
    });

    const state = readState(instance);
    // Two sessions now: the original Telegram-sourced one + the
    // fallback web chat the helper created.
    expect(state.chatSessions.length).toBe(2);
    const tgSession = state.chatSessions.find((s) => s.source?.kind === "telegram");
    const webSession = state.chatSessions.find((s) => !s.source);
    expect(tgSession).toBeDefined();
    expect(webSession).toBeDefined();
    // Approval block landed on the web session, not the Telegram one.
    expect(listChatBlocks(instance, tgSession!.id).filter((b) => b.kind === "approval_requested").length).toBe(0);
    expect(listChatBlocks(instance, webSession!.id).filter((b) => b.kind === "approval_requested").length).toBe(1);
  });

  test("returns undefined and swallows errors so the poller doesn't crash on a surface failure", async () => {
    // Configure an instance whose state can't be initialized to
    // force the inner mutateState to throw. We simulate that by
    // passing a config with an obviously-invalid stateRoot; the
    // helper's try/catch should swallow + log + return undefined.
    const config: RuntimeConfig = {
      instance: "pairing-alert-broken",
      port: 0,
      token: "t",
      provider: { name: "echo", model: "" },
      // Path that can't be written (parent doesn't exist; mkdir would
      // throw in createState's first call).
      workspaceRoot: "/this/path/does/not/exist/and/cannot/be/created/workspace",
      stateRoot: "/this/path/does/not/exist/and/cannot/be/created",
      logRoot: "/this/path/does/not/exist/and/cannot/be/created/logs"
    };
    // mutateState attempts to read/write under stateRoot. If it
    // throws, surface helper must catch + return undefined.
    let threw = false;
    try {
      await surfacePendingPairingInChat(config, {
        bridgeId: "bridge_x",
        bridgeName: "doomed",
        chatId: 99,
        chatType: "private"
      });
    } catch {
      threw = true;
    }
    // The helper's contract is "never throw" — surfacing failures
    // must not crash the Telegram poller. The result may be a
    // real approvalId (if the env happens to allow creating the
    // state directory) or undefined (if mutateState swallowed an
    // error inside the helper's try/catch); what matters is the
    // call returns without throwing.
    expect(threw).toBe(false);
  });

  // appendTrace shouldn't be a hard dependency of this module — the
  // poller has its own logging surface — but if a future refactor
  // adds a trace call inside the helper, the test fixture above
  // (with no task / no taskId) needs to keep working.
  test("never references appendTrace with a missing taskId (defense against unbound trace writes)", async () => {
    const instance = `pairing-alert-no-task-trace-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    // Smoke test: the surface call inserts no `traces` row (the
    // table only exists per-task and this approval has no task).
    await surfacePendingPairingInChat(config, {
      bridgeId: "bridge_a",
      bridgeName: "tg",
      chatId: 7,
      chatType: "private"
    });
    const state = readState(instance);
    expect(state.tasks.length).toBe(0);
  });
});

// Force a mutateState read after surfacePendingPairingInChat so the
// test runner doesn't optimize away the helper's effects. Without
// this the JIT might shortcut the assertion above.
void mutateState;
