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
//
// `displayLabel` is the human-readable short label clients render in
// tool_call ChatBlocks. Server-side ownership keeps the labels consistent
// across web / mobile / CLI bridges (see ADR chat-block-protocol.md).
// When omitted on a TOOL_DEFS entry, `chatBlockLabelFor` falls back to a
// humanized version of the tool name.
const TOOL_DEFS: Array<ToolFunctionSpec & { toolset: string; displayLabel?: string }> = [
  {
    toolset: "file",
    displayLabel: "Read file",
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
    displayLabel: "List directory",
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
    displayLabel: "Search files",
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
    displayLabel: "Write file",
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
    displayLabel: "Patch file",
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
    displayLabel: "Fetch URL",
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
    displayLabel: "Run shell command",
    type: "function",
    function: {
      name: "terminal_exec",
      description: "Run a shell command in the workspace. Approval-gated; user must approve. Returns stdout/stderr and exit code. Set timeoutMs explicitly for slow commands (Apple/AppleScript-backed CLIs like memo or remindctl can take 30+ seconds; brew installs can take minutes). Set pty=true for interactive CLI tools (vim, memo, claude-code, codex, python repl) — without pty they hang or exit immediately because stdin is not a TTY. Commands always run with a clean env: no connector secrets are ever injected, so a Linear-token leak can't ride alongside a curl invocation. A command that genuinely needs a connector credential must ship as a skill script and be invoked via `skill_run` — that is the only path connector secrets enter a process.",
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
    displayLabel: "Run code",
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
    displayLabel: "Read skill",
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
    displayLabel: "Spawn subagent",
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
    displayLabel: "Open page",
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
    displayLabel: "Snapshot page",
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
    displayLabel: "Click element",
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
    displayLabel: "Type text",
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
    displayLabel: "Press key",
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
    displayLabel: "Scroll page",
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
    displayLabel: "Go back",
    type: "function",
    function: {
      name: "browser_back",
      description: "Navigate back one entry in the browser history. Returns a fresh snapshot.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Read console",
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
    displayLabel: "Close browser",
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the browser session for the current task. Frees the underlying BrowserContext immediately instead of waiting for the idle sweeper.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Hover element",
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
    displayLabel: "Drag element",
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
    displayLabel: "Select option",
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
    displayLabel: "Wait for element",
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
    displayLabel: "Manage tabs",
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
    displayLabel: "Upload file",
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
    displayLabel: "See page",
    type: "function",
    function: {
      name: "browser_connect",
      description: "Surface a Connect button in chat so the user can sign in to a third-party service in a visible Chrome window. Use this whenever a navigation lands on a sign-in / OAuth / auth-wall page (login screen, identity-provider redirect, 401/403, \"please sign in\" interstitial) — do NOT report sign-in as a blocker, call this tool instead. The user clicks Connect, signs in once, clicks \"I've signed in\", then the browser switches to headless and the agent continues with the persisted session. Always pass `url`: the page the agent was trying to reach (so the visible Chrome opens directly on the sign-in form).",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "One short user-facing sentence shown in the approval card (e.g. 'Sign in to Amazon to manage your Audible subscription')." },
          url: { type: "string", description: "Absolute http(s) URL the agent was trying to reach. The visible Chrome opens directly on this page so the user lands on the sign-in form, and the agent retries this URL after sign-in." },
          headless: { type: "boolean", description: "Reserved for the legacy auto-approve path. Leave unset in normal use — the two-stage Connect / \"I've signed in\" flow handles the headed→headless transition automatically.", default: false }
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
    displayLabel: "Request connector",
    type: "function",
    function: {
      name: "request_connector",
      description: "Ask the user to connect a credential the task needs. This is the ONLY way to obtain a credential: it renders a SECURE inline input in the web chat so the value is captured server-side — NEVER ask the user to paste an API key, token, or secret as a normal chat message (the value would land in your context and the transcript). Two ways to call it: (1) pass a registered `provider` id (e.g. 'linear', 'github') for a known service; or (2) for a brand-new service that has no provider module, pass `name` + `type:\"api-key\"` (and optionally `label`, `mcpUrl`, `skillId`) to request an arbitrary api-key credential. Templateless requests support api-key ONLY — an oauth2 credential requires a registered provider or setup skill. The user sees a Connect button in the chat; the task pauses until they finish the setup, then resumes automatically.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Registered provider id (e.g. 'linear'). Use this for a known service whose setup is already modeled. Omit it (and pass `name` + `type:\"api-key\"` instead) for a brand-new service with no provider module." },
          name: { type: "string", description: "Credential name for a templateless request (no registered provider). It IS the environment variable, so it must be an uppercase token like SOME_SERVICE_API_KEY (matches /^[A-Z][A-Z0-9_]*$/). Required when `provider` is omitted." },
          type: { type: "string", enum: ["api-key"], description: "Credential type for a templateless request. Only 'api-key' (a single secret token stored in the env var named by `name`) is supported templatelessly; an oauth2 credential needs a registered provider or setup skill. Required when `provider` is omitted." },
          label: { type: "string", description: "Optional human-readable label shown to the user for a templateless request (e.g. 'Some Service'). Defaults to `name`." },
          mcpUrl: { type: "string", description: "Optional MCP server URL to associate with an api-key credential (templateless requests only)." },
          skillId: { type: "string", description: "Optional id of the skill that needs this credential. When set, completing the card both stores the credential AND grants it to this skill — no separate consent card." },
          reason: { type: "string", description: "The full user-visible message shown above the inline Connect form. You are responsible for producing the complete text — including any URLs, project IDs, click instructions, or step-by-step guidance the user needs. Substitute any real values (project ids, etc.) directly into the string; do not leave `${...}` placeholders. The skill body (when one applies) shows the exact format to follow; copy it line-for-line, fill in the real values, and pass the result here verbatim." }
        },
        required: ["reason"]
      }
    }
  },
  {
    // Browser-fill-secrets affordance. When the agent's browser tool
    // reaches a login or other input form whose values must come from
    // the user (passwords, OTPs, account ids, MFA codes), the agent
    // calls this tool. The user sees a card in chat with one input
    // field per slot, types the value(s), and the gateway pipes them
    // straight into page.locator(...).fill(...) via the same /connect
    // endpoint connector.request uses. Submitted values are never
    // persisted, never enter the LLM context, never reach the
    // transcript or audit payload — see ADR browser-fill-secret.md.
    toolset: "browser",
    displayLabel: "Ask user for browser input",
    type: "function",
    function: {
      name: "browser_fill_secrets",
      description: "Ask the user to fill one or more input fields on the active browser page. Use this for credentials, OTPs, account ids, or any value the user must type — NEVER attempt to fill these fields yourself with browser_type. The user sees a single card in chat with one input per slot; once they submit, the gateway fills each locator on the page with the user's value via playwright. Requires an active browser session — call browser_navigate first if needed. Your tool result is a plain-text summary naming which slots filled (by slot.name, never values), which errored, and any abort condition (cancel, origin drift); you never see the values themselves. Re-snapshot the page after this returns to see the post-fill state. If more fields need filling (e.g. an MFA code on the next page), call this tool again.",
      parameters: {
        type: "object",
        properties: {
          slots: {
            type: "array",
            description: "One entry per input field to fill. Order matters — fields are filled in array order. Each slot's name is opaque (used only as the key in the secrets dict the user submits); locator is the playwright selector or @-ref of the input; label is the human-readable text shown next to the input in chat; kind picks the HTML input type for masking.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Slot identifier (e.g. 'username', 'password', 'otp'). Used as the secrets-dict key on submit; not shown to the user." },
                locator: { type: "string", description: "Playwright selector (CSS, text=, etc.) or @-ref from a recent browser_snapshot. The gateway fills this locator via playwright at fill time." },
                label: { type: "string", description: "Human-readable label rendered next to the input in chat (e.g. 'GitHub password')." },
                kind: { type: "string", enum: ["text", "password", "email", "tel", "number", "url"], description: "HTML input type for the rendered field. Use 'password' to mask the value while the user types. Defaults to 'text'." }
              },
              required: ["name", "locator", "label"]
            }
          },
          reason: { type: "string", description: "Short user-visible text shown above the form (e.g. 'Sign in to GitHub to continue'). One line." }
        },
        required: ["slots", "reason"]
      }
    }
  },
  {
    // Messaging-bridge-request affordance. Surfaces the same inline form
    // card used by `request_connector` / `browser_fill_secrets`, but for
    // adding a Telegram bridge. The agent calls this when the user asks
    // something like "add a telegram bot" or "wire up telegram"; the
    // user sees a card with a name input and a bot-token input
    // (password-masked) inside the chat. On Submit, the gateway
    // forwards the values to addMessagingBridge — same code path the
    // CLI (`gini messaging add`) and the settings page already go
    // through. Bot token never enters the model context, the audit row
    // evidence, or the chat transcript.
    //
    // Discord is deliberately NOT advertised in the kind enum: a
    // Discord bridge requires a list of channel IDs (deliveryTargets)
    // that the current chat card doesn't collect, so the create would
    // always fail at the /connect handler's deliveryTargets check.
    // Discord still flows through the CLI and the settings dialog,
    // both of which surface the channel-ID input. When the chat card
    // grows a channel-IDs textarea, widen the enum here.
    toolset: "messaging",
    displayLabel: "Add messaging bridge",
    type: "function",
    function: {
      name: "request_messaging_bridge",
      description: "Ask the user to wire up a Telegram messaging bridge by entering a bot token. Use this when the user says something like 'add a telegram bot', 'connect telegram', or any other Telegram onboarding ask. The user sees an inline card in chat with a name input and a password-masked bot-token input; once they submit, the bridge is created on the runtime — same path as the CLI's `gini messaging add` and the settings page's Add Telegram dialog. The task pauses on this approval and resumes automatically after the user submits. AFTER the bridge resolves successfully, the agent SHOULD typically chain `wait_for_messaging_pair` next so the user gets walked through the DM-the-bot → approve-the-pair handshake without context-switching — only skip the wait if the user explicitly asked to just provision the bridge without pairing right now. For Discord, point the user at the settings page (Add Discord button) because Discord bridges need a channel-ID list that this chat card does not collect.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["telegram"],
            description: "Which bridge kind to add. Only 'telegram' is supported from chat today; for Discord, direct the user to the settings page."
          },
          suggestedName: {
            type: "string",
            description: "Optional default name for the bridge (e.g. 'my-telegram-bot'). The user can edit this in the card before submitting. Defaults to a kind-derived placeholder when omitted."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the form explaining what the bridge will do (e.g. 'Add a Telegram bot so I can DM you updates.'). One line."
          }
        },
        required: ["kind"]
      }
    }
  },
  {
    // Read-only inventory of messaging bridges. Always-on so the agent
    // can answer "what bridges do I have?" or "is the telegram bot
    // configured?" without needing the messaging toolset enabled. Same
    // always-on rationale as request_messaging_bridge: meta-tools that
    // surface UI / read state are always available; the
    // surface-gateway send_message tool stays gated.
    toolset: "messaging",
    displayLabel: "List messaging bridges",
    type: "function",
    function: {
      name: "list_messaging_bridges",
      description: "List the messaging bridges configured on this Gini instance. Returns each bridge's id, name, kind (telegram | discord | demo), status (configured | error | disabled), and bot username when present. Useful before suggesting bridge changes ('do you already have telegram?'), before calling request_remove_messaging_bridge or request_messaging_pairing (so you can target the right bridge id), or whenever the user asks 'what bots are connected?'. Read-only and cheap — call it whenever you need fresh state.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    // Read-only inventory of a Telegram bridge's pending pairing
    // requests + allowlist. Always-on for the same reason as
    // list_messaging_bridges. Cheap; call before
    // request_messaging_pairing so the operator card shows the
    // current row.
    toolset: "messaging",
    displayLabel: "List messaging pairings",
    type: "function",
    function: {
      name: "list_messaging_pairings",
      description: "List the pending Telegram pairing requests AND the currently-allowed chats for a bridge. Returns an object with `allowedChatIds` (the chats already enrolled) and `recentDeniedChats` (each pending row's chatId, sender, chatType, lastAttemptAt). Call this when the user says 'any pending bots?' / 'who DM'd the bot?' / 'show pairings'; the result tells you whether to immediately call request_messaging_pairing to surface an approve card. Verification codes are NOT returned by this tool — the operator confirms them out-of-band against the bot's DM reply, and request_messaging_pairing reads the code server-side when minting the approval. Only telegram bridges have an allowlist; calling on a discord/demo bridge returns an error envelope.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id (e.g. 'bridge_abc123') or human name (e.g. 'my-telegram-bot') of the bridge to query. Get it from list_messaging_bridges first if you're not sure."
          }
        },
        required: ["bridge"]
      }
    }
  },
  {
    // Approval-gated affordance for confirming or rejecting an
    // inbound Telegram pairing request from chat. The agent calls
    // this after list_messaging_pairings shows there's a pending
    // entry the user has likely just DM'd the bot from; the chat
    // card displays the sender + verification code + expiry so the
    // operator can verify the code matches what the user reports
    // before approving. Approve / Reject both go through /connect
    // (the agent doesn't run the side effect directly).
    toolset: "messaging",
    displayLabel: "Wait for messaging pair",
    type: "function",
    function: {
      name: "wait_for_messaging_pair",
      description: "Block server-side until an inbound Telegram pairing request arrives on the named bridge, then automatically surface the messaging.approve_pairing confirmation card so the user can Approve / Reject inline. Use this RIGHT AFTER request_messaging_bridge succeeds: the agent should stay engaged with the user through the bridge add → user DMs bot → approve dance instead of returning control and asking the user to come back. The tool blocks for up to `timeoutSeconds` (default 600) checking for a fresh pending row every second; the moment one appears it mints the approval card and pauses the task on it. On Approve/Reject the chat-task loop resumes with the outcome string and the agent continues. On timeout, returns `{ok: false, error: 'timeout'}` so the agent can ask the user whether to keep waiting.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id or name to watch for inbound pairings. Same shape as list_messaging_pairings."
          },
          timeoutSeconds: {
            type: "number",
            description: "Max seconds to block waiting for an inbound pair. Default 600 (10 min — matches the verification code's TTL so a slow user can still complete pairing on the same code). The runtime clamps to [10, 1800]."
          },
          reason: {
            type: "string",
            description: "Optional user-visible text shown above the eventual approval card (e.g. 'Confirm the code I'm seeing matches what your bot replied with.'). One line."
          }
        },
        required: ["bridge"]
      }
    }
  },
  {
    toolset: "messaging",
    displayLabel: "Approve pairing request",
    type: "function",
    function: {
      name: "request_messaging_pairing",
      description: "Surface an Approve / Reject card in chat for a single pending Telegram pairing request. Use this when list_messaging_pairings reveals a pending row that the user is asking about (e.g. they just DM'd the bot from their phone and want to be enrolled). The card shows the sender, chat id, verification code, and expiry — the user clicks Approve only after confirming the code matches what their Telegram client received. Approve enrolls the chat on the allowlist and the bot greets the user; Reject clears the pending row without enrolling. Don't call this for pairing requests with expired codes — tell the user to DM the bot again to mint a fresh code.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id or name. Same shape list_messaging_pairings accepts."
          },
          chatId: {
            type: "number",
            description: "Telegram chat id from the pending row. Negative ids are valid (groups/supergroups), positive ids are direct DMs."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the card (e.g. 'Confirm this is you on Telegram before I enroll your chat.'). One line."
          }
        },
        required: ["bridge", "chatId"]
      }
    }
  },
  {
    // Approval-gated destructive affordance for tearing down a
    // configured bridge from chat. Same passthrough-card pattern as
    // the other request_ tools; the card surfaces a Remove
    // confirmation with the bridge name. On Submit the runtime calls
    // removeMessagingBridge — same path the CLI / settings page use.
    toolset: "messaging",
    displayLabel: "Remove messaging bridge",
    type: "function",
    function: {
      name: "request_remove_messaging_bridge",
      description: "Ask the user to confirm tearing down a messaging bridge from chat. The card shows the bridge's name + kind + an irreversibility warning ('deletes the bridge and its bot token; past messages stay in history'). Use this when the user says 'remove my telegram bot', 'delete the discord bridge', etc. List with list_messaging_bridges first if you don't already know the bridge id. The card requires explicit Remove confirmation; the user can Cancel to back out.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id (e.g. 'bridge_abc123') or human name (e.g. 'my-telegram-bot'). Resolves to the same record list_messaging_bridges returns."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the confirmation (e.g. 'Confirm you want to delete the my-telegram-bot bridge and its bot token.'). One line."
          }
        },
        required: ["bridge"]
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
    displayLabel: "Call MCP tool",
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
    // skill_run: invoke a script that ships with an enabled skill. The
    // skill's SKILL.md documents what scripts it offers and what args
    // each takes; the runtime spawns the script with stdin = JSON args,
    // env = connector secrets + GINI_* context, and returns stdout
    // parsed as JSON. This is the dispatch surface for recipe-shaped
    // procedures that live in skills (signed-URL upload flows, multi-
    // step orchestrations, format conversions) — distinct from `mcp_call`
    // (which hits external MCP servers) and from the primitive tools in
    // the catalog (which expose raw runtime capabilities).
    //
    // Read the skill's body via read_skill first to know which scripts
    // exist and what args they take.
    toolset: "mcp",
    displayLabel: "Run skill script",
    type: "function",
    function: {
      name: "skill_run",
      description: "Invoke a script that ships with an enabled skill. Use this for skill-bundled procedures (e.g. `skill_run({skill:'attachments', script:'signed-upload', args:{uploadId, url, headers}})` for signed-PUT upload flows). The skill's SKILL.md is the reference for which scripts it offers and what args each takes — read_skill it first. Returns the script's JSON result verbatim, or `{ok:false, error}` on script failure / non-JSON output.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Name of the enabled skill that owns the script (e.g. 'attachments')." },
          script: { type: "string", description: "Script basename (no extension) inside the skill's scripts/ folder (e.g. 'signed-upload')." },
          args: { type: "object", description: "Args object passed to the script as JSON on stdin. Shape is per-script; the skill's SKILL.md documents it.", additionalProperties: true }
        },
        required: ["skill", "script"]
      }
    }
  },
  {
    // vision_query: ask the configured vision model a question about a
    // Gini upload. Like browser_vision but for arbitrary uploads — pairs
    // with skill-managed downloads/uploads and chat-attached images so
    // the model can "see" content it didn't start with as a data URL.
    // Stays in core (not a skill script) because it's a thin wrapper
    // over the model's internal multimodal capability — same shape as
    // browser_vision and web_fetch.
    toolset: "mcp",
    displayLabel: "Vision query",
    type: "function",
    function: {
      name: "vision_query",
      description: "Ask the configured vision model a question about an existing Gini upload (image/png or image/jpeg). Use this for chat-attached screenshots when you need to inspect details beyond what's already in vision context, or after skill scripts (e.g. attachments/signed-download) landed an image and you want the model to describe / extract from it. Returns { ok, answer, usage?, error? }. Costs a vision-model call.",
      parameters: {
        type: "object",
        properties: {
          uploadId: { type: "string", description: "Id of the image upload to query (from the chat marker, or from a skill script that landed an upload)." },
          question: { type: "string", description: "What to ask about the image." },
          maxTokens: { type: "number", description: "Optional cap on the response length. Default 512." }
        },
        required: ["uploadId", "question"]
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
    displayLabel: "Schedule job",
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
    displayLabel: "List jobs",
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
    displayLabel: "Update job",
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
    displayLabel: "Delete job",
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
    displayLabel: "Install skill",
    type: "function",
    function: {
      name: "install_skill",
      description: "Install a skill from a raw SKILL.md document. Validates the manifest, writes it under the instance's skills directory, and reloads the skill registry. Use when the user shares a SKILL.md body (or you generated one) and wants it active. Companion to the meta/install-skill agent skill — that skill drives the full UX flow; this tool is the direct API call.",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "Full SKILL.md content (YAML frontmatter + markdown body)." },
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
    displayLabel: "Enable skill",
    type: "function",
    function: {
      name: "enable_skill",
      description: "Enable a registered skill so it appears in the advertised-skills block and the agent can read its body. Use after the user asks to turn a skill on (or after install_skill if the manifest didn't auto-enable). Bundled (first-party) skills enable immediately. Enabling a non-bundled skill that requires a credentialed connector first prompts the user for a one-time consent grant (a setup card per connector) before the skill can use that credential — expect the call to come back pending; the loop resumes once the user grants.",
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
    displayLabel: "Disable skill",
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
    displayLabel: "Cancel task",
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
    displayLabel: "Send message",
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
    // Cross-session lookup. Scans past tasks, traces, skills, and audit
    // rows for a substring match. Low-risk; read-only. (Pinned memories
    // were dropped in the state.memories consolidation — for memory
    // recall use `recall_memory` against the Hindsight bank instead.)
    toolset: "session_search",
    displayLabel: "Search history",
    type: "function",
    function: {
      name: "search_history",
      description: "Search past chat sessions, task traces, skill text, and audit events for a substring. Use when the user references something they did before ('did I ever ask about X?', 'find that conversation about Y'). Returns up to `limit` snippets ordered by score, each with kind (task/trace/skill/audit), title, excerpt, and taskId when applicable. For memory recall use `recall_memory` instead — it queries the Hindsight bank where auto-retain persists facts.",
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
    displayLabel: "Recall memory",
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
    // Manually trigger an existing scheduled job. Wraps the same
    // `runJobNow` entrypoint that `POST /api/jobs/<id>/run` calls. Low-risk
    // / no approval: the spawned task itself still flows through the job's
    // configured `approvalMode` / `autoApproveCommands`, so any side
    // effects inside the run are gated at their normal granularity. The
    // tool only fires an EXISTING job — for one-off prompts use create_job
    // with intervalSeconds + oneShot=true instead.
    toolset: "jobs",
    displayLabel: "Run job",
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
  },
  {
    // Propose an edit to the active agent's SOUL.md (per-agent persona).
    // The tool writes the new body to SOUL.md.proposed; the runtime
    // continues to read the approved SOUL.md (if any) until the user
    // approves the proposal via `POST /api/identity-files/soul/approve`.
    // Always exposed alongside add_memory — the "identity" toolset is
    // not part of the legacy default set; gating on enable would silently
    // hide the per-agent persona surface on fresh instances.
    // See ADR runtime-identity-files.md.
    toolset: "identity",
    displayLabel: "Edit persona",
    type: "function",
    function: {
      name: "edit_soul",
      description: "Propose an edit to the active agent's SOUL.md — the agent's persona / character / identity, as ASSIGNED BY THE USER. Rare: most chat sessions never call this. Only fire when the user is explicitly sculpting WHO the agent IS, not WHAT TO DO for them. Example phrasings that DO trigger this tool: \"You are Athena, a research assistant\"; \"Act as a stoic critic with strong opinions\"; \"You're a sardonic, witty assistant who doesn't hedge\"; \"Speak like a pirate from now on\". Example phrasings that DO NOT trigger this tool: \"I prefer concise replies\", \"be more concise\", \"no pleasantries\", \"use bullet points\" — those are USER preferences about how the user wants replies and route to `edit_user_profile`. When in doubt, default to `edit_user_profile`; SOUL.md is a deliberate opt-in. Prefer `action: \"set\"` with the full consolidated SOUL.md body under H2 sections (`## Voice`, `## Style`, `## Boundaries`) — the current file is visible in the system prompt above, so emit the new version with the new content integrated under the right section. Write entries as facts about the agent's identity, not directives to yourself (\"Voice is terse\" ✓ — \"Always be terse\" ✗). Aim to keep the file under the soft cap shown in the SOUL persona header (1500 chars); when near or over cap, consolidate. The proposed body lands as SOUL.md.proposed and does NOT enter the system prompt until the user approves it via `POST /api/identity-files/soul/approve`. After calling, you MAY briefly mention the approval step but do NOT otherwise narrate the tool call. `action: \"append\"` adds a new section below existing content (prefer set; append is a legacy fallback). `action: \"remove\"` drops the first paragraph containing the `needle` substring from the existing approved body; requires `needle`. Requires an active agent — there is no per-instance SOUL.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "append", "remove"],
            description: "Whether to replace the whole SOUL.md body (set), append a new section below the existing approved content (append), or drop the first paragraph containing `needle` from the existing approved content (remove).",
            default: "set"
          },
          content: { type: "string", description: "The new SOUL.md body (action=set) or the section to append (action=append). Keep it concise — every turn pays for this in tokens. Not required for action=remove." },
          needle: { type: "string", description: "Required when action=remove. A plain substring; the first paragraph in the existing approved SOUL.md that contains this substring is dropped." }
        },
        required: []
      }
    }
  },
  {
    // Edit the instance-scoped USER.md. Auto-approved: writes land at
    // USER.md directly and ride the system prompt on the next turn.
    // USER.md is instance-scoped so the user's identity carries across
    // agent switches. Distinct from edit_soul (per-agent persona, still
    // propose → approve). Always exposed. See ADR
    // runtime-identity-files.md.
    toolset: "identity",
    displayLabel: "Edit user profile",
    type: "function",
    function: {
      name: "edit_user_profile",
      description: "Edit the instance-scoped USER.md — facts and preferences ABOUT THE USER. Two kinds of content fire this tool: (1) facts about the user — name, role, location, employer, languages, family; (2) preferences for how the user wants you to communicate — \"I prefer concise replies\", \"be more concise\", \"no pleasantries\", \"use bullet points for lists\", \"wants detailed technical explanations\". Even when the user phrases a preference as an imperative (\"be direct with me\", \"skip the preamble\"), it is a preference about how the user wants replies → this tool, NOT `edit_soul`. If the user is talking about themselves OR about how they want replies, use this tool. `edit_soul` is reserved for the rare case where the user is explicitly assigning the agent a persona (\"You are X\", \"Act as X\"). When in doubt, default to this tool. Prefer `action: \"set\"` with the full consolidated USER.md content under H2 sections (`## Identity`, `## Preferences`, `## Background`, `## Goals`) — the current file is visible in the system prompt above, so emit the new version with the new content integrated under the right section rather than appending a chunk below. Only call when the user's CURRENT message contains a NEW durable fact or preference NOT already in USER.md. Write entries as facts ABOUT the user, not directives to yourself (\"User prefers concise replies\" ✓ — \"Always reply concisely\" ✗); imperative phrasing in USER.md gets re-read next session as a system directive. Casual chat and follow-up questions are NOT identity facts — most turns should produce ZERO calls. Aim to keep the file under the soft cap shown in the USER profile header (1500 chars); when near or over cap, consolidate. DO NOT save task progress, PR/issue/commit IDs, completed-work logs, or other transient state — those belong in long-term memory (auto-retain handles them silently). Do NOT narrate the call: just acknowledge briefly (\"Got it, X.\", \"Noted.\"). Auto-approved: writes go straight to USER.md and ride the system prompt on the next turn. USER.md is instance-scoped so the user's identity bridges across agent switches. The injection scan still gates content that trips a threat pattern. `action: \"append\"` adds a new section (legacy fallback; the storage layer de-duplicates lines that already exist); `action: \"remove\"` drops the first paragraph containing the `needle` substring (requires `needle`). Distinct from edit_soul which still requires user approval.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "append", "remove"],
            description: "Whether to replace the whole USER.md body (set), append a new section below the existing content (append), or drop the first paragraph containing `needle` from the existing content (remove).",
            default: "set"
          },
          content: { type: "string", description: "The new USER.md body (action=set) or the section to append (action=append). Not required for action=remove." },
          needle: { type: "string", description: "Required when action=remove. A plain substring; the first paragraph in the existing USER.md that contains this substring is dropped." }
        },
        required: []
      }
    }
  }
];

