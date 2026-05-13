import { writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { restAfter } from "../args";
import { configPath } from "../../paths";
import { normalizeProvider, providerHealth } from "../../provider";
import { api } from "../api";
import { print } from "../output";

export async function provider(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "show";
  if (sub === "set") {
    const name = restAfter(cliArgs, sub)[0];
    const model = restAfter(cliArgs, sub)[1];
    if (name !== "echo" && name !== "openai" && name !== "codex" && name !== "openrouter" && name !== "local") {
      throw new Error("Usage: gini provider set echo|openai|codex|openrouter|local [model]");
    }
    config.provider = normalizeProvider({
      name,
      model: model ?? (name === "echo" ? "gini-echo-v0" : name === "codex" ? "gpt-5.5" : name === "openrouter" ? "openrouter/auto" : name === "local" ? "local/default" : "gpt-5.4-mini")
    });
    writeFileSync(configPath(config.instance), `${JSON.stringify(config, null, 2)}\n`);
    print({ updated: true, provider: providerHealth(config), configPath: configPath(config.instance) });
    return;
  }
  if (sub === "catalog") {
    print(await api(config, "/api/providers/catalog"));
    return;
  }
  print(providerHealth(config));
}
