import type { CliContext } from "../context";
import { parseSubArgs, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

const ADD_FLAGS = new Set(["--connector"]);
const TELEGRAM_ALLOW_FLAGS = new Set(["--agent", "--username"]);

export async function messaging(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    // Backwards-compatible: positional `name [kind] [targets...]`
    // plus a new `--connector <id>` flag for telegram bridges. The
    // connector flag is REQUIRED for kind=telegram per ADR
    // connector-secret-storage.md (the bot token never lands on the
    // bridge record).
    const tail = restAfter(cliArgs, sub);
    const { positional, flags } = parseSubArgs(tail, ADD_FLAGS);
    const [name, kind = "demo", ...targets] = positional;
    if (!name) {
      throw new Error("Usage: gini messaging add <name> [kind] [delivery-targets...] [--connector <connector-id>]");
    }
    const connectorId = flags["--connector"];
    if (kind === "telegram" && !connectorId) {
      throw new Error("Usage: gini messaging add <name> telegram --connector <connector-id>");
    }
    const payload: Record<string, unknown> = {
      name,
      kind,
      deliveryTargets: targets
    };
    if (connectorId) payload.connectorId = connectorId;
    if (kind === "telegram") {
      payload.telegram = { allowlist: [] };
    }
    print(await api(config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "receive" || sub === "send") {
    const [id, ...textParts] = restAfter(cliArgs, sub);
    if (!id || textParts.length === 0) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name> <text>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, {
      method: "POST",
      body: JSON.stringify({ text: textParts.join(" "), target: "local" })
    }));
    return;
  }
  if (sub === "messages") {
    const id = restAfter(cliArgs, sub)[0];
    print(await api(config, id ? `/api/messaging/${encodeURIComponent(id)}/messages` : "/api/messaging/messages"));
    return;
  }
  if (sub === "telegram") {
    await telegramSub(ctx);
    return;
  }
  print(await api(config, "/api/messaging"));
}

async function telegramSub(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const action = cliArgs[2];
  if (action === "allow") {
    const tail = restAfter(cliArgs, "allow");
    const { positional, flags } = parseSubArgs(tail, TELEGRAM_ALLOW_FLAGS);
    const [bridge, telegramUserIdRaw] = positional;
    if (!bridge || !telegramUserIdRaw) {
      throw new Error("Usage: gini messaging telegram allow <bridge> <telegram-user-id> --agent <agent-id> [--username <handle>]");
    }
    const agentId = flags["--agent"];
    if (!agentId) {
      throw new Error("--agent <agent-id> is required.");
    }
    const telegramUserId = Number(telegramUserIdRaw);
    if (!Number.isInteger(telegramUserId) || telegramUserId <= 0) {
      throw new Error("telegram-user-id must be a positive integer.");
    }
    const payload: Record<string, unknown> = { telegramUserId, agentId };
    if (flags["--username"]) payload.telegramUsername = flags["--username"];
    print(await api(config, `/api/messaging/${encodeURIComponent(bridge)}/telegram/allow`, {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }
  if (action === "revoke") {
    const [bridge, telegramUserIdRaw] = restAfter(cliArgs, "revoke");
    if (!bridge || !telegramUserIdRaw) {
      throw new Error("Usage: gini messaging telegram revoke <bridge> <telegram-user-id>");
    }
    print(await api(config, `/api/messaging/${encodeURIComponent(bridge)}/telegram/allow/${encodeURIComponent(telegramUserIdRaw)}`, {
      method: "DELETE"
    }));
    return;
  }
  throw new Error("Usage: gini messaging telegram <allow|revoke> ...");
}
