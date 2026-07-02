// `gini embedding status` and `gini embedding reembed` — surfaces the
// active provider, model, cache, and per-bank model breakdown, and lets
// the user re-embed a bank's units after a provider change.

import type { CliContext } from "../context";
import { flagValue, hasFlag } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function embedding(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "status") {
    print(await api(config, "/api/embedding/status"));
    return;
  }
  if (sub === "reembed") {
    const bank = flagValue(cliArgs, "--bank");
    const dryRun = hasFlag(cliArgs, "--dry-run");
    const allBanks = hasFlag(cliArgs, "--all-banks");
    if (allBanks && bank) {
      throw new Error("--all-banks and --bank are mutually exclusive");
    }
    const body = JSON.stringify(
      allBanks ? { allBanks: true, dryRun } : { bankId: bank, dryRun }
    );
    print(await api(config, "/api/embedding/reembed", { method: "POST", body }));
    return;
  }
  // help/usage
  throw new Error(
    "Usage: gini embedding <status|reembed> [--bank ID | --all-banks] [--dry-run]"
  );
}
