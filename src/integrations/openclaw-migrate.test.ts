import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMigration,
  canonicalApiKeyEnv,
  discoverOpenclawState,
  mapProviderToGini,
  parseOpenclawJson,
  parseOpenclawModelRouting,
  planMigration,
  readStateDotenv,
  rewriteSkillFrontmatter,
  summarizePlan
} from "./openclaw-migrate";
import { loadConfig } from "../paths";
import { mutateState, readState } from "../state";
import { readSecret } from "../state/secrets";

// Isolated roots so the tests never touch ~/.gini or ~/.openclaw on the
// developer's machine.
const ROOT = "/tmp/gini-openclaw-migrate-test";
const GINI_STATE = `${ROOT}/gini-state`;
const GINI_HOME = `${ROOT}/home`;
const OPENCLAW_ROOT = `${ROOT}/openclaw-state`;

// Capture pre-test env so we can restore it. Bun runs all test files in
// one process, so leaving HOME/GINI_STATE_ROOT/etc. pointing at our
// /tmp paths would poison any subsequent test (or any homedir() consumer)
// that runs after this file.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_STATE_ROOT = process.env.GINI_STATE_ROOT;
const ORIGINAL_LOG_ROOT = process.env.GINI_LOG_ROOT;
const ORIGINAL_WORKSPACE = process.env.GINI_WORKSPACE;
const ORIGINAL_OPENCLAW_HOME = process.env.OPENCLAW_HOME;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(GINI_HOME, { recursive: true });
  process.env.GINI_STATE_ROOT = GINI_STATE;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
  process.env.HOME = GINI_HOME;
  // GINI_WORKSPACE leaks the developer's real workspace path into
  // workspaceDir() if inherited; clear it so apply tests write into the
  // sandbox instance's workspace rather than the real one.
  delete process.env.GINI_WORKSPACE;
  // OPENCLAW_HOME takes precedence over HOME inside
  // discoverOpenclawState; a developer with it set in their shell
  // would see the discovery tests resolve to a different path than
  // the test author intended. Clear it before any test runs.
  delete process.env.OPENCLAW_HOME;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("GINI_STATE_ROOT", ORIGINAL_STATE_ROOT);
  restoreEnv("GINI_LOG_ROOT", ORIGINAL_LOG_ROOT);
  restoreEnv("GINI_WORKSPACE", ORIGINAL_WORKSPACE);
  restoreEnv("OPENCLAW_HOME", ORIGINAL_OPENCLAW_HOME);
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function seedOpenclawTree(stateRoot: string, options: {
  withConfig?: boolean;
  withAuthProfile?: boolean;
  withDotenv?: boolean;
  withTelegramChannel?: boolean;
  withDiscordChannel?: boolean;
  withTelegramAllowFrom?: boolean;
  withSkill?: boolean;
  withWorkspaceFiles?: boolean;
  withUnsupportedDirs?: boolean;
} = {}): void {
  rmSync(stateRoot, { recursive: true, force: true });
  mkdirSync(stateRoot, { recursive: true });

  if (options.withConfig) {
    const cfg = {
      agents: {
        // openclaw model strings carry provider+model together as
        // "<provider>/<model>" — verbatim shape from openclaw's
        // AgentModelConfig schema.
        defaults: { model: "openai/gpt-5.4-mini" },
        list: [
          { id: "main", default: true, model: "openai/gpt-5.4-mini" },
          { id: "work", model: "openai/gpt-5.4-mini" }
        ]
      },
      channels: {
        ...(options.withTelegramChannel ? { telegram: { dmPolicy: "pairing" } } : {}),
        ...(options.withDiscordChannel ? { discord: { dmPolicy: "pairing" } } : {}),
        whatsapp: { dmPolicy: "pairing" }
      },
      env: {
        vars: {
          ...(options.withTelegramChannel ? { TELEGRAM_BOT_TOKEN: "tg-token-from-config" } : {}),
          ...(options.withDiscordChannel ? { DISCORD_BOT_TOKEN: "discord-token-from-config" } : {})
        }
      }
    };
    writeFileSync(join(stateRoot, "openclaw.json"), JSON.stringify(cfg, null, 2));
  }

  if (options.withDotenv) {
    writeFileSync(
      join(stateRoot, ".env"),
      [
        `export TELEGRAM_BOT_TOKEN='tg-token-from-dotenv'`,
        `DISCORD_BOT_TOKEN="discord-token-from-dotenv"`,
        `# comment`,
        ``
      ].join("\n")
    );
  }

  if (options.withAuthProfile) {
    const dir = join(stateRoot, "agents", "main", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-default": { type: "api_key", provider: "openai", key: "sk-test-from-openclaw" },
          "anthropic-default": { type: "api_key", provider: "anthropic", key: "sk-ant-unsupported" }
        }
      })
    );
  }

  if (options.withTelegramAllowFrom) {
    mkdirSync(join(stateRoot, "credentials"), { recursive: true });
    writeFileSync(
      join(stateRoot, "credentials", "telegram-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["12345", "67890"] })
    );
  }

  if (options.withSkill) {
    const dir = join(stateRoot, "skills", "memo-helper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: memo-helper",
        "description: Helps with memos.",
        "openclaw:",
        "  version: 1.0.0",
        "  category: productivity",
        "---",
        "",
        "# Memo Helper",
        "Body content."
      ].join("\n")
    );
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "helper.sh"), "#!/bin/sh\necho hi\n");
  }

  if (options.withWorkspaceFiles) {
    // Seed inside the snapshot's stateRoot, matching openclaw's own
    // convention (<state>/workspace/). The HOME-relative fallback only
    // fires for un-pathed discovery and is exercised separately.
    const wsDir = join(stateRoot, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "AGENTS.md"), "# AGENTS\n");
    writeFileSync(join(wsDir, "SOUL.md"), "# SOUL\n");
  }

  if (options.withUnsupportedDirs) {
    mkdirSync(join(stateRoot, "memory"), { recursive: true });
    mkdirSync(join(stateRoot, "tasks"), { recursive: true });
    mkdirSync(join(stateRoot, "plugins"), { recursive: true });
    mkdirSync(join(stateRoot, "devices"), { recursive: true });
  }
}

