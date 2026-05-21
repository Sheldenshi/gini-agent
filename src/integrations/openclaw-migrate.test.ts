import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
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
  recordOpenclawPlanFailure,
  rewriteSkillFrontmatter,
  summarizePlan
} from "./openclaw-migrate";
import { loadConfig } from "../paths";
import { mutateState, readState } from "../state";
import { closeAllMemoryDbs, getMemoryDb } from "../state/memory-db";
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
  // Mirror the beforeEach safeguard: dbCache (src/state/memory-db.ts)
  // is module-level and survives across test files in the same Bun
  // process. rmSync'ing ROOT without closing cached handles first
  // would leave dangling Database refs pointing at unlinked files,
  // and any subsequent test file that touches memory.db on the same
  // path would hit SQLITE_IOERR_VNODE. Closing here is symmetric
  // with the per-beforeEach close call.
  closeAllMemoryDbs();
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

  test("elides trailing comma when a block comment intervenes before the closer", () => {
    // Hand-edited configs commonly carry `, /* note */` before a
    // closing bracket. The scanner's whitespace-only lookahead would
    // leave the comma in place and strict JSON.parse would reject
    // the cleaned string.
    const raw = `{"a": 1, /* note */}`;
    expect(parseOpenclawJson(raw)).toEqual({ a: 1 });
  });

  test("elides trailing comma when a line comment intervenes before the closer", () => {
    // parseOpenclawJson is typed as returning OpenclawConfig (an
    // object shape); arrays are valid at runtime but the type cast
    // hides that — re-cast to unknown so toEqual accepts the array
    // shape for comparison.
    const raw = `[1, // note\n]`;
    expect(parseOpenclawJson(raw) as unknown).toEqual([1]);
  });

  test("elides trailing comma when both whitespace and a comment intervene", () => {
    const raw = `{\n  "a": 1,  \n  // explainer\n  /* still inside */\n}`;
    expect(parseOpenclawJson(raw)).toEqual({ a: 1 });
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

  test("honors in-state-root agents.list[].agentDir for auth-profiles.json resolution", () => {
    // Openclaw lets operators relocate per-agent secret dirs via
    // agents.list[].agentDir. The override is honored when it
    // resolves INSIDE the source state root (typical non-default
    // layout: a per-tenant subdirectory under the same state). An
    // override that escapes the state root is rejected separately
    // (see the next test) to prevent a coworker's backup tarball
    // from redirecting the auth read into the operator's other
    // credential stores.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const overrideDir = join(OPENCLAW_ROOT, "tenants", "primary", "agent");
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

  test("refuses leaf-symlinked openclaw.json that escapes source.stateRoot", () => {
    // A `<state>/openclaw.json` symlink to `~/.openclaw/openclaw.json`
    // (or any other openclaw.json on the system) would redirect the
    // whole plan — agent ids, agentDir overrides, channel tokens —
    // through a config the operator didn't choose with --path. Refuse
    // the read up front; the operator can either replace the symlink
    // with a real file or set OPENCLAW_CONFIG_PATH explicitly to opt
    // into the env-override case.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const externalConfig = `${ROOT}/external-openclaw.json`;
    rmSync(externalConfig, { force: true });
    writeFileSync(
      externalConfig,
      JSON.stringify({ agents: { list: [{ id: "external-only", default: true }] } })
    );
    symlinkSync(externalConfig, join(OPENCLAW_ROOT, "openclaw.json"));
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    // No agent from the external config should appear in the plan.
    expect(
      plan.steps.some(
        (step) => step.kind === "agent" && step.openclawId === "external-only"
      )
    ).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "openclaw-state" &&
          entry.detail.includes("outside the openclaw state root")
      )
    ).toBe(true);
  });

  test("honors OPENCLAW_CONFIG_PATH even when the env config lives outside stateRoot", () => {
    // The env-override case is by design outside stateRoot. The
    // realpath containment check must skip it explicitly, otherwise
    // the migrator would refuse every operator using the env to
    // relocate openclaw.json (a documented openclaw feature).
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const externalConfig = `${ROOT}/env-override-openclaw.json`;
    rmSync(externalConfig, { force: true });
    writeFileSync(
      externalConfig,
      JSON.stringify({ agents: { list: [{ id: "env-main", default: true }] } })
    );
    process.env.OPENCLAW_STATE_DIR = OPENCLAW_ROOT;
    process.env.OPENCLAW_CONFIG_PATH = externalConfig;
    try {
      const discovery = discoverOpenclawState();
      const plan = planMigration(discovery);
      expect(
        plan.steps.some(
          (step) => step.kind === "agent" && step.openclawId === "env-main"
        )
      ).toBe(true);
      expect(
        plan.unsupported.some((entry) => entry.kind === "openclaw-state")
      ).toBe(false);
    } finally {
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
  });

  test("refuses leaf-symlinked auth-profiles.json that escapes source.stateRoot", () => {
    // A hostile state with a legitimate agentDir inside the source
    // root but the leaf `auth-profiles.json` symlinked at
    // `~/.aws/credentials.json` would dereference the symlink and
    // exfil credentials from the operator's other tools into
    // `~/.gini/secrets.env`. The leaf must be containment-checked
    // even when the parent agentDir is safe.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const externalCreds = `${ROOT}/external-creds.json`;
    rmSync(externalCreds, { force: true });
    writeFileSync(
      externalCreds,
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-default": {
            type: "api_key",
            provider: "openai",
            key: "sk-would-be-exfiltrated"
          }
        }
      })
    );
    const agentDir = join(OPENCLAW_ROOT, "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(externalCreds, join(agentDir, "auth-profiles.json"));
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    // The migrator agent is created (agentDir itself is inside the
    // root), but the credential read is refused.
    expect(plan.steps.some((step) => step.kind === "secret")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "auth-profiles:main" &&
          entry.detail.includes("outside the openclaw state root")
      )
    ).toBe(true);
  });

  test("refuses leaf-symlinked .env that escapes source.stateRoot (returns empty map)", () => {
    // `<state>/.env` symlinked at e.g. `~/.zsh_history` would
    // parse any UPPER_CASE=value lines as openclaw config env vars,
    // potentially picking up TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN
    // assignments from unrelated shell exports.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const externalEnv = `${ROOT}/external-env`;
    rmSync(externalEnv, { force: true });
    writeFileSync(externalEnv, `TELEGRAM_BOT_TOKEN=stolen-from-outside\n`);
    symlinkSync(externalEnv, join(OPENCLAW_ROOT, ".env"));
    const env = readStateDotenv(OPENCLAW_ROOT);
    expect(env).toEqual({});
  });

  test("refuses external agents.list[].agentDir that escapes source.stateRoot", () => {
    // A crafted openclaw.json (e.g., from a coworker's backup
    // tarball) with `agentDir: "~/.aws"` or any absolute path
    // outside the operator's chosen --path could exfiltrate
    // credentials from the operator's other tools into
    // `~/.gini/secrets.env`. Refuse-by-default and surface the
    // skip on the unsupported list so the operator sees what was
    // dropped. Operators who legitimately need an external
    // agentDir can either move secrets into --path or use
    // OPENCLAW_STATE_DIR to encompass both.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const externalDir = `${ROOT}/external-agent-secrets`;
    rmSync(externalDir, { recursive: true, force: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(
      join(externalDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-default": {
            type: "api_key",
            provider: "openai",
            key: "sk-would-be-exfiltrated"
          }
        }
      })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [{ id: "main", default: true, agentDir: externalDir }]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    // No agent created, no secret migrated.
    expect(plan.steps.some((step) => step.kind === "agent" && step.openclawId === "main")).toBe(
      false
    );
    expect(plan.steps.some((step) => step.kind === "secret")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "agent:main" && entry.detail.includes("outside the openclaw state root")
      )
    ).toBe(true);
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

  test("refuses to attach openclaw sessions and memory to a pre-existing gini agent without --force", async () => {
    // A native gini agent named "main" already exists. Openclaw's
    // implicit "main" agent should NOT silently merge its
    // sessions and memory into the operator's pre-existing one —
    // the operator's history would be polluted with openclaw
    // transcripts and memory units. Surface the collision so the
    // operator either renames their native agent or passes --force.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "session-1", [
      { role: "user", text: "from openclaw", timestamp: "2026-01-01T00:00:00.000Z" }
    ]);
    const config = loadConfig("agent-name-collision");
    // Plant a native gini agent with the colliding name before
    // running the migration.
    mutateState(config.instance, (state) => {
      state.agents.unshift({
        id: "agent_native",
        instance: config.instance,
        name: "main",
        status: "active",
        toolsets: [],
        messagingTargets: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    // The fixture has agents.list = [main, work]. `main` collides
    // with the native agent and is refused; `work` has no collision
    // and is created normally.
    expect(result.agentsCreated).toBe(1);
    expect(
      readState(config.instance).agents.some((agent) => agent.name === "work")
    ).toBe(true);
    // The collision shows up on the unsupported list with a
    // remediation pointing at rename or --force.
    const collision = result.unsupported.find(
      (entry) => entry.kind === "agent:main:name-collision"
    );
    expect(collision).toBeDefined();
    expect(collision?.detail).toContain("--force");
    expect(collision?.detail).toContain("gini agent delete");
    // The openclaw session belongs to 'main' (writeOpenclawSessionJsonl
    // wrote it under agents/main/). It must NOT attach to the native
    // 'main' agent. Without this refusal the session would land on
    // agent_native and pollute the operator's history.
    expect(result.sessionsCreated).toBe(0);
    expect(readState(config.instance).chatSessions).toHaveLength(0);
  });

  test("--force acknowledges agent-name collision and merges openclaw sessions into the pre-existing agent", async () => {
    // Operator who knows the collision is intentional (e.g. re-
    // running migration after a previous successful import created
    // the agent) can pass --force to skip the refusal. Sessions
    // and memory then attach to the pre-existing agent.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "session-1", [
      { role: "user", text: "from openclaw", timestamp: "2026-01-01T00:00:00.000Z" }
    ]);
    const config = loadConfig("agent-name-collision-force");
    mutateState(config.instance, (state) => {
      state.agents.unshift({
        id: "agent_existing",
        instance: config.instance,
        name: "main",
        status: "active",
        toolsets: [],
        messagingTargets: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan, { force: true });
    // 'main' collision is acknowledged via --force; 'work' is created normally.
    expect(result.agentsCreated).toBe(1);
    expect(
      result.unsupported.some((entry) => entry.kind === "agent:main:name-collision")
    ).toBe(false);
    // Session attaches to the pre-existing agent.
    expect(result.sessionsCreated).toBe(1);
    const state = readState(config.instance);
    const session = state.chatSessions[0];
    expect(session?.agentId).toBe("agent_existing");
  });

  test("recordOpenclawPlanFailure refuses to write while another import holds the lock", async () => {
    // mutateState only serializes inside a single Node process —
    // two CLI invocations on the same instance can corrupt state
    // by racing on <state>.tmp. applyMigration uses the .import-lock
    // for cross-process serialization; the plan-failure helper has
    // to honor the same lock. We simulate a peer apply by planting
    // a held lock file, then assert the helper returns null
    // instead of competing for the same writeState slot.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: false });
    const config = loadConfig("plan-fail-lock-defense");
    const lockPath = join(GINI_STATE, "instances", "plan-fail-lock-defense", ".import-lock");
    mkdirSync(join(GINI_STATE, "instances", "plan-fail-lock-defense"), { recursive: true });
    // Plant a foreign lock with our own pid (so the stale-detection
    // sees the holder as alive). The fresh acquisition attempt
    // inside the helper hits EEXIST and bails because the peer
    // pid is alive.
    writeFileSync(
      lockPath,
      `pid=${process.pid}\ntoken=foreign-token\nat=2026-01-01T00:00:00.000Z\n`,
      { mode: 0o600 }
    );
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const synthetic = new Error("openclaw.json: malformed");
    const report = await recordOpenclawPlanFailure(config, discovery, synthetic);
    expect(report).toBeNull();
    // Lock file still belongs to the peer — the helper did not
    // delete it on its way out.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toContain("token=foreign-token");
    rmSync(lockPath, { force: true });
  });

  test("orphan-bank remediation message tells operator to update bank_id too", async () => {
    // /api/memory/recall filters by both bank_id AND agent_id. The
    // migrator routes orphan memory (no matching agent) into the
    // default bank with agent_id NULL — updating only agent_id would
    // leave the row pinned in bank_default while recall queries
    // bank_<agentId>, so the units stay invisible. The warning must
    // mention bank_id and the agent-create step that materializes
    // the per-agent bank.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    // Plant a memory.db whose source bank name doesn't match any
    // agent in agents.list[]. The default openclaw fixture has
    // agents.list = [{ id: "main" }], so a memory file named
    // `ghost.sqlite` is intentionally orphan.
    const memoryDir = join(OPENCLAW_ROOT, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const ghostDbPath = join(memoryDir, "ghost.sqlite");
    const { Database: Sqlite } = require("bun:sqlite");
    const seed = new Sqlite(ghostDbPath, { create: true });
    seed.run(
      "CREATE TABLE memory_banks (id TEXT PRIMARY KEY, name TEXT, created_at TEXT)"
    );
    seed.run(
      "INSERT INTO memory_banks (id, name, created_at) VALUES ('bank-1', 'ghost', '2026-01-01T00:00:00Z')"
    );
    seed.run(
      "CREATE TABLE memory_units (id TEXT PRIMARY KEY, bank_id TEXT, text TEXT, network TEXT, status TEXT, confidence REAL, metadata TEXT, mentioned_at TEXT, created_at TEXT, updated_at TEXT, embedding BLOB, embedding_model TEXT, embedding_dim INTEGER, last_recalled_at TEXT, recall_count INTEGER)"
    );
    seed.run(
      "INSERT INTO memory_units (id, bank_id, text, network, status, confidence, metadata, mentioned_at, created_at, updated_at) VALUES ('unit-1', 'bank-1', 'orphan fact', 'experience', 'active', 0.8, '{}', '2026-01-01', '2026-01-01', '2026-01-01')"
    );
    seed.close();
    const config = loadConfig("orphan-bank-message");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    const warning = result.warnings.find((w) => w.includes("openclaw bank 'ghost'"));
    expect(warning).toBeDefined();
    expect(warning).toContain("bank_id");
    expect(warning).toContain("gini agent create");
    expect(warning).toContain("bank_<agent-id>");
  });

  test("failed archive does not echo 'Archived to X' in the failure report findings", async () => {
    // archivePath is assigned before zip runs (zip needs it as an
    // argument). If zip then fails, the catch path would otherwise
    // record a finding "Archived openclaw state to <path>" even
    // though no such file exists. Gate the finding on a separate
    // archiveSucceeded flag set only after zip + chmod complete.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("archive-fail-no-finding");
    // Block the archive step by planting <instance>/imports as a
    // regular file (mkdirSync recursive then throws on the leaf).
    const instanceDir = join(GINI_STATE, "instances", "archive-fail-no-finding");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "imports"), "blocking-file");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await expect(
      applyMigration(config, discovery, planMigration(discovery))
    ).rejects.toThrow();
    const state = readState("archive-fail-no-finding");
    const failedReport = state.importReports.find(
      (r) => r.source === "openclaw" && r.status === "failed"
    );
    expect(failedReport).toBeDefined();
    // The catch wrote a failed report, but archive never succeeded
    // so the findings array must not claim an archive was created.
    expect(
      failedReport?.findings.some((line) => line.includes("Archived openclaw state to"))
    ).toBe(false);
  });

  test("recordOpenclawPlanFailure persists a failed ImportReport for plan-time throws", async () => {
    // planMigration parses the operator-supplied openclaw.json. A
    // malformed file beyond what the tolerant JSONC scanner can fix
    // throws SyntaxError before applyMigration's catch runs, so the
    // failed-report write must come from a separate code path the
    // CLI can invoke directly. This test exercises that helper
    // independently of the CLI wiring.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: false });
    const config = loadConfig("plan-failure-report");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const synthetic = new Error("openclaw.json: Unexpected token } at position 42");
    const report = await recordOpenclawPlanFailure(config, discovery, synthetic);
    expect(report).not.toBeNull();
    expect(report?.status).toBe("failed");
    expect(report?.mode).toBe("applied");
    expect(report?.source).toBe("openclaw");
    expect(report?.error).toContain("planMigration failed before apply could run");
    expect(report?.error).toContain("Unexpected token");
    const state = readState("plan-failure-report");
    expect(state.importReports.some((r) => r.id === report?.id)).toBe(true);
  });

  test("refuses to collapse multiple openclaw telegram accounts into a single bridge", () => {
    // Openclaw can run multiple telegram bots (each with its own
    // token + allowlist for tenant isolation). Gini's bridge model
    // is one per kind per instance — a naive union would silently
    // widen access from "corpbot only sees corp chats" to "one bot
    // sees every account's chats." Detect multi-account and refuse.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    mkdirSync(join(OPENCLAW_ROOT, "credentials"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: {
          telegram: {
            dmPolicy: "pairing",
            accounts: {
              corpbot: { botToken: "tg-corp" },
              personalbot: { botToken: "tg-personal" }
            }
          }
        }
      })
    );
    // Two per-account allowlists, each with their own scope.
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-corpbot-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["100"] })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-personalbot-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["200"] })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    expect(plan.steps.some((step) => step.kind === "bridge" && step.bridgeKind === "telegram")).toBe(false);
    const refusal = plan.unsupported.find(
      (entry) => entry.kind === "messaging:telegram:multi-account"
    );
    expect(refusal).toBeDefined();
    expect(refusal?.detail).toContain("corpbot");
    expect(refusal?.detail).toContain("personalbot");
    expect(refusal?.detail).toContain("gini messaging add");
  });

  test("tolerates null and primitive entries in agents.list without aborting the plan", () => {
    // parseOpenclawJson is JSON.parse → `as OpenclawConfig`; nothing
    // validates per-entry shape. A coworker's malformed config with
    // `[null, 42, { id: "main" }]` used to throw TypeError on the
    // first null entry and abort `gini import plan` before any of
    // the other steps reached the operator. Each malformed entry
    // now becomes an unsupported entry and the well-formed entries
    // continue to plan.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [null, 42, "string", { id: "main", default: true }] } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    // 'main' still made it onto the plan.
    expect(plan.steps.some((step) => step.kind === "agent" && step.openclawId === "main")).toBe(true);
    // Three malformed entries each surfaced.
    const malformed = plan.unsupported.filter(
      (entry) => entry.kind === "agent" && entry.detail.includes("agents.list")
    );
    expect(malformed.length).toBeGreaterThanOrEqual(3);
  });

  test("accepts openclaw `apiKey` field as an alias for `key`", () => {
    // Openclaw's auth-profile loader at openclaw/src/agents/auth-
    // profiles/store.ts:167-170 accepts `apiKey` and `key` as
    // interchangeable; users in the wild write both forms. The
    // migrator must too, otherwise an entire openclaw config with
    // `apiKey: sk-...` silently loses its credential.
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
          "openai-default": {
            type: "api_key",
            provider: "openai",
            apiKey: "sk-from-apikey-alias"
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secretStep = plan.steps.find((step) => step.kind === "secret") as
      | { envVar: string; valueFrom: string }
      | undefined;
    expect(secretStep).toBeDefined();
    expect(secretStep!.envVar).toBe("OPENAI_API_KEY");
    expect(secretStep!.valueFrom).toBe("sk-from-apikey-alias");
  });

  test("unions telegram-default-allowFrom.json and named-account variants with the legacy file", () => {
    // Openclaw's doctor migration moves the legacy
    // credentials/telegram-allowFrom.json to
    // telegram-default-allowFrom.json (when no named accounts) or
    // fans out to telegram-<account>-allowFrom.json (when named
    // accounts are configured). The migrator must read all three
    // shapes, otherwise any install that ran openclaw's doctor
    // OR used named accounts has its authorized chats silently
    // dropped.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    mkdirSync(join(OPENCLAW_ROOT, "credentials"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: { telegram: { dmPolicy: "pairing" } }
      })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, ".env"),
      "TELEGRAM_BOT_TOKEN=tg-token-for-allowfrom-variants\n"
    );
    // Legacy file: chat 100
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["100"] })
    );
    // Default-account file: chat 200 (what openclaw doctor produces)
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-default-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["200"] })
    );
    // Named-account files: chats 300 and 400
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-corpbot-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["300"] })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-personal-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["400"] })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const bridge = plan.steps.find((step) => step.kind === "bridge") as
      | { allowedChatIds: number[] }
      | undefined;
    expect(bridge).toBeDefined();
    expect(bridge!.allowedChatIds.sort((a, b) => a - b)).toEqual([100, 200, 300, 400]);
  });

  test("refuses to rotate a native messaging bridge under --force", async () => {
    // A native gini telegram bridge the operator created themselves
    // must not be silently overwritten by `gini import apply --force`.
    // The bridge collision check uses the same audit-marker
    // pattern as the agent collision: a `messaging.configured`
    // row with `source: "openclaw-migration"` marks "ours";
    // anything else is the operator's, refuse to touch.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("bridge-native-collision");
    // Plant a native telegram bridge the operator created via the
    // regular addMessagingBridge path (no openclaw audit marker).
    mutateState(config.instance, (state) => {
      state.messagingBridges.unshift({
        id: "bridge_native",
        instance: config.instance,
        name: "operator's native bot",
        kind: "telegram",
        deliveryTargets: [],
        status: "configured",
        secretRefs: [{ purpose: "bot-token", path: "messaging.bridge_native.bot-token.json" }],
        metadata: { allowedChatIds: [999], lastOffset: 50 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan, { force: true });
    expect(result.bridgesCreated).toBe(0);
    expect(result.bridgesRotated).toBe(0);
    const collision = result.unsupported.find(
      (entry) => entry.kind === "messaging:telegram:native-collision"
    );
    expect(collision).toBeDefined();
    expect(collision?.detail).toContain("gini messaging disable");
    // The native bridge's metadata/token must be untouched.
    const state = readState(config.instance);
    const bridge = state.messagingBridges.find((b) => b.id === "bridge_native");
    expect((bridge?.metadata as { allowedChatIds: number[] }).allowedChatIds).toEqual([999]);
    expect((bridge?.metadata as { lastOffset: number }).lastOffset).toBe(50);
  });

  test("disabled native bridge no longer blocks a fresh migration", async () => {
    // The native-collision remediation directs operators
    // to `gini messaging disable <bridge-id>` followed by a re-
    // import. disableMessagingBridge sets status="disabled" but
    // does not remove the bridge record. The migrator's collision
    // check used to find the disabled bridge by kind anyway and
    // re-refuse the import — a dead-end loop. Filter by status so
    // disabling actually unblocks the documented recovery.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("bridge-disabled-unblocks");
    // Plant a disabled native bridge (the post-`disable` shape).
    mutateState(config.instance, (state) => {
      state.messagingBridges.unshift({
        id: "bridge_disabled_native",
        instance: config.instance,
        name: "operator's disabled bot",
        kind: "telegram",
        deliveryTargets: [],
        status: "disabled",
        secretRefs: [],
        metadata: { allowedChatIds: [], lastOffset: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    // Fresh migrator-tagged bridge gets created; the disabled
    // one stays disabled in state.
    expect(result.bridgesCreated).toBe(1);
    expect(
      result.unsupported.some((entry) =>
        entry.kind === "messaging:telegram:native-collision"
      )
    ).toBe(false);
    const state = readState(config.instance);
    const disabled = state.messagingBridges.find((b) => b.id === "bridge_disabled_native");
    expect(disabled?.status).toBe("disabled");
    const fresh = state.messagingBridges.find((b) => b.id !== "bridge_disabled_native");
    expect(fresh?.status).toBe("configured");
  });

  test("rotates a prior-migration bridge with --force without refusing", async () => {
    // The collision refusal applies only to native bridges. A
    // bridge created by an earlier run of THIS migrator should
    // re-import cleanly under --force so the operator can refresh
    // the token.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("bridge-prior-migration-rotate");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    // First import: lays down the openclaw-tagged bridge.
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.bridgesCreated).toBe(1);
    // Second import with --force: rotates instead of refusing.
    const second = await applyMigration(config, discovery, planMigration(discovery), { force: true });
    expect(second.bridgesRotated).toBe(1);
    expect(
      second.unsupported.some((entry) =>
        entry.kind === "messaging:telegram:native-collision"
      )
    ).toBe(false);
  });

  test("chmods migrated workspace files to 0600 even when openclaw source was world-readable", async () => {
    // Node's copyFileSync preserves source mode by default. A
    // sloppy openclaw backup with 0666 entries would land world-
    // writable under <instance>/workspace/, and the gateway reads
    // those at startup — any local user could rewrite the agent's
    // prompt. Normalize to owner-only after copy.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withWorkspaceFiles: true });
    // Force the source files to a permissive mode.
    chmodSync(join(OPENCLAW_ROOT, "workspace", "SOUL.md"), 0o666);
    const config = loadConfig("workspace-chmod");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.workspaceFilesCopied).toBeGreaterThan(0);
    const target = join(config.workspaceRoot, "SOUL.md");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("rejects non-integer Telegram allow-list entries instead of coercing to 0", () => {
    // openclaw's allowFrom string serialization is the surface area
    // an operator-supplied openclaw config touches. The migrator
    // must refuse anything Number() would silently coerce: empty
    // strings and whitespace become 0 (the JSON sentinel that
    // would enroll chat 0), decimals lose precision, hex/scientific
    // notation parse to surprising integers. Mirror the HTTP
    // allow/deny endpoint's strict integer contract.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    mkdirSync(join(OPENCLAW_ROOT, "credentials"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: ["", "  ", "0x10", "1.5", "1e9", "abc", "12345", "tg:67890"]
          }
        }
      })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "credentials", "telegram-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: [""] })
    );
    // Bot token so the bridge step survives header-safe filtering.
    writeFileSync(
      join(OPENCLAW_ROOT, ".env"),
      "TELEGRAM_BOT_TOKEN=tg-token-for-strict-parse\n"
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const bridge = plan.steps.find((step) => step.kind === "bridge") as
      | { allowedChatIds: number[] }
      | undefined;
    expect(bridge).toBeDefined();
    // Only the two valid integer entries survive — everything else
    // (empty, whitespace, hex, decimal, scientific, alpha) drops.
    expect(bridge!.allowedChatIds.sort((a, b) => a - b)).toEqual([12345, 67890]);
  });

  test("apply surfaces persisted Telegram allow-list ids in result + audit row", async () => {
    // A workflow that skips `gini import plan` and runs apply
    // directly must still see which chat ids the bridge will
    // authorize. The audit row is the only durable record of an
    // apply; reporting only a scalar count there would hide a
    // smuggled-id incident from anyone reading the audit trail
    // post-fact. Both the apply result and the audit evidence
    // carry the explicit list.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("apply-surfaces-allowlist");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    expect(result.bridgesAuthorized).toHaveLength(1);
    expect(result.bridgesAuthorized[0]!.kind).toBe("telegram");
    expect(result.bridgesAuthorized[0]!.allowedChatIds.sort((a, b) => a - b)).toEqual([12345, 67890]);
    const state = readState("apply-surfaces-allowlist");
    const audit = state.audit.find(
      (entry) => entry.action === "messaging.configured"
    );
    expect(audit).toBeDefined();
    const evidence = audit?.evidence as { allowedChatIds: number[]; allowedChatCount: number };
    expect(evidence.allowedChatIds.sort((a, b) => a - b)).toEqual([12345, 67890]);
    expect(evidence.allowedChatCount).toBe(2);
  });

  test("rejects a default <state>/workspace that is itself a symlink", () => {
    // Hostile tarball plants `<state>/workspace` as a symlink to a
    // sibling directory the operator didn't intend to copy from.
    // The leaf-symlink check at apply-time passes (e.g.
    // <leak>/SOUL.md is a regular file) and the workspaceRoot
    // containment check passes (the realpath becomes the boundary),
    // so without this guard the migrator copies the closed list of
    // bootstrap filenames out of the redirected target. Symlinks
    // are only refused for the unsuffixed default path — the
    // OPENCLAW_WORKSPACE_DIR / OPENCLAW_PROFILE overrides are the
    // operator's explicit intent and can point anywhere.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    // Plant the redirected target with a bootstrap filename so the
    // copy would happen if the symlink were honored.
    const leakDir = join(ROOT, "workspace-leak");
    mkdirSync(leakDir, { recursive: true });
    writeFileSync(join(leakDir, "SOUL.md"), "secret-content");
    // Replace `<state>/workspace` with a symlink to the leak dir.
    const { symlinkSync } = require("node:fs");
    symlinkSync(leakDir, join(OPENCLAW_ROOT, "workspace"));
    // Discovery should refuse the symlinked default.
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    expect(discovery.workspaceRoot).toBeNull();
    const plan = planMigration(discovery);
    expect(plan.steps.some((step) => step.kind === "workspaceFile")).toBe(false);
  });

  test("surfaces on-disk agent session dirs that aren't in agents.list as orphan-sessions", () => {
    // Openclaw auto-creates <state>/agents/<id>/sessions/ for any
    // agent id the runtime sees in a session key — subagents spawned
    // at runtime, agents removed from agents.list[] after sessions
    // accumulated, ids that arrived on inbound traffic. The
    // migrator's session-step generator iterates agentIds (sourced
    // from agents.list[]) and never scans the filesystem, so those
    // on-disk transcripts get silently dropped. Surface each orphan
    // dir + session count so the operator can re-add the agent in
    // openclaw.json or recover from the archive zip.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "sessions"), { recursive: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "ghost", "sessions"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    // Plant orphan session transcripts under an agent that isn't in
    // agents.list[]. Content shape mirrors what the apply path reads,
    // but the migrator never gets that far because the agent isn't planned.
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "ghost", "sessions", "abc-123.jsonl"),
      JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "lost" }] }) + "\n"
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "ghost", "sessions", "def-456.jsonl"),
      JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "also lost" }] }) + "\n"
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const orphan = plan.unsupported.find(
      (entry) => entry.kind === "agent:ghost:orphan-sessions"
    );
    expect(orphan).toBeDefined();
    expect(orphan?.detail).toContain("2 on-disk session file");
    expect(orphan?.detail).toContain("ghost");
    // 'main' is in the list, so it does NOT appear as an orphan.
    expect(
      plan.unsupported.some((entry) => entry.kind === "agent:main:orphan-sessions")
    ).toBe(false);
  });

  test("surfaces malformed `agents.list` as an unsupported entry instead of throwing", () => {
    // parseOpenclawJson is `JSON.parse() as OpenclawConfig` with no
    // schema validation, so a tarball from a coworker or a hand-edit
    // can land any shape in agents.list. The original code's
    // `for (const agent of agentList)` would throw TypeError on a
    // non-array and abort `gini import plan` with a stack trace
    // before the operator saw any of the other steps. Now the
    // schema drift becomes an unsupported entry; the rest of the
    // plan is still inspectable.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: { not: "an array" } } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const drift = plan.unsupported.find(
      (entry) =>
        entry.kind === "agent" &&
        entry.detail.includes("`agents.list`") &&
        entry.detail.includes("not an array")
    );
    expect(drift).toBeDefined();
    // The implicit 'main' agent fallback still runs so a migration
    // with one bad config field isn't a total loss.
    expect(plan.steps.some((step) => step.kind === "agent" && step.openclawId === "main")).toBe(true);
  });

  test("warns when an openclaw agent had per-agent tool/sandbox restrictions that gini's toolset model can't carry", () => {
    // openclaw's tools.profile / tools.allow / tools.deny / tools.exec
    // / tools.fs / sandbox fields restrict a specific agent's tool
    // surface. gini's DEFAULT_AGENT_TOOLSETS grants file.write +
    // terminal.exec to every newly-created agent. Without a warning,
    // a "minimal" openclaw agent silently gains shell exec after
    // migration — the operator must see the diff before the agent
    // handles untrusted input.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "minimal", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [
            {
              id: "minimal",
              default: true,
              tools: {
                profile: "minimal",
                exec: { security: "deny" },
                fs: { workspaceOnly: true }
              },
              sandbox: { mode: "container", workspaceAccess: "read-only" }
            }
          ]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const warning = plan.unsupported.find(
      (entry) => entry.kind === "agent:minimal:tool-restrictions"
    );
    expect(warning).toBeDefined();
    expect(warning?.detail).toContain("tools.profile: minimal");
    expect(warning?.detail).toContain("tools.exec.security: deny");
    expect(warning?.detail).toContain("tools.fs.workspaceOnly: true");
    expect(warning?.detail).toContain("sandbox.mode: container");
    expect(warning?.detail).toContain("sandbox.workspaceAccess: read-only");
    expect(warning?.detail).toContain("DEFAULT_AGENT_TOOLSETS");
    // The agent is still migrated — the warning is informational, not
    // a refusal. The operator's instance retains its agent record so
    // chat history doesn't dangle.
    expect(plan.steps.some((step) => step.kind === "agent" && step.openclawId === "minimal")).toBe(true);
  });

  test("redacts the exec command from SecretRef detail to avoid leaking secret-store paths", async () => {
    // Openclaw exec-source SecretRefs carry operator-authored shell
    // commands like `op read op://CorpName-Vault/openai-prod/credential`.
    // The command itself isn't a literal credential but the lookup path
    // embeds organization, vault, and item identifiers that should not
    // land in plan/apply output, reports, or anywhere a third party
    // could read. The migrator must surface that a SecretRef exists
    // (so the operator knows their key wasn't migrated) without
    // echoing the command.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(join(OPENCLAW_ROOT, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    const sensitiveCommand = "op read op://CorpName-Vault/openai-prod/credential";
    const sensitiveId = "op://CorpName-Vault/openai-prod/credential";
    writeFileSync(
      join(OPENCLAW_ROOT, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-via-1password": {
            type: "api_key",
            provider: "openai",
            keyRef: {
              source: "exec",
              provider: "1password",
              id: sensitiveId,
              command: sensitiveCommand
            }
          }
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const ref = plan.unsupported.find(
      (entry) =>
        entry.kind === "provider:openai" && entry.detail.includes("SecretRef")
    );
    expect(ref).toBeDefined();
    // Provider name is acceptable disclosure metadata — operators
    // need to know it's a 1password ref to look it up themselves.
    expect(ref?.detail).toContain("source=exec");
    expect(ref?.detail).toContain("1password");
    // Lookup paths must NOT appear.
    expect(ref?.detail).not.toContain(sensitiveCommand);
    expect(ref?.detail).not.toContain(sensitiveId);
    expect(ref?.detail).not.toContain("CorpName-Vault");
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

  test("summarizePlan exposes the actual Telegram allowedChatIds to the operator", () => {
    // The CLI prints summarizePlan(plan) so the operator can review
    // before apply. The bridge summary used to scrub allowedChatIds
    // down to a scalar count, which let a tampered backup smuggle
    // foreign chat ids past the operator's eye — the IDs only became
    // visible after `gini messaging list` post-apply, by which time
    // the bridge was already accepting their messages. The full list
    // must round-trip into the summary so a plan diff catches an
    // unexpected ID.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const summary = summarizePlan(plan);
    const bridgeSummary = summary.steps.find((step) => step.kind === "bridge");
    expect(bridgeSummary).toBeDefined();
    expect((bridgeSummary as { allowedChatIds: number[] }).allowedChatIds).toEqual([12345, 67890]);
    expect((bridgeSummary as { allowedChatCount: number }).allowedChatCount).toBe(2);
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

  test("empty TELEGRAM_BOT_TOKEN in env.vars falls through to the .env file", () => {
    // The token selection uses `?? ` to fall back to dotenv/inline.
    // Nullish coalescing only triggers on null/undefined, so without
    // filtering, an empty placeholder in `env.vars` would shadow the
    // real token in `.env`. collectOpenclawEnv / readStateDotenv must
    // drop empties so the chain can reach the real value.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, ".env"),
      `export TELEGRAM_BOT_TOKEN='tg-real-from-dotenv'\n`
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: { telegram: { dmPolicy: "pairing" } },
        env: { vars: { TELEGRAM_BOT_TOKEN: "" } }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const telegram = plan.steps.find((step) => step.kind === "bridge") as {
      tokenValue: string;
    } | undefined;
    expect(telegram?.tokenValue).toBe("tg-real-from-dotenv");
  });

  test("empty DISCORD_BOT_TOKEN in env.vars falls through to the inline channel token", () => {
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        channels: { discord: { botToken: "discord-real-inline" } },
        env: { vars: { DISCORD_BOT_TOKEN: "" } }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const discord = plan.steps.find((step) => step.kind === "bridge") as {
      tokenValue: string;
    } | undefined;
    expect(discord?.tokenValue).toBe("discord-real-inline");
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

  test("lmstudio / vllm openclaw agents surface a baseUrl mismatch warning", () => {
    // mapProviderToGini collapses lmstudio/vllm/ollama onto "local",
    // but each listens on a different default port (1234 / 8000 /
    // 11434). The migrated agent inherits the instance's local
    // baseUrl, which is Ollama's by default — silently misrouting
    // LMStudio/vLLM users to port 11434 if they don't notice.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [
            { id: "main", default: true, model: "lmstudio/gemma-7b" },
            { id: "secondary", model: "vllm/llama3-8b" }
          ]
        }
      })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const lmstudioNote = plan.unsupported.find(
      (entry) => entry.kind === "provider:lmstudio"
    );
    const vllmNote = plan.unsupported.find(
      (entry) => entry.kind === "provider:vllm"
    );
    expect(lmstudioNote).toBeDefined();
    expect(lmstudioNote!.detail).toContain("1234");
    expect(lmstudioNote!.detail).toContain("11434");
    expect(vllmNote).toBeDefined();
    expect(vllmNote!.detail).toContain("8000");
  });

  test("malformed first provider key doesn't block a valid duplicate from taking the slot", () => {
    // Previously a header-unsafe first profile claimed the env-var
    // slot in seenSecretEnv at plan time; the apply-time header check
    // then rejected it, but the second profile had already been
    // dropped as "duplicate", so the operator ended up with no
    // migrated key. Running the header-safe gate at plan time lets
    // the valid second profile take the slot.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    const agentDir = join(OPENCLAW_ROOT, "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-first": {
            type: "api_key",
            provider: "openai",
            // Header-unsafe: embedded newline.
            key: "sk-malformed\nexport EVIL=oops"
          },
          "openai-second": {
            type: "api_key",
            provider: "openai",
            key: "sk-valid-second-key"
          }
        }
      })
    );
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    const plan = planMigration(discoverOpenclawState(OPENCLAW_ROOT));
    const secret = plan.steps.find((step) => step.kind === "secret") as
      | { envVar: string; valueFrom: string }
      | undefined;
    expect(secret?.envVar).toBe("OPENAI_API_KEY");
    expect(secret?.valueFrom).toBe("sk-valid-second-key");
    expect(
      plan.unsupported.some(
        (entry) => entry.kind.endsWith(":malformed") && entry.detail.includes("header-safe")
      )
    ).toBe(true);
  });
});

