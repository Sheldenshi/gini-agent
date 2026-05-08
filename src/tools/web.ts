// Web fetch tool: low-risk, immediate execution. Strips scripts/styles/tags
// before recording the fetched body in the task summary so the trace is
// readable and bounded.
import type { RuntimeConfig, Task } from "../types";
import { appendTrace } from "../state";
import { completeLowRiskToolTask } from "../agent";

export async function fetchWeb(config: RuntimeConfig, task: Task): Promise<Task> {
  const rawUrl = task.input.replace(/^web\s+/i, "").trim();
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Use: web <http-or-https-url>");
  const response = await fetch(parsed);
  const text = (await response.text())
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
  appendTrace(config.instance, task.id, { type: "tool", message: "Web page fetched", data: { url: parsed.toString(), status: response.status, bytes: text.length } });
  return completeLowRiskToolTask(config, task.id, text || `Fetched ${parsed.toString()} with HTTP ${response.status}.`, "web.fetch", parsed.toString(), { status: response.status, bytes: text.length });
}
