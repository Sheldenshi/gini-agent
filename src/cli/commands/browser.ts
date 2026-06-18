// CLI surface for the browser-connect capability:
//   gini browser status
//   gini browser connect [--url ws://127.0.0.1:9222/devtools/browser/abc]
//   gini browser disconnect
//
// Thin client over /api/browser*. All subcommands print the JSON response so
// users can pipe it into jq / scripts; the underlying capability shapes the
// response with a `connected` boolean for quick checks.
//
// Transport (issue #420): with no `--url`, the runtime drives its own spawned
// per-instance Chrome — `connect` is a no-op acknowledgement and sign-in
// happens through the in-chat screencast modal, not the CLI. Passing `--url`
// attaches the runtime to your OWN already-running external Chrome over that
// CDP websocket URL (an opt-in transport for users who run their own Chrome).
// To clear saved logins from the spawned profile, rm -rf the per-instance
// profile dir manually.
import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
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
    const rest = restAfter(cliArgs, "connect");
    const url = flagValue(rest, "--url");
    const requestBody: Record<string, unknown> = {};
    if (url) requestBody.cdpUrl = url;
    print(
      await api(config, "/api/browser/connect", {
        method: "POST",
        body: JSON.stringify(requestBody)
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

  throw new Error("Usage: gini browser status | connect [--url WSURL] | disconnect");
}