export type ToolCatalogTool = ToolFunctionSpec & {
  toolset: string;
  displayLabel?: string;
};

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
    // skill_run is the generic dispatch surface for skill-bundled
    // procedures (recipe-shaped operations that live in skills, not in
    // core). Always-on alongside mcp_call so a fresh instance can invoke
    // any skill script without toolset toggling — the skill's `enabled`
    // status is the gate.
    if (tool.function.name === "skill_run") return true;
    // vision_query is the base primitive that exposes the model's
    // multimodal capability against arbitrary uploads — like
    // browser_vision but not tied to the browser session. Always-on
    // alongside mcp_call for the same reasons.
    if (tool.function.name === "vision_query") return true;
    // request_connector is the in-chat affordance that lets the agent
    // ask the user to wire up a missing connector. Same always-on
    // rationale: a fresh instance with no toolsets toggled still needs
    // to be able to surface "connect linear" when the linear skill is
    // inactive — gating on a legacy toolset would silently disable the
    // onboarding path.
    if (tool.function.name === "request_connector") return true;
    // browser_fill_secrets is the in-chat affordance for credential
    // entry on the agent's browser tab. Always-on for the same
    // reason as request_connector: a fresh instance with no toolsets
    // toggled still needs the agent to be able to ask the user for a
    // password mid-task. The browser_type tool is gated by the
    // browser toolset, but browser_fill_secrets is a meta-tool
    // (renders a chat card; never types anything itself) and stays
    // visible so the agent can always escalate to the user instead
    // of guessing a credential.
    if (tool.function.name === "browser_fill_secrets") return true;
    // request_messaging_bridge is the in-chat affordance for adding a
    // Telegram / Discord bridge — peer of request_connector but for
    // outbound messaging plumbing. Always-on for the same reason: the
    // user should be able to ask "add a telegram bot" on a fresh
    // instance without first toggling a toolset. The owning toolset is
    // "messaging" (same as `send_message`), but unlike send_message
    // this is a meta-tool that surfaces a credential form card; it
    // doesn't egress data on its own. Always exposed so the onboarding
    // path stays reachable even when the messaging toolset is disabled
    // by operators who don't want the agent autonomously sending DMs.
    if (tool.function.name === "request_messaging_bridge") return true;
    // The rest of the chat-side messaging lifecycle: read-only
    // inventory (list_messaging_bridges, list_messaging_pairings) so
    // the agent can answer state questions, and approval-gated
    // request_messaging_pairing / request_remove_messaging_bridge so
    // the agent can drive pair-approval and removal from chat without
    // the user needing to context-switch to the settings page. Same
    // always-on rationale as request_messaging_bridge: meta-tools that
    // surface UI cards or read state ride alongside it; the
    // surface-gateway send_message tool stays gated by the messaging
    // toolset kill switch.
    if (tool.function.name === "list_messaging_bridges") return true;
    if (tool.function.name === "list_messaging_pairings") return true;
    if (tool.function.name === "wait_for_messaging_pair") return true;
    if (tool.function.name === "request_messaging_pairing") return true;
    if (tool.function.name === "request_remove_messaging_bridge") return true;
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
    // must work. Flipping the `messaging` toolset to disabled is how
    // the operator turns it off.
    if (tool.function.name === "cancel_task") return true;
    if (tool.function.name === "install_skill") return true;
    if (tool.function.name === "enable_skill") return true;
    if (tool.function.name === "disable_skill") return true;
    // Identity-file edit tools. The "identity" toolset is not part of
    // the legacy default set; gating on enable would silently hide the
    // per-agent SOUL.md / instance USER.md edit surface on fresh
    // instances. The proposed-vs-approved file split (see ADR
    // runtime-identity-files.md) keeps unreviewed content out of the
    // prompt regardless of toolset state, so always-on here is safe.
    if (tool.function.name === "edit_soul") return true;
    if (tool.function.name === "edit_user_profile") return true;
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

