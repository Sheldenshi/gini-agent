// Generic skill-script hook handler tests (ADR job-pre-run-hooks.md).
//
// Drives the handler against a REAL fixture skill script invoked headless
// (interpreter by extension, JSON over stdin, JSON on stdout) and asserts the
// stdout -> HookResult mapping, the state round-trip (in via the payload, out on
// the result), and the error taxonomy: missing routing keys / missing skill /
// malformed output => config error; a non-zero exit => a throw the runner
// classes transient (so a scheduled job stays alive). No real agent turn.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { createSkill, mutateState } from "../state";
import { skillScriptHandler } from "./skill-script-hook";
import type { HookContext, HookResult } from "../hooks/types";

const ROOT = mkdtempSync(join(tmpdir(), "gini-skill-script-hook-"));
const SKILL_DIR = mkdtempSync(join(tmpdir(), "gini-skill-script-fixture-"));
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  // A fixture script that echoes its stdin back in the hook-result shape: it
  // reads {state, ...declarative} and emits a context result whose state
  // increments a counter — exercising the pure state round-trip.
  writeFileSync(
    join(SCRIPTS_DIR, "echo.ts"),
    `#!/usr/bin/env bun
const chunks: Uint8Array[] = [];
for await (const c of Bun.stdin.stream()) chunks.push(c);
const args = JSON.parse(Buffer.concat(chunks).toString("utf8").trim() || "{}");
const n = (args.state && typeof args.state.n === "number") ? args.state.n : 0;
if (args.mode === "shortcircuit") {
  process.stdout.write(JSON.stringify({ kind: "shortCircuit", summary: "[SILENT]", state: { n: n + 1 } }));
} else if (args.mode === "malformed") {
  process.stdout.write(JSON.stringify({ kind: "context" })); // missing items
} else if (args.mode === "buckets") {
  process.stdout.write(JSON.stringify({
    kind: "context",
    buckets: {
      r1: [{ text: "from:alice", untrusted: true }],
      triage: [{ text: "from:bob", untrusted: true }]
    },
    state: { r1: { n: n + 1 }, triage: { n: n + 1 } }
  }));
} else if (args.mode === "fail") {
  process.stderr.write("boom");
  process.exit(3);
} else {
  process.stdout.write(JSON.stringify({
    kind: "context",
    items: [{ text: "echo:" + String(args.query), untrusted: true }],
    state: { n: n + 1 }
  }));
}
`
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
  rmSync(SKILL_DIR, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

async function seedSkill(config: RuntimeConfig): Promise<void> {
  await mutateState(config.instance, (state) => {
    createSkill(state, {
      name: "fixture-skill",
      description: "fixture",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      manifestPath: join(SKILL_DIR, "SKILL.md"),
      source: "bundled"
    });
  });
}

function fire(config: RuntimeConfig, hookConfig: Record<string, unknown>): Promise<HookResult> {
  const ctx: HookContext = { config, hookConfig };
  return skillScriptHandler(ctx);
}

describe("skill-script hook handler", () => {
  test("maps a context result and round-trips state", async () => {
    const config = buildConfig("ssh-context");
    await seedSkill(config);
    const result = await fire(config, {
      skill: "fixture-skill",
      script: "echo",
      query: "from:alice",
      state: { n: 4 }
    });
    expect(result.kind).toBe("context");
    if (result.kind === "context") {
      // The skill-script handler always returns the flat `items` carrier (never
      // routed buckets), so narrow off the now-optional field before indexing.
      expect(result.items).toHaveLength(1);
      expect(result.items![0]!.text).toBe("echo:from:alice");
      expect(result.items![0]!.untrusted).toBe(true);
      // State round-trip: in n=4 -> out n=5.
      expect(result.state).toEqual({ n: 5 });
    }
  });

  test("maps a fan-out buckets context result", async () => {
    const config = buildConfig("ssh-buckets");
    await seedSkill(config);
    const result = await fire(config, { skill: "fixture-skill", script: "echo", mode: "buckets" });
    expect(result.kind).toBe("context");
    if (result.kind === "context") {
      expect(result.items).toBeUndefined();
      expect(Object.keys(result.buckets ?? {}).sort()).toEqual(["r1", "triage"]);
      expect(result.buckets!.r1![0]!.text).toBe("from:alice");
      expect(result.buckets!.r1![0]!.untrusted).toBe(true);
      expect(result.buckets!.triage![0]!.text).toBe("from:bob");
      expect((result.state as { r1?: { n?: number } }).r1?.n).toBe(1);
    }
  });

  test("maps a shortCircuit result and carries state + summary", async () => {
    const config = buildConfig("ssh-shortcircuit");
    await seedSkill(config);
    const result = await fire(config, {
      skill: "fixture-skill",
      script: "echo",
      mode: "shortcircuit",
      state: { n: 0 }
    });
    expect(result.kind).toBe("shortCircuit");
    if (result.kind === "shortCircuit") {
      expect(result.summary).toBe("[SILENT]");
      expect(result.state).toEqual({ n: 1 });
    }
  });

  test("a missing skill key is a config error", async () => {
    const config = buildConfig("ssh-no-skill");
    await seedSkill(config);
    const result = await fire(config, { script: "echo" });
    expect(result.kind).toBe("error");
  });

  test("an unknown skill/script is a config error", async () => {
    const config = buildConfig("ssh-unknown");
    await seedSkill(config);
    const result = await fire(config, { skill: "fixture-skill", script: "nope" });
    expect(result.kind).toBe("error");
  });

  test("malformed script output is a config error (typed, not a throw)", async () => {
    const config = buildConfig("ssh-malformed");
    await seedSkill(config);
    const result = await fire(config, { skill: "fixture-skill", script: "echo", mode: "malformed" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("items");
  });

  test("a non-zero exit throws so the runner classes it transient", async () => {
    const config = buildConfig("ssh-fail");
    await seedSkill(config);
    await expect(
      fire(config, { skill: "fixture-skill", script: "echo", mode: "fail" })
    ).rejects.toThrow();
  });
});
