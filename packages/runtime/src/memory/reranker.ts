// Reranker-provider domain helpers: status report.
//
// Mirrors src/memory/embedding.ts but for the cross-encoder reranker.
// There's no reembed-equivalent — the reranker is stateless and applied at
// recall time, so changing models doesn't leave a migration trail behind.
// `gini reranker status` and `gini doctor` consume this.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { resolveRerankerChoice, type RerankerChoice } from "../reranker";

export interface RerankerStatus {
  provider: RerankerChoice;
  cache: { dir: string; exists: boolean; sizeBytes: number };
}

export function rerankerStatus(config: RuntimeConfig): RerankerStatus {
  const provider = resolveRerankerChoice(config);
  const dir = provider.cacheDir ?? "";
  const cache = dir
    ? { dir, exists: existsSync(dir), sizeBytes: existsSync(dir) ? dirSize(dir) : 0 }
    : { dir: "", exists: false, sizeBytes: 0 };
  return { provider, cache };
}

// Recursive directory size — the cache dir is shared with embeddings, so
// this is the same routine used there. Kept local to avoid exporting a
// generic util just for two callers.
function dirSize(path: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      try {
        const st = statSync(child);
        if (st.isDirectory()) total += dirSize(child);
        else total += st.size;
      } catch { /* ignore stat failures (broken symlinks etc.) */ }
    }
  } catch { /* ignore readdir failures */ }
  return total;
}