// Return the OpenAI tool spec without the `toolset` / `displayLabel`
// annotations we use for filtering and chat rendering. The provider
// only knows the `type/function` shape.
export function toProviderTools(tools: ToolCatalogTool[]): ToolFunctionSpec[] {
  return tools.map(({ toolset: _toolset, displayLabel: _displayLabel, ...rest }) => rest);
}

// Display-label lookup for ChatBlock rendering. Returns the catalog
// entry's explicit `displayLabel` when set; otherwise humanizes the
// tool's machine name (`file_read` → `File read`) as a stable fallback.
// Centralized server-side so web, mobile, and CLI bridges render the
// same vocabulary in tool_call ChatBlocks (ADR chat-block-protocol.md).
export function chatBlockLabelFor(toolName: string): string {
  const entry = TOOL_DEFS.find((t) => t.function.name === toolName);
  if (entry?.displayLabel) return entry.displayLabel;
  // Fallback: split underscores, capitalize the first word, lowercase
  // the rest. `file_read` → `File read`, `mcp_call` → `Mcp call`. We
  // intentionally don't title-case every word — `Search History` looks
  // like a marketing label rather than a compact verb phrase.
  const tokens = toolName.split(/[._]/).filter(Boolean);
  if (tokens.length === 0) return toolName;
  const first = tokens[0]!;
  const head = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const tail = tokens.slice(1).map((t) => t.toLowerCase()).join(" ");
  return tail ? `${head} ${tail}` : head;
}

