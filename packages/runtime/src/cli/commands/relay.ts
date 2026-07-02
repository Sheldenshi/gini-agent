import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function relay(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name = "local", endpoint = "local://localhost", mode = "local-only"] = restAfter(cliArgs, sub);
    print(await api(config, "/api/relays", { method: "POST", body: JSON.stringify({ name, endpoint, mode }) }));
    return;
  }
  if (sub === "health") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini relay health <relay-id-or-name>");
    print(await api(config, `/api/relays/${encodeURIComponent(id)}/health`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/relays"));
}
