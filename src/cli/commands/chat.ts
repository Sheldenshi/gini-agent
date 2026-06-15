import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function chat(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "new") {
    const title = restAfter(cliArgs, sub).join(" ").trim() || "New chat";
    print(await api(config, "/api/chat", { method: "POST", body: JSON.stringify({ title }) }));
    return;
  }
  if (sub === "send") {
    const [sessionId, ...contentParts] = restAfter(cliArgs, sub);
    if (!sessionId || contentParts.length === 0) throw new Error("Usage: gini chat send <session-id> <message>");
    print(await api(config, `/api/chat/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: contentParts.join(" "), client: "cli" })
    }));
    return;
  }
  if (sub === "sync") {
    const [sessionId, taskId] = restAfter(cliArgs, sub);
    if (!sessionId || !taskId) throw new Error("Usage: gini chat sync <session-id> <task-id>");
    print(await api(config, `/api/chat/${sessionId}/tasks/${taskId}/sync`, { method: "POST" }));
    return;
  }
  if (sub === "show") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini chat show <session-id>");
    print(await api(config, `/api/chat/${id}`));
    return;
  }
  print(await api(config, "/api/chat"));
}
