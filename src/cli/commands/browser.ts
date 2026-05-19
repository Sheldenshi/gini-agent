// CLI surface for the browser-connect capability:
//   gini browser status
//   gini browser connect [--url WSURL]
//   gini browser disconnect
//
// Thin client over /api/browser*. All subcommands print the JSON response
// so users can pipe it into jq / scripts; the underlying capability
// already shapes the response with a `connected` boolean for quick checks.
//
// Note on persistence: connect/disconnect toggle visibility only — the
// agent always drives the same per-instance profile so sign-ins persist
// across cycles. To clear saved logins, rm -rf the per-instance profile
// dir manually.
//
// Note on --port: managed mode launches Chromium via
// chromium.launchPersistentContext, which doesn't take a user-supplied
// debugging port. CDP-attach mode never used a port either — the user
// pastes a full ws:// URL. The flag is gone; older scripts that pass it
// will get the usage error below.
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
    const body: Record<string, unknown> = {};
    if (url) body.cdpUrl = url;
    print(
      await api(config, "/api/browser/connect", {
        method: "POST",
        body: JSON.stringify(body)
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

  throw new Error(
    "Usage: gini browser status | connect [--url WSURL] | disconnect"
  );
}
