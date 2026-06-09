import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

// `gini email list | add --from <sender> [--query <q>] | remove <id>
//   | disable <id> | enable <id>`.
// Thin client over /api/email/watchers (ADR email-watch.md).
export async function email(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const sender = flagValue(cliArgs, "--from");
    const query = flagValue(cliArgs, "--query");
    if (!sender && !query) throw new Error("Usage: gini email add --from <sender> [--query <gmail-query>]");
    print(await api(config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender, query })
    }));
    return;
  }
  if (sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini email remove <watcher-id>");
    print(await api(config, `/api/email/watchers/${id}`, { method: "DELETE" }));
    return;
  }
  if (sub === "disable" || sub === "enable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini email ${sub} <watcher-id>`);
    print(await api(config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: sub === "enable" })
    }));
    return;
  }
  print(await api(config, "/api/email/watchers"));
}