describe("parseOpenclawJson", () => {
  test("parses strict JSON", () => {
    expect(parseOpenclawJson('{"agents":{"list":[{"id":"main"}]}}')).toEqual({
      agents: { list: [{ id: "main" }] }
    });
  });

  test("strips line and block comments", () => {
    const raw = `{
      // top comment
      "agents": {
        /* block
           comment */
        "list": [{ "id": "main" }]
      }
    }`;
    expect(parseOpenclawJson(raw)).toEqual({ agents: { list: [{ id: "main" }] } });
  });

  test("strips trailing commas", () => {
    const raw = `{ "channels": { "telegram": {}, "discord": {}, } }`;
    expect(parseOpenclawJson(raw)).toEqual({ channels: { telegram: {}, discord: {} } });
  });

  test("preserves comment-like text inside strings", () => {
    const raw = `{ "note": "this has // not a comment and /* also not */ inside" }`;
    expect(parseOpenclawJson(raw)).toEqual({
      note: "this has // not a comment and /* also not */ inside"
    });
  });

  test("does not strip commas that appear inside string literals before braces", () => {
    // The previous post-hoc regex /,(\s*[}\]])/g ran over the whole
    // input without string awareness, so a value containing `, }` or
    // `, ]` got the comma silently deleted. Verify the string-aware
    // pass preserves user data verbatim.
    const inputs = [
      { raw: `{"text": "hello, }world", "x": 1, }`, expected: { text: "hello, }world", x: 1 } },
      { raw: `{"text": "trailing, ]bracket", "items": [1, 2]}`, expected: { text: "trailing, ]bracket", items: [1, 2] } },
      { raw: `{"a": "one,    }two"   }`, expected: { a: "one,    }two" } }
    ];
    for (const { raw, expected } of inputs) {
      expect(parseOpenclawJson(raw)).toEqual(expected);
    }
  });

  test("throws on irrecoverable syntax errors", () => {
    expect(() => parseOpenclawJson("not json at all")).toThrow();
  });
});

describe("readStateDotenv", () => {
  test("parses single, double, and unquoted values with export prefix", () => {
    const dir = `${ROOT}/dotenv-parse`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".env"),
      [
        `export FOO='single'`,
        `BAR="double"`,
        `BAZ=bare`,
        `# comment line`,
        `INVALID line with no equals`
      ].join("\n")
    );
    const parsed = readStateDotenv(dir);
    expect(parsed.FOO).toBe("single");
    expect(parsed.BAR).toBe("double");
    expect(parsed.BAZ).toBe("bare");
    expect(parsed.INVALID).toBeUndefined();
  });

  test("returns empty object when .env is absent", () => {
    const dir = `${ROOT}/dotenv-missing`;
    mkdirSync(dir, { recursive: true });
    expect(readStateDotenv(dir)).toEqual({});
  });
});

describe("parseOpenclawModelRouting", () => {
  test("splits a provider/model string", () => {
    expect(parseOpenclawModelRouting("openai/gpt-5")).toEqual({
      providerName: "openai",
      model: "gpt-5"
    });
    expect(parseOpenclawModelRouting("anthropic/claude-3-5-sonnet-20240620")).toEqual({
      providerName: "anthropic",
      model: "claude-3-5-sonnet-20240620"
    });
  });

  test("reads the primary slot when given the object form", () => {
    expect(parseOpenclawModelRouting({ primary: "openai/gpt-5", fallbacks: [] })).toEqual({
      providerName: "openai",
      model: "gpt-5"
    });
  });

  test("returns model-only routing for bare model strings", () => {
    expect(parseOpenclawModelRouting("gpt-5-mini")).toEqual({
      providerName: undefined,
      model: "gpt-5-mini"
    });
  });

  test("returns empty routing when undefined", () => {
    expect(parseOpenclawModelRouting(undefined)).toEqual({
      providerName: undefined,
      model: undefined
    });
    expect(parseOpenclawModelRouting({})).toEqual({
      providerName: undefined,
      model: undefined
    });
  });
});

