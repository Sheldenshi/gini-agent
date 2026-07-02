// Hook-primitive domain-boundary test (ADR job-pre-run-hooks.md; CLAUDE.md
// boundaries).
//
// The generic hook primitive (types/registry/runner/index) MUST stay
// domain-agnostic: it knows nothing about jobs, state persistence, or email. A
// consumer (the jobs scheduler) drives it; domains register trusted handlers via
// the composition root (builtins.ts), which is the ONE place a domain handler is
// imported — so it is deliberately excluded here. This test pins the boundary by
// scanning the primitive's source for forbidden imports, so a future edit that
// drags `../jobs`, `../state`, or an email/gmail module into the primitive fails
// loudly instead of silently coupling the layers.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The generic primitive files. builtins.ts is intentionally excluded — it is the
// composition root whose whole job is to import + register domain handlers.
const PRIMITIVE_FILES = ["types.ts", "registry.ts", "runner.ts", "index.ts"];

// Forbidden import sources: the jobs layer, the state/persistence layer, and any
// email/gmail domain module. Matched against the module specifier in any
// `import ... from "<spec>"` (static) or `import("<spec>")` (dynamic).
const FORBIDDEN = [/(["'])\.\.\/jobs(\/[^"']*)?\1/, /(["'])\.\.\/state(\/[^"']*)?\1/, /(["'])[^"']*(email|gmail)[^"']*\1/i];

describe("hook primitive domain boundary", () => {
  for (const file of PRIMITIVE_FILES) {
    test(`${file} imports nothing from jobs/state/email`, () => {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      // Consider only import statements (static + dynamic), not prose comments.
      const importLines = source
        .split("\n")
        .filter((line) => /\bimport\b/.test(line) && (line.includes("from ") || line.includes("import(")));
      for (const pattern of FORBIDDEN) {
        const offending = importLines.find((line) => pattern.test(line));
        expect(offending, `${file} must not import matching ${pattern}: ${offending ?? ""}`).toBeUndefined();
      }
    });
  }
});
