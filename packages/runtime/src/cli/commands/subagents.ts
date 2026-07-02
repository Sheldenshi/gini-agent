import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function subagent(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "spawn") {
    const [name, ...promptParts] = restAfter(cliArgs, sub);
    if (!name || promptParts.length === 0) throw new Error("Usage: gini subagent spawn <name> <prompt>");
    print(await api(config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name, prompt: promptParts.join(" ") })
    }));
    return;
  }
  print(await api(config, "/api/subagents"));
}
