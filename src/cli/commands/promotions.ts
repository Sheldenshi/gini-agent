import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function promotion(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "propose") {
    const [candidateRef, evidencePath, ...summaryParts] = restAfter(cliArgs, sub);
    if (!candidateRef) throw new Error("Usage: gini promotion propose <candidate-ref> [evidence-path] [summary]");
    print(await api(config, "/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        candidateRef,
        evidencePath,
        summary: summaryParts.join(" ") || `Promote candidate ${candidateRef}`,
        rollbackPlan: "Create a instance snapshot before promotion and restore it if verification fails."
      })
    }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini promotion ${sub} <promotion-id>`);
    print(await api(config, `/api/promotions/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/promotions"));
}
