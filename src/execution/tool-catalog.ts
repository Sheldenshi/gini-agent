// Tool catalog: the OpenAI-shaped tool specs the chat-task agent loop
// exposes to the model. Each tool name corresponds to a dispatch handler
// in src/execution/tool-dispatch.ts. Specs mirror the existing imperative
// tools in src/tools/* — same approval gating, same audit + trace surface.
//
// The list returned here is filtered by enabled toolsets (from
// `RuntimeState.toolsets`) so the user can disable a toolset and have the
// model never see its tools, just like the legacy /toolsets page.

import { createHash } from "node:crypto";
import type { ToolFunctionSpec } from "../provider";
import type { RuntimeState } from "../types";

// Canonical tool list. Initial set mirrors src/tools/* one-for-one. We keep
// each entry small and self-documenting so models with weaker tool-calling
// (local Llamas, some compat providers) still understand what each tool
// does without extra system-prompt context.
const TOOL_DEFS: Array<ToolFunctionSpec & { toolset: string }> = [
  {
    toolset: "file",
    type: "function",
    function: {
      name: "file_read",
      description: "Read a UTF-8 text file from the workspace. Returns up to 12000 characters.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." }
        },
        required: ["path"]
      }
    }
  },
  {
    toolset: "file",
    type: "function",
    function: {
      name: "file_list",
      description: "List entries in a directory inside the workspace. Returns up to 200 entries.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory. Defaults to '.'.", default: "." }
        }
      }
    }
  },
  {
    toolset: "file",
    type: "function",
    function: {
      name: "file_search",
      description: "Search workspace files for a substring (case-insensitive). Returns up to 100 path:line matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Substring to match." },
          path: { type: "string", description: "Workspace-relative directory to search. Defaults to '.'.", default: "." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    toolset: "file",
    type: "function",
    function: {
      name: "file_write",
      description: "Write a workspace file. Approval-gated: the user must approve before the file is written.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          content: { type: "string", description: "Full file content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    toolset: "file",
    type: "function",
    function: {
      name: "file_patch",
      description: "Patch a workspace file by replacing one block of text with another. Approval-gated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          oldText: { type: "string", description: "The exact existing text to replace. Must appear verbatim in the file." },
          newText: { type: "string", description: "The replacement text." }
        },
        required: ["path", "oldText", "newText"]
      }
    }
  },
  {
    toolset: "messaging",
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return up to 12000 characters of stripped text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." }
        },
        required: ["url"]
      }
    }
  },
  {
    toolset: "terminal",
    type: "function",
    function: {
      name: "terminal_exec",
      description: "Run a shell command in the workspace. Approval-gated; user must approve. Returns stdout/stderr and exit code. Set timeoutMs explicitly for slow commands (Apple/AppleScript-backed CLIs like memo or remindctl can take 30+ seconds; brew installs can take minutes). Set pty=true for interactive CLI tools (vim, memo, claude-code, codex, python repl) — without pty they hang or exit immediately because stdin is not a TTY. To drive vim non-interactively, pre-feed keystrokes via stdin like: `printf 'i<title>\\n<body>\\x1b:wq\\n' | <command>`.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line. Runs through `zsh -lc`." },
          timeoutMs: { type: "number", description: "Maximum runtime before kill, in milliseconds. Defaults to 60000 (60s). Bump for slow ops (memo/remindctl scans, brew installs, network).", default: 60000 },
          pty: { type: "boolean", description: "Set true for interactive CLIs that need a TTY (vim, memo, claude-code, codex, python repl). When true the command is spawned under a pseudo-terminal so it doesn't see stdin-is-not-tty errors. Default false.", default: false }
        },
        required: ["command"]
      }
    }
  },
  {
    toolset: "terminal",
    type: "function",
    function: {
      name: "code_exec",
      description: "Run a short snippet of code in a sandboxed shell. Approval-gated.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", description: "Language to execute. Supported: js, ts, python." },
          code: { type: "string", description: "The code to run." }
        },
        required: ["language", "code"]
      }
    }
  },
  {
    // Skill catalog access. Always available so the model can opportunistically
    // load any trusted skill listed in the system prompt without waiting for
    // the user to enable a toolset. Sync, low-risk, no approval needed: the
    // body is just text content that already lives in state.
    toolset: "skills",
    type: "function",
    function: {
      name: "read_skill",
      description: "Read the full markdown body of a trusted skill by name. Use this when the system prompt advertises a skill and you need its instructions to follow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name (e.g. 'apple-notes')." }
        },
        required: ["name"]
      }
    }
  },
  {
    // Subagent delegation. Spawns a constrained child task running the
    // chat-task agent loop with its own system prompt and toolset/skill
    // subsets. The dispatch waits for the child to reach a terminal state
    // (completed/failed/timeout) and feeds the summary back as the tool
    // result. Medium-risk: no approval, but every call is audited and
    // traced; depth-capped at 3 levels.
    toolset: "subagents",
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Delegate a focused sub-task to a constrained child agent. Returns the child's summary (or error) once it finishes. Use sparingly — one delegation per logical sub-goal — and prefer direct tool use for simple queries.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label for the subagent (e.g. 'research', 'patch-author')." },
          prompt: { type: "string", description: "The user-facing instruction for the subagent." },
          system_prompt: { type: "string", description: "Optional override for the subagent's system instructions. Defaults to a generic 'focused subagent' preamble." },
          toolsets: { type: "array", items: { type: "string" }, description: "Optional list of toolset names to expose. Subset of the parent's enabled toolsets." },
          skills: { type: "array", items: { type: "string" }, description: "Optional list of trusted skill names to advertise. Subset of the parent's trusted skills." },
          timeout_ms: { type: "number", description: "How long to wait for the subagent before timing out. Defaults to 300000 (5 minutes)." }
        },
        required: ["name", "prompt"]
      }
    }
  }
];

