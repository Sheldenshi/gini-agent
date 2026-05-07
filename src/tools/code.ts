// Code tool: js/python execution always requires approval. The approved
// action runs through the same terminal.exec path in agent.executeApprovedAction.
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { appendTrace, createApproval, mutateState, now } from "../state";
import { findTask } from "../agent";

export async function requestCodeExecution(config: RuntimeConfig, task: Task): Promise<Task> {
  const match = task.input.match(/^code\s+(\w+)\s*::\s*([\s\S]+)$/i);
  if (!match) throw new Error("Use: code js|python :: <code>");
  const [, language, code] = match;
  return mutateState(config.lane, (state: RuntimeState) => {
    const item = findTask(state, task.id);
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: "Code execution can change the system and requires explicit approval.",
      payload: { command: codeExecutionCommand(language, code), timeoutMs: 10_000 }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.lane, item.id, { type: "approval", message: "Approval requested for code execution", data: { approvalId: approval.id, language } });
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