describe("canonicalApiKeyEnv", () => {
  test("matches the env var names normalizeProvider sets", () => {
    expect(canonicalApiKeyEnv("openai")).toBe("OPENAI_API_KEY");
    expect(canonicalApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
    // The local provider uses GINI_LOCAL_API_KEY — NOT LOCAL_API_KEY,
    // which is what a hand-rolled toUpperCase + _API_KEY would produce.
    expect(canonicalApiKeyEnv("local")).toBe("GINI_LOCAL_API_KEY");
    // Codex returns null because there is no canonical bearer env —
    // codex reads OAuth from ~/.codex/auth.json.
    expect(canonicalApiKeyEnv("codex")).toBeNull();
  });
});

describe("mapProviderToGini", () => {
  test("maps native providers", () => {
    expect(mapProviderToGini("openai")).toBe("openai");
    expect(mapProviderToGini("codex")).toBe("codex");
    expect(mapProviderToGini("openrouter")).toBe("openrouter");
    expect(mapProviderToGini("ollama")).toBe("local");
    expect(mapProviderToGini("lmstudio")).toBe("local");
    expect(mapProviderToGini("vllm")).toBe("local");
  });

  test("returns null for unsupported providers", () => {
    expect(mapProviderToGini("anthropic")).toBeNull();
    expect(mapProviderToGini("google")).toBeNull();
    expect(mapProviderToGini(undefined)).toBeNull();
  });

  test("is case-insensitive", () => {
    expect(mapProviderToGini("OpenAI")).toBe("openai");
  });
});

describe("rewriteSkillFrontmatter", () => {
  test("rewrites flow-style metadata.openclaw into loader-readable block-style metadata.gini", () => {
    // The skill loader is a hand-rolled YAML-ish parser that doesn't
    // handle JSON flow-style. The migrator must therefore convert the
    // whole flow block into block-style YAML or the migrated skill's
    // metadata silently disappears (loader falls through to defaults).
    const raw = [
      "---",
      "name: github",
      'description: "GitHub CLI."',
      "metadata:",
      "  {",
      '    "openclaw":',
      "      {",
      '        "emoji": "🐙",',
      '        "requires": { "bins": ["gh"] }',
      "      }",
      "  }",
      "---",
      "body"
    ].join("\n");
    const out = rewriteSkillFrontmatter(raw);
    // The output must be block-style under metadata.gini and the
    // original openclaw key shouldn't survive anywhere in frontmatter.
    expect(out).toMatch(/metadata:\n[ \t]+gini:\n/);
    expect(out).not.toContain('"openclaw"');
    expect(out).not.toContain("openclaw:");
    expect(out).toContain("emoji: 🐙");
    expect(out).toContain("bins: [gh]");
  });

  test("emits ambiguous string scalars as quoted YAML so they round-trip as strings", async () => {
    // Without quoting, "false"/"true"/"null" would re-parse as
    // booleans/null, numeric-looking strings would re-parse as
    // numbers, and strings containing commas inside inline arrays
    // would be split — silent data corruption on every migration.
    const raw = [
      "---",
      "name: edgey",
      "description: Pins parser edge cases.",
      "metadata:",
      "  {",
      '    "openclaw":',
      "      {",
      '        "flag": "false",',
      '        "version": "42",',
      '        "missing": "null",',
      '        "tildey": "~",',
      '        "tags": ["a,b", "ok"]',
      "      }",
      "  }",
      "---",
      "body"
    ].join("\n");
    const rewritten = rewriteSkillFrontmatter(raw);
    const { parseFrontmatter } = await import("../capabilities/skill-loader");
    const fmText = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rewritten)![1]!;
    const fm = parseFrontmatter(fmText) as {
      metadata?: { gini?: { flag?: unknown; version?: unknown; missing?: unknown; tildey?: unknown; tags?: unknown } };
    };
    // Strings must survive as strings, never coerced to scalar types.
    expect(fm.metadata?.gini?.flag).toBe("false");
    expect(fm.metadata?.gini?.version).toBe("42");
    expect(fm.metadata?.gini?.missing).toBe("null");
    expect(fm.metadata?.gini?.tildey).toBe("~");
    // Comma-bearing strings in inline arrays must not be split.
    expect(fm.metadata?.gini?.tags).toEqual(["a,b", "ok"]);
  });

  test("migrated skill metadata is round-trippable through the gini skill-loader frontmatter parser", async () => {
    // Anchor the fix end-to-end: rewrite the openclaw flow-style
    // frontmatter, then feed it through the same parseFrontmatter the
    // loader uses and assert metadata.gini comes out as a real object
    // with the expected keys.
    const raw = [
      "---",
      "name: github",
      'description: "GitHub CLI."',
      "metadata:",
      "  {",
      '    "openclaw":',
      "      {",
      '        "emoji": "🐙",',
      '        "os": ["darwin", "linux"],',
      '        "requires": { "bins": ["gh"] }',
      "      }",
      "  }",
      "---",
      "body"
    ].join("\n");
    const rewritten = rewriteSkillFrontmatter(raw);
    const { parseFrontmatter } = await import("../capabilities/skill-loader");
    const fmText = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rewritten)![1]!;
    const fm = parseFrontmatter(fmText) as {
      metadata?: { gini?: { emoji?: string; os?: unknown; requires?: { bins?: unknown } } };
    };
    expect(fm.metadata?.gini).toBeDefined();
    expect(fm.metadata?.gini?.emoji).toBe("🐙");
    expect(fm.metadata?.gini?.os).toEqual(["darwin", "linux"]);
    expect(fm.metadata?.gini?.requires?.bins).toEqual(["gh"]);
  });

  test("rewrites block-style nested metadata.openclaw → metadata.gini", () => {
    const raw = [
      "---",
      "name: foo",
      "metadata:",
      "  openclaw:",
      "    emoji: X",
      "    requires:",
      "      bins: [foo]",
      "---",
      "body"
    ].join("\n");
    const out = rewriteSkillFrontmatter(raw);
    expect(out).toContain("metadata:\n  gini:\n");
    expect(out).toContain("    emoji: X");
    expect(out).not.toMatch(/openclaw:/);
  });

  test("promotes legacy top-level openclaw: block and re-indents children", () => {
    const raw = [
      "---",
      "name: memo-helper",
      "description: Helps with memos.",
      "openclaw:",
      "  version: 1.0.0",
      "  category: productivity",
      "---",
      "body"
    ].join("\n");
    const out = rewriteSkillFrontmatter(raw);
    expect(out).toContain("metadata:\n  gini:\n");
    // Children must land four spaces in (two under gini:, two more under metadata:).
    expect(out).toContain("    version: 1.0.0");
    expect(out).toContain("    category: productivity");
    expect(out).not.toMatch(/^openclaw:/m);
  });

  test("leaves non-frontmatter openclaw mentions alone", () => {
    const raw = "---\nname: foo\n---\nThis skill references openclaw: in its body.";
    expect(rewriteSkillFrontmatter(raw)).toBe(raw);
  });

  test("is a no-op when SKILL.md has no openclaw markers", () => {
    const raw = "---\nname: foo\ndescription: bar\n---\nbody";
    expect(rewriteSkillFrontmatter(raw)).toBe(raw);
  });
});

