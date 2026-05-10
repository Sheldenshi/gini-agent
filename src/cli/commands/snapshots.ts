import type { CliContext } from "../context";
import { restAfter } from "../args";
import { readState } from "../../state";
import { createSnapshot, restoreSnapshot } from "../../runtime/harness";
import { print } from "../output";

export async function snapshot(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const reason = restAfter(cliArgs, sub).join(" ").trim() || "Manual snapshot";
    print(await createSnapshot(config, reason));
    return;
  }
  if (sub === "restore") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini snapshot restore <snapshot-id>");
    print(await restoreSnapshot(config, id));
    return;
  }
  print(readState(config.instance).snapshots);
}
