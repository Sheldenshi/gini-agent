import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Whether a local Hugging Face model already exists in the on-disk cache.
// Transformers.js nests each model under <cacheDir>/<org>/<model>/ (and, in the
// HF-hub layout, <cacheDir>/models--<org>--<model>/), so a flat top-level scan
// of the cache dir never matches a cached model and re-prints the "downloading"
// notice on every start. Check the model's own nested directory for content.
export function isLocalModelCached(cacheDir: string, modelId: string): boolean {
  const candidates = [
    join(cacheDir, ...modelId.split("/")),
    join(cacheDir, `models--${modelId.replace(/\//g, "--")}`)
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(dir) && readdirSync(dir).length > 0) return true;
    } catch {
      // Unreadable candidate — treat as "not found here", try the next.
    }
  }
  return false;
}