// Truncate a short headline string to 80 chars with an ellipsis. Picked
// to fit one bubble line on a phone (mobile is the narrowest target);
// web can expand the bubble for the full args object via `argsFull`.
function truncatePreview(value: string, maxLen = 80): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + "…";
}

// Stringify the value half of an args entry compactly: strings pass
// through, numbers/booleans are coerced, objects/arrays are JSON-encoded
// with a hard length cap so a giant blob doesn't blow out the preview.
function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Per-tool argsPreview override — returns the most useful 1-line
// representation of the call's headline argument. Falls back to a
// generic "key=value, ..." dump of all top-level args when no specific
// mapping fires. Always truncated to 80 chars (see truncatePreview).
//
// Add new entries here as new tools land; the helper deliberately
// covers all the current first-class tools so clients render a useful
// inline preview without each one rebuilding the per-tool mapping.
export function chatBlockArgsPreviewFor(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): string {
  const safe = args ?? {};
  // Headline-arg mapping per tool. Order matters within an entry only
  // when multiple alt sources are queried (e.g. `browser_*` may have
  // `url` OR `ref`).
  switch (toolName) {
    case "file_read":
    case "file_list":
    case "file_search":
    case "file_write":
    case "file_patch":
      return truncatePreview(previewValue(safe.path) || previewValue(safe.pattern));
    case "web_fetch":
      return truncatePreview(previewValue(safe.url));
    case "terminal_exec":
      return truncatePreview(previewValue(safe.command));
    case "code_exec":
      return truncatePreview(`${previewValue(safe.language) || "code"}: ${previewValue(safe.code)}`);
    case "read_skill":
    case "enable_skill":
    case "disable_skill":
      return truncatePreview(previewValue(safe.name) || previewValue(safe.skillId));
    case "install_skill":
      return truncatePreview("skill");
    case "spawn_subagent":
      return truncatePreview(previewValue(safe.name) || previewValue(safe.prompt));
    case "browser_navigate":
      return truncatePreview(previewValue(safe.url));
    case "browser_click":
    case "browser_type":
    case "browser_hover":
    case "browser_select_option":
    case "browser_upload_file":
      return truncatePreview(previewValue(safe.ref));
    case "browser_press":
      return truncatePreview(previewValue(safe.key));
    case "browser_scroll":
      return truncatePreview(previewValue(safe.direction));
    case "browser_wait_for":
      return truncatePreview(previewValue(safe.ref) || previewValue(safe.text));
    case "browser_tabs":
      return truncatePreview(previewValue(safe.action));
    case "browser_vision":
      return truncatePreview(previewValue(safe.question));
    case "browser_drag":
      return truncatePreview(
        `${previewValue(safe.fromRef)} → ${previewValue(safe.toRef)}`
      );
    case "browser_snapshot":
    case "browser_back":
    case "browser_close":
    case "browser_console":
      return "";
    case "mcp_call":
      return truncatePreview(
        `${previewValue(safe.server)}.${previewValue(safe.tool)}`
      );
    case "skill_run":
      return truncatePreview(`${previewValue(safe.skill)}/${previewValue(safe.script)}`);
    case "vision_query":
      return truncatePreview(`${previewValue(safe.uploadId)}: ${previewValue(safe.question)}`);
    case "request_connector":
      return truncatePreview(previewValue(safe.provider));
    case "request_messaging_bridge":
      return truncatePreview(previewValue(safe.kind));
    case "list_messaging_bridges":
      return "";
    case "list_messaging_pairings":
      return truncatePreview(previewValue(safe.bridge));
    case "wait_for_messaging_pair":
      return truncatePreview(previewValue(safe.bridge));
    case "request_messaging_pairing":
      return truncatePreview(`${previewValue(safe.bridge)} chat ${previewValue(safe.chatId)}`);
    case "request_remove_messaging_bridge":
      return truncatePreview(previewValue(safe.bridge));
    case "create_job":
    case "run_job":
    case "delete_job":
    case "update_job":
      return truncatePreview(previewValue(safe.name) || previewValue(safe.jobId));
    case "list_jobs":
      return truncatePreview(previewValue(safe.nameContains) || "");
    case "cancel_task":
      return truncatePreview(previewValue(safe.taskId));
    case "send_message":
      return truncatePreview(previewValue(safe.text));
    case "search_history":
      return truncatePreview(previewValue(safe.query));
    case "recall_memory":
      return truncatePreview(previewValue(safe.query));
    case "add_memory":
      return truncatePreview(previewValue(safe.content));
    case "update_memory":
      return truncatePreview(previewValue(safe.memoryId));
    default: {
      // Generic fallback: key=value, ... for the first few entries.
      // Keeps unmapped or future tools from emitting an empty preview.
      const parts = Object.entries(safe)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${previewValue(value)}`);
      return truncatePreview(parts.join(", "));
    }
  }
}
