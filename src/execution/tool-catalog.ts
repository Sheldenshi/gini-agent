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
    // load any enabled skill listed in the system prompt without waiting for
    // the user to enable a toolset. Sync, low-risk, no approval needed: the
    // body is just text content that already lives in state.
    toolset: "skills",
    type: "function",
    function: {
      name: "read_skill",
      description: "Read the full markdown body of an enabled skill by name. Use this when the system prompt advertises a skill and you need its instructions to follow.",
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
          skills: { type: "array", items: { type: "string" }, description: "Optional list of enabled skill names to advertise. Subset of the parent's enabled skills." },
          timeout_ms: { type: "number", description: "How long to wait for the subagent before timing out. Defaults to 300000 (5 minutes)." }
        },
        required: ["name", "prompt"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Open a URL in a headless browser session and return a compact accessibility snapshot with @eN refs the agent can click or type into.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to navigate to." }
        },
        required: ["url"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Re-snapshot the current browser page. Default returns interactive elements with @eN refs; pass full=true for a richer tree including landmarks and headings.",
      parameters: {
        type: "object",
        properties: {
          full: { type: "boolean", description: "If true, include landmark/heading nodes alongside interactive elements.", default: false }
        }
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element on the current page by its @eN ref from the latest snapshot. Returns a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_type",
      description: "Clear and type text into an input element identified by its @eN ref. Returns a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Input ref like '@e3' from the latest snapshot." },
          text: { type: "string", description: "Text to type into the input." }
        },
        required: ["ref", "text"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_press",
      description: "Press a keyboard key on the current page (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'). Returns a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name as Playwright understands it (e.g. 'Enter', 'ArrowDown', 'Control+A')." }
        },
        required: ["key"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the current page up or down by one viewport. Returns a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." }
        },
        required: ["direction"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_back",
      description: "Navigate back one entry in the browser history. Returns a fresh snapshot.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_console",
      description: "Read recent console messages from the current page. Optionally evaluate a JavaScript expression and return its result.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Optional JavaScript expression to evaluate in the page context." },
          clear: { type: "boolean", description: "If true, clear the captured console buffer before returning.", default: false }
        }
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the browser session for the current task. Frees the underlying BrowserContext immediately instead of waiting for the idle sweeper.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_hover",
      description: "Hover over an element on the current page by its @eN ref. Useful for revealing tooltips or :hover-only menus. Returns a fresh snapshot.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_drag",
      description: "Drag from one element to another by their @eN refs.",
      parameters: {
        type: "object",
        properties: {
          fromRef: { type: "string", description: "Source element ref like '@e3' from the latest snapshot." },
          toRef: { type: "string", description: "Target element ref like '@e7' from the latest snapshot." }
        },
        required: ["fromRef", "toRef"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_select_option",
      description: "Select an option in a <select> element by its @eN ref. Pass `value` for single-select or `values` for multi-select. Exactly one of the two must be provided.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Select element ref like '@e3' from the latest snapshot." },
          value: { type: "string", description: "Option value to select (single-select). Mutually exclusive with `values`." },
          values: { type: "array", items: { type: "string" }, description: "Option values to select (multi-select). Mutually exclusive with `value`." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_wait_for",
      description: "Wait for an element (by @eN ref) to reach a state, or for a substring to appear in the page text. Exactly one of `ref` or `text` must be supplied. Returns a fresh snapshot after the wait completes.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot. Mutually exclusive with `text`." },
          text: { type: "string", description: "Substring to wait for in document.body.innerText. Mutually exclusive with `ref`." },
          state: {
            type: "string",
            enum: ["visible", "hidden", "attached", "detached"],
            description: "Element state to wait for when using `ref`. Defaults to 'visible'."
          },
          timeoutMs: { type: "number", description: "Maximum wait in milliseconds. Defaults to 10000. Hard cap of 60000 (60s); larger values are silently clamped.", default: 10000 }
        }
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_tabs",
      description: "Manage browser tabs: list current tabs, open a new tab, switch the active tab, or close a tab. `index` (zero-based) is required for switch and close. `url` is optional for `new` (the new tab is created blank if omitted).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "new", "switch", "close"],
            description: "Tab operation to perform."
          },
          url: { type: "string", description: "Absolute http(s) URL to load when action='new'. Optional." },
          index: { type: "number", description: "Zero-based tab index for action='switch' or action='close'." }
        },
        required: ["action"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_upload_file",
      description: "Upload a workspace file via a file input. Path is workspace-relative and validated against escapes (including symlink targets).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "File-input element ref like '@e3' from the latest snapshot." },
          path: { type: "string", description: "Workspace-relative path to the file to upload." }
        },
        required: ["ref", "path"]
      }
    }
  },
  {
    toolset: "browser",
    type: "function",
    function: {
      name: "browser_vision",
      description: "Screenshot the current page and ask the configured vision model a question about what's visible. Returns the model's text answer. Use when the accessibility snapshot can't capture what you need (charts, image-only content, visual layout, captchas-by-description). One image per call.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to ask about the page screenshot." },
          full: { type: "boolean", default: false, description: "If true, capture the full scrollable page; otherwise just the viewport." }
        },
        required: ["question"]
      }
    }
  },
  {
    // Schedule a real cron/job. The job's output is delivered as an
    // assistant message back into the originating chat session when it
    // fires. Low-risk: no approval gate — the user can pause/delete the
    // job at any time, and gating reminders behind an approval dialog
    // would defeat the UX (`remind me in 2 minutes` should not pop a
    // modal). Always exposed (like read_skill / spawn_subagent) so a
    // fresh instance can schedule reminders without toolset toggling.
    toolset: "jobs",
    type: "function",
    function: {
      name: "create_job",
      description: "Schedule a recurring or one-shot job that runs a prompt. The job's response is delivered as an assistant message back to this chat session when it fires. Provide EITHER `intervalSeconds` OR `cronExpression` (with `cronTimezone`), never both. Use `intervalSeconds` for 'in N minutes' or 'every N hours' (from-now timing). Use `cronExpression` + `cronTimezone` for wall-clock or weekday patterns ('daily at 9am', 'weekdays at 8:30'). Set oneShot=true for single-fire reminders. When a scheduled job needs to run UNATTENDED (e.g. recurring with no human present at fire-time), set `autoApproveCommands` for the shell patterns it will need to run, or `dangerouslyAutoApprove: true` for tasks that need broad action — otherwise the job will stall at the first approval gate forever. The default `timeoutSeconds` is 600 (10 min) — drop it lower for trivial reminders, or raise it (e.g. 1800+) when the prompt invokes external CLIs like codex or claude-code that can take several minutes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short human-readable label (e.g. 'cake-reminder')." },
          intervalSeconds: { type: "number", description: "Seconds between runs (from-now timing). For a one-shot reminder, this is the delay until the single fire (e.g. 120 for 'in 2 minutes'). Mutually exclusive with `cronExpression`." },
          cronExpression: {
            type: "string",
            description: "Standard 5-field Unix cron: `minute hour day-of-month month day-of-week`. No seconds field, no year field. Day-of-week is 0-6 with 0 = Sunday (NOT ISO 1=Monday); `1` is Monday, `5` is Friday. Examples: '0 9 * * *' (every day at 09:00), '30 8 * * 1-5' (08:30 on weekdays), '0 */2 * * *' (every 2 hours), '0 0 1 * *' (midnight on the 1st of each month). FOOTGUN: if you restrict BOTH day-of-month and day-of-week, Unix cron OR's them — '0 0 1 * 1' means 'midnight on the 1st OR every Monday', NOT 'when the 1st is a Monday'. There is no Unix-cron expression for 'first Monday of the month'; refuse such requests or split into two separate jobs. Mutually exclusive with `intervalSeconds`. Always pair with `cronTimezone` for wall-clock-named times."
          },
          cronTimezone: {
            type: "string",
            description: "IANA timezone identifier (e.g. 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'). Defaults to 'UTC' when omitted. Always set this explicitly when the user names a wall-clock time — '9am' alone is ambiguous; '9am America/Los_Angeles' is not. Only valid alongside `cronExpression`."
          },
          prompt: { type: "string", description: "The instruction the agent will receive when the job fires. Phrase it from the user's perspective (e.g. 'Remind me to take the cake out of the oven.')." },
          oneShot: { type: "boolean", description: "If true, the job is paused after its first successful run. Defaults to false (recurring)." },
          autoApproveCommands: {
            type: "array",
            items: { type: "string" },
            description: "Shell command patterns that auto-approve without asking the user at fire-time. Use when the job must act unattended. Examples: 'git *', 'gh *', 'cd *', 'ls *', 'rg *'. Patterns are matched against the full command string; only add patterns that match the user's stated intent for the job."
          },
          dangerouslyAutoApprove: {
            type: "boolean",
            description: "If true, the scheduled task bypasses ALL approval gates (terminal, file write, file patch, code exec, etc.) at fire-time. Use sparingly — prefer specific `autoApproveCommands` when possible. Full audit trail is preserved (each approval row is still written and stamped autoApproved=true)."
          },
          timeoutSeconds: {
            type: "number",
            description: "Wall-clock seconds before the spawned task is killed. Default 600 (10 min) — enough for typical git/gh + multi-file scan jobs. Drop lower (e.g. 60-120) for trivial reminders; raise (e.g. 1800-3600) when the prompt invokes external CLIs like codex or claude-code that can run several minutes. The model will be terminated mid-thought if this is too low."
          }
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
//
// `agentToolsetFilter` is the optional active-agent whitelist (toolset
// names). When set, it intersects with the enabled-toolset filter — a tool
// passes only if its owning toolset is BOTH globally enabled AND in the
// agent's whitelist. Always-on tools (web_fetch, read_skill,
// spawn_subagent, create_job) bypass both filters.
export function buildToolCatalog(state: RuntimeState, agentToolsetFilter?: Set<string>): ToolCatalogTool[] {
  const enabled = new Set(state.toolsets.filter((t) => t.status === "enabled").map((t) => t.name));
  return allTools().filter((tool) => {
    if (tool.function.name === "web_fetch") return true;
    // Always expose read_skill so the model can load any enabled skill the
    // system prompt advertises. The "skills" toolset isn't part of the
    // legacy default toolsets; gating it on enable would mean a fresh
    // instance can't follow its own skill prompt without a toolset toggle.
    if (tool.function.name === "read_skill") return true;
    // Always expose spawn_subagent. Like read_skill it's a runtime
    // capability not tied to a legacy default toolset row, and gating it
    // on enable would silently disable delegation on freshly cloned
    // instances. Subagent path itself is depth-capped and audited.
    if (tool.function.name === "spawn_subagent") return true;
    // Always expose create_job. The "jobs" toolset isn't part of the
    // legacy defaults; gating on enable would silently hide scheduling
    // (and chat-reminder delivery) on fresh instances. Low-risk by
    // design — the user can pause/delete any job from /jobs.
    if (tool.function.name === "create_job") return true;
    if (!enabled.has(tool.toolset)) return false;
    if (agentToolsetFilter && !agentToolsetFilter.has(tool.toolset)) return false;
    return true;
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
