import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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
import { getMemoryDb } from "../state/memory-db";
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
// that runs after this file. Every OPENCLAW_* var the migrator reads
// is included so tests can't inherit them from the developer's shell
// (or leak them between describe blocks within the same file).
const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_ENV = [
  "HOME",
  "GINI_STATE_ROOT",
  "GINI_LOG_ROOT",
  "GINI_WORKSPACE",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_PROFILE",
  "OPENCLAW_CONFIG_PATH"
] as const;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(GINI_HOME, { recursive: true });
  for (const name of TRACKED_ENV) SAVED_ENV[name] = process.env[name];
  process.env.GINI_STATE_ROOT = GINI_STATE;
  process.env.GINI_LOG_ROOT = `${ROOT}/logs`;
  process.env.HOME = GINI_HOME;
  // Clear every OPENCLAW_* override and GINI_WORKSPACE so individual
  // tests can opt in to specific shapes without inheriting from the
  // developer's shell or from a prior test.
  delete process.env.GINI_WORKSPACE;
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_WORKSPACE_DIR;
  delete process.env.OPENCLAW_PROFILE;
  delete process.env.OPENCLAW_CONFIG_PATH;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const name of TRACKED_ENV) restoreEnv(name, SAVED_ENV[name]);
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

// Write a synthetic openclaw session JSONL under
// `<stateRoot>/agents/<agentId>/sessions/<sessionId>.jsonl`. Each
// supplied message becomes a `type: "message"` line whose content
// holds one text block plus `toolBlocks` extra tool_use blocks —
// the migrator must drop tool blocks from the migrated chat content
// because gini's ChatMessageRecord.content is a flat string.
function writeOpenclawSessionJsonl(
  stateRoot: string,
  agentId: string,
  sessionId: string,
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    timestamp: string;
    toolBlocks?: number;
  }>
): string {
  const dir = join(stateRoot, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const headerTimestamp = messages[0]?.timestamp ?? "2026-03-04T22:20:00.000Z";
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: headerTimestamp,
      cwd: "/synthetic/openclaw/workspace"
    })
  ];
  let parentId = "header";
  let counter = 0;
  for (const message of messages) {
    counter += 1;
    const messageId = `msg_${counter.toString(16).padStart(8, "0")}`;
    const content: Array<Record<string, unknown>> = [{ type: "text", text: message.text }];
    for (let i = 0; i < (message.toolBlocks ?? 0); i += 1) {
      content.push({
        type: "tool_use",
        id: `tool_${counter}_${i}`,
        name: "synthetic_tool",
        input: { stub: true }
      });
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id: messageId,
        parentId,
        timestamp: message.timestamp,
        message: { role: message.role, content, timestamp: Date.parse(message.timestamp) }
      })
    );
    parentId = messageId;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// Write a minimal Hindsight-shape SQLite under `<memoryDir>/<filename>`.
// We mirror openclaw's column set (memory_banks + memory_units) closely
// enough that scanMemorySqlite recognizes the schema and extracts each
// row. Extra columns gini doesn't read are omitted on purpose — the
// migration only reads id/text/network/status/confidence/metadata/
// mentioned_at.
function writeHindsightMemorySqlite(
  memoryDir: string,
  filename: string,
  units: Array<{
    id: string;
    text: string;
    network: string;
    status?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
    mentionedAt?: string;
  }>
): string {
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, filename);
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE memory_banks (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
      CREATE TABLE memory_units (
        id TEXT PRIMARY KEY,
        bank_id TEXT,
        text TEXT,
        network TEXT,
        status TEXT,
        confidence REAL,
        metadata TEXT,
        mentioned_at TEXT
      );
    `);
    db.run(
      "INSERT INTO memory_banks (id, name, created_at) VALUES (?, ?, ?)",
      ["bank_default", "default", "2026-01-01T00:00:00.000Z"]
    );
    for (const unit of units) {
      db.run(
        `INSERT INTO memory_units (id, bank_id, text, network, status, confidence, metadata, mentioned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          unit.id,
          "bank_default",
          unit.text,
          unit.network,
          unit.status ?? "active",
          unit.confidence ?? 0.5,
          JSON.stringify(unit.metadata ?? {}),
          unit.mentionedAt ?? "2026-01-01T00:00:00.000Z"
        ]
      );
    }
  } finally {
    db.close();
  }
  return path;
}

