import { spawn } from "bun";

// Google Workspace sign-in liveness, derived from `gws auth status`.
//
// This is a SEPARATE signal from the google-oauth-desktop connector's
// `health` field. Connector health == "OAuth *client* creds provisioned"
// (the client_id/secret the user pasted; they never expire) and is
// load-bearing for first-time setup: the connector.request /complete path
// DELETES any connector whose probe isn't "healthy" at creation. A
// sign-in probe is unhealthy before `gws auth login` runs, so it cannot be
// folded into `health` without breaking setup. Sign-in liveness — whether
// the *user session* token from `gws auth login` is still valid — lives
// here instead.
//
// `gws auth status` prints JSON to stdout, e.g.:
//   { "client_config_exists": true, "token_valid": false,
//     "token_error": "reauth related error (invalid_rapt)",
//     "has_refresh_token": true, ... }
// signedIn := token_valid === true; clientConfigured := client_config_exists.

export interface GwsSessionStatus {
  // Whether the `gws` CLI is on PATH and produced parseable JSON.
  installed: boolean;
  // Whether OAuth client config (client_id/secret) is present for gws.
  clientConfigured: boolean;
  // Whether the user session token is currently valid (the live signal).
  signedIn: boolean;
  // Short human string for the UI / model.
  message: string;
}

// Parse the JSON `gws auth status` emits into a session status. Pure and
// unit-testable: the subprocess boundary is isolated in `gwsSessionStatus`.
// Any parse failure / non-object output yields the not-installed shape, so a
// garbled CLI is treated the same as a missing one (we can't trust it).
export function parseGwsAuthStatus(stdout: string): GwsSessionStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return notInstalled();
  }
  if (!parsed || typeof parsed !== "object") return notInstalled();
  const obj = parsed as Record<string, unknown>;
  const clientConfigured = obj.client_config_exists === true;
  const signedIn = obj.token_valid === true;
  return {
    installed: true,
    clientConfigured,
    signedIn,
    message: signedIn
      ? "Signed in to Google"
      : clientConfigured
      ? "Google sign-in expired — re-auth needed"
      : "Google sign-in needed"
  };
}

function notInstalled(): GwsSessionStatus {
  return {
    installed: false,
    clientConfigured: false,
    signedIn: false,
    message: "gws not installed"
  };
}

// Machine-global cache. Sign-in liveness is a property of the local gws
// install, not of any one instance or connector, so a single ~15s-TTL cache
// keeps repeated /api/connectors and list_connectors calls from spawning gws
// on every request.
const TTL_MS = 15_000;
let cached: { at: number; value: GwsSessionStatus } | undefined;

// Resolve the current Google Workspace sign-in liveness. Cached ~15s. Runs
// `gws auth status` through a login shell so gws is on PATH (mirroring how
// terminal_exec spawns in src/agent.ts). gws missing / command error /
// non-JSON output → installed:false.
export async function gwsSessionStatus(): Promise<GwsSessionStatus> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value: GwsSessionStatus;
  try {
    const proc = spawn(["zsh", "-lc", "gws auth status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env }
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    value = parseGwsAuthStatus(stdout);
  } catch {
    value = notInstalled();
  }
  cached = { at: now, value };
  return value;
}

// Test seam: drop the cache so a unit test can assert fresh behavior.
export function resetGwsSessionCache(): void {
  cached = undefined;
}
