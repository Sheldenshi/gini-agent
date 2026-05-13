import { writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { restAfter } from "../args";
import { configPath } from "../../paths";
import { normalizeProvider, providerHealth } from "../../provider";
import { api } from "../api";
import { print } from "../output";
import { maybeRefreshAutostart } from "./autostart";

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
    // If an autostart plist already exists for this instance, refresh it
    // so the new provider (and any secrets.env values that came along
    // with it) are picked up on the next launchd respawn. No-op on
    // non-macOS or when autostart is not enabled.
    const autostart = await maybeRefreshAutostart(config.instance);
    print({ updated: true, provider: providerHealth(config), configPath: configPath(config.instance), autostart });
    return;
  }
  if (sub === "catalog") {
    print(await api(config, "/api/providers/catalog"));
    return;
  }
  print(providerHealth(config));
}
