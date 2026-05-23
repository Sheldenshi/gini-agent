import { writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { parseSubArgs, restAfter } from "../args";
import { configPath, writeConfigAtomic } from "../../paths";
import { normalizeProvider, providerHealth } from "../../provider";
import { api } from "../api";
import { print } from "../output";
import { maybeRefreshAutostart } from "./autostart";

const USAGE = "Usage: gini provider set echo|openai|codex|openrouter|local [model] [--base-url <url>] [--api-key-env <NAME>] [--extra-body <JSON>]";

// Single source of truth for value-bearing flags on `gini provider set`.
// `parseSubArgs` uses this to both partition positionals and extract flag
// values, so the parser can never disagree with itself about which tokens
// belong to which flag.
const PROVIDER_SET_FLAGS: ReadonlySet<string> = new Set([
  "--base-url",
  "--api-key-env",
  "--extra-body"
]);

export async function provider(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "show";
  if (sub === "set") {
    const tail = restAfter(cliArgs, sub);
    const { positional, flags, unknownFlags } = parseSubArgs(tail, PROVIDER_SET_FLAGS);
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}\n${USAGE}`);
    }

    const name = positional[0];
    const model = positional[1];
    if (name !== "echo" && name !== "openai" && name !== "codex" && name !== "openrouter" && name !== "local") {
      throw new Error(USAGE);
    }
    if (positional.length > 2) {
      // Symmetric with the unknown-flag rejection: don't silently drop tokens
      // the user typed. Catches typos like
      // `gini provider set local model-a model-b`.
      throw new Error(`Unexpected extra argument(s): ${positional.slice(2).join(", ")}\n${USAGE}`);
    }

    const baseUrl = flags["--base-url"];
    const apiKeyEnv = flags["--api-key-env"];
    const extraBodyRaw = flags["--extra-body"];
    let extraBody: Record<string, unknown> | undefined;
    if (extraBodyRaw !== undefined) {
      // Parse and shape-validate as separate steps so a "not an object"
      // error doesn't get swallowed and re-wrapped as "is not valid JSON".
      let parsed: unknown;
      try {
        parsed = JSON.parse(extraBodyRaw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`--extra-body is not valid JSON: ${message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--extra-body must be a JSON object");
      }
      extraBody = parsed as Record<string, unknown>;
    }

    // Echo bypasses HTTP entirely and ignores every flag.
    // Codex uses /responses with its own request shape, so it ignores
    // --extra-body — but it DOES honor --base-url (the codex backend URL)
    // and --api-key-env (codexAuthPath reads process.env[apiKeyEnv] to
    // locate the auth.json file). Warn precisely.
    if (name === "echo") {
      const ignored: string[] = [];
      if (baseUrl !== undefined) ignored.push("--base-url");
      if (apiKeyEnv !== undefined) ignored.push("--api-key-env");
      if (extraBody !== undefined) ignored.push("--extra-body");
      if (ignored.length > 0) {
        process.stderr.write(`gini: warning — ${ignored.join(", ")} ${ignored.length > 1 ? "are" : "is"} ignored for the echo provider; echo bypasses HTTP entirely.\n`);
      }
    } else if (name === "codex" && extraBody !== undefined) {
      process.stderr.write("gini: warning — --extra-body is ignored for the codex provider; codex uses the /responses API with its own request shape.\n");
    }

    config.provider = normalizeProvider({
      name,
      model: model ?? (name === "echo" ? "gini-echo-v0" : name === "codex" ? "gpt-5.5" : name === "openrouter" ? "openrouter/auto" : name === "local" ? "local/default" : "gpt-5.4-mini"),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(extraBody ? { extraBody } : {})
    });
    writeConfigAtomic(config.instance, config);
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
