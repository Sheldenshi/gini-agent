---
name: linear
description: "Read and write Linear issues, comments, projects, cycles, and users via the Linear MCP server."
license: MIT
allowed-tools: "mcp_call read_skill"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    requires:
      connectors:
        - provider: linear
---

# Linear

Linear is reachable through the `mcp_call` tool. Each call hits the Linear MCP server at `https://mcp.linear.app/mcp`; the runtime resolves the Authorization header from the connected Linear token. You never see the token or the endpoint — you just pass `server: "linear"` and a tool name.

Every Linear call has the same shape:

```
mcp_call({
  server: "linear",
  tool: "<tool name>",
  arguments: { ... }
})
```

The response is a JSON string. Parse it before reporting back to the user — Linear sometimes returns nested `pageInfo` or arrays you should summarize, not dump.

## When To Use

- User asks about Linear issues, comments, projects, cycles, teams, labels, or members.
- User asks to create or update an issue ("file a bug", "assign LIN-123 to me", "comment on it").
- User asks for the status of their work this week, this cycle, or this sprint.

If the user wants something other than Linear (Jira, GitHub Issues), do NOT use this skill.

## Quick Reference

### Listing issues

```
mcp_call({ server: "linear", tool: "list_issues", arguments: { assignee: "me" } })
```

- `assignee: "me"` resolves to the authenticated viewer — no need to look up the user id first.
- `team: "ENG"` filters by team key.
- `state: "started"` filters by workflow state group. Other groups: `backlog`, `unstarted`, `started`, `completed`, `cancelled`.
- `limit: 25` caps the page. Pagination cursors come back in the response.
- Long issue descriptions are truncated in the list. Use `get_issue` to load the full body.

### Reading a single issue

```
mcp_call({ server: "linear", tool: "get_issue", arguments: { id: "LIN-123" } })
```

Pass either the issue identifier (`LIN-123`) or the UUID. Returns the full description, attachments, and the comment thread head.

### Creating or updating issues

`save_issue` is one tool that handles both. With an `id` it updates; without one it creates.

Create:

```
mcp_call({
  server: "linear",
  tool: "save_issue",
  arguments: {
    team: "ENG",
    title: "Login fails on Safari 17",
    description: "Steps to reproduce…"
  }
})
```

Update (assign + change state):

```
mcp_call({
  server: "linear",
  tool: "save_issue",
  arguments: { id: "LIN-123", assigneeId: "me", state: "In Progress" }
})
```

`team` accepts the team key (`ENG`) or UUID. `state` accepts either a state id or the display name (`"In Progress"`, `"Done"`). `priority` is `0|1|2|3|4` where `1` is urgent and `4` is low.

### Comments

```
mcp_call({ server: "linear", tool: "list_comments", arguments: { issueId: "LIN-123" } })
mcp_call({ server: "linear", tool: "save_comment", arguments: { issueId: "LIN-123", body: "Reproduced on macOS 14." } })
```

### Teams, projects, cycles

```
mcp_call({ server: "linear", tool: "list_teams", arguments: {} })
mcp_call({ server: "linear", tool: "list_projects", arguments: { team: "ENG" } })
mcp_call({ server: "linear", tool: "list_cycles", arguments: { team: "ENG", type: "current" } })
```

`list_cycles` accepts `type: "current" | "next" | "previous"` for relative lookup.

### Users

```
mcp_call({ server: "linear", tool: "list_users", arguments: {} })
mcp_call({ server: "linear", tool: "get_user", arguments: { id: "me" } })
```

### Labels and statuses

```
mcp_call({ server: "linear", tool: "list_issue_labels", arguments: { team: "ENG" } })
mcp_call({ server: "linear", tool: "list_issue_statuses", arguments: { team: "ENG" } })
```

Use these to confirm a label or status exists before passing its name to `save_issue` — otherwise Linear returns a generic validation error.

### Documentation search

```
mcp_call({ server: "linear", tool: "search_documentation", arguments: { query: "GraphQL rate limit" } })
```

Returns the relevant Linear help-center pages. Useful when the user asks "how do I do X in Linear".

## Tips

- Prefer `list_issues` with filters over filtering client-side. Linear can do `assignee`, `team`, `state`, `cycle`, `project`, `label`, and `createdAt`/`updatedAt` ranges server-side.
- `list_issues` truncates `description` to keep responses small. If the user needs the full body, follow up with `get_issue`.
- Paginate by passing the `cursor` from `pageInfo.endCursor` back into the same call.
- Team identifiers are 3–5 letter keys (`ENG`, `DESIGN`, `OPS`). When you don't know the key, call `list_teams` once and cache it for the rest of the conversation.
- Quote issue identifiers verbatim in user-facing replies (`LIN-123`, not `123`). Linear's deeplinks resolve those directly.

## Limitations

- Read-only attachments (the MCP server returns metadata, not bytes).
- No webhook setup — the server is request/response. For live updates, point the user at Linear's native subscriptions.
- Bulk operations (e.g. updating 50 issues at once) must loop client-side; there is no batch tool.

## Rules

1. Always invoke through `mcp_call` with `server: "linear"`. Do not call any other tool to reach Linear.
2. Confirm destructive intent before deleting an issue or comment. Linear has no undo.
3. When the user asks "what am I working on", default to `list_issues({ assignee: "me", state: "started" })` and summarize, not dump.
4. Never include the user's API token in a reply or in any tool argument — the runtime injects it server-side.
