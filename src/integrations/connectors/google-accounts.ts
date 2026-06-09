// Orchestration for the machine-global tagged Google account registry.
//
// Low-level persistence lives in src/state/google-accounts.ts; per-config-dir
// `gws auth status` lives in ./gws-session.ts. This module joins them: live
// status for the listing, and register/remove/retag that drive the registry +
// (for register) capture the signed-in email.
//
// The status fetcher is injectable (the `deps` param) so these can be
// unit-tested without a real `gws` binary on PATH.

import { rmSync } from "node:fs";
import { basename } from "node:path";

import type { GoogleAccount, GoogleAccountStatus } from "../../types";
import {
  addGoogleAccount,
  configDirForAccount,
  getGoogleAccount,
  googleAccountsRoot,
  newAccountId,
  readGoogleAccounts,
  removeGoogleAccount,
  retagGoogleAccount
} from "../../state/google-accounts";
import { now } from "../../state/ids";
import { gwsSessionStatusForDir, type GwsSessionStatus } from "./gws-session";

type StatusFetcher = (configDir: string) => Promise<GwsSessionStatus>;

interface AccountDeps {
  statusForDir?: StatusFetcher;
}

// List every registered account joined with its live `gws auth status` (one
// spawn per config dir, in parallel). Best-effort: a status fetch that rejects
// degrades that account to signedIn:false rather than failing the whole list.
export async function listAccountsWithStatus(deps: AccountDeps = {}): Promise<GoogleAccountStatus[]> {
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  const accounts = readGoogleAccounts();
  return Promise.all(
    accounts.map(async (account) => {
      let status: GwsSessionStatus;
      try {
        status = await statusForDir(account.configDir);
      } catch (err) {
        return {
          ...account,
          signedIn: false,
          services: {},
          message: err instanceof Error ? err.message : "Failed to read Google sign-in status"
        };
      }
      return {
        ...account,
        // A freshly captured email can drift from what was stored (e.g. adopted
        // dir later re-authed as a different user); prefer the live one.
        email: status.email ?? account.email,
        signedIn: status.signedIn,
        services: status.services,
        message: status.message
      };
    })
  );
}

// Register (or refresh) a tagged account for an already-signed-in gws config
// dir. Reads `gws auth status` for the dir to confirm a live session and
// capture the email; throws when not signed in so we never register an empty
// dir. The account id is derived from the config-dir basename when the dir is a
// gini-managed one (under googleAccountsRoot()), so the dir↔id coupling
// configDirForAccount(id) === account.configDir holds and removeAccount cleans
// the dir up. For an adopted dir outside the root (e.g. ~/.config/gws), reuse
// the existing id when a registry entry already points at this configDir, else
// mint a new one.
export async function registerAccount(
  input: { tag: string; configDir: string; adopt?: boolean },
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  const status = await statusForDir(input.configDir);
  if (!status.signedIn) {
    throw new Error(`No signed-in Google session in ${input.configDir}`);
  }
  const existing = readGoogleAccounts().find((a) => a.configDir === input.configDir);
  const managed = input.configDir.startsWith(googleAccountsRoot());
  const account: GoogleAccount = {
    id: managed ? basename(input.configDir) : existing?.id ?? newAccountId(),
    tag: input.tag,
    email: status.email ?? "",
    configDir: input.configDir,
    addedAt: existing?.addedAt ?? now()
  };
  addGoogleAccount(account);
  return account;
}

// Remove an account from the registry. When its config dir is a gini-managed
// one (under googleAccountsRoot()), best-effort delete that dir too so its
// tokens don't linger. NEVER touches ~/.config/gws (an adopted dir lives
// outside the gini root), so adopting then removing leaves the user's default
// gws session intact.
export function removeAccount(accountId: string): void {
  const account = getGoogleAccount(accountId);
  removeGoogleAccount(accountId);
  if (!account) return;
  const managedDir = configDirForAccount(accountId);
  if (account.configDir === managedDir && account.configDir.startsWith(googleAccountsRoot())) {
    try { rmSync(account.configDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function retagAccount(accountId: string, tag: string): void {
  retagGoogleAccount(accountId, tag);
}