// Write a SQLite under `<memoryDir>/<filename>` shaped like openclaw's
// alternative file-chunk RAG store (chunks + files + embedding_cache).
// scanMemorySqlite must recognize this layout and emit an unsupported
// entry rather than a migration step.
function writeFileChunkMemorySqlite(memoryDir: string, filename: string, chunkCount = 2): string {
  mkdirSync(memoryDir, { recursive: true });
  const path = join(memoryDir, filename);
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT, content TEXT);
      CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT);
      CREATE TABLE embedding_cache (id TEXT PRIMARY KEY, embedding BLOB);
    `);
    db.run("INSERT INTO files (id, path) VALUES (?, ?)", ["file-1", "/tmp/x.md"]);
    for (let i = 0; i < chunkCount; i += 1) {
      db.run("INSERT INTO chunks (id, file_id, content) VALUES (?, ?, ?)", [
        `chunk-${i}`,
        "file-1",
        `chunk content ${i}`
      ]);
    }
  } finally {
    db.close();
  }
  return path;
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

  test("round-trips strings containing quotes and backslashes without JSON-escape corruption", async () => {
    // JSON.stringify would emit \"-style escapes and the gini skill
    // loader (which only strips outer quotes, no unescaping) would
    // return the escape sequence verbatim. Verify the migrator's
    // quoting picks a quote style that survives that round-trip.
    const raw = [
      "---",
      "name: punc",
      "description: Pins escape handling.",
      "metadata:",
      "  {",
      '    "openclaw":',
      "      {",
      '        "url": "https://example.com/path?q=a&b=c",',
      '        "with-double": "he said \\"hi\\"",',
      '        "with-backslash": "C:\\\\windows\\\\system32",',
      '        "with-apostrophe": "it'+"'"+'s fine"',
      "      }",
      "  }",
      "---",
      "body"
    ].join("\n");
    const rewritten = rewriteSkillFrontmatter(raw);
    const { parseFrontmatter } = await import("../capabilities/skill-loader");
    const fmText = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rewritten)![1]!;
    const fm = parseFrontmatter(fmText) as {
      metadata?: {
        gini?: {
          url?: unknown;
          "with-double"?: unknown;
          "with-backslash"?: unknown;
          "with-apostrophe"?: unknown;
        };
      };
    };
    expect(fm.metadata?.gini?.url).toBe("https://example.com/path?q=a&b=c");
    expect(fm.metadata?.gini?.["with-double"]).toBe('he said "hi"');
    expect(fm.metadata?.gini?.["with-backslash"]).toBe("C:\\windows\\system32");
    expect(fm.metadata?.gini?.["with-apostrophe"]).toBe("it's fine");
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

  test("does not duplicate metadata: when a legacy openclaw: sits alongside an existing metadata: block", () => {
    // Two top-level keys would produce invalid YAML and the gini
    // loader's first-match-wins parser silently drops one side.
    const raw = [
      "---",
      "name: dual",
      "metadata:",
      "  license: MIT",
      "openclaw:",
      "  emoji: X",
      "---",
      "body"
    ].join("\n");
    const out = rewriteSkillFrontmatter(raw);
    const metadataCount = (out.match(/^metadata:[ \t]*(?:\r?\n|$)/gm) ?? []).length;
    expect(metadataCount).toBe(1);
  });

  test("does not consume an unrelated field's flow block when metadata is block-style", () => {
    // convertFlowStyleMetadata used to scan forward from metadata:
    // for any `{`, so a later field whose value happened to be a flow
    // block carrying an `openclaw` key was misread as the metadata
    // value, replacing the block-style metadata field outright.
    const raw = [
      "---",
      "name: scopey",
      "metadata:",
      "  license: MIT",
      "config:",
      '  { "openclaw": { "emoji": "Z" } }',
      "---",
      "body"
    ].join("\n");
    const out = rewriteSkillFrontmatter(raw);
    expect(out).toContain("metadata:\n  license: MIT");
  });
});

describe("discoverOpenclawState", () => {
  const saved: Record<string, string | undefined> = {};
  const PER_TEST_ENV = [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKSPACE_DIR",
    "OPENCLAW_PROFILE",
    "OPENCLAW_CONFIG_PATH"
  ] as const;

  beforeEach(() => {
    // Snapshot every openclaw-side env var before this describe block
    // mutates them, then restore on teardown. Without the afterEach,
    // a test that intentionally sets one (e.g. the
    // OPENCLAW_CONFIG_PATH coverage test) would leak the value into
    // every later test in this file or the bun test process.
    for (const name of PER_TEST_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of PER_TEST_ENV) restoreEnv(name, saved[name]);
  });

  test("honors an explicit path argument", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    expect(discovery.stateRoot).toBe(OPENCLAW_ROOT);
    expect(discovery.configPath).toBe(join(OPENCLAW_ROOT, "openclaw.json"));
  });

  test("honors OPENCLAW_CONFIG_PATH for the config file location", () => {
    // Openclaw's documented env hierarchy includes OPENCLAW_CONFIG_PATH
    // for relocating openclaw.json outside the state root. Without
    // honoring it, multi-instance or portable-config setups see "no
    // openclaw config found" and the migrator no-ops.
    const stateOnly = `${ROOT}/state-no-config`;
    const externalConfig = `${ROOT}/external/openclaw.json`;
    rmSync(stateOnly, { recursive: true, force: true });
    rmSync(`${ROOT}/external`, { recursive: true, force: true });
    mkdirSync(stateOnly, { recursive: true });
    mkdirSync(`${ROOT}/external`, { recursive: true });
    writeFileSync(externalConfig, JSON.stringify({ agents: { list: [{ id: "main" }] } }));
    process.env.OPENCLAW_CONFIG_PATH = externalConfig;
    process.env.OPENCLAW_STATE_DIR = stateOnly;
    const discovery = discoverOpenclawState();
    expect(discovery.configPath).toBe(externalConfig);
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

  test("honors agents.list[].agentDir for auth-profiles.json resolution", () => {
    // Openclaw lets operators relocate per-agent secret dirs via
    // agents.list[].agentDir. Without this override, the migrator
    // hard-codes <state>/agents/<id>/agent/ and silently misses every
    // API key for installs using the override.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const overrideDir = `${ROOT}/external-agent-secrets`;
    rmSync(overrideDir, { recursive: true, force: true });
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(
      join(overrideDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-default": {
            type: "api_key",
            provider: "openai",
            key: "sk-from-override-dir"
          }
        }
      })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [{ id: "main", default: true, agentDir: overrideDir }]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secret = plan.steps.find((step) => step.kind === "secret") as {
      envVar: string;
      valueFrom: string;
    } | undefined;
    expect(secret?.envVar).toBe("OPENAI_API_KEY");
    expect(secret?.valueFrom).toBe("sk-from-override-dir");
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

  test("discovers tokens from inline channel config when env vars are missing", () => {
    // Openclaw's per-account schema stores botToken/token inline under
    // channels.<kind>.<account>.{botToken,token}. The migrator was
    // only reading env vars, so modern configs failed to migrate
    // their bridges silently.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: { accounts: { primary: { botToken: "tg-inline-token" } } },
          discord: { accounts: { primary: { token: "discord-inline-token" } } }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find(
      (step) => step.kind === "bridge" && (step as { bridgeKind: string }).bridgeKind === "telegram"
    ) as { tokenValue: string } | undefined;
    const discord = plan.steps.find(
      (step) => step.kind === "bridge" && (step as { bridgeKind: string }).bridgeKind === "discord"
    ) as { tokenValue: string } | undefined;
    expect(telegram?.tokenValue).toBe("tg-inline-token");
    expect(discord?.tokenValue).toBe("discord-inline-token");
  });

  test("strips telegram:/tg: prefixes from allowFrom entries before coercing to numbers", () => {
    // Openclaw's normalizer (extensions/telegram/src/allow-from.ts)
    // strips a leading telegram: or tg: prefix case-insensitively.
    // Number(\"telegram:12345\") is NaN, so prefixed entries used to
    // disappear without warning.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: {
          telegram: {
            accounts: { primary: { botToken: "tg-token" } },
            allowFrom: ["telegram:111", "Tg:222", "333"]
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge") as {
      allowedChatIds: number[];
    };
    expect(telegram.allowedChatIds.sort((a, b) => a - b)).toEqual([111, 222, 333]);
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

  test("surfaces unsupported provider routing at plan time, not only apply time", () => {
    // A user with no auth-profiles.json but agents.list[0].model
    // pointing at an unsupported provider would have seen a clean
    // dry-run and then a surprise warning + silent fallback to the
    // instance provider on apply. The plan must surface the same
    // provider:<name> entry the auth-profiles loop emits.
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
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const anthropicEntry = plan.unsupported.find(
      (entry) => entry.kind === "provider:anthropic"
    );
    expect(anthropicEntry).toBeDefined();
    expect(anthropicEntry?.detail).toContain("main");
    expect(anthropicEntry?.detail).toContain("anthropic");
  });

  test("surfaces bare-model routing (no provider prefix) as unsupported and drops the orphan model", () => {
    // resolveEffectiveContext AND-guards on (providerName, model);
    // a bare \`model: \"gpt-5-mini\"\` lands as model-only and the
    // runtime silently discards the model. Tell the operator and
    // drop the orphan so the AgentRecord doesn't lie.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true, model: "gpt-5-mini" }] }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const agent = plan.steps.find((step) => step.kind === "agent") as {
      providerName: string | undefined;
      model: string | undefined;
    };
    expect(agent.providerName).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "agent" &&
          entry.detail.includes("main") &&
          entry.detail.includes("gpt-5-mini") &&
          entry.detail.includes("without a provider prefix")
      )
    ).toBe(true);
  });

  test("flags dropped duplicate auth profiles for the same provider", () => {
    // Openclaw allows multiple auth profiles per provider for
    // rotation. Gini stores one key per env var; the migrator can
    // only carry one, but it must say which it dropped.
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
          "openai-work": {
            type: "api_key",
            provider: "openai",
            key: "sk-work-key"
          },
          "openai-personal": {
            type: "api_key",
            provider: "openai",
            key: "sk-personal-key"
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secrets = plan.steps.filter((step) => step.kind === "secret");
    expect(secrets.length).toBe(1);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "provider:openai:duplicate" &&
          entry.detail.includes("OPENAI_API_KEY")
      )
    ).toBe(true);
  });

  test("surfaces unsupported defaults-model provider for the implicit main agent", () => {
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: "google/gemini-2.5-pro" } }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(
      plan.unsupported.some((entry) => entry.kind === "provider:google")
    ).toBe(true);
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
    // Session / memory inputs are absent so their counters stay zero
    // — the summary surface includes them unconditionally because the
    // CLI prints the full counts shape for every migration.
    expect(summary.counts.sessions).toBe(0);
    expect(summary.counts.sessionMessages).toBe(0);
    expect(summary.counts.memoryUnits).toBe(0);
  });

  test("counts session messages by step and totals memoryUnit rows", () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "sess-1", [
      { role: "user", text: "hi", timestamp: "2026-03-04T22:20:00.000Z" },
      { role: "assistant", text: "hi back", timestamp: "2026-03-04T22:20:05.000Z" }
    ]);
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "sess-2", [
      { role: "user", text: "again", timestamp: "2026-03-05T01:00:00.000Z" }
    ]);
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", [
      { id: "u1", text: "alpha", network: "world" },
      { id: "u2", text: "beta", network: "experience" }
    ]);
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const summary = summarizePlan(plan);
    expect(summary.counts.sessions).toBe(2);
    expect(summary.counts.sessionMessages).toBe(3);
    expect(summary.counts.memoryUnits).toBe(2);
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
    // The rotated token decrypting to the new value, and the
    // pre-rotation allow-list being merged into the post-rotation
    // metadata, are both proofs the second mutateState block wrote
    // to the persisted state graph rather than mutating a stale
    // snapshot. We deliberately do NOT probe updatedAt for change —
    // gini timestamps are millisecond-resolution ISO strings and the
    // two writes can land in the same millisecond under fast I/O,
    // producing a byte-identical string and a flake.
    expect(readSecret("rotate", bridge.secretRefs![0]!)).toBe("tg-token-rotated");
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
    // The recovery instructions must point at the in-band CLI flow
    // (disable + re-add). Hand-editing state.json is intentionally
    // NOT suggested because it skips the per-instance lock, the
    // audit chain, and the atomic tmp+rename that mutateState
    // provides.
    expect(warning).toContain("messaging disable");
    expect(warning).toContain("--bot-token");
    expect(warning).not.toContain("state.json");
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

// The archive + session + memory paths use the same /tmp roots and
// loadConfig pattern as the existing applyMigration block, but live
// in their own describe blocks so the file stays browsable. The
// beforeEach wipes both /tmp roots so each test starts from a clean
// slate; the file-level afterAll restores HOME / GINI_* env so the
// test file can't poison subsequent tests in the same Bun process.

describe("applyMigration archive", () => {
  beforeEach(() => {
    rmSync(GINI_STATE, { recursive: true, force: true });
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".gini"), { recursive: true, force: true });
  });

  test("writes a zip of the entire openclaw state to <instance>/imports", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeFileSync(join(OPENCLAW_ROOT, "marker.txt"), "preserve-me");
    const config = loadConfig("archive-write");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.applied).toBe(true);
    expect(result.archivePath).toBeDefined();
    const archive = result.archivePath!;
    expect(existsSync(archive)).toBe(true);
    expect(archive.startsWith(join(GINI_STATE, "instances", "archive-write", "imports"))).toBe(
      true
    );
    // The zip listing must include the recognizable marker and the
    // openclaw.json — the archive captures the whole state root, not
    // just config.
    const listing = execFileSync("unzip", ["-l", archive], { encoding: "utf8" });
    expect(listing).toContain("marker.txt");
    expect(listing).toContain("openclaw.json");
  });

  test("archive directory + file land at owner-only modes (0700 / 0600)", async () => {
    // The archive carries a verbatim copy of every plaintext credential
    // the openclaw state held; per-instance secrets elsewhere in gini
    // use mode 0700/0600, so the archive must match to avoid an
    // exfiltration surface that the rest of the codebase explicitly
    // avoids. mkdirSync(mode: 0o700) handles the first-create case;
    // chmodSync after handles the recursive-re-create case where mode
    // is silently ignored.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withAuthProfile: true });
    const config = loadConfig("archive-perms");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    const importsDir = join(GINI_STATE, "instances", "archive-perms", "imports");
    expect(statSync(importsDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.archivePath!).mode & 0o777).toBe(0o600);
  });

  test("apply records the archive path in the import-report findings", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("archive-report");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.report.findings.some((line) => line.includes("Archived openclaw state to"))).toBe(
      true
    );
    expect(
      result.report.findings.some(
        (line) => line.includes("imports") && line.endsWith(".zip")
      )
    ).toBe(true);
  });

  test("archive write failure aborts the migration before state mutates", async () => {
    // The safety net is non-optional. We simulate a failure by
    // pre-creating <instance>/imports as a regular file, so the
    // `mkdirSync(importsDir, { recursive: true })` call inside
    // applyMigration throws before zip even runs. This proves the
    // archive failure aborts the migration without writing any
    // agents into state.json. (We don't rely on PATH manipulation
    // here because Bun's spawnSync caches the absolute path of
    // common binaries and ignores a mid-process PATH change, which
    // would let zip still resolve and the test would no longer
    // exercise the failure branch.)
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("archive-fail");
    const blockedImportsParent = join(GINI_STATE, "instances", "archive-fail");
    mkdirSync(blockedImportsParent, { recursive: true });
    writeFileSync(join(blockedImportsParent, "imports"), "blocking-file");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await expect(
      applyMigration(config, discovery, planMigration(discovery))
    ).rejects.toThrow();
    // No agents must land in state.json — apply aborted before step 4.
    const state = readState("archive-fail");
    expect(state.agents.some((agent) => agent.name === "main")).toBe(false);
  });
});

describe("applyMigration sessions", () => {
  beforeEach(() => {
    rmSync(GINI_STATE, { recursive: true, force: true });
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".gini"), { recursive: true, force: true });
  });

  test("migrates JSONL transcript into ChatSession + ordered ChatMessages", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "sess-basic", [
      { role: "user", text: "hello", timestamp: "2026-03-04T22:20:00.000Z" },
      { role: "assistant", text: "hi there", timestamp: "2026-03-04T22:20:05.000Z" },
      { role: "user", text: "follow-up", timestamp: "2026-03-04T22:20:10.000Z" }
    ]);
    const config = loadConfig("session-basic");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const sessionStep = plan.steps.find((step) => step.kind === "session");
    expect(sessionStep).toBeDefined();
    expect((sessionStep as { messageCount: number }).messageCount).toBe(3);
    const result = await applyMigration(config, discovery, plan);
    expect(result.sessionsCreated).toBe(1);
    expect(result.sessionMessagesCreated).toBe(3);
    const state = readState("session-basic");
    const migrated = state.chatSessions.find((session) => session.title.startsWith("Openclaw"));
    expect(migrated).toBeDefined();
    // Session createdAt/updatedAt must reflect the openclaw timestamps,
    // not migration day — otherwise every migrated chat sorts to the
    // top of the UI's recent-chats list and crowds out current work.
    expect(migrated!.createdAt.startsWith("2026-03-04T22:20")).toBe(true);
    expect(migrated!.updatedAt).toBe("2026-03-04T22:20:10.000Z");
    const messages = state.chatMessages.filter(
      (message) => message.sessionId === migrated!.id
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi there", "follow-up"]);
    expect(messages[0]!.createdAt).toBe("2026-03-04T22:20:00.000Z");
    expect(messages[2]!.createdAt).toBe("2026-03-04T22:20:10.000Z");
  });

  test("drops tool_use blocks from migrated message text", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "sess-tools", [
      { role: "user", text: "real prompt", timestamp: "2026-03-04T22:20:00.000Z" },
      {
        role: "assistant",
        text: "real reply",
        timestamp: "2026-03-04T22:20:05.000Z",
        toolBlocks: 3
      }
    ]);
    const config = loadConfig("session-tools");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.sessionMessagesCreated).toBe(2);
    const state = readState("session-tools");
    expect(state.chatMessages.find((m) => m.content === "real reply")).toBeDefined();
    // Tool block payloads must NEVER survive into ChatMessageRecord.content.
    // The verbatim transcript lives in the archive zip for anyone who
    // needs the original tool-call detail.
    expect(state.chatMessages.some((m) => m.content.includes("tool_use"))).toBe(false);
    expect(state.chatMessages.some((m) => m.content.includes("synthetic_tool"))).toBe(false);
  });

  test("binds each migrated session to the gini agent matching its openclaw id", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "work", "sess-w", [
      { role: "user", text: "morning standup", timestamp: "2026-03-04T22:20:00.000Z" }
    ]);
    const config = loadConfig("session-agent-binding");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await applyMigration(config, discovery, planMigration(discovery));
    const state = readState("session-agent-binding");
    const workAgent = state.agents.find((agent) => agent.name === "work");
    expect(workAgent).toBeDefined();
    const session = state.chatSessions.find((entry) => entry.title.includes("Openclaw work"));
    expect(session?.agentId).toBe(workAgent!.id);
  });

  test("warns and skips a session whose only content is non-text blocks", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const sessionDir = join(OPENCLAW_ROOT, "agents", "main", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "tool-only.jsonl"),
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          id: "tool-only",
          timestamp: "2026-03-04T22:20:00.000Z"
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-03-04T22:20:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }]
          }
        })
      ].join("\n")}\n`
    );
    const config = loadConfig("session-tool-only");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.sessionsCreated).toBe(0);
    expect(result.warnings.some((warning) => warning.includes("no replayable messages"))).toBe(
      true
    );
  });
});

