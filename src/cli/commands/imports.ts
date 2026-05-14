import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function importInspect(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "inspect") {
    const [source, path] = restAfter(cliArgs, sub);
    if (source !== "openclaw" || !path) {
      throw new Error("Usage: gini import inspect openclaw <path>");
    }
    print(await api(config, "/api/imports/inspect", { method: "POST", body: JSON.stringify({ source, path }) }));
    return;
  }
  print(await api(config, "/api/imports"));
}
