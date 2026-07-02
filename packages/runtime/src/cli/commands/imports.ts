import type { CliContext } from "../context";
import { parseSubArgs, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";
import {
  applyMigration,
  describeSource,
  discoverOpenclawState,
  planMigration,
  recordOpenclawPlanFailure,
  summarizePlan
} from "../../integrations/openclaw-migrate";

const PLAN_FLAGS: ReadonlySet<string> = new Set();
const APPLY_FLAGS: ReadonlySet<string> = new Set();
const APPLY_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--force"]);

// `gini import inspect|plan|apply` share the same dispatch but vary
// wildly in what they need from the surrounding context. We destructure
// `cliArgs` up front because every branch consumes it, but `ctx.config`
// is accessed only in the branches that legitimately need it — that
// access triggers loadConfig which materializes the instance dir
// (traces/, logs/, skills/, snapshots/, workspace/). `plan` is pure
// inspection of an external openclaw source and must not create gini
// scaffolding as a side effect.
export async function importInspect(ctx: CliContext): Promise<void> {
  const { cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "inspect") {
    const [source, path] = restAfter(cliArgs, sub);
    if (source !== "openclaw" || !path) {
      throw new Error("Usage: gini import inspect openclaw <path>");
    }
    print(
      await api(ctx.config, "/api/imports/inspect", {
        method: "POST",
        body: JSON.stringify({ source, path })
      })
    );
    return;
  }
  if (sub === "plan") {
    const { positional, unknownFlags } = parseSubArgs(restAfter(cliArgs, sub), PLAN_FLAGS);
    if (unknownFlags.length > 0) {
      throw new Error(
        `Unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}\nUsage: gini import plan openclaw [path]`
      );
    }
    if (positional.length > 2) {
      throw new Error(
        `Unexpected extra argument(s): ${positional.slice(2).join(", ")}\nUsage: gini import plan openclaw [path]`
      );
    }
    const [source, path] = positional;
    if (source !== "openclaw") {
      throw new Error("Usage: gini import plan openclaw [path]");
    }
    const discovery = discoverOpenclawState(path);
    const plan = planMigration(discovery);
    const summary = summarizePlan(plan);
    print({
      description: describeSource(discovery),
      ...summary
    });
    return;
  }
  if (sub === "apply") {
    const tail = restAfter(cliArgs, sub);
    // parseSubArgs only recognizes value-bearing flags; --force is a
    // boolean, so we partition it out before calling the parser
    // (otherwise the next positional would be consumed as the value).
    const filteredTail = tail.filter((token) => !APPLY_BOOLEAN_FLAGS.has(token));
    const force = tail.includes("--force");
    const { positional, unknownFlags } = parseSubArgs(filteredTail, APPLY_FLAGS);
    if (unknownFlags.length > 0) {
      throw new Error(
        `Unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}\nUsage: gini import apply openclaw [path] [--force]`
      );
    }
    if (positional.length > 2) {
      throw new Error(
        `Unexpected extra argument(s): ${positional.slice(2).join(", ")}\nUsage: gini import apply openclaw [path] [--force]`
      );
    }
    const [source, path] = positional;
    if (source !== "openclaw") {
      throw new Error("Usage: gini import apply openclaw [path] [--force]");
    }
    const discovery = discoverOpenclawState(path);
    // planMigration parses the operator-supplied openclaw.json. If
    // the file is malformed beyond what the tolerant JSONC scanner
    // can fix, JSON.parse throws SyntaxError out of planMigration
    // before applyMigration's catch path runs. Record a failed
    // ImportReport so the activity feed shows the attempt; the
    // original error still propagates so the CLI exit code stays
    // nonzero and the operator sees the parse problem.
    let plan;
    try {
      plan = planMigration(discovery);
    } catch (err) {
      await recordOpenclawPlanFailure(ctx.config, discovery, err);
      throw err;
    }
    const result = await applyMigration(ctx.config, discovery, plan, { force });
    print({
      source: describeSource(discovery),
      applied: result.applied,
      counts: {
        agents: result.agentsCreated,
        bridgesCreated: result.bridgesCreated,
        bridgesRotated: result.bridgesRotated,
        skills: result.skillsCopied,
        secrets: result.secretsWritten,
        workspaceFiles: result.workspaceFilesCopied,
        sessions: result.sessionsCreated,
        sessionMessages: result.sessionMessagesCreated,
        memoryUnits: result.memoryUnitsCreated
      },
      // Echo the persisted allow-list so an apply run without a
      // preceding `gini import plan` (e.g. a script) still has a
      // chance to spot a tampered backup that smuggled a foreign
      // chat id into the bridge.
      bridgesAuthorized: result.bridgesAuthorized,
      archivePath: result.archivePath,
      unsupported: result.unsupported,
      warnings: result.warnings,
      reportId: result.report.id
    });
    return;
  }
  print(await api(ctx.config, "/api/imports"));
}
