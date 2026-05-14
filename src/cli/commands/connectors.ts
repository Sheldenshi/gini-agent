import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function connector(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";

  if (sub === "providers") {
    print(await api(config, "/api/connectors/providers"));
    return;
  }

  if (sub === "add") {
    const name = flagValue(cliArgs, "--name") ?? "";
    const provider = flagValue(cliArgs, "--provider") ?? "";
    const scopesRaw = flagValue(cliArgs, "--scopes") ?? "";
    const token = flagValue(cliArgs, "--token");
    if (!name || !provider) {
      throw new Error("Usage: gini connector add --provider <id> --name <name> [--scopes a,b] [--token <value>]");
    }
    const secrets: Record<string, string> = {};
    if (token) secrets.token = token;
    const body = {
      name,
      provider,
      scopes: scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
      secrets
    };
    print(await api(config, "/api/connectors", { method: "POST", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini connector remove <id>");
    print(await api(config, `/api/connectors/${id}`, { method: "DELETE" }));
    return;
  }

  if (sub === "rotate") {
    const id = restAfter(cliArgs, sub)[0];
    const token = flagValue(cliArgs, "--token");
    if (!id || !token) throw new Error("Usage: gini connector rotate <id> --token <value>");
    const body = { secrets: { token } };
    print(await api(config, `/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "health") {
    const id = restAfter(cliArgs, sub)[0] ?? "id_demo";
    print(await api(config, `/api/connectors/${id}/health`, { method: "POST" }));
    return;
  }

  print(await api(config, "/api/connectors"));
}
