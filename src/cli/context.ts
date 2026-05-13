import type { RuntimeConfig } from "../types";
import type { WebOptions } from "./process";

// Per-invocation parameters threaded through every command module.
//
// `cliArgs` is the args list AFTER global flags have been stripped, so
// `cliArgs[0]` is the verb (`task`, `chat`, ...) and `cliArgs[1]` is the
// sub-verb. Command modules read positional tail args via
// `args.restAfter(cliArgs, sub)`.
export interface CliContext {
  config: RuntimeConfig;
  cliArgs: string[];
  command: string;
  ephemeralSmoke: boolean;
  // True ONLY when `--instance` was passed in raw argv. GINI_INSTANCE env is
  // intentionally NOT treated as explicit because the installed wrapper at
  // ~/.local/bin/gini sets GINI_INSTANCE=default on every invocation — if the env
  // counted, `gini uninstall` from the wrapper would always fall into
  // single-instance mode and never run a full uninstall.
  explicitInstance: boolean;
  // The original argv slice before stripGlobalArgs. Commands that need to peek
  // at flags consumed by the global parser (e.g. uninstall checking --yes,
  // --purge) read from here.
  rawArgs: string[];
  web: WebOptions;
}
