// CLI surface for the browser-connect capability:
//   gini browser status
//   gini browser connect
//   gini browser disconnect
//
// Thin client over /api/browser*. All subcommands print the JSON response
// so users can pipe it into jq / scripts; the underlying capability
// already shapes the response with a `connected` boolean for quick checks.
//
// Transport (issue #420): the runtime drives a single spawned per-instance
// Chrome. There is no managed-window or cdp-attach mode, so connect takes no
// arguments — the agent's headless Chrome is launched lazily on the first
// browser tool call. Sign-in happens through the in-chat screencast modal, not
// the CLI. To clear saved logins, rm -rf the per-instance profile dir manually.
import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function browser(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "status") {
    print(await api(config, "/api/browser"));
    return;
  }

  if (sub === "connect") {
    print(
      await api(config, "/api/browser/connect", {
        method: "POST",
        body: JSON.stringify({})
      })
    );
    return;
  }

  if (sub === "disconnect") {
    print(
      await api(config, "/api/browser/disconnect", {
        method: "POST"
      })
    );
    return;
  }

  throw new Error("Usage: gini browser status | connect | disconnect");
}
