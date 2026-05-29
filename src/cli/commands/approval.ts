import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function approval(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "approve" || sub === "deny") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini approval ${sub} <approval-id>`);
    print(await api(config, `/api/authorizations/${id}/${sub === "approve" ? "approve" : "deny"}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/authorizations"));
}