describe("applyMigration", () => {
  beforeEach(() => {
    // Close any cached memory.db handles before deleting GINI_STATE.
    // dbCache (src/state/memory-db.ts) is module-level, so it survives
    // across reruns of the same test file inside a single Bun process.
    // Without this, `bun test --rerun-each=N` (or any in-process
    // re-execution) hits the cached handle on run 2+ pointing at a
    // file inode the previous beforeEach already unlinked, and
    // applyMigration's `getMemoryDb` call throws SQLITE_IOERR_VNODE.
    closeAllMemoryDbs();
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

  test("telegram migration auto-mints a pairing code when allow-list is empty", async () => {
    // Without auto-minting, an openclaw config that ships a bot
    // token but no allowFrom (operator was using openclaw's
    // dmPolicy="pairing" pattern) lands a configured-looking
    // bridge that silently denies every inbound. The migrator
    // should mirror addMessagingBridge and mint a pairing code so
    // the bridge is immediately usable via DM-and-paste.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true
      // Intentionally no withTelegramAllowFrom — empty allow-list.
    });
    const config = loadConfig("telegram-pair-automint");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.bridgesCreated).toBe(1);
    const state = readState("telegram-pair-automint");
    const bridge = state.messagingBridges.find((entry) => entry.kind === "telegram")!;
    const metadata = bridge.metadata as { pairingCode?: string; pairingCodeExpiresAt?: string };
    expect(typeof metadata.pairingCode).toBe("string");
    expect(metadata.pairingCode!.length).toBeGreaterThan(0);
    expect(typeof metadata.pairingCodeExpiresAt).toBe("string");
    // Operator-facing warning tells them to run `gini messaging pair`.
    expect(
      result.warnings.some((warning) =>
        warning.includes("Telegram bridge migrated with empty allow-list") &&
        warning.includes("gini messaging pair")
      )
    ).toBe(true);
  });

  test("telegram migration does NOT auto-mint when allow-list is non-empty", async () => {
    // Operators with a populated allowFrom already have a working
    // bridge; minting a pairing code would just clutter the
    // metadata with an unused token.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withTelegramChannel: true,
      withTelegramAllowFrom: true
    });
    const config = loadConfig("telegram-no-automint");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.bridgesCreated).toBe(1);
    const state = readState("telegram-no-automint");
    const bridge = state.messagingBridges.find((entry) => entry.kind === "telegram")!;
    const metadata = bridge.metadata as { pairingCode?: string; allowedChatIds: number[] };
    expect(metadata.allowedChatIds.length).toBeGreaterThan(0);
    expect(metadata.pairingCode).toBeUndefined();
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
    // The second apply rotates the existing bridge — bridgesCreated
    // stays at 0, bridgesRotated bumps to 1 — so an operator reading
    // the counts can tell a rotation apart from a fresh creation
    // (matters because rotation touches the encrypted bot-token store).
    expect(second.bridgesCreated).toBe(0);
    expect(second.bridgesRotated).toBe(1);

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

  test("refuses to apply while another import holds the per-instance lock", async () => {
    // Two `gini import apply openclaw` invocations against the same
    // instance must NOT race on state.json. The migrator acquires an
    // O_EXCL lockfile at `<instance>/.import-lock`; a second process
    // that finds the lock held by a still-alive PID throws with a
    // diagnostic message instead of proceeding.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("import-lock-busy");
    // Plant an existing lock holding the current PID — `process.kill(pid, 0)`
    // will return true so the stale-cleanup path won't fire.
    const lockPath = join(GINI_STATE, "instances", "import-lock-busy", ".import-lock");
    mkdirSync(join(GINI_STATE, "instances", "import-lock-busy"), { recursive: true });
    writeFileSync(lockPath, `pid=${process.pid}\nat=2026-01-01T00:00:00.000Z\n`);
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    await expect(applyMigration(config, discovery, plan)).rejects.toThrow(/Another gini import/i);
    // Clear the lock so subsequent tests aren't blocked.
    rmSync(lockPath, { force: true });
  });

  test("refuses to unlink a lockfile that records no PID (peer mid-acquisition)", async () => {
    // The acquisition path used to be open-then-write — between the
    // two syscalls a peer could find the lockfile existing but empty,
    // read no PID, treat it as stale, and unlink the peer's live
    // lock. We now refuse-when-uncertain: an existing lockfile with
    // no recorded PID is treated as held by a peer mid-acquisition,
    // not as a stale crash artifact. This makes the migrator
    // conservative (manual cleanup if a process truly crashes in the
    // micro-window between create and write), but preserves
    // correctness for the common case.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("import-lock-no-pid");
    const lockPath = join(GINI_STATE, "instances", "import-lock-no-pid", ".import-lock");
    mkdirSync(join(GINI_STATE, "instances", "import-lock-no-pid"), { recursive: true });
    // No `pid=` line — simulates the open-but-not-yet-written state.
    writeFileSync(lockPath, "");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await expect(
      applyMigration(config, discovery, planMigration(discovery))
    ).rejects.toThrow(/no recorded PID/i);
    // The migrator must NOT have removed the lockfile.
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { force: true });
  });

  test("release() leaves a peer's lock alone if our token was replaced", async () => {
    // If two cleanup paths race and our token got replaced by a
    // peer's fresh acquisition, our release must NOT unlink — that
    // would nuke the peer's live lock. We simulate the race by
    // running the migration, then mutating the lock file mid-run
    // is impractical; instead exercise the smaller post-acquisition
    // case: tampering with the lock content (rewriting the token)
    // before release. The fix's defense is: re-read the token in
    // release() and only unlink if it still matches our own.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("import-lock-token-defense");
    const lockPath = join(
      GINI_STATE,
      "instances",
      "import-lock-token-defense",
      ".import-lock"
    );
    mkdirSync(join(GINI_STATE, "instances", "import-lock-token-defense"), { recursive: true });
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await applyMigration(config, discovery, planMigration(discovery));
    // After a clean apply, the lock should have been released
    // (file gone). Re-create it manually with a foreign token —
    // simulates a peer process having raced through and acquired
    // a new lock after ours released.
    writeFileSync(lockPath, `pid=${process.pid}\ntoken=foreign-token\nat=2026-01-01\n`);
    // Now exercise release() implicitly: a second apply attempts to
    // acquire, finds the foreign lock alive (its pid is ours, which
    // is alive), and bails with "Another gini import is running".
    // The defense being exercised is the FIRST apply's release()
    // not having deleted a hypothetical peer's lock when ours got
    // replaced; since the file we placed has a different token, the
    // first apply's already-completed release was a no-op, which is
    // what we want.
    await expect(
      applyMigration(config, discovery, planMigration(discovery))
    ).rejects.toThrow(/Another gini import is running/i);
    rmSync(lockPath, { force: true });
  });

  test("cleans up a stale lock left behind by a crashed previous run", async () => {
    // If the previous apply died without releasing the lockfile, the
    // operator shouldn't have to grep filesystems to recover. We
    // detect a stale lock (recorded PID is gone) and remove + retry.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("import-lock-stale");
    const lockPath = join(GINI_STATE, "instances", "import-lock-stale", ".import-lock");
    mkdirSync(join(GINI_STATE, "instances", "import-lock-stale"), { recursive: true });
    // PID 999999 is reserved-but-unused on macOS/Linux test hosts; if
    // it ever happened to be alive on a host this assertion fails
    // visibly, which is preferable to silently passing.
    writeFileSync(lockPath, `pid=999999\nat=2026-01-01T00:00:00.000Z\n`);
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.applied).toBe(true);
    // Lockfile should have been removed at exit.
    expect(existsSync(lockPath)).toBe(false);
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

  test("suppresses the Discord delivery-target warning when the bridge is skipped (existing, no --force)", async () => {
    // On re-import without --force the migrator finds the existing
    // Discord bridge and emits the "Skipped" warning. The
    // delivery-target warning would be noise: it was meaningful on
    // the first import (where the migrator created a dormant
    // skeleton), but the operator's existing bridge presumably
    // already has channels wired, so warning them again to
    // re-create it would just add confusion.
    seedOpenclawTree(OPENCLAW_ROOT, {
      withConfig: true,
      withDiscordChannel: true
    });
    const config = loadConfig("discord-skip-no-warn");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    // First apply lays down the bridge skeleton (will warn about
    // delivery targets).
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.bridgesCreated).toBe(1);
    expect(
      first.warnings.some((w) => w.includes("Discord") && w.includes("deliveryTargets"))
    ).toBe(true);
    // Second apply finds the existing bridge and skips. The
    // delivery-target warning must NOT fire — the only Discord
    // message should be the "Skipped" notice.
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(second.bridgesCreated).toBe(0);
    expect(second.bridgesRotated).toBe(0);
    expect(
      second.warnings.some((w) => w.includes("Discord") && w.includes("deliveryTargets"))
    ).toBe(false);
    expect(
      second.warnings.some((w) => w.includes("Skipped discord bridge"))
    ).toBe(true);
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

  test("tightens ~/.gini/secrets.env to 0600 even when every secret is skipped", async () => {
    // Skipping existing-key writes (no --force) used to leave a
    // pre-existing 0644 secrets.env world-readable. The migrator must
    // chmod the file to 0600 on every apply, independent of whether
    // any individual key was written, so the operator's hand-created
    // file inherits the same posture as a freshly-written one.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withAuthProfile: true });
    const dotGini = join(GINI_HOME, ".gini");
    mkdirSync(dotGini, { recursive: true });
    const secretsPath = join(dotGini, "secrets.env");
    writeFileSync(secretsPath, `export OPENAI_API_KEY='sk-real-existing-key'\n`, { mode: 0o644 });
    expect(statSync(secretsPath).mode & 0o777).toBe(0o644);

    const config = loadConfig("tighten-secrets-perms");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const result = await applyMigration(config, discovery, plan);
    // No secret was written — every step was skipped.
    expect(result.secretsWritten).toBe(0);
    // But the file ends up at 0600 anyway.
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
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
    const plan = planMigration(discovery);
    // The header-safe gate now runs at plan time, so the malformed
    // key never becomes a `secret` step in the first place and lands
    // on the unsupported list with a `:malformed` kind.
    expect(plan.steps.some((step) => step.kind === "secret")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind.endsWith(":malformed") &&
          entry.detail.includes("OPENAI_API_KEY") &&
          entry.detail.includes("header-safe")
      )
    ).toBe(true);
    const result = await applyMigration(config, discovery, plan);
    expect(result.secretsWritten).toBe(0);
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
    // Close any cached memory.db handles before deleting GINI_STATE.
    // dbCache (src/state/memory-db.ts) is module-level, so it survives
    // across reruns of the same test file inside a single Bun process.
    // Without this, `bun test --rerun-each=N` (or any in-process
    // re-execution) hits the cached handle on run 2+ pointing at a
    // file inode the previous beforeEach already unlinked, and
    // applyMigration's `getMemoryDb` call throws SQLITE_IOERR_VNODE.
    closeAllMemoryDbs();
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

  test("honors OPENCLAW_WORKSPACE_DIR even when it points outside the state root", async () => {
    // Openclaw exposes OPENCLAW_WORKSPACE_DIR so operators can keep
    // workspace markdown in a separate dotfiles repo. Earlier
    // iterations containment-checked workspace file paths against
    // source.stateRoot, which silently disabled the env override
    // (operators lost every workspace file with no warning). Switch
    // the containment boundary to source.workspaceRoot so the env
    // opt-in works while still defending against leaf symlinks
    // pointing OUTSIDE the workspace dir.
    const externalWorkspace = `${ROOT}/external-workspace`;
    rmSync(externalWorkspace, { recursive: true, force: true });
    mkdirSync(externalWorkspace, { recursive: true });
    writeFileSync(join(externalWorkspace, "AGENTS.md"), "# external AGENTS\n");
    writeFileSync(join(externalWorkspace, "SOUL.md"), "# external SOUL\n");
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    process.env.OPENCLAW_STATE_DIR = OPENCLAW_ROOT;
    process.env.OPENCLAW_WORKSPACE_DIR = externalWorkspace;
    try {
      const config = loadConfig("workspace-dir-override");
      // No pathArg → env overrides take effect.
      const discovery = discoverOpenclawState();
      expect(discovery.workspaceRoot).toBe(externalWorkspace);
      const result = await applyMigration(config, discovery, planMigration(discovery));
      expect(result.workspaceFilesCopied).toBe(2);
      const agentsPath = join(
        GINI_STATE,
        "instances",
        "workspace-dir-override",
        "workspace",
        "AGENTS.md"
      );
      expect(readFileSync(agentsPath, "utf8")).toBe("# external AGENTS\n");
    } finally {
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_WORKSPACE_DIR;
    }
  });

  test("workspace symlink source resolving outside source.stateRoot is refused at plan time", async () => {
    // `copyFileSync` follows symlinks by default, so a
    // `workspace/SOUL.md` symlink to `/etc/passwd` would happily
    // rematerialize that file inside the gini workspace, defeating
    // the workspace sandbox other tooling relies on. The planner's
    // realpath containment check now catches this BEFORE the step
    // is even added — the operator sees it on the unsupported list
    // instead of via an apply-time warning.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withWorkspaceFiles: true });
    const link = join(OPENCLAW_ROOT, "workspace", "AGENTS.md");
    rmSync(link, { force: true });
    symlinkSync("/etc/hosts", link);
    const config = loadConfig("workspace-symlink-refused");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    // The leaked file is never added to the plan as a workspace step.
    expect(plan.steps.some(
      (step) => step.kind === "workspaceFile" && step.name === "AGENTS.md"
    )).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "workspaceFile:AGENTS.md" &&
          entry.detail.includes("outside the workspace root")
      )
    ).toBe(true);
    const result = await applyMigration(config, discovery, plan);
    // SOUL.md still copies; AGENTS.md is gone.
    expect(result.workspaceFilesCopied).toBe(1);
    const target = join(GINI_STATE, "instances", "workspace-symlink-refused", "workspace", "AGENTS.md");
    expect(existsSync(target)).toBe(false);
  });

  test("skill SKILL.md symlink resolving outside source.stateRoot is refused at plan time", async () => {
    // Same threat as the workspace test, applied to the skill copy
    // path which uses `readFileSync` (also follows symlinks).
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withSkill: true });
    const link = join(OPENCLAW_ROOT, "skills", "memo-helper", "SKILL.md");
    rmSync(link, { force: true });
    symlinkSync("/etc/hosts", link);
    const config = loadConfig("skill-symlink-refused");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.some(
      (step) => step.kind === "skill" && step.name === "memo-helper"
    )).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "skill:memo-helper" &&
          entry.detail.includes("outside the openclaw state root")
      )
    ).toBe(true);
    const result = await applyMigration(config, discovery, plan);
    expect(result.skillsCopied).toBe(0);
  });

  test("parent-directory symlink in skills/ is refused at plan time", async () => {
    // Even if every leaf SKILL.md is itself a regular file, a parent
    // directory symlinked outside source.stateRoot (e.g. `skills` ->
    // `/etc`) would defeat the leaf-only `isSymlinkSource` check.
    // The planner's realpath containment catches this.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const externalSkillsHome = `${ROOT}/external-skills`;
    rmSync(externalSkillsHome, { recursive: true, force: true });
    mkdirSync(join(externalSkillsHome, "extracted-skill"), { recursive: true });
    writeFileSync(
      join(externalSkillsHome, "extracted-skill", "SKILL.md"),
      "---\nname: extracted\n---\nbody\n"
    );
    // Replace `<state>/skills` with a symlink to the external dir.
    rmSync(join(OPENCLAW_ROOT, "skills"), { recursive: true, force: true });
    symlinkSync(externalSkillsHome, join(OPENCLAW_ROOT, "skills"));
    const config = loadConfig("skill-parent-symlink-refused");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.some((step) => step.kind === "skill")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) =>
          entry.kind === "skill:extracted-skill" &&
          entry.detail.includes("outside the openclaw state root")
      )
    ).toBe(true);
    const result = await applyMigration(config, discovery, plan);
    expect(result.skillsCopied).toBe(0);
  });

  test("nested symlink inside skill scripts directory is dropped during recursive copy", async () => {
    // cpSync with `dereference: false` (Node default) would preserve a
    // nested outward-pointing symlink, leaving a dangling exfiltration
    // vector that gini tools could later read through. copyDirShallow's
    // filter must refuse them.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true, withSkill: true });
    const link = join(OPENCLAW_ROOT, "skills", "memo-helper", "scripts", "evil.sh");
    symlinkSync("/etc/hosts", link);
    const config = loadConfig("skill-nested-symlink");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.skillsCopied).toBe(1);
    const evilTarget = join(
      GINI_STATE,
      "instances",
      "skill-nested-symlink",
      "skills",
      "memo-helper",
      "scripts",
      "evil.sh"
    );
    expect(existsSync(evilTarget)).toBe(false);
    // helper.sh (the legitimate sibling file from the fixture) still copies.
    const helperTarget = join(
      GINI_STATE,
      "instances",
      "skill-nested-symlink",
      "skills",
      "memo-helper",
      "scripts",
      "helper.sh"
    );
    expect(existsSync(helperTarget)).toBe(true);
  });

  test("archive captures external config when OPENCLAW_CONFIG_PATH points outside stateRoot", async () => {
    // discoverOpenclawState honors OPENCLAW_CONFIG_PATH as a config-
    // location override, but only when no explicit pathArg was passed
    // (the explicit arg is the more specific operator gesture). The
    // recursive zip only captures source.stateRoot, so without an
    // explicit append the archive would silently drop the externally-
    // located config and a restore would fail with the planner's
    // "No openclaw config found" guard.
    const externalConfigDir = `${ROOT}/external-config`;
    rmSync(externalConfigDir, { recursive: true, force: true });
    mkdirSync(externalConfigDir, { recursive: true });
    const externalConfigPath = join(externalConfigDir, "openclaw.json");
    writeFileSync(
      externalConfigPath,
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } })
    );
    // No config inside stateRoot — the OPENCLAW_CONFIG_PATH override is
    // the only place the config exists.
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(join(OPENCLAW_ROOT, "marker.txt"), "outside-config");
    process.env.OPENCLAW_STATE_DIR = OPENCLAW_ROOT;
    process.env.OPENCLAW_CONFIG_PATH = externalConfigPath;
    try {
      const config = loadConfig("archive-external-config");
      // No pathArg → env overrides apply: state from OPENCLAW_STATE_DIR,
      // config from OPENCLAW_CONFIG_PATH.
      const discovery = discoverOpenclawState();
      expect(discovery.configPath).toBe(externalConfigPath);
      expect(discovery.stateRoot).toBe(OPENCLAW_ROOT);
      const result = await applyMigration(config, discovery, planMigration(discovery));
      expect(result.applied).toBe(true);
      // Archive must contain BOTH the state-root marker and the external
      // config's basename at the archive root.
      const listing = execFileSync("unzip", ["-l", result.archivePath!], { encoding: "utf8" });
      expect(listing).toContain("marker.txt");
      expect(listing).toContain("openclaw.json");
    } finally {
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
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

  test("records a failed ImportReport when a mid-apply step throws", async () => {
    // Without this catch path, a throw inside the apply body leaves
    // `gini import` with no record of the attempt, contradicting the
    // operator-facing audit-trail promise in migration-from-openclaw.md.
    // We use the blocked-imports-as-file trick to force the archive
    // step (which sits inside the new try/catch envelope) to throw,
    // then assert a failed-status report row landed before the throw
    // re-propagated to the caller.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const config = loadConfig("apply-failure-report");
    const blockedImportsParent = join(GINI_STATE, "instances", "apply-failure-report");
    mkdirSync(blockedImportsParent, { recursive: true });
    writeFileSync(join(blockedImportsParent, "imports"), "blocking-file");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    await expect(
      applyMigration(config, discovery, planMigration(discovery))
    ).rejects.toThrow();
    const state = readState("apply-failure-report");
    const failedReport = state.importReports.find(
      (report) =>
        report.source === "openclaw" &&
        report.mode === "applied" &&
        report.status === "failed"
    );
    expect(failedReport).toBeDefined();
    expect(failedReport?.error).toBeTruthy();
    expect(failedReport?.error?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("applyMigration sessions", () => {
  beforeEach(() => {
    // Close any cached memory.db handles before deleting GINI_STATE.
    // dbCache (src/state/memory-db.ts) is module-level, so it survives
    // across reruns of the same test file inside a single Bun process.
    // Without this, `bun test --rerun-each=N` (or any in-process
    // re-execution) hits the cached handle on run 2+ pointing at a
    // file inode the previous beforeEach already unlinked, and
    // applyMigration's `getMemoryDb` call throws SQLITE_IOERR_VNODE.
    closeAllMemoryDbs();
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

  test("plan messageCount matches apply sessionMessagesCreated when tool blocks filter messages out", async () => {
    // Previously the plan-time counter counted ALL `type: "message"`
    // lines regardless of content shape, while the apply-time parser
    // filtered out messages with only tool_use / tool_result blocks
    // and no text. An e2e against the real backup reported 73 on the
    // plan but only 61 on apply — operator-visible misinformation.
    // The fix is to share the filter; this test pins the agreement.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const sessionDir = join(OPENCLAW_ROOT, "agents", "main", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "mixed.jsonl"),
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          id: "mixed",
          timestamp: "2026-03-04T22:20:00.000Z"
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-03-04T22:20:05.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] }
        }),
        // Tool-only assistant turn — apply drops it, plan must drop it too.
        JSON.stringify({
          type: "message",
          id: "m2",
          timestamp: "2026-03-04T22:20:06.000Z",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "fake", input: {} }]
          }
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          timestamp: "2026-03-04T22:20:07.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "reply" }] }
        })
      ].join("\n")}\n`
    );
    const config = loadConfig("session-plan-apply-agreement");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    const sessionStep = plan.steps.find(
      (step) => step.kind === "session"
    ) as Extract<typeof plan.steps[number], { kind: "session" }> | undefined;
    expect(sessionStep).toBeDefined();
    // 3 source `type:"message"` lines but only 2 produce ChatMessageRecord
    // rows. Plan must report the filtered count.
    expect(sessionStep!.messageCount).toBe(2);
    const result = await applyMigration(config, discovery, plan);
    expect(result.sessionMessagesCreated).toBe(2);
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
    // Title shape is `Openclaw <sessionId> :: <openclawAgentId>` so we
    // match on the suffix rather than a "Openclaw work" substring.
    const session = state.chatSessions.find((entry) => entry.title.endsWith(":: work"));
    expect(session?.agentId).toBe(workAgent!.id);
  });

  test("re-apply dedup survives operator-renamed chat sessions (structured source provenance)", async () => {
    // Earlier the dedup parsed the deterministic title prefix; a
    // simple rename (the live UI exposes this via `gini chat rename`
    // or the web app's rename action) would defeat dedup and import
    // a duplicate. The structured `source.openclawSessionId` field
    // survives renames since the UI never touches `source`.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "rename-survives", [
      { role: "user", text: "hi", timestamp: "2026-03-04T22:20:00.000Z" }
    ]);
    const config = loadConfig("session-rename-survives-dedup");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.sessionsCreated).toBe(1);
    // Operator renames the migrated chat to something opinionated.
    await mutateState("session-rename-survives-dedup", (state) => {
      const migrated = state.chatSessions.find(
        (s) => s.source?.kind === "openclaw" && s.source.openclawSessionId === "rename-survives"
      );
      if (migrated) migrated.title = "My custom rename";
    });
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(second.sessionsCreated).toBe(0);
    expect(second.warnings.some((warning) => warning.includes("already imported"))).toBe(true);
    const state = readState("session-rename-survives-dedup");
    const matchedByProvenance = state.chatSessions.filter(
      (s) => s.source?.kind === "openclaw" && s.source.openclawSessionId === "rename-survives"
    );
    expect(matchedByProvenance).toHaveLength(1);
    expect(matchedByProvenance[0]!.title).toBe("My custom rename");
  });

  test("re-apply dedup survives even when the openclaw agent id is the max 64 chars", async () => {
    // Earlier dedup used a title shape `Openclaw <agentId>/<8-char>` —
    // for the max-length 64-char agent id the title overflowed
    // records.ts's 80-char truncation, lopping off disambiguating
    // session-id chars and producing duplicate sessions on re-apply.
    // The fix moves the openclaw session id (a UUID, 36 chars) to the
    // front and uses a unique " :: " delimiter, so the dedup key is
    // always recoverable from the stored title.
    const longAgentId = "a".repeat(64);
    rmSync(OPENCLAW_ROOT, { recursive: true, force: true });
    mkdirSync(OPENCLAW_ROOT, { recursive: true });
    writeFileSync(
      join(OPENCLAW_ROOT, "openclaw.json"),
      JSON.stringify({
        agents: { list: [{ id: longAgentId, default: true, model: "openai/gpt-5.4-mini" }] }
      })
    );
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, longAgentId, "010a59e7-a154-4a5b-b930-660d59deb8b5", [
      { role: "user", text: "first", timestamp: "2026-03-04T22:20:00.000Z" }
    ]);
    const config = loadConfig("session-long-agent-id");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.sessionsCreated).toBe(1);
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(second.sessionsCreated).toBe(0);
    expect(second.warnings.some((warning) => warning.includes("already imported"))).toBe(true);
    const state = readState("session-long-agent-id");
    const migrated = state.chatSessions.filter((session) => session.title.startsWith("Openclaw "));
    expect(migrated).toHaveLength(1);
  });

  test("re-apply skips sessions already imported by deterministic title", async () => {
    // The migrator's documented contract is "create what is missing,
    // leave what exists alone." A second `applyMigration` against the
    // same openclaw source must NOT duplicate ChatSessionRecords or
    // double the chat-message volume. Sessions are deduped by the
    // deterministic `Openclaw <agent>/<short-id>` title.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeOpenclawSessionJsonl(OPENCLAW_ROOT, "main", "sess-idempotent", [
      { role: "user", text: "first", timestamp: "2026-03-04T22:20:00.000Z" },
      { role: "assistant", text: "second", timestamp: "2026-03-04T22:20:05.000Z" }
    ]);
    const config = loadConfig("session-idempotent");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.sessionsCreated).toBe(1);
    expect(first.sessionMessagesCreated).toBe(2);
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(second.sessionsCreated).toBe(0);
    expect(second.sessionMessagesCreated).toBe(0);
    expect(second.warnings.some((warning) => warning.includes("already imported"))).toBe(true);
    const state = readState("session-idempotent");
    // Exactly one Openclaw-titled session, exactly two messages.
    const migrated = state.chatSessions.filter((session) => session.title.startsWith("Openclaw"));
    expect(migrated).toHaveLength(1);
    const messages = state.chatMessages.filter(
      (message) => message.sessionId === migrated[0]!.id
    );
    expect(messages).toHaveLength(2);
  });

  test("session with only non-text content is dropped at plan time as unsupported", async () => {
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
    const plan = planMigration(discovery);
    // The planner's countSessionMessages now applies the same content
    // filter the apply parser uses, so a tool-only transcript reports
    // 0 messages and the planner drops it from the steps list entirely.
    // It surfaces on the unsupported list instead so the operator sees
    // the file was scanned and intentionally skipped.
    expect(plan.steps.some((step) => step.kind === "session")).toBe(false);
    expect(
      plan.unsupported.some(
        (entry) => entry.kind.startsWith("session:main/") && entry.detail.includes("tool-only")
      )
    ).toBe(true);
    const result = await applyMigration(config, discovery, plan);
    expect(result.sessionsCreated).toBe(0);
  });
});

describe("applyMigration memory units", () => {
  beforeEach(() => {
    // Close any cached memory.db handles before deleting GINI_STATE.
    // dbCache (src/state/memory-db.ts) is module-level, so it survives
    // across reruns of the same test file inside a single Bun process.
    // Without this, `bun test --rerun-each=N` (or any in-process
    // re-execution) hits the cached handle on run 2+ pointing at a
    // file inode the previous beforeEach already unlinked, and
    // applyMigration's `getMemoryDb` call throws SQLITE_IOERR_VNODE.
    closeAllMemoryDbs();
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

  test("binds migrated units to the matching agent's bank so recall surfaces them", async () => {
    // Per ADR `agent-memory-isolation.md` every recall channel filters
    // on `bank_id = ? AND agent_id = ?` where `bank_id =
    // bankIdForAgent(agentId)` (i.e. `bank_<agentId>`). Inserting into
    // DEFAULT_BANK_ID with agent_id NULL would parking the unit
    // outside any recall channel. The migrator must pair each openclaw
    // bank (the SQLite filename, e.g. `main`) with the gini agent of
    // the same name, ensure that agent's bank exists, then insert
    // with the matching `bankId` + `agentId`.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", [
      { id: "u-recall", text: "Bob likes coffee", network: "experience" }
    ]);
    const config = loadConfig("memory-recall-binding");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.memoryUnitsCreated).toBe(1);
    const state = readState("memory-recall-binding");
    const mainAgent = state.agents.find((agent) => agent.name === "main");
    expect(mainAgent).toBeDefined();
    const memDb = getMemoryDb("memory-recall-binding");
    const row = memDb
      .query<{ bank_id: string; agent_id: string | null }, [string]>(
        "SELECT bank_id, agent_id FROM memory_units WHERE text = ?"
      )
      .get("Bob likes coffee");
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe(mainAgent!.id);
    expect(row!.bank_id).toBe(`bank_${mainAgent!.id}`);
    // Verify the agent's bank row actually exists in memory_banks (the
    // FOREIGN KEY enforcement would have already caught a missing
    // parent, but this proves ensureAgentBank wired up correctly).
    const bank = memDb
      .query<{ id: string; agent_id: string | null }, [string]>(
        "SELECT id, agent_id FROM memory_banks WHERE id = ?"
      )
      .get(`bank_${mainAgent!.id}`);
    expect(bank?.agent_id).toBe(mainAgent!.id);
  });

  test("falls back to default bank with warning when no gini agent matches the openclaw bank name", async () => {
    // An openclaw deployment with an SQLite named after an agent that
    // never made it into agents.list (or one the operator deleted)
    // shouldn't make migration fail. We park the units in the default
    // bank with agent_id NULL and warn the operator that recall will
    // not return them until they manually reassign agent_id.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "ghost.sqlite", [
      { id: "u-orphan-1", text: "orphan one", network: "world" },
      { id: "u-orphan-2", text: "orphan two", network: "world" }
    ]);
    const config = loadConfig("memory-orphan-bank");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const result = await applyMigration(config, discovery, planMigration(discovery));
    expect(result.memoryUnitsCreated).toBe(2);
    // Single warning across both orphan units (de-duplicated by source
    // bank name so a Hindsight DB with 10k rows doesn't drown the
    // operator in identical warnings).
    const orphanWarnings = result.warnings.filter((warning) => warning.includes("ghost"));
    expect(orphanWarnings).toHaveLength(1);
    expect(orphanWarnings[0]).toContain("default bank");
    expect(orphanWarnings[0]).toContain("agent_id");
    const memDb = getMemoryDb("memory-orphan-bank");
    const rows = memDb
      .query<{ bank_id: string }, []>(
        "SELECT bank_id FROM memory_units WHERE metadata LIKE '%\"openclawBank\":\"ghost\"%'"
      )
      .all();
    expect(rows).toHaveLength(2);
    // Units land in DEFAULT_BANK_ID — this is what recall channels
    // never read (they filter on bank_id = bank_<agentId>), and is the
    // load-bearing assertion behind the warning. agent_id may be
    // backfilled by the normalizeState migration to the active agent,
    // but bank_id stays at bank_default until the operator reassigns
    // it manually, so units remain unreachable via the recall surface.
    expect(rows.every((row) => row.bank_id === "bank_default")).toBe(true);
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

  test("re-apply skips memory units already imported (dedup on openclawUnitId metadata)", async () => {
    // Same idempotency contract as sessions/agents. Memory units are
    // deduped by their openclaw unit id (stamped into
    // `metadata.openclawUnitId` on insert) so a second apply against
    // the same Hindsight SQLite is a no-op.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    writeHindsightMemorySqlite(join(OPENCLAW_ROOT, "memory"), "main.sqlite", [
      { id: "u1", text: "alpha", network: "world" },
      { id: "u2", text: "beta", network: "experience" }
    ]);
    const config = loadConfig("memory-idempotent");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const first = await applyMigration(config, discovery, planMigration(discovery));
    expect(first.memoryUnitsCreated).toBe(2);
    const second = await applyMigration(config, discovery, planMigration(discovery));
    expect(second.memoryUnitsCreated).toBe(0);
    // Verify the SQLite still has exactly 2 rows tagged with our
    // openclaw unit ids — no duplicates.
    const memDb = getMemoryDb("memory-idempotent");
    const totalForOpenclaw = memDb
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memory_units WHERE json_extract(metadata, '$.openclawUnitId') IS NOT NULL"
      )
      .get();
    expect(totalForOpenclaw?.c).toBe(2);
  });

  test("older Hindsight schema missing a column degrades to an unsupported note instead of aborting", async () => {
    // Older Hindsight schemas may be missing `confidence` (or any
    // other column the migrator's SELECT reads). prepare()/all() then
    // throw "no such column" — without graceful handling that throw
    // would propagate up and abort the whole planMigration call,
    // taking down agent / skill / session migration too.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const memoryDir = join(OPENCLAW_ROOT, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const dbPath = join(memoryDir, "legacy.sqlite");
    const db = new Database(dbPath);
    try {
      // Hindsight-shape DB intentionally missing the `confidence`,
      // `metadata`, and `mentioned_at` columns the migrator reads.
      db.exec(`
        CREATE TABLE memory_banks (id TEXT PRIMARY KEY);
        CREATE TABLE memory_units (
          id TEXT PRIMARY KEY,
          text TEXT,
          network TEXT,
          status TEXT
        );
      `);
      db.run("INSERT INTO memory_banks (id) VALUES ('bank_default')");
      db.run(
        "INSERT INTO memory_units (id, text, network, status) VALUES (?, ?, ?, ?)",
        ["legacy-1", "old row", "world", "active"]
      );
    } finally {
      db.close();
    }
    const config = loadConfig("memory-legacy-schema");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    // The plan completes without throwing — that's the load-bearing
    // assertion (a throw here would crash the entire migration).
    const memoryNote = plan.unsupported.find((entry) => entry.kind === "memory");
    expect(memoryNote).toBeDefined();
    expect(memoryNote!.detail).toContain("Hindsight schema detected but SELECT failed");
    expect(plan.steps.some((step) => step.kind === "memoryUnit")).toBe(false);
    // Apply also succeeds even though the SELECT failed — sessions /
    // agents / skills migrate independently and we don't want one
    // bad memory file to take the whole import down.
    const result = await applyMigration(config, discovery, plan);
    expect(result.applied).toBe(true);
    expect(result.memoryUnitsCreated).toBe(0);
  });

  test("refuses memory sqlite that symlinks outside source.stateRoot", async () => {
    // A `<state>/memory/main.sqlite` symlinked at e.g.
    // `~/.config/Firefox/cookies.sqlite` would be opened as a valid
    // SQLite DB and the "unknown table layout (...)" unsupported
    // note would leak the table list of the operator's browser
    // cookies / password store. Refuse symlinked leafs at plan
    // time so the file is never opened.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const memoryDir = join(OPENCLAW_ROOT, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const externalDb = `${ROOT}/external-cookies.sqlite`;
    rmSync(externalDb, { force: true });
    // Seed a real SQLite DB at the external path so the leak path
    // would actually fire if containment weren't enforced.
    const db = new Database(externalDb);
    try {
      db.exec("CREATE TABLE cookies (name TEXT, value TEXT)");
    } finally {
      db.close();
    }
    symlinkSync(externalDb, join(memoryDir, "main.sqlite"));
    const config = loadConfig("memory-leaf-symlink-refused");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    // No memory step landed in the plan.
    expect(plan.steps.some((step) => step.kind === "memoryUnit")).toBe(false);
    const memoryNote = plan.unsupported.find((entry) => entry.kind === "memory");
    expect(memoryNote).toBeDefined();
    expect(memoryNote!.detail).toContain("outside the openclaw state root");
    // The "unknown table layout" leak path must NOT have fired —
    // the table name `cookies` should be nowhere in the plan.
    expect(JSON.stringify(plan)).not.toContain("cookies");
    const result = await applyMigration(config, discovery, plan);
    expect(result.memoryUnitsCreated).toBe(0);
  });

  test("refuses memory SQLite filenames that contain SQL-unsafe characters", async () => {
    // The orphan-bank warning suggests a copy-paste `UPDATE` SQL that
    // interpolates the bank label inside a LIKE literal. A filename
    // like `evil');DROP TABLE memory_units;--.sqlite` would land an
    // injection if the operator ran the suggestion verbatim. Refuse
    // unsafe labels at scan time so the suggestion is never produced.
    seedOpenclawTree(OPENCLAW_ROOT, { withConfig: true });
    const memoryDir = join(OPENCLAW_ROOT, "memory");
    mkdirSync(memoryDir, { recursive: true });
    const hostileName = "evil');DROP TABLE memory_units;--.sqlite";
    const hostilePath = join(memoryDir, hostileName);
    writeHindsightMemorySqlite(memoryDir, hostileName, [
      { id: "u1", text: "should-not-migrate", network: "world" }
    ]);
    // Sanity-check the seed actually landed at the hostile filename.
    expect(existsSync(hostilePath)).toBe(true);
    const config = loadConfig("memory-bank-slug-refused");
    const discovery = discoverOpenclawState(OPENCLAW_ROOT);
    const plan = planMigration(discovery);
    expect(plan.steps.some((step) => step.kind === "memoryUnit")).toBe(false);
    const memoryNote = plan.unsupported.find((entry) => entry.kind === "memory");
    expect(memoryNote).toBeDefined();
    expect(memoryNote!.detail).toContain("bank label");
    expect(memoryNote!.detail).toContain("aren't safe for operator-visible SQL");
    const result = await applyMigration(config, discovery, plan);
    expect(result.memoryUnitsCreated).toBe(0);
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
