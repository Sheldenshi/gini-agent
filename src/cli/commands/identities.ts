import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function identity(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";

  if (sub === "add") {
    const name = flagValue(cliArgs, "--name") ?? "";
    const kind = flagValue(cliArgs, "--kind") ?? "";
    const scopesRaw = flagValue(cliArgs, "--scopes") ?? "";
    const token = flagValue(cliArgs, "--token");
    if (!name || !kind) {
      throw new Error("Usage: gini identity add --kind <kind> --name <name> [--scopes a,b] [--token <value>]");
    }
    const secrets: Record<string, string> = {};
    if (token) secrets.token = token;
    const body = {
      name,
      kind,
      scopes: scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
      secrets
    };
    print(await api(config, "/api/identities", { method: "POST", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini identity remove <id>");
    print(await api(config, `/api/identities/${id}`, { method: "DELETE" }));
    return;
  }

  if (sub === "rotate") {
    const id = restAfter(cliArgs, sub)[0];
    const token = flagValue(cliArgs, "--token");
    if (!id || !token) throw new Error("Usage: gini identity rotate <id> --token <value>");
    const body = { secrets: { token } };
    print(await api(config, `/api/identities/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "health") {
    const id = restAfter(cliArgs, sub)[0] ?? "id_demo";
    print(await api(config, `/api/identities/${id}/health`, { method: "POST" }));
    return;
  }

  print(await api(config, "/api/identities"));
}
