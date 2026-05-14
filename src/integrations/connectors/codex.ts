import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModule } from "./types";

// Codex CLI provider. No managed secrets — auth lives in `~/.codex/auth.json`
// or the `OPENAI_API_KEY` env var. Probe verifies the CLI is on PATH and
// either of the two auth surfaces is present.

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

export const codexProvider: ProviderModule = {
  id: "codex",
  label: "Codex",
  description: "Delegate coding work to the Codex CLI. No secrets stored — auth lives in your host install.",
  fields: [],
  async probe() {
    const path = which("codex");
    if (!path) return { ok: false, message: "codex not found on PATH." };
    const authFile = join(homedir(), ".codex", "auth.json");
    if (existsSync(authFile)) {
      return { ok: true, message: `codex available; auth via ${authFile}` };
    }
    if (process.env.OPENAI_API_KEY) {
      return { ok: true, message: "codex available; auth via OPENAI_API_KEY" };
    }
    return { ok: false, message: "codex on PATH but no auth (no ~/.codex/auth.json and no OPENAI_API_KEY)." };
  },
  async detect() {
    const path = which("codex");
    if (!path) return { detected: false };
    return { detected: true, suggestedName: "codex", message: `Found codex at ${path}.` };
  }
};
