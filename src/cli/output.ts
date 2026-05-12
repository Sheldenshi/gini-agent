export function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function compactTask(task: { id: string; status: string; title: string; updatedAt: string }) {
  return { id: task.id, status: task.status, title: task.title, updatedAt: task.updatedAt };
}

export function improvementPayload(kind: string, title: string, content: string): Record<string, unknown> {
  if (kind === "skill") {
    return { name: title, description: content, trigger: title, steps: [content], status: "draft" };
  }
  if (kind === "job") {
    return { name: title, prompt: content, intervalSeconds: 3600 };
  }
  return { content, scope: "project", confidence: 0.75 };
}

export function help(): void {
  console.log(`Gini CLI

Usage:
  bun run gini install [--instance dev]
  bun run gini start|stop|status|doctor|reset [--instance dev] [--port 7337]
  bun run gini run [--instance dev] [--no-web]
  bun run gini uninstall [--instance <name>] [--yes] [--purge]
  bun run gini update
  bun run gini setup [--force] [--yes]
  bun run gini task submit <prompt>
  bun run gini task list
  bun run gini task show <task-id>
  bun run gini runs list|show
  bun run gini approvals
  bun run gini approval approve|deny <approval-id>
  bun run gini memory list|add|approve|reject
  bun run gini reranker status
  bun run gini skills list|add|show|search|validate|test|trust|disable|rollback
  bun run gini jobs list|add|run|pause|resume|remove|runs|replay
  bun run gini connectors list|health
  bun run gini improvements list|propose|approve|reject
  bun run gini pairing create|claim
  bun run gini devices list|revoke
  bun run gini mobile bootstrap
  bun run gini search <query>
  bun run gini toolsets list|enable|disable
  bun run gini subagents list|spawn
  bun run gini mcp list|add|health|invoke|disable
  bun run gini messaging list|add|health|disable
  bun run gini import inspect hermes|openclaw <path>
  bun run gini profiles list|create|use
  bun run gini parity hermes
  bun run gini readiness v1
  bun run gini relays list|add|health
  bun run gini notifications list|queue|send|ack
  bun run gini promotions list|propose|approve|reject
  bun run gini snapshots list|create|restore
  bun run gini provider show|catalog|set echo|openai|codex|openrouter|local [model]
  bun run gini trace <task-id>
  bun run gini events
  bun run gini audit
  bun run gini evidence
  bun run gini smoke

Process lifecycle:
  gini start  - daemon mode; instance keeps running after the terminal closes.
                Use this for a persistent personal agent on your machine.
  gini run    - foreground mode; instance dies when this terminal exits or
                you Ctrl-C. Use this for coding-agent worktrees and CI.

Global options:
  --instance <name>        Select a persistent instance. Smoke uses an ephemeral instance when omitted.
  --state-root <path>  Override state root for tests or parallel agents.
  --log-root <path>    Override log root for tests or parallel agents.
  --port <number>      Preferred runtime localhost port. Start scans upward if busy.
  --web-port <number>  Preferred Next.js port (default 3000).
  --no-web             Don't launch the Next.js control plane (smoke uses this automatically).
  --web                Force the Next.js control plane to launch even for smoke runs.
`);
}
