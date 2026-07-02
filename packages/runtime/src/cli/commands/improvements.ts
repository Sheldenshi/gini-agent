import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { improvementPayload, print } from "../output";

export async function improvement(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "propose") {
    const [kind, title, sourceTaskId, ...contentParts] = restAfter(cliArgs, sub);
    if (!kind || !title) throw new Error("Usage: gini improvement propose skill|job <title> [source-task-id] [content]");
    const content = contentParts.join(" ").trim() || title;
    print(await api(config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind,
        title,
        sourceTaskId,
        rationale: sourceTaskId ? `Proposed from trace evidence for ${sourceTaskId}` : "Proposed by user",
        payload: improvementPayload(kind, title, content)
      })
    }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini improvement ${sub} <proposal-id>`);
    print(await api(config, `/api/improvements/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/improvements"));
}
