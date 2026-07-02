import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { compactTask, print } from "../output";

export async function task(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "submit") {
    const input = restAfter(cliArgs, sub).join(" ").trim();
    if (!input) throw new Error("Usage: gini task submit <prompt>");
    print(await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input }) }));
    return;
  }
  if (sub === "show") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini task show <task-id>");
    print(await api(config, `/api/tasks/${id}`));
    return;
  }
  if (sub === "retry" || sub === "cancel") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini task ${sub} <task-id>`);
    print(await api(config, `/api/tasks/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print((await api(config, "/api/tasks")).map(compactTask));
}
