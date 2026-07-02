import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function notification(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "queue") {
    const [kind = "runtime", target = "local", ...bodyParts] = restAfter(cliArgs, sub);
    print(await api(config, "/api/notifications", {
      method: "POST",
      body: JSON.stringify({ kind, target, title: `Gini ${kind}`, body: bodyParts.join(" ") })
    }));
    return;
  }
  if (sub === "send") {
    print(await api(config, "/api/notifications/send", { method: "POST" }));
    return;
  }
  if (sub === "ack") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini notification ack <notification-id>");
    print(await api(config, `/api/notifications/${id}/ack`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/notifications"));
}
