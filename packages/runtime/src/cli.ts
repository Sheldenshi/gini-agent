#!/usr/bin/env bun
// Thin shim: package.json `bin.gini` points here for backward compatibility
// with anyone who hard-coded src/cli.ts. The actual entry is src/cli/index.ts.
import { run } from "./cli/index";

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
