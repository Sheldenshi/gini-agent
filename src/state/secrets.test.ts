import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import {
  deleteIdentitySecrets,
  deleteSecret,
  ensureSecretsDir,
  getInstanceKey,
  readSecret,
  secretFilePath,
  secretKeyPath,
  writeSecret
} from "./secrets";

const ROOT = "/tmp/gini-secrets-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("instance key", () => {
  test("creates a 32-byte key at mode 0600 on first call and reuses it", () => {
    const instance = "key-roundtrip";
    const first = getInstanceKey(instance);
    expect(first.length).toBe(32);
    const path = secretKeyPath(instance);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const second = getInstanceKey(instance);
    expect(second.equals(first)).toBe(true);
  });

  test("ensureSecretsDir creates the dir at mode 0700", () => {
    const instance = "ensure-dir";
    const dir = ensureSecretsDir(instance);
    expect(existsSync(dir)).toBe(true);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe("secret round-trip", () => {
  test("encrypts and decrypts back to the same plaintext", () => {
    const instance = "round-trip";
    const ref = writeSecret(instance, "id_abc", "token", "lin_api_super_secret");
    expect(ref.purpose).toBe("token");
    expect(ref.path).toBe(secretFilePath(instance, "id_abc", "token"));
    const fileMode = statSync(ref.path).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const back = readSecret(instance, ref);
    expect(back).toBe("lin_api_super_secret");
  });

  test("ciphertext does not contain the plaintext", () => {
    const instance = "no-plaintext";
    const ref = writeSecret(instance, "id_xyz", "token", "another_plaintext_value");
    const raw = require("node:fs").readFileSync(ref.path, "utf8");
    expect(raw).not.toContain("another_plaintext_value");
  });

  test("isolates secrets between different identities", () => {
    const instance = "isolated";
    const a = writeSecret(instance, "id_a", "token", "alpha");
    const b = writeSecret(instance, "id_b", "token", "beta");
    expect(readSecret(instance, a)).toBe("alpha");
    expect(readSecret(instance, b)).toBe("beta");
    expect(a.path).not.toBe(b.path);
  });

  test("rotating a secret overwrites the ciphertext", () => {
    const instance = "rotate";
    const ref = writeSecret(instance, "id_r", "token", "v1");
    writeSecret(instance, "id_r", "token", "v2");
    expect(readSecret(instance, ref)).toBe("v2");
  });
});

describe("delete", () => {
  test("deleteSecret unlinks the file", () => {
    const instance = "del-one";
    const ref = writeSecret(instance, "id_d", "token", "boom");
    expect(existsSync(ref.path)).toBe(true);
    deleteSecret(instance, ref);
    expect(existsSync(ref.path)).toBe(false);
  });

  test("deleteIdentitySecrets removes every file for an identity", () => {
    const instance = "del-all";
    const refToken = writeSecret(instance, "id_multi", "token", "t");
    const refRefresh = writeSecret(instance, "id_multi", "refresh", "r");
    const refOther = writeSecret(instance, "id_other", "token", "o");
    deleteIdentitySecrets(instance, "id_multi");
    expect(existsSync(refToken.path)).toBe(false);
    expect(existsSync(refRefresh.path)).toBe(false);
    expect(existsSync(refOther.path)).toBe(true);
  });
});
