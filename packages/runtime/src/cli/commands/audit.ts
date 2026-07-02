import type { CliContext } from "../context";
import { readState } from "../../state";
import { print } from "../output";

export function audit(ctx: CliContext): void {
  print(readState(ctx.config.instance).audit);
}
