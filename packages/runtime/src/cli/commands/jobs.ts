import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function job(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, intervalRaw, ...promptParts] = restAfter(cliArgs, sub);
    if (!name || !intervalRaw || promptParts.length === 0) throw new Error("Usage: gini job add <name> <interval-seconds> <prompt>");
    print(await api(config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name, intervalSeconds: Number(intervalRaw), prompt: promptParts.join(" ") })
    }));
    return;
  }
  if (["run", "pause", "resume"].includes(sub)) {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini job ${sub} <job-id>`);
    print(await api(config, `/api/jobs/${id}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini job remove <job-id>");
    print(await api(config, `/api/jobs/${id}`, { method: "DELETE" }));
    return;
  }
  if (sub === "runs") {
    const id = restAfter(cliArgs, sub)[0];
    print(await api(config, id ? `/api/jobs/${id}/runs` : "/api/job-runs"));
    return;
  }
  if (sub === "replay") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini job replay <job-run-id>");
    print(await api(config, `/api/job-runs/${id}/replay`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/jobs"));
}
