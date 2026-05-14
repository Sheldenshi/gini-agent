// Terminal tool: shell exec is high-risk and always raises an approval.
// The `requestShell` helper builds the approval payload and pauses the
// task; the actual exec runs from agent.executeApprovedAction once the
// user approves.
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import { appendTrace, createApproval, isTerminalTaskStatus, mutateState, now } from "../state";
import { findTask } from "../agent";

export async function requestShell(config: RuntimeConfig, task: Task): Promise<Task> {
  const command = task.input.replace(/^shell\s+/i, "").trim();
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, task.id);
    // Respect a prior terminal status. cancelTask may have flipped
    // the task to "cancelled" while the imperative dispatcher was
    // between Bun.sleep(10) and this call; flipping to
    // "waiting_approval" here would resurrect the approval lifecycle
    // and (under dangerouslyAutoApprove) execute a side effect
    // against a cancelled task.
    if (isTerminalTaskStatus(item.status)) return item;
    const approval = createApproval(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "Terminal execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs: 10_000 }
    });
    item.status = "waiting_approval";
    item.currentStep = "Waiting for approval";
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, { type: "approval", message: "Approval requested for terminal command", data: { approvalId: approval.id, command } });
    return item;
  });
}
