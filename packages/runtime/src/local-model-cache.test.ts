// isLocalModelCached covers the on-disk cache layout that Transformers.js
// uses: each model nests under <cacheDir>/<org>/<model>/ (or the HF-hub
// <cacheDir>/models--<org>--<model>/), so a cached model is detected without
// re-printing the one-time download notice on every restart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalModelCached } from "./local-model-cache";

const MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "gini-model-cache-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("isLocalModelCached", () => {
  test("detects a model nested at <cache>/<org>/<model>/ with a file", () => {
    const dir = join(cacheDir, "Xenova", "ms-marco-MiniLM-L-6-v2", "onnx");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.onnx"), "weights");
    expect(isLocalModelCached(cacheDir, MODEL)).toBe(true);
  });

  test("detects a model in the HF-hub <cache>/models--<org>--<model>/ layout", () => {
    const dir = join(cacheDir, "models--Xenova--ms-marco-MiniLM-L-6-v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    expect(isLocalModelCached(cacheDir, MODEL)).toBe(true);
  });

  test("returns false when a different model is cached but not the requested one", () => {
    // The exact regression: top-level `Xenova` exists from another model, but
    // the requested Xenova/ms-marco-MiniLM-L-6-v2 is not present.
    const dir = join(cacheDir, "Xenova", "all-MiniLM-L6-v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    expect(isLocalModelCached(cacheDir, MODEL)).toBe(false);
  });

  test("returns false for an empty cache dir", () => {
    expect(isLocalModelCached(cacheDir, MODEL)).toBe(false);
  });

  test("returns false for a non-existent cache dir", () => {
    expect(isLocalModelCached(join(cacheDir, "missing"), MODEL)).toBe(false);
  });

  test("returns false when the model dir exists but is empty", () => {
    mkdirSync(join(cacheDir, "Xenova", "ms-marco-MiniLM-L-6-v2"), { recursive: true });
    expect(isLocalModelCached(cacheDir, MODEL)).toBe(false);
  });
});
