import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

// `gini cache-warmer` — show the current interval (minutes; 0 = off).
// `gini cache-warmer set <minutes>` — update it. The integer must be in
// [0, 1440]. The CLI posts to the running gateway so the change takes
// effect on the next loop iteration without waiting for a restart; the
// gateway also persists the new value to config.json.
//
// Off is just `set 0`. No verbal alias on purpose — the slider in the
// web UI is also numeric, and a single canonical input shape keeps the
// surface honest. Validation lives in setCacheWarmer; the CLI is a thin
// shim that surfaces the error message.
export async function cacheWarmer(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "show";
  if (sub === "set") {
    const rest = restAfter(cliArgs, sub);
    const raw = rest[0];
    if (raw === undefined) {
      throw new Error("Usage: gini cache-warmer set <minutes>");
    }
    const minutes = Number(raw);
    if (!Number.isInteger(minutes)) {
      throw new Error("minutes must be an integer between 0 and 1440");
    }
    print(
      await api(config, "/api/settings/cache-warmer", {
        method: "POST",
        body: JSON.stringify({ minutes })
      })
    );
    return;
  }
  if (sub !== "show") {
    throw new Error("Usage: gini cache-warmer [set <minutes>]");
  }
  print(await api(config, "/api/settings/cache-warmer"));
}
