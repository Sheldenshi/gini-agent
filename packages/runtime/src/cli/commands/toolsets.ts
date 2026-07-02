import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function toolset(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "enable" || sub === "disable") {
    const name = restAfter(cliArgs, sub)[0];
    if (!name) throw new Error(`Usage: gini toolset ${sub} <name>`);
    print(await api(config, `/api/toolsets/${encodeURIComponent(name)}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/toolsets"));
}
