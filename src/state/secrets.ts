// Encrypted file-backed identity secret storage (ADR 0006).
//
// Each instance owns a 32-byte AES-256-GCM key at
// `<instance>/secrets/.key` (mode 0600). Individual secrets live as
// `<instance>/secrets/<identity-id>.<purpose>.json` (mode 0600) and store
// `{ iv, ciphertext, tag }` as base64. The gateway is the only process
// that reads or writes these files; clients submit secrets through
// HTTP and never see plaintext after the initial POST.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Instance, IdentitySecretRef } from "../types";
import { instanceRoot } from "../paths";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function secretsDir(instance: Instance): string {
  return join(instanceRoot(instance), "secrets");
}

export function secretKeyPath(instance: Instance): string {
  return join(secretsDir(instance), ".key");
}

export function secretFilePath(instance: Instance, identityId: string, purpose: string): string {
  return join(secretsDir(instance), `${identityId}.${purpose}.json`);
}

export function ensureSecretsDir(instance: Instance): string {
  const dir = secretsDir(instance);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

// Read-or-create the per-instance AES-256-GCM key. The file is mode 0600
// and lives next to the encrypted secret files. Generated once per
// instance; rotating the key is an explicit operation not exposed here.
export function getInstanceKey(instance: Instance): Buffer {
  ensureSecretsDir(instance);
  const path = secretKeyPath(instance);
  if (existsSync(path)) {
    return readFileSync(path);
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: FILE_MODE });
  return key;
}

interface EncryptedPayload {
  v: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function writeSecret(
  instance: Instance,
  identityId: string,
  purpose: string,
  plaintext: string
): IdentitySecretRef {
  ensureSecretsDir(instance);
  const key = getInstanceKey(instance);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64")
  };
  const path = secretFilePath(instance, identityId, purpose);
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: FILE_MODE });
  return { purpose, path };
}

export function readSecret(instance: Instance, ref: IdentitySecretRef): string {
  const key = getInstanceKey(instance);
  const raw = readFileSync(ref.path, "utf8");
  const payload = JSON.parse(raw) as EncryptedPayload;
  const iv = Buffer.from(payload.iv, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function deleteSecret(instance: Instance, ref: IdentitySecretRef): void {
  if (existsSync(ref.path)) unlinkSync(ref.path);
}

// Drop every encrypted file belonging to an identity. Used on identity
// delete. We rebuild the prefix from the directory listing rather than
// trusting `secretRefs` so a stale ref list can't strand a file on disk.
export function deleteIdentitySecrets(instance: Instance, identityId: string): void {
  const dir = secretsDir(instance);
  if (!existsSync(dir)) return;
  const prefix = `${identityId}.`;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      if (stat.isFile()) unlinkSync(path);
    } catch {
      // Best-effort: a missing file or permissions error here shouldn't
      // block the surrounding identity-delete flow. Audit elsewhere.
    }
  }
}