describe("applyMigration memory units", () => {
  beforeEach(() => {
    rmSync(GINI_STATE, { recursive: true, force: true });
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    rmSync(join(GINI_HOME, ".gini"), { recursive: true, force: true });
  });

  test("inserts every Hindsight memory_units row into gini memory.db", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", [
      { id: "u1", text: "alpha", network: "world", confidence: 0.4 },
      { id: "u2", text: "beta", network: "experience", confidence: 0.7 },
      { id: "u3", text: "gamma", network: "opinion", status: "archived" }
    ]);
    const config = loadConfig("memory-hindsight");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.filter((step) => step.kind === "memoryUnit")).toHaveLength(3);
    const result = await applyMigration(config, discovery, plan);
    expect(result.memoryUnitsCreated).toBe(3);

    const memDb = getMemoryDb("memory-hindsight");
    const rows = memDb
      .query<{ text: string; network: string; status: string; confidence: number | null }, []>(
        "SELECT text, network, status, confidence FROM memory_units ORDER BY text"
      )
      .all();
    expect(rows.map((row) => row.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(rows.map((row) => row.network)).toEqual(["world", "experience", "opinion"]);
    // archived status survives the round-trip; gini's MemoryUnitStatus
    // shares the openclaw set so no coercion is needed.
    expect(rows[2]!.status).toBe("archived");
  });

  test("preserves openclaw metadata + records source-bank + openclaw id", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "secondary.sqlite", [
      {
        id: "u-meta",
        text: "Bob likes coffee",
        network: "experience",
        metadata: { topic: "preferences", subject: "Bob" }
      }
    ]);
    const config = loadConfig("memory-metadata");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.memoryUnitsCreated).toBe(1);
    const memDb = getMemoryDb("memory-metadata");
    const row = memDb
      .query<{ metadata: string }, []>("SELECT metadata FROM memory_units LIMIT 1")
      .get();
    const metadata = JSON.parse(row!.metadata) as Record<string, unknown>;
    expect(metadata.topic).toBe("preferences");
    expect(metadata.subject).toBe("Bob");
    expect(metadata.openclawBank).toBe("secondary");
    expect(metadata.openclawUnitId).toBe("u-meta");
  });

  test("file-chunk RAG schema lands on the unsupported list with no migration step", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeFileChunkMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", 5);
    const config = loadConfig("memory-rag");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.some((step) => step.kind === "memoryUnit")).toBe(false);
    const unsupportedMemory = plan.unsupported.find((entry) => entry.kind === "memory");
    expect(unsupportedMemory).toBeDefined();
    expect(unsupportedMemory!.detail).toContain("file-chunk RAG");
    expect(unsupportedMemory!.detail).toContain("5 chunks");
    const result = await applyMigration(config, discovery, plan);
    expect(result.memoryUnitsCreated).toBe(0);
  });

  test("coerces unknown openclaw status / network to safe gini defaults", async () => {
    // An openclaw schema drift could surface an unknown status or
    // network value. The migrator must fall back to a value gini's
    // runtime accepts on read rather than poisoning the memory store
    // with rows recall and the UI can't render.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", [
      { id: "weird-1", text: "weird status", network: "world", status: "weird-status" },
      { id: "weird-2", text: "weird network", network: "mystery-net" }
    ]);
    const config = loadConfig("memory-coerce");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.memoryUnitsCreated).toBe(2);
    const memDb = getMemoryDb("memory-coerce");
    const rows = memDb
      .query<{ text: string; network: string; status: string }, []>(
        "SELECT text, network, status FROM memory_units ORDER BY text"
      )
      .all();
    const statusRow = rows.find((row) => row.text === "weird status")!;
    const networkRow = rows.find((row) => row.text === "weird network")!;
    expect(statusRow.status).toBe("active");
    expect(networkRow.network).toBe("experience");
  });

  test("empty memory directory produces no migration step and no unsupported note", async () => {
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    // memory/ exists but no .sqlite files inside. Hooks for memory
    // inspection should not surface anything that confuses an operator
    // who never used openclaw memory.
    mkdirSync(join(OPENCLAW_ROOT, "memory"), { recursive: true });
    const config = loadConfig("memory-empty-dir");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.some((step) => step.kind === "memoryUnit")).toBe(false);
    const memoryNote = plan.unsupported.find((entry) => entry.kind === "memory");
    expect(memoryNote?.detail).toContain("contains no .sqlite files");
    const result = await applyMigration(config, discovery, plan);
    expect(result.memoryUnitsCreated).toBe(0);
  });
});