describe("discoverOpenclawState", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot the three openclaw-side env vars before this describe
    // block clears them, then restore on teardown. Without the
    // afterEach, a developer with any of these set in their shell
    // would have them stripped permanently for the remainder of the
    // bun test invocation, affecting any later test file in the same
    // process.
    saved.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
    saved.OPENCLAW_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR;
    saved.OPENCLAW_PROFILE = process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_WORKSPACE_DIR;
    delete process.env.OPENCLAW_PROFILE;
  });

  afterEach(() => {
    restoreEnv("OPENCLAW_STATE_DIR", saved.OPENCLAW_STATE_DIR);
    restoreEnv("OPENCLAW_WORKSPACE_DIR", saved.OPENCLAW_WORKSPACE_DIR);
    restoreEnv("OPENCLAW_PROFILE", saved.OPENCLAW_PROFILE);
  });

  test("honors an explicit path argument", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    expect(discovery.stateRoot).toBe(OPENCLAW_ROOT);
    expect(discovery.configPath).toBe(join(OPENCLAW_ROOT, "openclaw.json"));
  });

  test("honors OPENCLAW_STATE_DIR env", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    process.env.OPENCLAW_STATE_DIR = OPENCLAW_ROOT;
    const discovery = discoverOpenclawState();
    expect(discovery.stateRoot).toBe(OPENCLAW_ROOT);
  });

  test("falls back to ~/.openclaw under HOME", () => {
    const homeOpenclaw = join(GINI_HOME, ".openclaw");
    seedOpenclawTree(homeOpenclaw, { withConfig: true });
    const discovery = discoverOpenclawState();
    expect(discovery.stateRoot).toBe(homeOpenclaw);
    expect(discovery.configPath).toBe(join(homeOpenclaw, "openclaw.json"));
    rmSync(homeOpenclaw, { recursive: true, force: true });
  });
});

