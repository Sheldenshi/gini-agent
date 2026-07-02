import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function search(ctx: CliContext): Promise<void> {
  const { config, cliArgs, command } = ctx;
  const query = restAfter(cliArgs, command).join(" ").trim();
  if (!query) throw new Error("Usage: gini search <query>");
  print(await api(config, `/api/search?q=${encodeURIComponent(query)}`));
}
