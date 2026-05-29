// Code tool: js/python execution always requires approval. The approved
// action runs through the same terminal.exec path in agent.executeApprovedAction.
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { appendTrace, createAuthorization, isTerminalTaskStatus, mutateState, now } from "../state";
import { findTask } from "../agent";
import { resolveApprovalPolicy } from "../execution/policy";

export async function requestCodeExecution(config: RuntimeConfig, task: Task): Promise<Task> {
  const match = task.input.match(/^code\s+(\w+)\s*::\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: code js|python :: <code>");
  const [, language, code] = match;
  const command = codeExecutionCommand(language, code);
  // Consult the policy seam UP FRONT so a `dangerous-pattern: <id>`
  // gate reason flows onto the approval row's reason field. Match
  // shape: the chat-task code_exec dispatcher uses `code.exec` so
  // the matcher sees both wrapper + source — mirror it here.
  const decision = resolveApprovalPolicy(config, "code.exec", { command, source: code, language });
  const reasonOverride = decision.mode === "gate" ? decision.reason : undefined;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, task.id);
    // Respect a prior terminal status — see requestShell for the
    // imperative-dispatch sleep-window race this guards against.
    if (isTerminalTaskStatus(item.status)) return item;
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: reasonOverride ?? "Code execution can change the system and requires explicit approval.",
      // Persist `source` + `language` on the payload so the imperative
      // re-resolve in agent.ts can recognize this as a code.exec
      // approval (not a plain terminal.exec) and route the policy
      // decision through the matcher that scans BOTH the wrapper
      // command AND the raw source. Without `source` here, an
      // argv-style payload like `Bun.spawn(["sudo", "apt"])` slips
      // past the substring-on-wrapper check.
      payload: { command, timeoutMs: 10_000, source: code, language }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, { type: "approval", message: "Approval requested for code execution", data: { approvalId: approval.id, language } });
    return item;
  });
}

export function codeExecutionCommand(language: string, code: string): string {
  if (language === "js" || language === "ts") {
    return `bun -e ${JSON.stringify(code)}`;
  }
  if (language === "python" || language === "py") {
    return `python3 - <<'PY'\n${code}\nPY`;
  }
  throw new Error(`Unsupported code language: ${language}`);
}
