import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function runs(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "show") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini runs show <run-id>");
    print(await api(config, `/api/runs/${id}`));
    return;
  }
  print(await api(config, "/api/runs"));
}
