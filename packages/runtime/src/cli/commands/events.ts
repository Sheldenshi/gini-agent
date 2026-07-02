import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";

export async function events(ctx: CliContext): Promise<void> {
  print(await api(ctx.config, "/api/events"));
}