describe("planMigration", () => {
  beforeEach(() => {
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".openclaw"), { recursive: true, force: true });
  });

  test("seeds an implicit main agent when no agents list exists", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: false });
    // Add a minimal config without an agents list.
    writeFileSync(join(OPENCLAW_ROOT, "openclaw.json"), JSON.stringify({}));
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agentSteps = plan.steps.filter((step) => step.kind === "agent");
    expect(agentSteps).toHaveLength(1);
    expect((agentSteps[0] as { name: string }).name).toBe("main");
  });

  test("emits one agent step per configured agent", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agentNames = plan.steps
      .filter((step) => step.kind === "agent")
      .map((step) => (step as { name: string }).name);
    expect(agentNames).toEqual(["main", "work"]);
  });

  test("parses provider and model out of openclaw's provider/model strings", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agents = plan.steps.filter((step) => step.kind === "agent") as Array<{
      name: string;
      providerName: string | undefined;
      model: string | undefined;
    }>;
    // Every imported agent must carry both pieces extracted from the
    // openclaw "openai/gpt-5.4-mini" string.
    for (const agent of agents) {
      expect(agent.providerName).toBe("openai");
      expect(agent.model).toBe("gpt-5.4-mini");
    }
  });

  test("rejects path-traversal agent ids before reading auth-profiles.json", () => {
    // openclaw state is user-supplied via --path; without slug
    // validation, a crafted agent.id of "../../../../etc/passwd" could
    // make the migrator readFileSync arbitrary paths under the operator's
    // HOME. Reject and surface the bad entry on the unsupported list.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [
            { id: "../../../../etc/passwd", default: true },
            { id: "evil/with/slash" },
            { id: "main" }
          ]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agentNames = plan.steps
      .filter((step) => step.kind === "agent")
      .map((step) => (step as { name: string }).name);
    expect(agentNames).toEqual(["main"]);
    const unsafeWarnings = plan.unsupported.filter(
      (entry) => entry.kind === "agent" && entry.detail.includes("unsafe id")
    );
    expect(unsafeWarnings.length).toBe(2);
  });

  test("falls back to defaults.model when an agent omits its own model", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: false });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { model: "openrouter/anthropic/claude-3-haiku" },
          list: [{ id: "main", default: true }]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agent = plan.steps.find((step) => step.kind === "agent") as {
      providerName: string | undefined;
      model: string | undefined;
    };
    // openclaw's openrouter routing carries the upstream-provider as
    // part of the model id; we keep that intact in the model field.
    expect(agent.providerName).toBe("openrouter");
    expect(agent.model).toBe("anthropic/claude-3-haiku");
  });

  test("extracts provider keys and marks unsupported providers", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withAuthProfile: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secrets = plan.steps.filter((step) => step.kind === "secret");
    expect(secrets).toHaveLength(1);
    expect((secrets[0] as { envVar: string }).envVar).toBe("OPENAI_API_KEY");
    expect(plan.unsupported.some((entry) => entry.kind === "provider:anthropic")).toBe(true);
  });

  test("uses the canonical GINI_LOCAL_API_KEY env name for the local provider", () => {
    // A hand-rolled `${PROVIDER.toUpperCase()}_API_KEY` would produce
    // LOCAL_API_KEY, which the runtime never reads. Source the env
    // name from the provider layer instead.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "lmstudio-default": {
            type: "api_key",
            provider: "lmstudio",
            key: "sk-local-fixture"
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secret = plan.steps.find((step) => step.kind === "secret") as {
      envVar: string;
      provider: string;
    };
    expect(secret.envVar).toBe("GINI_LOCAL_API_KEY");
    expect(secret.provider).toBe("local");
  });

  test("surfaces SecretRef profiles on the unsupported list", async () => {
    // Openclaw's ApiKeyCredential and TokenCredential support keyRef /
    // tokenRef indirection where the actual secret lives in an env var,
    // file, or exec command. The migrator can't dereference those (env
    // might not be set under the gini gateway, paths may be machine-
    // specific, exec may not be safe to run), so it must at least
    // surface what was skipped rather than silently continuing.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-via-env": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", id: "MY_OPENAI" }
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(plan.steps.some((step) => step.kind === "secret")).toBe(false);
    const ref = plan.unsupported.find(
      (entry) =>
        entry.kind === "provider:openai" && entry.detail.includes("SecretRef")
    );
    expect(ref).toBeDefined();
    expect(ref?.detail).toContain("MY_OPENAI");
    expect(ref?.detail).toContain("OPENAI_API_KEY");
  });

  test("skips codex secret writes and points the operator at codex --login", () => {
    // Gini's codex provider reads OAuth from ~/.codex/auth.json, the
    // same file openclaw uses. There's no bearer env to migrate, so
    // writing a CODEX_API_KEY would be unread by the runtime and would
    // also leak the openclaw access token under a misleading name.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "codex-default": {
            type: "oauth",
            provider: "codex",
            access: "sk-codex-fixture-access"
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(plan.steps.some((step) => step.kind === "secret")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) => entry.kind === "provider:codex" && entry.detail.includes("codex --login")
      )
    ).toBe(true);
  });

  test("creates telegram bridge step with allowed chat ids from config env", () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge");
    expect(telegram).toBeDefined();
    expect((telegram as { bridgeKind: string }).bridgeKind).toBe("telegram");
    expect((telegram as { allowedChatIds: number[] }).allowedChatIds).toEqual([12345, 67890]);
    expect((telegram as { tokenValue: string }).tokenValue).toBe("tg-token-from-config");
  });

  test("unions telegram allow-list from credentials file AND inline config", () => {
    // Operators using dmPolicy="allowlist" carry their allow-list inline in
    // openclaw.json (the modern surface). Configs that pre-date that move
    // still write to credentials/telegram-allowFrom.json. The migrator
    // must consult both sources or it silently drops enrollments.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const cfgPath = join(OPENCLAW_ROOT, "openclaw.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      channels: Record<string, Record<string, unknown>>;
    };
    cfg.channels.telegram = {
      ...cfg.channels.telegram,
      dmPolicy: "allowlist",
      allowFrom: ["67890", "999111", 222333]
    };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge") as {
      allowedChatIds: number[];
    };
    expect(telegram.allowedChatIds.sort((a, b) => a - b)).toEqual([
      12345, 67890, 222333, 999111
    ]);
  });

  test("discovers tokens under direct env.<KEY> as well as env.vars.<KEY>", () => {
    // Openclaw's env zod schema is { shellEnv?, vars?, catchall<string> },
    // so configs that hand-edit `env: { TELEGRAM_BOT_TOKEN: "..." }`
    // directly (without nesting under vars) are valid. Reading only
    // env.vars drops them silently.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: { telegram: { dmPolicy: "pairing" } },
        env: { TELEGRAM_BOT_TOKEN: "tg-direct-key" }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge") as {
      tokenValue: string;
    } | undefined;
    expect(telegram?.tokenValue).toBe("tg-direct-key");
  });

  test("env.vars takes precedence over direct env.<KEY> for the same name", () => {
    // When both shapes carry the same key, vars wins — that mirrors
    // the order operators expect from their existing openclaw config
    // edits, where vars is the documented nesting.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: { telegram: { dmPolicy: "pairing" } },
        env: {
          TELEGRAM_BOT_TOKEN: "tg-direct-key",
          vars: { TELEGRAM_BOT_TOKEN: "tg-from-vars" }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge") as {
      tokenValue: string;
    } | undefined;
    expect(telegram?.tokenValue).toBe("tg-from-vars");
  });

  test("falls back to state-dir .env when config.env.vars omits the token", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: false, withDotenv: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ channels: { telegram: {} } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find(
      (step) => step.kind === "bridge"
    ) as { tokenValue: string } | undefined;
    expect(telegram?.tokenValue).toBe("tg-token-from-dotenv");
  });

  test("captures unsupported channels in the report", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(plan.unsupported.some((entry) => entry.kind === "channel:whatsapp")).toBe(true);
  });

  test("captures memory/tasks/plugins as unsupported", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withUnsupportedDirs: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const kinds = plan.unsupported.map((entry) => entry.kind);
    expect(kinds).toContain("memory");
    expect(kinds).toContain("tasks");
    expect(kinds).toContain("plugins");
    expect(kinds).toContain("devices");
  });

  test("picks up skills and workspace files", () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withSkill: true,
      withWorkspaceFiles: true
    });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(plan.steps.some((step) => step.kind === "skill")).toBe(true);
    const workspaceSteps = plan.steps.filter((step) => step.kind === "workspaceFile");
    expect(workspaceSteps.map((step) => (step as { name: string }).name).sort()).toEqual([
      "AGENTS.md",
      "SOUL.md"
    ]);
  });

  test("does not fall back to HOME workspace when pathArg is explicit", () => {
    // An operator pointing --path at a snapshot or backup expects the
    // migrator to read from that directory only. A HOME-relative
    // workspace fallback would silently pull live ~/.openclaw/workspace
    // when the snapshot is missing a workspace subdir, mixing two
    // sources into one migration.
    const snapshotRoot = `${ROOT}/explicit-snapshot`;
    rmSync(snapshotRoot, { recursive: true, force: true });
    mkdirSync(snapshotRoot, { recursive: true });
    writeFileSync(join(snapshotRoot, "openclaw.json"), JSON.stringify({}));
    // Plant a workspace at HOME-relative location that the migrator
    // MUST NOT pick up given pathArg was explicit.
    const homeWorkspace = join(GINI_HOME, ".openclaw", "workspace");
    mkdirSync(homeWorkspace, { recursive: true });
    writeFileSync(join(homeWorkspace, "AGENTS.md"), "# live AGENTS\n");
    try {
      const discovery = discoverOpenclawState(snapshotRoot);
      expect(discovery.workspaceRoot).toBeNull();
    } finally {
      rmSync(homeWorkspace, { recursive: true, force: true });
    }
  });

  test("finds workspace files inside the state root when HOME doesn't match", () => {
    // Real openclaw's onboard writes workspace files to <stateRoot>/workspace/.
    // When the user migrates from a non-default state root (tarball extract,
    // sandboxed home, etc.) the migrator must still find them via the
    // pathArg-relative candidate rather than the HOME-relative one.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "workspace"), { recursive: true });
    writeFileSync(join(OPENCLAW_ROOT, "workspace", "AGENTS.md"), "# AGENTS\n");
    writeFileSync(join(OPENCLAW_ROOT, "workspace", "USER.md"), "# USER\n");
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const workspaceSteps = plan.steps.filter((step) => step.kind === "workspaceFile");
    expect(workspaceSteps.map((step) => (step as { name: string }).name).sort()).toEqual([
      "AGENTS.md",
      "USER.md"
    ]);
  });
});

