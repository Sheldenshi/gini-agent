// Unit tests for the persistent per-provider needs-reauth state (issue #233):
// record/clear semantics, audit emission on transitions only, and the
// lock-free no-churn guarantee of clearProviderAuthFailureIfPresent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProviderAuthStatus } from "../provider";
import {
  clearProviderAuthFailure,
  clearProviderAuthFailureIfPresent,
  recordProviderAuthFailure
} from "./provider-auth";
import { mutateState, readState } from "./store";

describe("provider-auth state", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-provider-auth-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-logs`, { recursive: true, force: true });
  });

  test("record writes the per-provider record and audits the ok→needs_reauth transition once", async () => {
    const instance = "pauth-record";
    await mutateState(instance, (state) => {
      recordProviderAuthFailure(state, { provider: "codex", detail: "token expired", taskId: "task_1" });
    });
    let state = readState(instance);
    expect(state.providerAuthFailures?.codex).toMatchObject({
      provider: "codex",
      detail: "token expired",
      taskId: "task_1"
    });
    expect(typeof state.providerAuthFailures?.codex?.at).toBe("string");
    const transitions = state.audit.filter((a) => a.action === "provider.auth.needs_reauth");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ target: "codex", risk: "medium" });

    // Repeated failures refresh the record (newest detail wins) but must NOT
    // re-emit the transition audit — the provider is already flagged.
    await mutateState(instance, (state2) => {
      recordProviderAuthFailure(state2, { provider: "codex", detail: "still expired", taskId: "task_2" });
    });
    state = readState(instance);
    expect(state.providerAuthFailures?.codex).toMatchObject({ detail: "still expired", taskId: "task_2" });
    expect(state.audit.filter((a) => a.action === "provider.auth.needs_reauth")).toHaveLength(1);
  });

  test("clear removes the record and audits provider.auth.cleared; clearing an absent record is a no-op", async () => {
    const instance = "pauth-clear";
    await mutateState(instance, (state) => {
      recordProviderAuthFailure(state, { provider: "openai", detail: "Incorrect API key" });
    });
    const cleared = await mutateState(instance, (state) =>
      clearProviderAuthFailure(state, "openai", { reason: "provider call succeeded", taskId: "task_ok" })
    );
    expect(cleared).toBe(true);
    const state = readState(instance);
    expect(state.providerAuthFailures?.openai).toBeUndefined();
    const audits = state.audit.filter((a) => a.action === "provider.auth.cleared");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ target: "openai", risk: "low" });
    expect(audits[0]?.evidence).toMatchObject({ provider: "openai", reason: "provider call succeeded" });

    // Absent record: returns false and emits nothing.
    const again = await mutateState(instance, (state2) =>
      clearProviderAuthFailure(state2, "openai", { reason: "provider call succeeded" })
    );
    expect(again).toBe(false);
    expect(readState(instance).audit.filter((a) => a.action === "provider.auth.cleared")).toHaveLength(1);
  });

  test("clearProviderAuthFailureIfPresent clears an existing record and skips the write when none exists", async () => {
    const instance = "pauth-if-present";
    await mutateState(instance, (state) => {
      recordProviderAuthFailure(state, { provider: "anthropic", detail: "401 unauthorized" });
    });
    expect(
      await clearProviderAuthFailureIfPresent(instance, "anthropic", { reason: "provider call succeeded" })
    ).toBe(true);
    expect(readState(instance).providerAuthFailures?.anthropic).toBeUndefined();

    // No record: returns false WITHOUT entering mutateState — updatedAt and
    // the audit trail are byte-identical to before the call.
    const before = readState(instance);
    expect(
      await clearProviderAuthFailureIfPresent(instance, "anthropic", { reason: "provider call succeeded" })
    ).toBe(false);
    const after = readState(instance);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.audit.filter((a) => a.action === "provider.auth.cleared")).toHaveLength(
      before.audit.filter((a) => a.action === "provider.auth.cleared").length
    );
  });

  test("evidenceFrom keeps a record newer than the success's call start and clears an older one", async () => {
    const instance = "pauth-evidence";
    await mutateState(instance, (state) => {
      recordProviderAuthFailure(state, { provider: "codex", detail: "token expired" });
    });
    const recordedAt = readState(instance).providerAuthFailures!.codex!.at;

    // Evidence gathered BEFORE the failure was recorded (a long stream that
    // authenticated at start, then outlived the token): the record survives
    // and no provider.auth.cleared row is emitted.
    const before = new Date(Date.parse(recordedAt) - 1000).toISOString();
    expect(
      await clearProviderAuthFailureIfPresent(instance, "codex", {
        reason: "provider call succeeded",
        evidenceFrom: before
      })
    ).toBe(false);
    let state = readState(instance);
    expect(state.providerAuthFailures?.codex).toBeDefined();
    expect(state.audit.filter((a) => a.action === "provider.auth.cleared")).toHaveLength(0);

    // Evidence from a call that started AFTER the failure: the success
    // post-dates the record, so the clear proceeds.
    const after = new Date(Date.parse(recordedAt) + 1000).toISOString();
    expect(
      await clearProviderAuthFailureIfPresent(instance, "codex", {
        reason: "provider call succeeded",
        evidenceFrom: after
      })
    ).toBe(true);
    state = readState(instance);
    expect(state.providerAuthFailures?.codex).toBeUndefined();
    expect(state.audit.filter((a) => a.action === "provider.auth.cleared")).toHaveLength(1);
  });

  test("a millisecond tie between evidenceFrom and the record keeps the record", async () => {
    const instance = "pauth-evidence-tie";
    await mutateState(instance, (state) => {
      recordProviderAuthFailure(state, { provider: "openai", detail: "401 unauthorized" });
    });
    const recordedAt = readState(instance).providerAuthFailures!.openai!.at;
    const kept = await mutateState(instance, (state) =>
      clearProviderAuthFailure(state, "openai", {
        reason: "provider call succeeded",
        evidenceFrom: recordedAt
      })
    );
    expect(kept).toBe(false);
    expect(readState(instance).providerAuthFailures?.openai).toBeDefined();
  });
});

describe("withProviderAuthStatus", () => {
  test("marks providers with a failure record needs_reauth and everything else ok", () => {
    const items = [
      { name: "codex", configured: true },
      { name: "openai", configured: true },
      { name: "bedrock", configured: true }
    ];
    const at = new Date().toISOString();
    const enriched = withProviderAuthStatus(items, {
      codex: { provider: "codex", detail: "token expired", at },
      bedrock: { provider: "bedrock", detail: "403 forbidden", at }
    });
    const codex = enriched.find((i) => i.name === "codex");
    expect(codex?.authStatus).toBe("needs_reauth");
    // codex is OAuth/CLI — the CTA routes to the hosted docs step-through.
    expect(codex?.reauth).toMatchObject({
      detail: "token expired",
      at,
      reauthKind: "docs",
      reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
    });
    // bedrock signs with AWS credentials — kind "aws", Settings URL.
    const bedrock = enriched.find((i) => i.name === "bedrock");
    expect(bedrock?.authStatus).toBe("needs_reauth");
    expect(bedrock?.reauth).toMatchObject({ reauthKind: "aws", reauthUrl: "/settings" });
    // No record → ok with no reauth payload.
    const openai = enriched.find((i) => i.name === "openai");
    expect(openai?.authStatus).toBe("ok");
    expect(openai?.reauth).toBeUndefined();
  });

  test("an api-key provider's record routes to the Settings key form", () => {
    const enriched = withProviderAuthStatus(
      [{ name: "openai" }],
      { openai: { provider: "openai", detail: "Incorrect API key provided: sk-***", at: "2026-06-10T00:00:00.000Z" } }
    );
    expect(enriched[0]?.authStatus).toBe("needs_reauth");
    expect(enriched[0]?.reauth).toMatchObject({ reauthKind: "settings", reauthUrl: "/settings" });
  });

  test("an undefined failure map yields ok for every row", () => {
    const enriched = withProviderAuthStatus([{ name: "codex" }, { name: "echo" }], undefined);
    expect(enriched.every((i) => i.authStatus === "ok" && i.reauth === undefined)).toBe(true);
  });
});