export type ToolCatalogTool = ToolFunctionSpec & { toolset: string };

// Public read-only copy. Returned ordering is stable so the toolsHash is
// deterministic across boots (used for resume after approval).
export function allTools(): ToolCatalogTool[] {
  return TOOL_DEFS.map((t) => ({ ...t, function: { ...t.function, parameters: { ...t.function.parameters } } }));
}

// Filter tools by enabled toolsets in state. The web_fetch tool is grouped
// under "messaging" only because the legacy defaults didn't include a "web"
// toolset; if state has no `web` toolset the tool stays available unless an
// explicit messaging toolset row is disabled. To keep behavior intuitive we
// always allow web_fetch for now (low-risk, matches legacy `web ` prefix).
export function buildToolCatalog(state: RuntimeState): ToolCatalogTool[] {
  const enabled = new Set(state.toolsets.filter((t) => t.status === "enabled").map((t) => t.name));
  return allTools().filter((tool) => {
    if (tool.function.name === "web_fetch") return true;
    // Always expose read_skill so the model can load any trusted skill the
    // system prompt advertises. The "skills" toolset isn't part of the
    // legacy default toolsets; gating it on enable would mean a fresh
    // instance can't follow its own skill prompt without a toolset toggle.
    if (tool.function.name === "read_skill") return true;
    // Always expose spawn_subagent. Like read_skill it's a runtime
    // capability not tied to a legacy default toolset row, and gating it
    // on enable would silently disable delegation on freshly cloned
    // instances. Subagent path itself is depth-capped and audited.
    if (tool.function.name === "spawn_subagent") return true;
    return enabled.has(tool.toolset);
  });
}

// Stable hash over a tool list. Used to detect when the catalog changes
// between iterations of the agent loop (e.g. user enabled a toolset
// mid-conversation) so we can decide whether to keep resuming with the
// snapshotted state.
export function hashCatalog(tools: ToolCatalogTool[]): string {
  const summary = tools.map((t) => `${t.function.name}:${JSON.stringify(t.function.parameters)}`).join("|");
  return createHash("sha1").update(summary).digest("hex").slice(0, 16);
}

// Return the OpenAI tool spec without the `toolset` annotation we use for
// filtering. The provider only knows the `type/function` shape.
export function toProviderTools(tools: ToolCatalogTool[]): ToolFunctionSpec[] {
  return tools.map(({ toolset: _toolset, ...rest }) => rest);
}