describe("summarizePlan", () => {
  test("redacts plaintext secret values", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withAuthProfile: true });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const summary = summarizePlan(plan);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("sk-test-from-openclaw");
    expect(serialized).not.toContain("tg-token-from-config");
    expect(summary.counts.secrets).toBeGreaterThan(0);
  });

  test("populates counts that match the plan steps", () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withAuthProfile: true,
      withTelegramChannel: true,
      withSkill: true,
      withWorkspaceFiles: true
    });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const summary = summarizePlan(plan);
    expect(summary.counts.agents).toBe(2);
    expect(summary.counts.secrets).toBe(1);
    expect(summary.counts.bridges).toBe(1);
    expect(summary.counts.skills).toBe(1);
    expect(summary.counts.workspaceFiles).toBe(2);
  });
});

describe("applyMigration", () => {
  beforeEach(() => {
    rmSync(GINI_STATE, { recursive: true, force: true });
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".openclaw"), { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".gini"), { recursive: true, force: true });
  });

  test("creates agents, writes secrets, and configures a telegram bridge", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withAuthProfile: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("apply-end-to-end");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);

    expect(result.agentsCreated).toBe(2);
    expect(result.secretsWritten).toBe(1);
    expect(result.bridgesCreated).toBe(1);

    // Persisted state should hold the new agents and bridge.
    const state = await mutateState("apply-end-to-end", (current) => current);
    expect(state.agents.some((agent) => agent.name === "main")).toBe(true);
    expect(state.agents.some((agent) => agent.name === "work")).toBe(true);
    expect(state.messagingBridges.some((bridge) => bridge.kind === "telegram")).toBe(true);

    // Provider key should be in ~/.gini/secrets.env at mode 0600.
    const secretsEnv = readFileSync(join(GINI_HOME, ".gini", "secrets.env"), "utf8");
    expect(secretsEnv).toContain("OPENAI_API_KEY=");
    expect(secretsEnv).toContain("sk-test-from-openclaw");

    // Bridge token should decrypt back to the plaintext we passed in.
    const bridge = state.messagingBridges.find((entry) => entry.kind === "telegram")!;
    const ref = bridge.secretRefs?.[0];
    expect(ref).toBeDefined();
    expect(readSecret("apply-end-to-end", ref!)).toBe("tg-token-from-config");
    expect((bridge.metadata as { allowedChatIds: number[] }).allowedChatIds).toEqual([
      12345, 67890
    ]);

    // Import report should land in state.
    expect(result.report.mode).toBe("applied");
    expect(result.report.status).toBe("completed");

    // Audit row must announce a state-mutating apply, not a read-only
    // inspection (per ADR openclaw-migration.md and connector-secret-storage.md
    // the audit trail is the only post-hoc record of what was written).
    const importAudit = state.audit.find(
      (entry) => entry.target === result.report.id
    );
    expect(importAudit?.action).toBe("import.applied");
    expect(importAudit?.evidence?.mode).toBe("applied");
  });

  test("is idempotent — second apply skips existing agents and bridges", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withAuthProfile: true,
      withTelegramChannel: true
    });
    const config = loadConfig("idempotent-apply");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const first = await applyMigration(config, discovery, planMigration(discovery));
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.agentsCreated).toBeGreaterThan(0);
    expect(second.agentsCreated).toBe(0);
    expect(second.bridgesCreated).toBe(0);
    expect(second.warnings.some((warning) => warning.includes("Skipped existing"))).toBe(true);
  });

  test("copies a skill with sibling files and rewrites the frontmatter", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withSkill: true });
    const config = loadConfig("skill-copy");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.skillsCopied).toBe(1);

    const skillPath = join(GINI_STATE, "instances", "skill-copy", "skills", "memo-helper", "SKILL.md");
    const copied = readFileSync(skillPath, "utf8");
    expect(copied).toContain("metadata:\n  gini:");
    expect(copied).not.toContain("\nopenclaw:");

    const helperPath = join(
      GINI_STATE,
      "instances",
      "skill-copy",
      "skills",
      "memo-helper",
      "scripts",
      "helper.sh"
    );
    expect(readFileSync(helperPath, "utf8")).toContain("#!/bin/sh");
  });

  test("--force refreshes skill sibling files alongside SKILL.md", async () => {
    // --force was previously only refreshing SKILL.md; the sibling-file
    // copy unconditionally skipped existing destinations, so a
    // rotation left the operator with a new manifest pointing at
    // stale scripts from the prior import. Verify both halves refresh.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withSkill: true });
    const config = loadConfig("skill-force-refresh");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await applyMigration(config, discovery, planMigration(discovery));

    // Rewrite the sibling script in the openclaw source.
    writeFileSync(
      join(OPENCLAW_ROOT, "skills", "memo-helper", "scripts", "helper.sh"),
      "#!/bin/sh\necho refreshed\n"
    );
    const result = await applyMigration(config, discovery, planMigration(discovery), {
      force: true
    });
    expect(result.skillsCopied).toBe(1);
    const helperPath = join(
      GINI_STATE,
      "instances",
      "skill-force-refresh",
      "skills",
      "memo-helper",
      "scripts",
      "helper.sh"
    );
    expect(readFileSync(helperPath, "utf8")).toContain("refreshed");
  });

  test("--force rotates a bot token on an existing bridge", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("rotate");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await applyMigration(config, discovery, planMigration(discovery));

    // Capture the bridge before rotation so we can assert specific
    // fields actually change (not just any-write).
    const stateBefore = readState("rotate");
    const bridgeBefore = stateBefore.messagingBridges.find(
      (entry) => entry.kind === "telegram"
    )!;
    const updatedAtBefore = bridgeBefore.updatedAt;

    // Rewrite config to point at a new token AND a new allow-list so the
    // merge path has something to verify.
    const cfg = JSON.parse(readFileSync(join(OPENCLAW_ROOT, "openclaw.json"), "utf8")) as {
      env: { vars: Record<string, string> };
    };
    cfg.env.vars.TELEGRAM_BOT_TOKEN = "tg-token-rotated";
    writeFileSync(join(OPENCLAW_ROOT, "openclaw.json"), JSON.stringify(cfg));
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["99988", "77766"] })
    );

    const second = await applyMigration(config, discovery, planMigration(discovery), {
      force: true
    });
    expect(second.bridgesCreated).toBe(1);

    const state = readState("rotate");
    const bridge = state.messagingBridges.find((entry) => entry.kind === "telegram")!;
    expect(readSecret("rotate", bridge.secretRefs![0]!)).toBe("tg-token-rotated");

    // The bridge record itself must have changed — proves the second
    // mutateState block actually wrote to the persisted state graph
    // rather than mutating a stale snapshot.
    expect(bridge.updatedAt).not.toBe(updatedAtBefore);
    // Allow-list is the union of pre-rotation [12345, 67890] and
    // post-rotation [99988, 77766]; we never want a rotation to drop
    // an enrolled chat.
    const allowed = (bridge.metadata as { allowedChatIds: number[] }).allowedChatIds;
    expect(allowed.sort((a, b) => a - b)).toEqual([12345, 67890, 77766, 99988]);
  });

  test("bails with a failed report when there's no openclaw config to read", async () => {
    // Apply must NOT synthesize a phantom main agent or claim a
    // successful migration when there's nothing on disk to migrate.
    const emptyPath = `${ROOT}/no-openclaw-here`;
    rmSync(emptyPath, { recursive: true, force: true });
    mkdirSync(emptyPath, { recursive: true });
    const config = loadConfig("no-openclaw");
    const discovery = discoverOpenclawState(emptyPath);
    const plan = planMigration(discovery);
    expect(plan.steps).toEqual([]);
    expect(plan.unsupported.some((entry) => entry.kind === "openclaw-state")).toBe(true);

    const result = await applyMigration(config, discovery, plan);
    expect(result.applied).toBe(false);
    expect(result.agentsCreated).toBe(0);
    expect(result.report.status).toBe("failed");
    expect(result.report.error).toContain("No openclaw config");

    // No phantom agent must land in state.
    const state = readState("no-openclaw");
    expect(state.agents.some((agent) => agent.name === "main")).toBe(false);
  });

  test("refuses to apply while a gateway is running on the same instance", async () => {
    // The CLI's in-process mutateState lock cannot serialize writes
    // across separate OS processes. If apply mutated state.json while
    // a live gateway was reading-modifying-writing it, one of the two
    // would lose updates. Refusing up front with a clear message is
    // the only safe default.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("gateway-alive");
    // Plant a runtime.pid file pointing at our own pid so the
    // process.kill(pid, 0) check thinks a gateway is alive.
    writeFileSync(
      join(GINI_STATE, "instances", "gateway-alive", "runtime.pid"),
      String(process.pid),
      { mode: 0o644 }
    );
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    await expect(applyMigration(config, discovery, plan)).rejects.toThrow(
      /gateway is running/i
    );
    // Clear the pid file so subsequent tests aren't blocked.
    rmSync(join(GINI_STATE, "instances", "gateway-alive", "runtime.pid"), { force: true });
  });

  test("warns when an imported agent uses an unsupported provider", async () => {
    // Without a warning, an openclaw agent whose model was
    // \"anthropic/claude-3-5-sonnet\" would silently turn into a gini
    // agent with providerName: undefined and would route through the
    // instance-level provider on first run. Operators don't expect
    // that — they'd see the wrong model in audit + outputs without an
    // obvious reason.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [{ id: "main", default: true, model: "anthropic/claude-3-5-sonnet" }]
        }
      })
    );
    const config = loadConfig("unsupported-agent-provider");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.agentsCreated).toBe(1);
    expect(
      result.warnings.some((warning) =>
        warning.includes("main") &&
        warning.includes("anthropic") &&
        warning.includes("fall back")
      )
    ).toBe(true);
  });

  test("warns when a Discord bridge migrates without delivery channels", async () => {
    // The discord-poller's shouldRun gate refuses to start a loop for
    // a bridge with empty deliveryTargets. Openclaw doesn't expose a
    // channel-list equivalent we can map 1:1, so the migrator MUST
    // call attention to the gap.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withDiscordChannel: true
    });
    const config = loadConfig("discord-warn");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.bridgesCreated).toBe(1);
    const warning = result.warnings.find(
      (w) => w.includes("Discord") && w.includes("deliveryTargets")
    );
    expect(warning).toBeDefined();
    // The recovery instructions must point at the actual flow that
    // works today, not at the misleading `gini messaging add` shortcut
    // (which would create a SECOND Discord bridge alongside the
    // migrated one).
    expect(warning).toContain("messaging disable");
    expect(warning).toContain("--bot-token");
    expect(warning).toContain("state.json");
  });

  test("skips existing secrets.env entries unless --force is set", async () => {
    // ~/.gini/secrets.env is shared across instances, so silently
    // overwriting OPENAI_API_KEY with whatever openclaw stored would
    // poison the operator's running production gini. Default behavior
    // skips with a warning; --force rotates.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withAuthProfile: true });
    // Pre-populate secrets.env with a real-looking key the operator
    // would not want clobbered.
    const dotGini = join(GINI_HOME, ".gini");
    mkdirSync(dotGini, { recursive: true });
    writeFileSync(join(dotGini, "secrets.env"), `export OPENAI_API_KEY='sk-real-existing-key'\n`, {
      mode: 0o600
    });

    const config = loadConfig("preserve-secrets");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);

    const skipResult = await applyMigration(config, discovery, plan);
    expect(skipResult.secretsWritten).toBe(0);
    expect(
      skipResult.warnings.some((warning) => warning.includes("OPENAI_API_KEY"))
    ).toBe(true);
    expect(readFileSync(join(dotGini, "secrets.env"), "utf8")).toContain(
      "sk-real-existing-key"
    );

    // --force lets the operator deliberately rotate.
    const forceResult = await applyMigration(config, discovery, plan, { force: true });
    expect(forceResult.secretsWritten).toBe(1);
    expect(readFileSync(join(dotGini, "secrets.env"), "utf8")).not.toContain(
      "sk-real-existing-key"
    );
  });

  test("rejects malformed provider API keys before writing secrets.env", async () => {
    // Same defense-in-depth the messaging path applies on bot tokens.
    // A newline-laced value would survive secrets.env's single-quoted
    // shell escaping at source time, but the launchd plist installer
    // splits the file by newlines and copies each KEY=VALUE into
    // EnvironmentVariables — `sk-foo\\nexport EVIL=...` injects EVIL.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-malformed": {
            type: "api_key",
            provider: "openai",
            key: "sk-foo\nexport EVIL=injected"
          }
        }
      })
    );
    const config = loadConfig("malformed-api-key");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.secretsWritten).toBe(0);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("OPENAI_API_KEY") && warning.includes("header-safe")
      )
    ).toBe(true);
  });

  test("rejects malformed bot tokens before they reach the encrypted store", async () => {
    // A token containing a control character would otherwise be
    // persisted and leak via bridge.message after the first failed
    // fetch echoes the full Authorization header. Migration must run
    // the same header-safe gate the POST /api/messaging path uses.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: { telegram: { dmPolicy: "pairing" } },
        env: { vars: { TELEGRAM_BOT_TOKEN: "bad\ntoken-with-newline" } }
      })
    );
    const config = loadConfig("malformed-token");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    expect(result.bridgesCreated).toBe(0);
    expect(result.warnings.some((warning) =>
      warning.includes("telegram") && warning.includes("invalid characters")
    )).toBe(true);
    const state = readState("malformed-token");
    expect(state.messagingBridges.some((bridge) => bridge.kind === "telegram")).toBe(false);
  });

  test("skips telegram channel with no token and records the gap", async () => {
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: { telegram: {} }
      })
    );
    const config = loadConfig("no-token");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    expect(result.bridgesCreated).toBe(0);
    expect(result.unsupported.some((entry) => entry.kind === "telegram")).toBe(true);
  });
});
