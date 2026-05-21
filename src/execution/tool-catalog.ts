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
      name: "browser_connect",
      description: "Spawn a visible managed Chrome window so the user can sign in to a third-party service (Google Cloud Console, Slack, etc). The user is prompted to approve. Use this BEFORE browser_navigate when the user needs to interact with a sign-in / OAuth page — Google blocks automated sign-in and a headless window cannot accept credentials. Requires `reason`: one short user-facing sentence shown on the approval card so the user knows why a browser is opening.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "One short user-facing sentence shown in the approval card (e.g. 'Sign in to Google Cloud Console')." },
          headless: { type: "boolean", description: "Set `true` to relaunch as a headless (windowless) Chrome session using the same profile dir as the prior managed connect. Cookies from the visible session replay, so the headless session is already signed in. Use this AFTER sign-in to continue automation invisibly.", default: false }
        },
        required: ["reason"]
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
    // Connector-request affordance. When a skill is enabled but inactive
    // because its required connector is missing, the model calls this tool
    // to surface a "Connect <provider>" card in chat. The task pauses on
    // the resulting approval and resumes automatically once the user
    // completes the secret entry. Always-on (like read_skill / mcp_call):
    // the model needs this path even on a fresh instance with no toolsets
    // toggled.
    toolset: "connectors",
    type: "function",
    function: {
      name: "request_connector",
      description: "Ask the user to connect an external provider (e.g. linear, github). Use this when a skill is available but inactive because the required connector is not configured. The user sees a Connect button in the chat; the task pauses until they finish the setup, then resumes automatically.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider id (e.g. 'linear'). Must match a registered provider module." },
          reason: { type: "string", description: "The user-visible message shown above the inline Connect form. May contain `${var}` placeholders that the runtime substitutes from `params` at dispatch time (skill bodies typically own this string verbatim — copy it without paraphrasing)." },
          params: {
            type: "object",
            description: "Optional. String values substituted for `${var}` placeholders in `reason` (e.g. { project_id: 'gini-workspace-1234567' } substitutes `${project_id}`). Unknown placeholders are left verbatim.",
            additionalProperties: { type: "string" }
          }
        },
        required: ["provider", "reason"]
      }
    }
  },
  {
    // Generic MCP tool invocation. The agent loop sees this as a single
    // tool entry; the dispatcher routes (server, tool, arguments) to the
    // matching McpServerRecord via src/integrations/mcp.ts. Each
    // configured http MCP server is advertised separately in the system
    // prompt so the model knows which tools belong to which server.
    // TODO: gate side-effecting MCP tools through the approval policy
    // based on the tool's `annotations.destructiveHint`; for v0 every call
    // auto-executes.
    toolset: "mcp",
    type: "function",
    function: {
      name: "mcp_call",
      description: "Invoke a tool on a configured MCP server. Use list_skills/read_skill first to discover what tools each MCP server exposes (e.g. read_skill name='linear' for Linear).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name (e.g. 'linear')." },
          tool: { type: "string", description: "Tool name as advertised by the MCP server (e.g. 'list_issues')." },
          arguments: { type: "object", description: "Arguments object the MCP tool expects. Shape varies per tool — read the skill for details.", additionalProperties: true }
        },
        required: ["server", "tool"]
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
      description: "Schedule a recurring or one-shot job that runs a prompt. The job's response is delivered as an assistant message back to this chat session when it fires. Provide EITHER `intervalSeconds` OR `cronExpression` (with `cronTimezone`), never both. Use `intervalSeconds` for 'in N minutes' or 'every N hours' (from-now timing). Use `cronExpression` + `cronTimezone` for wall-clock or weekday patterns ('daily at 9am', 'weekdays at 8:30'). Set oneShot=true for single-fire reminders. When a scheduled job needs to run UNATTENDED (e.g. recurring with no human present at fire-time), set `approvalMode: \"yolo\"` for tasks that need broad action, or use `autoApproveCommands` for narrow shell-pattern opt-ins — otherwise the job may stall at a gated approval forever (the instance default is \"auto\", which auto-approves file writes and safe shell commands but still gates dangerous patterns like rm -rf, sudo, pipe-to-sh, chmod 777, and destructive git operations). `dangerouslyAutoApprove: true` is a deprecated alias for `approvalMode: \"yolo\"` kept for back-compat. The default `timeoutSeconds` is 600 (10 min) — drop it lower for trivial reminders, or raise it (e.g. 1800+) when the prompt invokes external CLIs like codex or claude-code that can take several minutes.",
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
            description: "Shell command patterns that auto-approve without asking the user at fire-time. Always wins over the dangerous-pattern blocklist when matched (explicit operator allow beats heuristic block). Use when the job must act unattended on specific commands. Examples: 'git *', 'gh *', 'cd *', 'ls *', 'rg *'. Patterns are matched against the full command string; only add patterns that match the user's stated intent for the job."
          },
          approvalMode: {
            type: "string",
            enum: ["strict", "auto", "yolo"],
            description: "Approval policy for this job's spawned tasks only. \"strict\" gates every approval-eligible action. \"auto\" (instance default) auto-approves file writes / safe shell commands, gates dangerous shell patterns. \"yolo\" bypasses everything (full audit trail still written). When omitted, the spawned task inherits the operator's instance default."
          },
          dangerousTerminalPatterns: {
            type: "array",
            items: { type: "string" },
            description: "Override the dangerous-pattern blocklist for this job's spawned tasks. Each entry is a substring matched against the command string. Only consulted when approvalMode is \"auto\". When omitted, the built-in defaults apply (rm -rf to absolute paths, sudo, pipe-to-sh, chmod 777, destructive git operations, writes to /etc/, ~/.ssh/, ~/.aws/)."
          },
          dangerouslyAutoApprove: {
            type: "boolean",
            description: "DEPRECATED alias for approvalMode: \"yolo\". Kept for back-compat; new payloads should use approvalMode instead. If both fields are set, approvalMode wins."
          },
          timeoutSeconds: {
            type: "number",
            description: "Wall-clock seconds before the spawned task is killed. Default 600 (10 min) — enough for typical git/gh + multi-file scan jobs. Drop lower (e.g. 60-120) for trivial reminders; raise (e.g. 1800-3600) when the prompt invokes external CLIs like codex or claude-code that can run several minutes. The model will be terminated mid-thought if this is too low."
          }
        },
        required: ["name", "prompt"]
      }
    }
  },
  {
    // Read-only accessor for the scheduled job list. Cheap and low-risk;
    // call this first whenever the user refers to "this job" or any
    // existing scheduled job, so update_job / delete_job target the right
    // id instead of accidentally creating a duplicate via create_job.
    toolset: "jobs",
    type: "function",
    function: {
      name: "list_jobs",
      description: "List scheduled jobs visible to this instance. Cheap, side-effect-free; call this first when the user refers to 'this job', 'my reminder', or any existing scheduled job so you can target the right job id with update_job / delete_job (instead of creating a duplicate). Returns a compact JSON array with each job's id, name, status, schedule shape (cronExpression+cronTimezone OR intervalSeconds), oneShot flag, nextRunAt/lastRunAt timestamps, chatSessionId, and a truncated prompt. Pass `fullPrompt: true` when you intend to edit a prompt (e.g. 'append to this reminder' or 'change wording X to Y') so you get the verbatim prompt without truncation — otherwise prompts are truncated to 200 chars to keep the result compact.",
      parameters: {
        type: "object",
        properties: {
          nameContains: { type: "string", description: "Optional case-insensitive substring filter on job name." },
          fullPrompt: { type: "boolean", description: "Optional. If true, return each job's prompt verbatim with no truncation. Default false. Set true when you intend to edit a prompt (append, search-and-replace) so update_job can submit the complete new prompt without losing tail content." }
        }
      }
    }
  },
  {
    // Mutate an existing job in place. Preferred over delete+create when
    // the user wants to change a job's schedule, prompt, or status —
    // preserves the job id, chatSessionId, run history, and audit chain.
    // Low-risk / no approval for the same reason as create_job: the user
    // can always pause/delete from /jobs.
    toolset: "jobs",
    type: "function",
    function: {
      name: "update_job",
      description: "Patch an existing scheduled job in place. Use this — NOT delete+create — when the user wants to change a job's schedule, prompt, name, status, or auto-approve envelope; this preserves the job id, its dedicated chat thread, and run history. Supply only the fields you want to change. Schedule transitions follow the same mutual-exclusion rule as create_job: a single patch may not set BOTH a positive intervalSeconds AND a cronExpression. To switch a job between cron-driven and interval-driven, pass the new driver and set the other to null (e.g. `{cronExpression: '0 9 * * *', cronTimezone: 'America/Los_Angeles', intervalSeconds: null}`). Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to patch (e.g. 'job_a3aa6707'). Get this from list_jobs." },
          name: { type: "string", description: "Optional new human-readable label." },
          prompt: { type: "string", description: "Optional new instruction the agent will receive when the job fires." },
          intervalSeconds: { type: ["number", "null"], description: "Optional new interval. Pass a positive integer to make the job interval-driven; pass null to clear the interval when also setting cronExpression." },
          cronExpression: { type: ["string", "null"], description: "Optional new 5-field Unix cron expression. Pass a string to make the job cron-driven; pass null to clear it when switching to intervalSeconds." },
          cronTimezone: { type: ["string", "null"], description: "Optional new IANA timezone identifier (only valid with cronExpression). Pass null to clear (only legal when also clearing cronExpression)." },
          oneShot: { type: "boolean", description: "Optional. If true the job is auto-paused after its first run." },
          status: { type: "string", enum: ["active", "paused"], description: "Optional pause/resume. 'paused' stops the scheduler from firing the job; 'active' resumes it." },
          autoApproveCommands: { type: "array", items: { type: "string" }, description: "Optional new list of auto-approve shell patterns for unattended fires." },
          dangerouslyAutoApprove: { type: "boolean", description: "Optional. If true the scheduled task bypasses ALL approval gates at fire-time." },
          timeoutSeconds: { type: "number", description: "Optional. Wall-clock seconds before the spawned task is killed." }
        },
        required: ["jobId"]
      }
    }
  },
  {
    // Delete a scheduled job and its run history. Low-risk / no approval
    // for symmetry with create_job: gating destroys the composition story
    // (the agent should be able to do delete+create or update smoothly).
    // The user can always restore via re-creation; audit trail is preserved.
    toolset: "jobs",
    type: "function",
    function: {
      name: "delete_job",
      description: "Delete a scheduled job and its run history. Use sparingly — prefer update_job when changing a job's schedule, prompt, or status, since update preserves the job id, dedicated chat thread, and audit chain. Use delete_job when the user explicitly asks to remove a job, or when you must compose delete+create to reach a target state that update_job can't express. Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to delete (e.g. 'job_a3aa6707'). Get this from list_jobs." }
        },
        required: ["jobId"]
      }
    }
  },
  {
    // Install a skill from a raw SKILL.md body. Companion to the existing
    // meta/install-skill agent skill (which the agent invokes when the
    // user shares a skill description inline). This tool is the direct
    // API path — use it when you already have the SKILL.md text in hand
    // and just need to land it on the runtime.
    toolset: "skills",
    type: "function",
    function: {
      name: "install_skill",
      description: "Install a skill from a raw SKILL.md document. Validates the manifest, writes it under the instance's skills directory, and reloads the skill registry. Use when the user shares a SKILL.md body (or you generated one) and wants it active. Companion to the meta/install-skill agent skill — that skill drives the full UX flow; this tool is the direct API call.",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "Full SKILL.md content (YAML frontmatter + markdown body)." },
          category: { type: "string", description: "Optional category override. Defaults to metadata.gini.category in the frontmatter, then 'user'." },
          files: {
            type: "array",
            description: "Optional named-file payloads written next to SKILL.md (e.g. scripts/linear.sh). Each entry's name is treated as a relative path under the skill folder and must not escape it.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Relative path under the skill folder." },
                content: { type: "string", description: "File contents." }
              },
              required: ["name", "content"]
            }
          }
        },
        required: ["body"]
      }
    }
  },
  {
    // Enable a skill so it shows up in the system prompt and read_skill
    // can fetch its body. Low-risk; the underlying handler runs
    // `setSkillStatus(config, idOrName, "enabled")` and writes a
    // skill.enabled audit row.
    toolset: "skills",
    type: "function",
    function: {
      name: "enable_skill",
      description: "Enable a registered skill so it appears in the advertised-skills block and the agent can read its body. Use after the user asks to turn a skill on (or after install_skill if the manifest didn't auto-enable). Trivial; no approval gate.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name (e.g. 'skill_abc123' or 'apple-notes')." }
        },
        required: ["skillId"]
      }
    }
  },
  {
    // Disable a skill so it stops appearing in the system prompt and
    // read_skill refuses to fetch its body. Low-risk; underlying handler
    // writes a skill.disabled audit row.
    toolset: "skills",
    type: "function",
    function: {
      name: "disable_skill",
      description: "Disable a registered skill so it stops appearing in the advertised-skills block. Use when the user asks to turn a skill off. Trivial; no approval gate. The skill's manifest stays on disk — re-enable with enable_skill when needed.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name (e.g. 'skill_abc123' or 'apple-notes')." }
        },
        required: ["skillId"]
      }
    }
  },
  {
    // Cancel a task. Pairs with spawn_subagent for parent-side control
    // of a runaway child. Low-risk; the underlying `cancelTask` already
    // refuses on already-terminal tasks and cascades to child subagents.
    // The self-cancel guard lives in the dispatcher (the current task
    // cannot cancel itself — that would terminate the running
    // conversation).
    toolset: "subagents",
    type: "function",
    function: {
      name: "cancel_task",
      description: "Cancel a running task. Use for runaway subagents the user wants to abort, or to clean up an unrelated task. Refuses to cancel the CURRENT chat task — call cancellation never makes sense from inside the task it would terminate. Already-terminal tasks (completed / failed / cancelled) are returned as-is by the underlying handler.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Id of the task to cancel (e.g. 'task_abc123')." }
        },
        required: ["taskId"]
      }
    }
  },
  {
    // Outbound messaging via a configured bridge. High-risk: contains
    // "send" → routed through the approval queue. In "auto" mode the
    // policy seam auto-approves; "strict" gates every call. The user
    // can pre-approve specific bridges or flip approvalMode at runtime.
    toolset: "messaging",
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message through a configured messaging bridge (Telegram, Discord, etc.). Approval-gated by default — the operator's approvalMode controls whether each call is auto-approved or queued. Pass `target` to choose a specific allow-listed chat; omit it to use the bridge's first allowed target. Use sparingly and only when the user has asked the agent to relay something to a chat — don't send a message just because one came in.",
      parameters: {
        type: "object",
        properties: {
          bridgeId: { type: "string", description: "Id or name of the messaging bridge (e.g. 'msg_abc123' or 'my-bot')." },
          text: { type: "string", description: "Message body. Keep it concise — Telegram caps inbound text at 4096 chars." },
          target: { type: "string", description: "Optional delivery target (chat id) on the bridge's allow-list. When omitted the bridge's first allowed target is used." }
        },
        required: ["bridgeId", "text"]
      }
    }
  },
  {
    // Cross-session lookup. Scans past tasks, traces, memories, skills,
    // and audit rows for a substring match. Low-risk; read-only.
    toolset: "session_search",
    type: "function",
    function: {
      name: "search_history",
      description: "Search past chat sessions, task traces, stored memories, skill text, and audit events for a substring. Use when the user references something they did before ('did I ever ask about X?', 'find that conversation about Y'). Returns up to `limit` snippets ordered by score, each with kind (task/trace/memory/skill/audit), title, excerpt, and taskId when applicable.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for (case-insensitive)." },
          limit: { type: "number", description: "Maximum number of snippets to return. Defaults to 20, capped at 100." }
        },
        required: ["query"]
      }
    }
  },
  {
    // Explicit on-demand memory query. Distinct from the automatic
    // embedding recall that runs per chat task — this is the tool the
    // model reaches for when the user asks about something specific
    // ("did we discuss X?", "what do you remember about Y?"). Returns a
    // compact summary so the model can decide whether to dig deeper or
    // ask the user for clarification. Low-risk / no approval.
    toolset: "memory",
    type: "function",
    function: {
      name: "recall_memory",
      description: "Explicit on-demand recall of stored memory. Use when the user references prior context (e.g. 'did we discuss X?', 'what do you remember about Y?'). Distinct from the automatic embedding recall that runs at the start of every task — call this when you need to fetch additional memory mid-conversation. Returns a compact JSON summary: unit count, total tokens, and an excerpt list (id, truncated content, score). Pass `tokenBudget` to cap pack size; pass `bankId` only when you need to query a specific bank (default: the active agent's bank).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The phrase to search memory for." },
          tokenBudget: { type: "number", description: "Maximum tokens worth of memory units to return. Defaults to 2000." },
          bankId: { type: "string", description: "Optional memory bank id to query. Defaults to the active agent's per-agent bank." }
        },
        required: ["query"]
      }
    }
  },
  {
    // Add a new memory item. Defaults `status: "proposed"` — the agent
    // doesn't pin its own memory active; the user reviews via the existing
    // approval flow (`POST /api/memory/<id>/approve`).
    toolset: "memory",
    type: "function",
    function: {
      name: "add_memory",
      description: "Propose a new memory item. Memory items added by the agent start as `proposed` and require user approval via the memory review flow (`POST /api/memory/<id>/approve`). Use when the user shares a stable fact about themselves or their preferences that should ride the system prompt on future tasks. Avoid noting ephemeral context (it's already in the conversation) — propose only things worth remembering across sessions.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The memory text (1-2 sentences). Keep it concise — pinned memories cost context every turn." },
          confidence: { type: "number", description: "Confidence in the fact, 0-1. Defaults to 1. Lower for inferred facts." },
          sensitivity: { type: "string", enum: ["normal", "sensitive"], description: "Mark `sensitive` for items the user wouldn't want surfaced in default UI views. Defaults to `normal`." },
          provenance: { type: "string", description: "Short note about where the fact came from (e.g. 'User said in chat'). Defaults to 'Proposed by agent'." }
        },
        required: ["content"]
      }
    }
  },
  {
    // Edit an existing memory in place. Use sparingly — `add_memory` is
    // the usual path. The audit trail records every edit; the user can
    // archive a bad edit via `DELETE /api/memory/<id>`.
    toolset: "memory",
    type: "function",
    function: {
      name: "update_memory",
      description: "Edit an existing memory item in place (content / confidence / sensitivity). Use sparingly — `add_memory` is the usual path. The audit trail records every edit, and the user can archive a bad edit via `DELETE /api/memory/<id>`. Supply only the fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "Id of the memory to edit (e.g. 'mem_abc123')." },
          content: { type: "string", description: "Optional new memory text." },
          confidence: { type: "number", description: "Optional new confidence value, 0-1." },
          sensitivity: { type: "string", enum: ["normal", "sensitive"], description: "Optional new sensitivity classification." }
        },
        required: ["memoryId"]
      }
    }
  },
  {
    // Manually trigger an existing scheduled job. Wraps the same
    // `runJobNow` entrypoint that `POST /api/jobs/<id>/run` calls. Low-risk
    // / no approval: the spawned task itself still flows through the job's
    // configured `approvalMode` / `autoApproveCommands`, so any side
    // effects inside the run are gated at their normal granularity. The
    // tool only fires an EXISTING job — for one-off prompts use create_job
    // with intervalSeconds + oneShot=true instead.
    toolset: "jobs",
    type: "function",
    function: {
      name: "run_job",
      description: "Manually fire an EXISTING scheduled job right now. This is distinct from create_job: run_job triggers a job that has already been scheduled, while create_job defines a new one. Use this when the user says 'test this job now', 'fire the reminder', or 'run job X off-schedule'. Behavior differs by job kind: prompt-backed jobs spawn an async task — posting into the job's dedicated chat thread when one is configured — using the job's configured approvalMode / autoApproveCommands at fire-time, and the tool returns once the trigger lands (run id and spawned task id included); script-backed jobs (operator-installed only) execute synchronously and the tool returns the exit code, plus a truncated stderr tail on failure. Overlap protection only applies to scheduled triggers; a manual run CAN run alongside an in-flight scheduled run. Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to fire (e.g. 'job_a3aa6707'). Get this from list_jobs." }
        },
        required: ["jobId"]
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
// agent's whitelist. Always-on tools bypass both filters: web_fetch,
// read_skill, spawn_subagent, the scheduled-job surface (create_job,
// list_jobs, update_job, delete_job, run_job), mcp_call, request_connector,
// and the core agent-capability meta-tools that have no separate toolset
// to gate them (cancel_task — sibling to spawn_subagent; install_skill /
// enable_skill / disable_skill — siblings to read_skill). The surface-
// gateway tool `send_message` (toolset `messaging`) stays subject to the
// toolset enable/disable kill switch — operators disable that toolset to
// hide outbound messaging entirely.
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
    // Always expose the full scheduled-job tool surface (create / list /
    // update / delete / run). The "jobs" toolset isn't part of the legacy
    // defaults; gating on enable would silently hide scheduling (and the
    // chat-reminder delivery loop) on fresh instances. Exposing the set
    // together also keeps composition coherent — without list_jobs the
    // agent can't see existing jobs to pick the right id for update,
    // delete, or run, and that's how duplicates get created. Low-risk by
    // design: the user can pause/delete any job from /jobs, and manual
    // runs inherit the job's existing approval envelope.
    if (tool.function.name === "create_job") return true;
    if (tool.function.name === "list_jobs") return true;
    if (tool.function.name === "update_job") return true;
    if (tool.function.name === "delete_job") return true;
    if (tool.function.name === "run_job") return true;
    // mcp_call is a runtime capability not bound to a legacy toolset row.
    // Gating it on the "mcp" toolset would silently hide MCP usage on
    // fresh instances even when a user has configured a server, so it
    // mirrors read_skill / spawn_subagent's always-on stance.
    if (tool.function.name === "mcp_call") return true;
    // request_connector is the in-chat affordance that lets the agent
    // ask the user to wire up a missing connector. Same always-on
    // rationale: a fresh instance with no toolsets toggled still needs
    // to be able to surface "connect linear" when the linear skill is
    // inactive — gating on a legacy toolset would silently disable the
    // onboarding path.
    if (tool.function.name === "request_connector") return true;
    // Always expose the core agent-capability meta-tools whose owning
    // toolsets aren't in the legacy defaults (`skills`, `subagents`).
    // Gating these on a toolset toggle would mean a fresh instance
    // literally can't see them, even though they're the right path for
    // common asks ("cancel that subagent", "install this skill"). They
    // sit alongside their already-always-on siblings (cancel_task next
    // to spawn_subagent; install/enable/disable_skill next to
    // read_skill). When the underlying resource isn't configured the
    // tool handler surfaces a clear error — that's the correct UX, not
    // "tool didn't exist". Note: `send_message` (toolset `messaging`)
    // is deliberately NOT in this bypass — it's a surface-gateway tool
    // (outbound messaging) where the operator's toolset kill switch
    // must work. Its toolset defaults disabled; flipping the toolset
    // to enabled is how the operator turns it on.
    if (tool.function.name === "cancel_task") return true;
    if (tool.function.name === "install_skill") return true;
    if (tool.function.name === "enable_skill") return true;
    if (tool.function.name === "disable_skill") return true;
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
