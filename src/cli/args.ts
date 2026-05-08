// Argument parsing helpers shared by the CLI entry and command modules.

// Flags removed in the lane→instance rename. We reject them explicitly so
// users on older muscle memory get a clear diagnostic instead of having the
// flag silently ignored (which would let them think they were targeting one
// instance while actually hitting the default).
const REMOVED_FLAGS: Record<string, string> = {
  "--lane": "--instance"
};

export function rejectRemovedFlags(values: string[]): void {
  for (const value of values) {
    const replacement = REMOVED_FLAGS[value];
    if (replacement) {
      throw new Error(`Unknown flag '${value}'. It was renamed to '${replacement}'.`);
    }
  }
}

export function stripGlobalArgs(values: string[]): string[] {
  rejectRemovedFlags(values);
  const stripped: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (["--instance", "--state-root", "--log-root", "--port", "--web-port"].includes(values[index] ?? "")) {
      index += 1;
      continue;
    }
    if (values[index] === "--no-web" || values[index] === "--web") continue;
    stripped.push(values[index]);
  }
  return stripped;
}

export function applyGlobalEnvOverrides(values: string[], ephemeral: boolean): void {
  const stateRoot = flagValue(values, "--state-root");
  const logRoot = flagValue(values, "--log-root");
  const port = flagValue(values, "--port");
  if (stateRoot) process.env.GINI_STATE_ROOT = stateRoot;
  if (logRoot) process.env.GINI_LOG_ROOT = logRoot;
  if (port) process.env.GINI_PORT = port;
  if (ephemeral) {
    process.env.GINI_STATE_ROOT ??= `/tmp/gini-smoke-${process.pid}`;
    process.env.GINI_LOG_ROOT ??= `/tmp/gini-smoke-${process.pid}-logs`;
    process.env.GINI_PORT ??= String(7400 + Math.floor(Math.random() * 1000));
    // Smoke must never pull down the local embedding model — keeps CI fast
    // and offline. The default provider is local; explicit echo keeps smoke
    // contractually unaffected by the default change.
    process.env.GINI_EMBEDDING_PROVIDER ??= "echo";
    // Same constraint for the cross-encoder reranker. Smoke pins echo so
    // CI never triggers the ~100MB cross-encoder download.
    process.env.GINI_RERANKER_PROVIDER ??= "echo";
  }
}

export function flagValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

export function hasFlag(values: string[], flag: string): boolean {
  return values.includes(flag);
}

// Returns the args after a marker token within cliArgs. Used by command
// modules to collect the variable-length tail of a sub-command:
//   `gini task submit hello world` → restAfter(cliArgs, "submit") === ["hello", "world"]
export function restAfter(cliArgs: string[], marker: string): string[] {
  const index = cliArgs.indexOf(marker);
  return index >= 0 ? cliArgs.slice(index + 1) : [];
}
