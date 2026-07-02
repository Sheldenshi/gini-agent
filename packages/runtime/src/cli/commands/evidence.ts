import type { CliContext } from "../context";
import { createEvidenceBundle } from "../../runtime/harness";
import { print } from "../output";

export function evidence(ctx: CliContext): void {
  print(createEvidenceBundle(ctx.config));
}
