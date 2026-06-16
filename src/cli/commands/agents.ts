import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function agent(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const [name, ...toolsets] = restAfter(cliArgs, sub);
    if (!name) throw new Error("Usage: gini agent create <name> [toolsets...]");
    print(await api(config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name, toolsets: toolsets.length > 0 ? toolsets : undefined })
    }));
    return;
  }
  if (sub === "use") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini agent use <agent-id-or-name>");
    print(await api(config, `/api/agents/${encodeURIComponent(id)}/use`, { method: "POST" }));
    return;
  }
  if (sub === "rename") {
    const [idOrName, ...rest] = restAfter(cliArgs, sub);
    const name = rest.join(" ");
    if (!idOrName || !name) throw new Error("Usage: gini agent rename <id-or-name> <new name>");
    print(await api(config, `/api/agents/${encodeURIComponent(idOrName)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    }));
    return;
  }
  if (sub === "delete" || sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini agent ${sub} <agent-id-or-name>`);
    print(await api(config, `/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }));
    return;
  }
  if (sub === "archive") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini agent archive <agent-id-or-name>");
    print(await api(config, `/api/agents/${encodeURIComponent(id)}/archive`, { method: "POST" }));
    return;
  }
  if (sub === "unarchive") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini agent unarchive <agent-id-or-name>");
    print(await api(config, `/api/agents/${encodeURIComponent(id)}/unarchive`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/agents"));
}
