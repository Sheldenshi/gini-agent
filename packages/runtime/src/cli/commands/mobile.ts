import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function mobile(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "bootstrap";
  if (sub !== "bootstrap") throw new Error("Usage: gini mobile bootstrap");
  print(await api(config, "/api/mobile/bootstrap"));
}
