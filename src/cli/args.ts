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
    // Smoke must stay deterministic and offline (docs/operations.md). The
    // platform default provider is codex/gpt-5.5, which would call the
    // real codex backend and fail on any machine without codex auth.
    // Pin echo here so `gini smoke` works on every laptop and CI worker.
    // An explicit override like `GINI_PROVIDER=codex bun run gini smoke`
    // still wins, but in that case we MUST NOT pin the echo model
    // independently — otherwise smoke ends up with provider=codex and
    // model=gini-echo-v0, which is broken. Couple the model pin to the
    // provider pin so both move together (or neither does).
    // Treat blank/whitespace GINI_PROVIDER as unset. CI environments
    // sometimes pass `GINI_PROVIDER=""` (e.g. an unset shell variable
    // expanding to empty in a templated command), which would skip the
    // pin and let defaultConfig fall through to codex/gpt-5.5 — exactly
    // the offline-contract break this block exists to prevent.
    const explicitProvider = process.env.GINI_PROVIDER?.trim();
    if (!explicitProvider) {
      process.env.GINI_PROVIDER = "echo";
      process.env.GINI_MODEL ??= "gini-echo-v0";
    }
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

export interface ParsedSubArgs {
  positional: string[];
  flags: Record<string, string>;
  unknownFlags: string[];
}

// Single-pass partition of a sub-command's arg list into positionals + flag
// values. The caller declares which flags are value-bearing so the parser
// knows to consume the next token. Critical: only ONE source of truth for
// value-bearing flag names — the previous pattern (separate positional
// sweep + flagValue() calls) had two lists that could disagree, letting a
// missed entry consume `--api-key-env`'s value as the model name.
//
// Throws when a value-bearing flag is missing its value (better than
// silently consuming the next positional and producing a confusing config).
// Unknown flags are returned for the caller to handle (warn vs reject vs
// pass-through), since policy varies by command.
export function parseSubArgs(tokens: string[], valueFlags: ReadonlySet<string>): ParsedSubArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const unknownFlags: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.startsWith("--")) {
      if (valueFlags.has(token)) {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`Flag ${token} requires a value.`);
        }
        flags[token] = value;
        i += 1;
      } else {
        unknownFlags.push(token);
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags, unknownFlags };
}
