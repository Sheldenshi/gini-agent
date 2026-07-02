// `gini reranker status` — surfaces the active reranker provider, model,
// top-N, and shared cache state. Mirrors `gini embedding status`. There's
// no reembed-equivalent — the reranker is stateless.

import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function reranker(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "status") {
    print(await api(config, "/api/reranker/status"));
    return;
  }
  // help/usage
  throw new Error("Usage: gini reranker <status>");
}
