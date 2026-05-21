// Unit tests for the runtime-identity render + emission-decision helpers
// added alongside the tell-once-plus-delta system-prompt injection. The
// chat-task integration test covers wiring; this file pins the pure
// content/behavior contracts so regressions surface at the source.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GINI_INSTRUCTIONS,
  IDENTITY_FULL_REFRESH_INTERVAL,
  buildAgentSystemContext,
  decideIdentityEmission,
  renderFullIdentity,
  renderIdentityDelta
} from "./system-prompt";
import type { AgentIdentity, IdentitySnapshotRecord, MemoryRecord } from "./types";

function makeMemory(content: string, id = "mem_x"): MemoryRecord {
  return {
    id,
    instance: "test",
    agentId: "agent_test",
    content,
    confidence: 1,
    sensitivity: "normal",
    provenance: "test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as MemoryRecord;
}

function makeIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    instance: "gini-agent",
    runtimePort: 7351,
    agentName: "default",
    agentId: "profile_default",
    provider: "codex/gpt-5.5",
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryNamespace: "profile_default",
    ...overrides
  };
}

describe("renderFullIdentity", () => {
  test("renders every field as a bullet under a stable header", () => {
    const out = renderFullIdentity(makeIdentity());
    expect(out).toBe(
      [
        "Your runtime identity:",
        "- instance: gini-agent",
        "- runtime port: 7351",
        "- agent: default (profile_default)",
        "- provider: codex/gpt-5.5",
        "- toolsets enabled: file, terminal, memory, session_search, delegation",
        "- memory namespace: profile_default"
      ].join("\n")
    );
  });

  test("renders '(none)' when an agent has no toolsets configured", () => {
    const out = renderFullIdentity(makeIdentity({ toolsets: [] }));
    expect(out).toContain("- toolsets enabled: (none)");
  });
});

describe("renderIdentityDelta", () => {
  test("returns empty string when nothing changed", () => {
    expect(renderIdentityDelta(makeIdentity(), makeIdentity())).toBe("");
  });

  test("emits only the changed field with the prior value annotated", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ toolsets: ["file", "terminal"] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- toolsets enabled: file, terminal (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("emits multiple changed fields in field order", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ provider: "openai/gpt-5", toolsets: [] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- provider: openai/gpt-5 (was codex/gpt-5.5)",
        "- toolsets enabled: (none) (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("treats agent rename and id swap as one combined entry", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ agentName: "discord", agentId: "profile_discord" })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- agent: discord (profile_discord) (was default (profile_default))"
      ].join("\n")
    );
  });
});

describe("decideIdentityEmission", () => {
  test("emits full and seeds the snapshot when no prior snapshot exists", () => {
    const current = makeIdentity();
    const decision = decideIdentityEmission(current, undefined, 1);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("emits nothing and skips snapshot updates when nothing changed under the refresh threshold", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 2);
    expect(decision.content).toBe("");
    expect(decision.nextSnapshot).toBeUndefined();
  });

  test("emits delta and advances snapshot.identity without touching lastFullTurn", () => {
    const prior = makeIdentity();
    const current = makeIdentity({ toolsets: ["file"] });
    const snapshot: IdentitySnapshotRecord = { identity: prior, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 3);
    expect(decision.content).toContain("Runtime identity changes since last turn:");
    expect(decision.content).toContain("- toolsets enabled: file (was file, terminal, memory, session_search, delegation)");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("re-emits full at the IDENTITY_FULL_REFRESH_INTERVAL boundary and resets lastFullTurn", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const refreshTurn = 1 + IDENTITY_FULL_REFRESH_INTERVAL;
    const decision = decideIdentityEmission(current, snapshot, refreshTurn);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: refreshTurn });
  });

  test("still emits full at the refresh boundary even when nothing changed", () => {
    // The refresh path is unconditional on change: it exists to give the
    // model a periodic re-grounding and the prompt cache a clean resync,
    // not just to surface changes.
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 1 + IDENTITY_FULL_REFRESH_INTERVAL);
    expect(decision.content).toContain("Your runtime identity:");
  });
});

describe("buildAgentSystemContext", () => {
  test("uses DEFAULT_GINI_INSTRUCTIONS when no override is provided", () => {
    const out = buildAgentSystemContext([], undefined, undefined);
    expect(out).toBe(DEFAULT_GINI_INSTRUCTIONS);
  });

  test("instructionsOverride wins over the default constant", () => {
    const out = buildAgentSystemContext([], undefined, undefined, {
      instructionsOverride: "Custom rules only."
    });
    expect(out).toBe("Custom rules only.");
    expect(out).not.toContain("local-first personal agent");
  });

  test("blank instructionsOverride falls back to the default", () => {
    // Whitespace-only override should not silently empty the preamble.
    const out = buildAgentSystemContext([], undefined, undefined, {
      instructionsOverride: "   \n"
    });
    expect(out).toBe(DEFAULT_GINI_INSTRUCTIONS);
  });

  test("assembles blocks in the documented order: instructions, soul, identity, pinned, user, recalled", () => {
    const identityBlock = "Your runtime identity:\n- instance: test";
    const out = buildAgentSystemContext(
      [makeMemory("Pinned fact A", "mem_a"), makeMemory("Pinned fact B", "mem_b")],
      "1. (semantic) recalled snippet",
      identityBlock,
      {
        instructionsOverride: "RULES",
        soul: "SOUL persona body",
        userProfile: "USER profile body"
      }
    );
    const rulesIdx = out.indexOf("RULES");
    const soulIdx = out.indexOf("SOUL persona body");
    const identityIdx = out.indexOf("Your runtime identity:");
    const pinnedIdx = out.indexOf("Pinned memories about this user");
    const userIdx = out.indexOf("USER profile body");
    const recalledIdx = out.indexOf("Long-term memory");
    expect(rulesIdx).toBe(0);
    expect(rulesIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(pinnedIdx);
    expect(pinnedIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(recalledIdx);
  });

  test("elides soul and userProfile blocks when blank or absent", () => {
    const out = buildAgentSystemContext([], undefined, "ID-BLOCK", {
      instructionsOverride: "RULES",
      soul: "   ",
      userProfile: ""
    });
    expect(out).toBe(["RULES", "ID-BLOCK"].join("\n\n"));
  });

  test("preserves prior contract: memories+recalled with no override or files", () => {
    // Existing callers that don't pass the new options object must keep
    // producing the same block shape as before.
    const out = buildAgentSystemContext([makeMemory("Fact one")], "1. (semantic) snip");
    expect(out).toContain(DEFAULT_GINI_INSTRUCTIONS);
    expect(out).toContain("Pinned memories about this user");
    expect(out).toContain("Long-term memory of prior conversations");
    expect(out).not.toContain("SOUL");
    expect(out).not.toContain("USER profile");
  });
});
