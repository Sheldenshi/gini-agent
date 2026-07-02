// `gini identity` — inspect and roll back the curated identity files
// (INSTRUCTIONS.md, USER.md, SOUL.md). The implementation is a thin
// transport over the runtime's `/api/identity-files/*` endpoints; the
// canonical behavior (history snapshots, rollback audit) lives in
// src/http.ts and src/runtime/identity-files.ts.

import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function identity(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1];

  if (!sub || sub === "help") {
    throw new Error(
      "Usage: gini identity show|history|rollback <args>\n" +
        "  show [--agent <id>]                      Dump INSTRUCTIONS.md / USER.md / SOUL.md with budget metadata\n" +
        "  history <kind> [--agent <id>]            List snapshots (kind ∈ user, soul; agent required for soul)\n" +
        "  rollback <kind> <snapshot> [--agent <id>]  Restore an identity file from a snapshot"
    );
  }

  if (sub === "show") {
    const agent = flagValue(cliArgs, "--agent");
    const params = new URLSearchParams();
    if (agent) params.set("agentId", agent);
    const query = params.toString();
    print(await api(config, `/api/identity-files${query ? `?${query}` : ""}`));
    return;
  }

  if (sub === "history") {
    const rest = restAfter(cliArgs, sub).filter((arg) => !arg.startsWith("--"));
    const kind = rest[0];
    if (!kind) throw new Error("Usage: gini identity history <user|soul> [--agent <id>]");
    if (kind !== "user" && kind !== "soul") {
      throw new Error(`Unknown identity kind: ${kind}. Expected 'user' or 'soul'.`);
    }
    const agent = flagValue(cliArgs, "--agent");
    if (kind === "soul" && !agent) {
      throw new Error("--agent <id> is required for kind=soul.");
    }
    const params = new URLSearchParams({ kind });
    if (agent) params.set("agentId", agent);
    print(await api(config, `/api/identity-files/history?${params.toString()}`));
    return;
  }

  if (sub === "rollback") {
    const rest = restAfter(cliArgs, sub).filter((arg) => !arg.startsWith("--"));
    const kind = rest[0];
    const snapshot = rest[1];
    if (!kind || !snapshot) {
      throw new Error("Usage: gini identity rollback <user|soul> <snapshot> [--agent <id>]");
    }
    if (kind !== "user" && kind !== "soul") {
      throw new Error(`Unknown identity kind: ${kind}. Expected 'user' or 'soul'.`);
    }
    const agent = flagValue(cliArgs, "--agent");
    if (kind === "soul" && !agent) {
      throw new Error("--agent <id> is required for kind=soul.");
    }
    print(await api(config, "/api/identity-files/rollback", {
      method: "POST",
      body: JSON.stringify({ kind, snapshot, agentId: agent })
    }));
    return;
  }

  throw new Error(
    `Unknown subcommand: gini identity ${sub}. Available: show | history | rollback.`
  );
}
