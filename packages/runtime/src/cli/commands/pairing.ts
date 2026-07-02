import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api, publicApi } from "../api";
import { print } from "../output";

export async function pairing(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "create";
  if (sub === "claim") {
    const [code, ...nameParts] = restAfter(cliArgs, sub);
    if (!code) throw new Error("Usage: gini pairing claim <code> [device-name]");
    print(await publicApi(config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code, deviceName: nameParts.join(" ") || "CLI device" })
    }));
    return;
  }
  print(await api(config, "/api/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 600 }) }));
}

export async function device(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "revoke") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini device revoke <device-id>");
    print(await api(config, `/api/devices/${id}/revoke`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/devices"));
}
