import { readFileSync, existsSync } from "node:fs";
import { configPath } from "../../paths";
import type { Instance } from "../../types";
import { atomicWriteFile } from "../../atomic-write";
import { generateTunnelSecret } from "./secret";
import type { TunnelPersistedConfig } from "./types";

// Reads / writes the `tunnel` subtree of config.json without disturbing the
// rest of the file. Uses atomic-rename for writes so concurrent reads see
// either the old or the new full document — never a partial. One immediate
// retry on parse error covers the brief window between unlink and rename.
// See docs/adr/tunnel-and-mobile-access.md "Architecture (summary)".

type ConfigShape = Record<string, unknown> & {
  tunnel?: Partial<TunnelPersistedConfig> & {
    appleNotes?: Partial<TunnelPersistedConfig["appleNotes"]>;
  };
};

// Default returned when both read attempts fail. Callers (readTunnelConfig
// / ensureTunnelConfig / patchTunnelConfig) treat the missing `tunnel`
// subtree as "first boot" and re-mint a fresh secret on the next write.
const SAFE_DEFAULT: ConfigShape = {};

function readConfigJson(instance: Instance): ConfigShape {
  const path = configPath(instance);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigShape;
  } catch {
    // Atomic-rename collision is bounded by the writer's `rename(2)`
    // syscall, so a single immediate retry catches the microscopic
    // race window without burning CPU on a busy-loop. If the second
    // read also fails (truly corrupted file), fall back to the safe
    // default rather than propagate — losing one record means the
    // next write re-seeds; throwing would brick the runtime.
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ConfigShape;
    } catch {
      return { ...SAFE_DEFAULT };
    }
  }
}

export function readTunnelConfig(instance: Instance): TunnelPersistedConfig {
  const cfg = readConfigJson(instance);
  const t = cfg.tunnel ?? {};
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : false,
    secret: typeof t.secret === "string" && t.secret.length > 0 ? t.secret : generateTunnelSecret(),
    appleNotes: {
      enabled: typeof t.appleNotes?.enabled === "boolean" ? t.appleNotes.enabled : false
    }
  };
}

export interface EnsureTunnelOptions {
  /** Force-mint a fresh secret. Used by `gini tunnel rotate-secret`. */
  rotateSecret?: boolean;
}

/**
 * Ensure config.json has a fully-populated `tunnel` block, generating a fresh
 * secret eagerly on first boot. Returns the post-write value. Idempotent: if
 * the existing block is complete, the file is not rewritten.
 */
export function ensureTunnelConfig(instance: Instance, opts: EnsureTunnelOptions = {}): TunnelPersistedConfig {
  const path = configPath(instance);
  const cfg = existsSync(path) ? readConfigJson(instance) : {};
  const existing = cfg.tunnel ?? {};
  const needsRewrite =
    typeof existing.enabled !== "boolean"
    || typeof existing.secret !== "string"
    || existing.secret.length === 0
    || typeof existing.appleNotes?.enabled !== "boolean"
    || Boolean(opts.rotateSecret);
  const next: TunnelPersistedConfig = {
    enabled: typeof existing.enabled === "boolean" ? existing.enabled : false,
    secret: opts.rotateSecret || typeof existing.secret !== "string" || !existing.secret
      ? generateTunnelSecret()
      : existing.secret,
    appleNotes: {
      enabled: typeof existing.appleNotes?.enabled === "boolean" ? existing.appleNotes.enabled : false
    }
  };
  if (needsRewrite) {
    cfg.tunnel = next;
    atomicWriteFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  return next;
}

/**
 * Patch one or more fields of the persisted tunnel config. The remainder of
 * config.json is preserved byte-for-byte (modulo JSON serialization).
 */
export function patchTunnelConfig(
  instance: Instance,
  patch: Partial<TunnelPersistedConfig> & { appleNotes?: Partial<TunnelPersistedConfig["appleNotes"]> }
): TunnelPersistedConfig {
  const path = configPath(instance);
  const cfg = existsSync(path) ? readConfigJson(instance) : {};
  const existing = ensureTunnelConfig(instance);
  const next: TunnelPersistedConfig = {
    enabled: patch.enabled ?? existing.enabled,
    secret: patch.secret ?? existing.secret,
    appleNotes: {
      enabled: patch.appleNotes?.enabled ?? existing.appleNotes.enabled
    }
  };
  cfg.tunnel = next;
  atomicWriteFile(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return next;
}
