import type { CliContext } from "../context";
import { restAfter } from "../args";
import { readTrace } from "../../state";
import { print } from "../output";

export function trace(ctx: CliContext): void {
  const { config, cliArgs, command } = ctx;
  const id = restAfter(cliArgs, command)[0];
  if (!id) throw new Error("Usage: gini trace <task-id>");
  print(readTrace(config.instance, id));
}
