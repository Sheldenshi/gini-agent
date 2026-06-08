import { writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { parseSubArgs, restAfter } from "../args";
import { configPath, writeRuntimeConfig } from "../../paths";
import { azureBaseUrlNeedsApiVersion, azureModeNeedsHttps, azureRoutingNeedsBaseUrl, normalizeProvider, providerHealth } from "../../provider";
import { isValidEnvVarName } from "../../state/secrets-env";
import { api } from "../api";
import { print } from "../output";
import { maybeRefreshAutostart } from "./autostart";

const USAGE = "Usage: gini provider set echo|openai|codex|openrouter|local|deepseek [model] [--base-url <url>] [--api-key-env <NAME>] [--extra-body <JSON>] [--api-version <VERSION>] [--deployment <NAME>] [--auth-scheme bearer|api-key]";

// Single source of truth for value-bearing flags on `gini provider set`.
// `parseSubArgs` uses this to both partition positionals and extract flag
// values, so the parser can never disagree with itself about which tokens
// belong to which flag.
const PROVIDER_SET_FLAGS: ReadonlySet<string> = new Set([
  "--base-url",
  "--api-key-env",
  "--extra-body",
  // Azure OpenAI routing (openai provider only): --api-version selects the
  // deployment-scoped surface, --deployment names the path segment (defaults
  // to the model), --auth-scheme picks the api-key vs Bearer header.
  "--api-version",
  "--deployment",
  "--auth-scheme"
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
    if (
      name !== "echo" &&
      name !== "openai" &&
      name !== "codex" &&
      name !== "openrouter" &&
      name !== "local" &&
      name !== "deepseek"
    ) {
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
    const apiVersion = flags["--api-version"];
    const deployment = flags["--deployment"];
    const authSchemeRaw = flags["--auth-scheme"];
    let authScheme: "bearer" | "api-key" | undefined;
    if (authSchemeRaw !== undefined) {
      if (authSchemeRaw !== "bearer" && authSchemeRaw !== "api-key") {
        throw new Error(`--auth-scheme must be 'bearer' or 'api-key' (got '${authSchemeRaw}')`);
      }
      authScheme = authSchemeRaw;
    }
    // The apiKeyEnv name is interpolated into ~/.gini/secrets.env (a
    // shell-sourced file); reject anything that isn't a plain env-var name.
    if (apiKeyEnv !== undefined && !isValidEnvVarName(apiKeyEnv)) {
      throw new Error("--api-key-env must be a valid environment variable name (letters, digits, underscore; not starting with a digit).");
    }
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
      if (apiVersion !== undefined) ignored.push("--api-version");
      if (deployment !== undefined) ignored.push("--deployment");
      if (authSchemeRaw !== undefined) ignored.push("--auth-scheme");
      if (ignored.length > 0) {
        process.stderr.write(`gini: warning — ${ignored.join(", ")} ${ignored.length > 1 ? "are" : "is"} ignored for the echo provider; echo bypasses HTTP entirely.\n`);
      }
    } else if (name === "codex" && extraBody !== undefined) {
      process.stderr.write("gini: warning — --extra-body is ignored for the codex provider; codex uses the /responses API with its own request shape.\n");
    }

    // Azure routing flags only affect the openai provider; normalizeProvider
    // drops them for everyone else. Warn so a misplaced flag isn't silently
    // ignored (echo is already covered above).
    if (name !== "openai" && name !== "echo") {
      const azureIgnored: string[] = [];
      if (apiVersion !== undefined) azureIgnored.push("--api-version");
      if (deployment !== undefined) azureIgnored.push("--deployment");
      if (authSchemeRaw !== undefined) azureIgnored.push("--auth-scheme");
      if (azureIgnored.length > 0) {
        process.stderr.write(`gini: warning — ${azureIgnored.join(", ")} ${azureIgnored.length > 1 ? "are" : "is"} ignored for the ${name} provider; Azure routing applies only to the openai provider.\n`);
      }
    }

    // Azure routing needs a real resource endpoint; --api-version against the
    // default api.openai.com base would build a 404-ing deployment URL.
    if (azureRoutingNeedsBaseUrl(name, apiVersion, baseUrl)) {
      throw new Error("--api-version selects Azure OpenAI routing and requires --base-url <https://<resource>.openai.azure.com>.");
    }
    // The inverse: an Azure resource base URL without --api-version would build
    // a flat path against the Azure host, which 404s.
    if (azureBaseUrlNeedsApiVersion(name, apiVersion, baseUrl)) {
      throw new Error("An Azure OpenAI base URL requires --api-version (e.g. 2024-12-01-preview).");
    }
    // Azure mode sends a credential on every call; never over plaintext http.
    if (azureModeNeedsHttps(name, apiVersion, baseUrl)) {
      throw new Error("Azure OpenAI (--api-version) requires an https:// --base-url.");
    }

    config.provider = normalizeProvider({
      name,
      model: model ?? (name === "echo" ? "gini-echo-v0" : name === "codex" ? "gpt-5.5" : name === "openrouter" ? "openrouter/auto" : name === "local" ? "local/default" : name === "deepseek" ? "deepseek-v4-flash" : "gpt-5.4-mini"),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(extraBody ? { extraBody } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(deployment ? { deployment } : {}),
      ...(authScheme ? { authScheme } : {})
    });
    writeRuntimeConfig(config);
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
