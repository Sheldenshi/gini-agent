# ADR 0008: Identity Secret Storage

## Decision

Identity secrets are stored as encrypted files inside the instance directory. Each instance owns a per-instance encryption key on disk; individual secrets are encrypted with that key and written under `~/.gini/instances/<instance>/secrets/`.

The macOS Keychain is rejected as a secret storage backend for this product. It is not deferred and not an opt-in alternative.

The gateway is the only process that reads or writes secrets. Clients (CLI, web, mobile) submit and rotate secrets through the gateway HTTP API; they never touch the secret files directly.

## Context

Gini's product shape assumes a screenless-Mac mode: the gateway runs on the user's Mac while the user interacts from a phone, remote web client, or messaging bridge. Any blocking UI on the Mac during normal operation is a dead-end interaction the remote user cannot resolve.

macOS Keychain protects items with an ACL keyed to the calling binary's code signature. Reads from a different binary (or from the same binary after a signature change) produce a modal "Always Allow / Deny" dialog. In practice this fires on:

- First install.
- Bun upgrades, since Gini runs on Bun and Bun is typically ad-hoc signed.
- Gini upgrades, signature changes, binary path moves.
- A manually locked keychain.

Each of these would strand a remote user. The Keychain security win (binary-ACL protection against malicious processes running as the same user) does not survive the headless-Mac constraint, and the headless-Mac constraint is structural to the product, not a v1 limitation.

Single-user developer tooling on macOS overwhelmingly stores credentials as files at mode `0600` (`~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.npmrc`, `~/.config/gh/hosts.yml`, Cursor, Claude Code). FileVault, on by default, provides the at-rest protection that Keychain otherwise contributes. The remaining gap (in-process attacker as the same user) is real but acceptable for this product.

A future requirement for hardware-backed key material is addressed by Secure Enclave wrapping of the instance key, not by reintroducing Keychain. Secure Enclave does not produce ACL dialogs and is compatible with the headless-Mac model.

## Required Now

- Each instance owns a key file at `~/.gini/instances/<instance>/secrets/.key`, mode `0600`, created on install.
- Each identity secret is stored at `~/.gini/instances/<instance>/secrets/<identity-id>.json`, mode `0600`, encrypted with the instance key (AES-256-GCM or libsodium secretbox).
- `IdentityRecord` persists only secret *references* (`{ purpose, path }`), never plaintext values, in instance state.
- Secrets are added, rotated, and revoked exclusively through `POST` / `PATCH` / `DELETE /api/identities/...` on the gateway. The CLI and web client call the same endpoints.
- The gateway is the only process that decrypts secrets. Browser code, per ADR 0001, never receives them.
- Every secret read and write emits an audit event with `target: identity.id` and `purpose`. The plaintext value is never logged.
- Health probes (`POST /api/identities/:id/health`) decrypt the secret in-process, hit the third-party API, and surface only the result.
- The smoke flow exercises add, use, rotate, and delete for at least one non-demo identity kind.

## Rejected

- macOS Keychain in any form (default, opt-in, hardened tier). Reintroduction requires a superseding ADR.

## Deferred

- Secure Enclave-wrapped instance keys.
- Cross-instance secret sharing.
- Cloud-backed secret sync or backup.
- Per-secret rotation policy and expiry.

## Consequences For Coding Agents

- Do not import, shell out to, or add a dependency on `keytar`, the `security` CLI, or any Keychain API. Do not add a `backend` discriminator anticipating one.
- Do not add fields to `IdentityRecord` that hold plaintext secret material; only references.
- Route new identity kinds through the gateway add/rotate/delete endpoints. Do not read or write the `secrets/` directory from clients.
- When adding a tool that consumes an identity, fetch the secret through the gateway's resolver, stamp the identity id into the audit event, and never include the secret in trace evidence.

## Acceptance Checks

- A fresh instance install creates `~/.gini/instances/<instance>/secrets/` with mode `0700` and a `.key` file with mode `0600`.
- `POST /api/identities` accepts a secret payload, writes an encrypted file, and returns a record whose state JSON contains only the reference.
- Inspecting `state.json` after adding an identity shows no plaintext secret bytes.
- `PATCH` rotates the secret without changing the record id; the old ciphertext is overwritten.
- `DELETE` removes both the record and the secret file.
- Audit events appear for add, rotate, use, and delete, and none of them contain the secret value.
- The full flow runs end-to-end against a remote client (phone / web BFF) with no UI interaction on the Mac.
